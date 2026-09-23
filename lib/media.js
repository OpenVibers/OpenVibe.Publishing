'use strict';
/**
 * openvibe-publishing/media — attachments by OpenVibe.Media object id, with an explicit
 * broken-asset state.
 *
 *   const { createAttachmentStore } = require('openvibe-publishing/media');
 *   const media = createAttachmentStore(db, { prefix: 'blog_post' });   // blog_post_attachments
 *   media.attach({ entityId: 'post_1', mediaId: 'med_01J…', role: 'cover', alt: 'A loaf' });
 *   // Media says the object is gone (media.object.deleted event, or a 404 on fetch):
 *   media.markBroken('med_01J…', 'deleted');
 *   media.list('post_1')  // → [{ …, state: 'broken', brokenReason: 'deleted' }]
 *
 * Bytes never live here: a row is a reference (MediaRef: med_<ULID> or the transitional
 * legacy:<app>:<kind>:<id>). States:
 *   unverified  attached, never checked
 *   available   the last check found the object
 *   broken      the object is gone (not_found | deleted | forbidden) — rendered as an explicit
 *               "media unavailable" placeholder, never silently dropped or replaced
 * A check that fails for another reason (timeout, 5xx) changes nothing and is reported as
 * check_failed: an outage is not evidence the object is gone, nor that it exists.
 */
const { PublishingError, assertDb, assertPrefix, clockOf, assertEntityId } = require('./internal');

const MEDIA_ID_RE = /^(med_[0-9A-HJKMNP-TV-Z]{26}|legacy:[a-z][a-z0-9-]{1,39}:(vod|clip|file|paste|thumbnail|avatar):[A-Za-z0-9._/-]{1,200})$/;
const ROLE_RE = /^[a-z][a-z0-9_]{1,39}$/;
const VARIANT_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const STATES = ['unverified', 'available', 'broken'];
const BROKEN_REASONS = ['not_found', 'deleted', 'forbidden'];

function isMediaId(id) { return typeof id === 'string' && MEDIA_ID_RE.test(id); }

function shape(row) {
    if (!row) return null;
    return {
        id: row.id,
        entityId: row.entity_id,
        revision: row.revision,
        mediaId: row.media_id,
        role: row.role,
        variant: row.variant,
        alt: row.alt,
        caption: row.caption,
        position: row.position,
        state: row.state,
        broken: row.state === 'broken',
        brokenReason: row.broken_reason,
        checkedAt: row.checked_at == null ? null : new Date(row.checked_at).toISOString(),
    };
}

