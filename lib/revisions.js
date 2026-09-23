'use strict';
/**
 * openvibe-publishing/revisions — drafts and immutable revisions in the consumer's own database.
 *
 *   const { createRevisionStore } = require('openvibe-publishing/revisions');
 *   const revs = createRevisionStore(db, { prefix: 'wiki_page' });   // wiki_page_revisions, …
 *   const r1 = revs.create({ entityId: 'pg_1', expectedRevision: 0, content: '# Hi', fields: { title: 'Hi' }, author: 'user:usr_…' });
 *   revs.create({ entityId: 'pg_1', expectedRevision: 1, content: '# Hello', author: … });   // r2, parent r1
 *   revs.diff('pg_1', 1, 2, { mode: 'word' });
 *   revs.revert({ entityId: 'pg_1', toRevision: 1, expectedRevision: 2, author: … });       // r3 = copy of r1
 *
 * Tables (created idempotently):
 *   <prefix>_revisions        immutable: UPDATE aborts; DELETE aborts unless the entity is purged
 *   <prefix>_drafts           one mutable working copy per (entity, owner), based on a revision
 *   <prefix>_revision_purges  audit rows for explicit erasure (purgeEntity)
 *
 * Optimistic concurrency: every write names the revision number it was based on
 * (`expectedRevision`, 0 for a new entity). If the head moved, the write throws a PublishingError
 * with status 412 and code 'revision.conflict' carrying `expected` and `current`. A UNIQUE
 * (entity_id, number) index is the last line of defence against two processes racing.
 *
 * This module stores content, not publication state: which revision is live is the product's
 * decision, kept in the product's own tables.
 */
const {
    PublishingError, assertDb, assertPrefix, clockOf, newId, sha256, stableStringify, parseJson,
    assertEntityId, assertRevisionNumber, immutableTriggers,
} = require('./internal');
const { diffText } = require('./diff');

const KINDS = ['edit', 'revert', 'import'];

function conflict(entityId, expected, current) {
    return new PublishingError(412, 'revision.conflict',
        `Revision conflict on ${entityId}: expected ${expected}, current is ${current}`,
        { entityId, expected, current });
}

function shape(row) {
    if (!row) return null;
    return {
        id: row.id,
        entityId: row.entity_id,
        number: row.number,
        parentId: row.parent_id,
        parentNumber: row.parent_number,
        kind: row.kind,
        revertedTo: row.reverted_to,
        content: row.content,
        fields: parseJson(row.fields, {}),
        meta: parseJson(row.meta, {}),
        contentHash: row.content_hash,
        author: row.author,
        message: row.message,
        createdAt: new Date(row.created_at).toISOString(),
    };
}

