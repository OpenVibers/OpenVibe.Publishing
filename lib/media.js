'use strict';
/**
 * openvibe-publishing/media — attachments by OpenVibe.Media object id, with an explicit
 * broken-asset state.
 *
 *   const { createAttachmentStore, schema } = require('openvibe-publishing/media');
 *   const media = createAttachmentStore(db, { prefix: 'blog_post' });   // blog_post_attachments
 *   await media.attach({ entityId: 'post_1', mediaId: 'med_01J…', role: 'cover', alt: 'A loaf' });
 *   // Media says the object is gone (media.object.deleted event, or a 404 on fetch):
 *   await media.markBroken('med_01J…', 'deleted');
 *   await media.list('post_1')  // → [{ …, state: 'broken', brokenReason: 'deleted' }]
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
const {
    PublishingError, assertDb, sqlOf, bindHandles, boundedLimit, toId, toInt4, assertPrefix, clockOf, assertEntityId,
} = require('./internal');

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

/** Distinct entity ids, sorted (the answer v0.4 gave from SELECT DISTINCT … ORDER BY entity_id). */
function distinctSorted(rows) {
    return [...new Set(rows.map((r) => r.entity_id))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The DDL for one prefix (idempotent), for the service's migration file. */
function schema(prefix) {
    assertPrefix(prefix);
    const A = `${prefix}_attachments`;
    return `CREATE TABLE IF NOT EXISTS ${A} (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id     text COLLATE "C" NOT NULL,
    revision      integer,
    media_id      text COLLATE "C" NOT NULL,
    role          text NOT NULL DEFAULT 'inline',
    variant       text,
    alt           text,
    caption       text,
    position      integer NOT NULL DEFAULT 0,
    state         text NOT NULL DEFAULT 'unverified' CHECK (state IN ('unverified','available','broken')),
    broken_reason text CHECK (broken_reason IS NULL OR broken_reason IN ('not_found','deleted','forbidden')),
    checked_at    bigint,
    created_at    bigint NOT NULL,
    CHECK ((state = 'broken') = (broken_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ${A}_entity ON ${A} (entity_id, position, id);
CREATE INDEX IF NOT EXISTS ${A}_media ON ${A} (media_id, entity_id);
`;
}

function createAttachmentStore(db, { prefix, now } = {}) {
    assertDb(db);
    assertPrefix(prefix);
    const sql = sqlOf(db);
    const clock = clockOf(now);
    const A = `${prefix}_attachments`;
    const a$ = sql.ident(A);

    const impl = {
        async attach(h, { entityId, mediaId, revision = null, role = 'inline', variant = null, alt = null, caption = null, position = 0 } = {}) {
            assertEntityId(entityId);
            if (!isMediaId(mediaId)) throw new PublishingError(400, 'media.invalid_id', 'mediaId must be a Media object id (med_<ULID> or legacy:<app>:<kind>:<id>)');
            if (!ROLE_RE.test(role)) throw new TypeError(`role must match ${ROLE_RE}`);
            if (variant != null && !VARIANT_RE.test(variant)) throw new TypeError(`variant must match ${VARIANT_RE}`);
            if (revision != null && (!Number.isInteger(revision) || revision < 1 || revision > 2147483647)) throw new TypeError('revision must be a positive integer');
            const pos = toInt4(position);
            return shape(await h.one(sql`INSERT INTO ${a$} (entity_id, revision, media_id, role, variant, alt, caption, position, created_at)
                VALUES (${entityId}, ${revision}, ${mediaId}, ${role}, ${variant}, ${alt == null ? null : String(alt).slice(0, 1000)},
                        ${caption == null ? null : String(caption).slice(0, 2000)}, ${Number.isInteger(position) && pos != null ? pos : 0}, ${clock()})
                RETURNING *`));
        },

        async detach(h, entityId, attachmentId) {
            const id = toId(attachmentId);
            assertEntityId(entityId);
            if (id == null) return false;
            return (await h.exec(sql`DELETE FROM ${a$} WHERE id = ${id} AND entity_id = ${entityId}`)) > 0;
        },

        async get(h, id) {
            const n = toId(id);
            return n == null ? null : shape(await h.maybe(sql`SELECT * FROM ${a$} WHERE id = ${n}`));
        },

        /** All attachments of an entity; with `revision`, entity-wide ones plus that revision's. */
        async list(h, entityId, { revision, limit = 1000 } = {}) {
            assertEntityId(entityId);
            const rev = revision == null ? null : toInt4(revision);
            const cond = revision == null ? sql`` : sql` AND (revision IS NULL OR revision = ${rev}::integer)`;
            return (await h.many(sql`SELECT * FROM ${a$} WHERE entity_id = ${entityId}${cond} ORDER BY position, id LIMIT ${boundedLimit(limit)}`)).map(shape);
        },

        async broken(h, entityId, { limit = 1000 } = {}) {
            return (await h.many(sql`SELECT * FROM ${a$} WHERE entity_id = ${assertEntityId(entityId)} AND state = 'broken'
                ORDER BY position, id LIMIT ${boundedLimit(limit)}`)).map(shape);
        },

        /**
         * Entities that reference a Media object — what to re-render/re-index when it changes.
         * Keyset pages: `after` is the last entity id of the previous page.
         */
        async entitiesUsing(h, mediaId, { limit = 1000, after = null } = {}) {
            const cursor = after == null ? sql`` : sql` AND entity_id > ${String(after)}`;
            return (await h.many(sql`SELECT DISTINCT entity_id FROM ${a$} WHERE media_id = ${String(mediaId)}${cursor}
                ORDER BY entity_id LIMIT ${boundedLimit(limit)}`)).map((r) => r.entity_id);
        },

        /** Mark every attachment of this object broken, in one statement. Returns the affected entity ids. */
        async markBroken(h, mediaId, reason = 'not_found') {
            if (!BROKEN_REASONS.includes(reason)) throw new TypeError(`reason must be one of ${BROKEN_REASONS.join(', ')}`);
            return distinctSorted(await h.many(sql`UPDATE ${a$} SET state = 'broken', broken_reason = ${reason}, checked_at = ${clock()}
                WHERE media_id = ${String(mediaId)} RETURNING entity_id`));
        },

        async markAvailable(h, mediaId) {
            return distinctSorted(await h.many(sql`UPDATE ${a$} SET state = 'available', broken_reason = NULL, checked_at = ${clock()}
                WHERE media_id = ${String(mediaId)} RETURNING entity_id`));
        },

        /**
         * Check an entity's attachments against Media. resolve(mediaId) must return
         * { exists: true } | { exists: false, reason: 'not_found'|'deleted'|'forbidden' } or throw.
         * Returns [{ mediaId, outcome: 'available'|'broken'|'check_failed', reason? }].
         * The verdicts are written together in one statement after every check has answered; no
         * transaction is held open across the calls to Media.
         */
        async verify(h, entityId, { resolve } = {}) {
            if (typeof resolve !== 'function') throw new TypeError('resolve(mediaId) is required');
            assertEntityId(entityId);
            const ids = [...new Set((await h.many(sql`SELECT media_id FROM ${a$} WHERE entity_id = ${entityId} ORDER BY position, id LIMIT 10000`)).map((r) => r.media_id))];
            const out = [];
            const verdicts = [];
            for (const mediaId of ids) {
                let r;
                try { r = await resolve(mediaId); } catch (err) {
                    out.push({ mediaId, outcome: 'check_failed', error: String(err && err.message || err) });
                    continue;
                }
                if (r && r.exists === true) { verdicts.push([mediaId, 'available', null]); out.push({ mediaId, outcome: 'available' }); }
                else if (r && r.exists === false && BROKEN_REASONS.includes(r.reason || 'not_found')) {
                    verdicts.push([mediaId, 'broken', r.reason || 'not_found']);
                    out.push({ mediaId, outcome: 'broken', reason: r.reason || 'not_found' });
                } else out.push({ mediaId, outcome: 'check_failed', error: 'resolver returned no verdict' });
            }
            if (verdicts.length) {
                await h.exec(sql`UPDATE ${a$} AS a SET state = v.state, broken_reason = v.reason, checked_at = ${clock()}::bigint
                    FROM unnest(${verdicts.map((v) => v[0])}::text[], ${verdicts.map((v) => v[1])}::text[], ${verdicts.map((v) => v[2])}::text[]) AS v(media_id, state, reason)
                    WHERE a.media_id = v.media_id`);
            }
            return out;
        },
    };

    const api = bindHandles(db, impl);
    api.table = A;
    api.schema = () => schema(prefix);
    /** Create the table where the handle may (tests, PGlite); services put schema() in a migration. */
    api.ensureSchema = async () => { await db.query(schema(prefix)); return api; };
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

module.exports = { createAttachmentStore, schema, mediaRef, figureHtml, isMediaId, STATES, BROKEN_REASONS, MEDIA_ID_RE };