function createAttachmentStore(db, { prefix, now } = {}) {
    assertDb(db);
    assertPrefix(prefix);
    const clock = clockOf(now);
    const A = `${prefix}_attachments`;

    db.exec(`
        CREATE TABLE IF NOT EXISTS ${A} (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_id     TEXT NOT NULL,
            revision      INTEGER,
            media_id      TEXT NOT NULL,
            role          TEXT NOT NULL DEFAULT 'inline',
            variant       TEXT,
            alt           TEXT,
            caption       TEXT,
            position      INTEGER NOT NULL DEFAULT 0,
            state         TEXT NOT NULL DEFAULT 'unverified' CHECK (state IN ('unverified','available','broken')),
            broken_reason TEXT CHECK (broken_reason IS NULL OR broken_reason IN ('not_found','deleted','forbidden')),
            checked_at    INTEGER,
            created_at    INTEGER NOT NULL,
            CHECK ((state = 'broken') = (broken_reason IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS ${A}_entity ON ${A} (entity_id, position);
        CREATE INDEX IF NOT EXISTS ${A}_media ON ${A} (media_id);
    `);

    const q = {
        insert: db.prepare(`INSERT INTO ${A} (entity_id, revision, media_id, role, variant, alt, caption, position, created_at)
                            VALUES (@entity_id, @revision, @media_id, @role, @variant, @alt, @caption, @position, @now)`),
        byId: db.prepare(`SELECT * FROM ${A} WHERE id = ?`),
        list: db.prepare(`SELECT * FROM ${A} WHERE entity_id = ? ORDER BY position, id`),
        listRev: db.prepare(`SELECT * FROM ${A} WHERE entity_id = ? AND (revision IS NULL OR revision = ?) ORDER BY position, id`),
        detach: db.prepare(`DELETE FROM ${A} WHERE id = ? AND entity_id = ?`),
        broken: db.prepare(`UPDATE ${A} SET state = 'broken', broken_reason = ?, checked_at = ? WHERE media_id = ?`),
        available: db.prepare(`UPDATE ${A} SET state = 'available', broken_reason = NULL, checked_at = ? WHERE media_id = ?`),
        brokenFor: db.prepare(`SELECT * FROM ${A} WHERE entity_id = ? AND state = 'broken' ORDER BY position, id`),
        entitiesWith: db.prepare(`SELECT DISTINCT entity_id FROM ${A} WHERE media_id = ? ORDER BY entity_id`),
    };

    const api = {
        table: A,

        attach({ entityId, mediaId, revision = null, role = 'inline', variant = null, alt = null, caption = null, position = 0 } = {}) {
            assertEntityId(entityId);
            if (!isMediaId(mediaId)) throw new PublishingError(400, 'media.invalid_id', 'mediaId must be a Media object id (med_<ULID> or legacy:<app>:<kind>:<id>)');
            if (!ROLE_RE.test(role)) throw new TypeError(`role must match ${ROLE_RE}`);
            if (variant != null && !VARIANT_RE.test(variant)) throw new TypeError(`variant must match ${VARIANT_RE}`);
            if (revision != null && (!Number.isInteger(revision) || revision < 1)) throw new TypeError('revision must be a positive integer');
            const info = q.insert.run({
                entity_id: entityId, revision, media_id: mediaId, role, variant,
                alt: alt == null ? null : String(alt).slice(0, 1000),
                caption: caption == null ? null : String(caption).slice(0, 2000),
                position: Number.isInteger(position) ? position : 0, now: clock(),
            });
            return shape(q.byId.get(info.lastInsertRowid));
        },

        detach(entityId, attachmentId) { return q.detach.run(Number(attachmentId), assertEntityId(entityId)).changes > 0; },

        get(id) { return shape(q.byId.get(Number(id))); },

        /** All attachments of an entity; with `revision`, entity-wide ones plus that revision's. */
        list(entityId, { revision } = {}) {
            assertEntityId(entityId);
            return (revision == null ? q.list.all(entityId) : q.listRev.all(entityId, revision)).map(shape);
        },

        broken(entityId) { return q.brokenFor.all(assertEntityId(entityId)).map(shape); },

        /** Entities that reference a Media object — what to re-render/re-index when it changes. */
        entitiesUsing(mediaId) { return q.entitiesWith.all(String(mediaId)).map((r) => r.entity_id); },

        /** Mark every attachment of this object broken. Returns the affected entity ids. */
        markBroken(mediaId, reason = 'not_found') {
            if (!BROKEN_REASONS.includes(reason)) throw new TypeError(`reason must be one of ${BROKEN_REASONS.join(', ')}`);
            return db.transaction(() => {
                const ids = api.entitiesUsing(mediaId);
                q.broken.run(reason, clock(), String(mediaId));
                return ids;
            })();
        },

        markAvailable(mediaId) {
            return db.transaction(() => {
                const ids = api.entitiesUsing(mediaId);
                q.available.run(clock(), String(mediaId));
                return ids;
            })();
        },

        /**
         * Check an entity's attachments against Media. resolve(mediaId) must return
         * { exists: true } | { exists: false, reason: 'not_found'|'deleted'|'forbidden' } or throw.
         * Returns [{ mediaId, outcome: 'available'|'broken'|'check_failed', reason? }].
         */
        async verify(entityId, { resolve } = {}) {
            if (typeof resolve !== 'function') throw new TypeError('resolve(mediaId) is required');
            const ids = [...new Set(api.list(entityId).map((a) => a.mediaId))];
            const out = [];
            for (const mediaId of ids) {
                let r;
                try { r = await resolve(mediaId); } catch (err) {
                    out.push({ mediaId, outcome: 'check_failed', error: String(err && err.message || err) });
                    continue;
                }
                if (r && r.exists === true) { api.markAvailable(mediaId); out.push({ mediaId, outcome: 'available' }); }
                else if (r && r.exists === false && BROKEN_REASONS.includes(r.reason || 'not_found')) {
                    api.markBroken(mediaId, r.reason || 'not_found');
                    out.push({ mediaId, outcome: 'broken', reason: r.reason || 'not_found' });
                } else out.push({ mediaId, outcome: 'check_failed', error: 'resolver returned no verdict' });
            }
            return out;
        },
    };
    return api;
}

/** The Contracts MediaRef ({ media_id, role?, variant? }) for an attachment. */
function mediaRef(att) {
    const ref = { media_id: att.mediaId };
    if (att.role) ref.role = att.role;
    if (att.variant) ref.variant = att.variant;
    return ref;
}

/**
 * Server-rendered <figure> for an attachment. urlFor(mediaId, att) returns the delivery URL.
 * A broken attachment renders an explicit placeholder — no <img>, no guessed URL.
 */
function figureHtml(att, { urlFor, unavailableText = 'This media is no longer available.' } = {}) {
    const { escapeHtml: esc } = require('./ssr');
    const caption = att.caption ? `<figcaption>${esc(att.caption)}</figcaption>` : '';
    if (att.state === 'broken') {
        return `<figure class="ov-media ov-media-broken" data-media-id="${esc(att.mediaId)}" data-state="broken"><div class="ov-media-missing" role="img" aria-label="${esc(unavailableText)}">${esc(unavailableText)}</div>${caption}</figure>`;
    }
    if (typeof urlFor !== 'function') throw new TypeError('urlFor(mediaId) is required to render an available attachment');
    const src = urlFor(att.mediaId, att);
    return `<figure class="ov-media" data-media-id="${esc(att.mediaId)}" data-state="${esc(att.state)}"><img src="${esc(src)}" alt="${esc(att.alt || '')}" loading="lazy" decoding="async">${caption}</figure>`;
}

module.exports = { createAttachmentStore, mediaRef, figureHtml, isMediaId, STATES, BROKEN_REASONS, MEDIA_ID_RE };