function createRevisionStore(db, { prefix, now } = {}) {
    assertDb(db);
    assertPrefix(prefix);
    const clock = clockOf(now);
    const T = `${prefix}_revisions`;
    const D = `${prefix}_drafts`;
    const P = `${prefix}_revision_purges`;

    db.exec(`
        CREATE TABLE IF NOT EXISTS ${T} (
            id            TEXT PRIMARY KEY,
            entity_id     TEXT NOT NULL,
            number        INTEGER NOT NULL CHECK (number >= 1),
            parent_id     TEXT,
            parent_number INTEGER,
            kind          TEXT NOT NULL CHECK (kind IN ('edit','revert','import')),
            reverted_to   INTEGER,
            content       TEXT NOT NULL,
            fields        TEXT NOT NULL DEFAULT '{}',
            meta          TEXT NOT NULL DEFAULT '{}',
            content_hash  TEXT NOT NULL,
            author        TEXT,
            message       TEXT,
            created_at    INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ${T}_entity_number ON ${T} (entity_id, number);
        CREATE TABLE IF NOT EXISTS ${D} (
            entity_id     TEXT NOT NULL,
            owner         TEXT NOT NULL,
            base_revision INTEGER NOT NULL,
            content       TEXT NOT NULL,
            fields        TEXT NOT NULL DEFAULT '{}',
            meta          TEXT NOT NULL DEFAULT '{}',
            created_at    INTEGER NOT NULL,
            updated_at    INTEGER NOT NULL,
            PRIMARY KEY (entity_id, owner)
        );
        CREATE TABLE IF NOT EXISTS ${P} (
            entity_id   TEXT PRIMARY KEY,
            reason      TEXT NOT NULL,
            purged_by   TEXT,
            purged_at   INTEGER NOT NULL
        );
        ${immutableTriggers(T, P)}
    `);

    const q = {
        head: db.prepare(`SELECT * FROM ${T} WHERE entity_id = ? ORDER BY number DESC LIMIT 1`),
        byNumber: db.prepare(`SELECT * FROM ${T} WHERE entity_id = ? AND number = ?`),
        byId: db.prepare(`SELECT * FROM ${T} WHERE id = ?`),
        list: db.prepare(`SELECT * FROM ${T} WHERE entity_id = ? AND number < ? ORDER BY number DESC LIMIT ?`),
        insert: db.prepare(`INSERT INTO ${T} (id, entity_id, number, parent_id, parent_number, kind, reverted_to, content, fields, meta, content_hash, author, message, created_at)
                            VALUES (@id, @entity_id, @number, @parent_id, @parent_number, @kind, @reverted_to, @content, @fields, @meta, @content_hash, @author, @message, @created_at)`),
        draft: db.prepare(`SELECT * FROM ${D} WHERE entity_id = ? AND owner = ?`),
        draftsFor: db.prepare(`SELECT * FROM ${D} WHERE entity_id = ? ORDER BY updated_at DESC`),
        upsertDraft: db.prepare(`INSERT INTO ${D} (entity_id, owner, base_revision, content, fields, meta, created_at, updated_at)
                                 VALUES (@entity_id, @owner, @base_revision, @content, @fields, @meta, @now, @now)
                                 ON CONFLICT (entity_id, owner) DO UPDATE SET base_revision = excluded.base_revision, content = excluded.content,
                                     fields = excluded.fields, meta = excluded.meta, updated_at = excluded.updated_at`),
        deleteDraft: db.prepare(`DELETE FROM ${D} WHERE entity_id = ? AND owner = ?`),
        purged: db.prepare(`SELECT 1 FROM ${P} WHERE entity_id = ?`),
    };

    function headNumber(entityId) {
        const h = q.head.get(entityId);
        return h ? h.number : 0;
    }

    function contentHash(content, fields) {
        return sha256(`${content}\u0000${stableStringify(fields || {})}`);
    }

    function insertRevision({ entityId, expectedRevision, content, fields, meta, author, message, kind, revertedTo, allowUnchanged }) {
        assertEntityId(entityId);
        assertRevisionNumber(expectedRevision, 'expectedRevision');
        if (typeof content !== 'string') throw new TypeError('content must be a string');
        if (fields != null && (typeof fields !== 'object' || Array.isArray(fields))) throw new TypeError('fields must be an object');
        if (meta != null && (typeof meta !== 'object' || Array.isArray(meta))) throw new TypeError('meta must be an object');
        if (!KINDS.includes(kind)) throw new TypeError(`kind must be one of ${KINDS.join(', ')}`);
        if (q.purged.get(entityId)) throw new PublishingError(410, 'entity.purged', `${entityId} was purged; its id cannot be reused`);
        const head = q.head.get(entityId);
        const current = head ? head.number : 0;
        if (current !== expectedRevision) throw conflict(entityId, expectedRevision, current);
        const hash = contentHash(content, fields);
        if (head && head.content_hash === hash && !allowUnchanged) return { revision: shape(head), created: false };
        const t = clock();
        const row = {
            id: newId('rev', t),
            entity_id: entityId,
            number: current + 1,
            parent_id: head ? head.id : null,
            parent_number: head ? head.number : null,
            kind,
            reverted_to: revertedTo == null ? null : revertedTo,
            content,
            fields: JSON.stringify(fields || {}),
            meta: JSON.stringify(meta || {}),
            content_hash: hash,
            author: author == null ? null : String(author),
            message: message == null ? null : String(message).slice(0, 2000),
            created_at: t,
        };
        try {
            q.insert.run(row);
        } catch (err) {
            if (/UNIQUE constraint failed/.test(String(err && err.message))) throw conflict(entityId, expectedRevision, headNumber(entityId));
            throw err;
        }
        return { revision: shape(q.byId.get(row.id)), created: true };
    }

    const tx = (fn) => db.transaction(fn);

    const store = {
        prefix,
        tables: { revisions: T, drafts: D, purges: P },

        /** Latest revision of an entity, or null. */
        head(entityId) { return shape(q.head.get(assertEntityId(entityId))); },

        /** Current head number (0 when the entity has no revision yet). */
        headNumber(entityId) { return headNumber(assertEntityId(entityId)); },

        get(entityId, number) { return shape(q.byNumber.get(assertEntityId(entityId), number)); },

        getById(id) { return shape(q.byId.get(String(id))); },

        /** Newest first. `before` is an exclusive revision number cursor. */
        list(entityId, { limit = 50, before } = {}) {
            const lim = Math.max(1, Math.min(500, Number(limit) || 50));
            const cursor = before == null ? Number.MAX_SAFE_INTEGER : Number(before);
            return q.list.all(assertEntityId(entityId), cursor, lim).map(shape);
        },

        /** Walks parent pointers from `number` (default: head) back to revision 1. */
        lineage(entityId, number) {
            let row = number == null ? q.head.get(assertEntityId(entityId)) : q.byNumber.get(assertEntityId(entityId), number);
            const out = [];
            while (row) {
                out.push(shape(row));
                row = row.parent_id ? q.byId.get(row.parent_id) : null;
            }
            return out;
        },

        /**
         * New immutable revision. Returns { revision, created }. An edit identical to the head
         * (same content and fields) returns the head with created: false unless allowUnchanged.
         */
        create({ entityId, expectedRevision, content, fields = {}, meta = {}, author = null, message = null, kind = 'edit', allowUnchanged = false } = {}) {
            if (kind === 'revert') throw new TypeError('use revert() to create a revert revision');
            return tx(() => insertRevision({ entityId, expectedRevision, content, fields, meta, author, message, kind, allowUnchanged }))();
        },

        /** Revert as a new revision: copies revision `toRevision`'s content and fields; history is never rewritten. */
        revert({ entityId, toRevision, expectedRevision, author = null, message = null, meta = {} } = {}) {
            return tx(() => {
                const target = q.byNumber.get(assertEntityId(entityId), toRevision);
                if (!target) throw new PublishingError(404, 'revision.not_found', `No revision ${toRevision} of ${entityId}`);
                return insertRevision({
                    entityId, expectedRevision, content: target.content, fields: parseJson(target.fields, {}),
                    meta: { ...meta, revertedFrom: headNumber(entityId) }, author,
                    message: message == null ? `Revert to revision ${toRevision}` : message,
                    kind: 'revert', revertedTo: toRevision, allowUnchanged: true,
                });
            })();
        },

        /** Line or word diff of the content plus a field-by-field comparison. */
        diff(entityId, fromNumber, toNumber, { mode = 'line' } = {}) {
            const a = q.byNumber.get(assertEntityId(entityId), fromNumber);
            const b = q.byNumber.get(entityId, toNumber);
            if (!a || !b) throw new PublishingError(404, 'revision.not_found', `No revision ${!a ? fromNumber : toNumber} of ${entityId}`);
            const fa = parseJson(a.fields, {});
            const fb = parseJson(b.fields, {});
            const fields = [];
            for (const key of [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort()) {
                if (stableStringify(fa[key]) !== stableStringify(fb[key])) fields.push({ field: key, from: fa[key] === undefined ? null : fa[key], to: fb[key] === undefined ? null : fb[key] });
            }
            return { entityId, from: fromNumber, to: toNumber, content: diffText(a.content, b.content, { mode }), fields };
        },

        /** Save (create or replace) the owner's working copy. baseRevision defaults to the current head. */
        saveDraft({ entityId, owner, content, fields = {}, meta = {}, baseRevision } = {}) {
            assertEntityId(entityId);
            if (typeof owner !== 'string' || !owner) throw new TypeError('owner must be a subject string');
            if (typeof content !== 'string') throw new TypeError('content must be a string');
            const base = baseRevision == null ? headNumber(entityId) : assertRevisionNumber(baseRevision, 'baseRevision');
            q.upsertDraft.run({ entity_id: entityId, owner, base_revision: base, content, fields: JSON.stringify(fields || {}), meta: JSON.stringify(meta || {}), now: clock() });
            return store.getDraft(entityId, owner);
        },

        getDraft(entityId, owner) {
            const row = q.draft.get(assertEntityId(entityId), String(owner));
            if (!row) return null;
            return {
                entityId: row.entity_id, owner: row.owner, baseRevision: row.base_revision, content: row.content,
                fields: parseJson(row.fields, {}), meta: parseJson(row.meta, {}),
                createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
                stale: row.base_revision !== headNumber(row.entity_id),
            };
        },

        drafts(entityId) {
            return q.draftsFor.all(assertEntityId(entityId)).map((row) => store.getDraft(row.entity_id, row.owner));
        },

        discardDraft(entityId, owner) { return q.deleteDraft.run(assertEntityId(entityId), String(owner)).changes > 0; },

        /**
         * Turn a draft into a revision, based on the revision the draft started from. If someone
         * published in between, this is a 412 conflict and the draft is kept.
         */
        commitDraft({ entityId, owner, message = null, author } = {}) {
            return tx(() => {
                const d = q.draft.get(assertEntityId(entityId), String(owner));
                if (!d) throw new PublishingError(404, 'draft.not_found', `No draft of ${entityId} for ${owner}`);
                const out = insertRevision({
                    entityId, expectedRevision: d.base_revision, content: d.content, fields: parseJson(d.fields, {}),
                    meta: parseJson(d.meta, {}), author: author || owner, message, kind: 'edit',
                });
                q.deleteDraft.run(entityId, owner);
                return out;
            })();
        },

        /**
         * Explicit, audited erasure of every revision and draft of one entity (legal removal).
         * The purge row stays as the record that it happened.
         */
        purgeEntity(entityId, { reason, purgedBy = null } = {}) {
            if (!reason) throw new TypeError('a purge needs a recorded reason');
            return tx(() => {
                db.prepare(`INSERT OR IGNORE INTO ${P} (entity_id, reason, purged_by, purged_at) VALUES (?, ?, ?, ?)`).run(assertEntityId(entityId), String(reason), purgedBy, clock());
                const n = db.prepare(`DELETE FROM ${T} WHERE entity_id = ?`).run(entityId).changes;
                db.prepare(`DELETE FROM ${D} WHERE entity_id = ?`).run(entityId);
                return { deleted: n };
            })();
        },
    };
    return store;
}

module.exports = { createRevisionStore, diffText, PublishingError, KINDS };
