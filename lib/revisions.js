'use strict';
/**
 * openvibe-publishing/revisions — drafts and immutable revisions in the consumer's own database.
 *
 *   const { createRevisionStore, schema } = require('openvibe-publishing/revisions');
 *   const revs = createRevisionStore(db, { prefix: 'wiki_page' });   // db: openvibe-sdk/db handle
 *   // schema('wiki_page') → the DDL for the service's migration (tests: await revs.ensureSchema())
 *   const r1 = await revs.create({ entityId: 'pg_1', expectedRevision: 0, content: '# Hi', fields: { title: 'Hi' }, author: 'user:usr_…' });
 *   await revs.create({ entityId: 'pg_1', expectedRevision: 1, content: '# Hello', author: … });   // r2, parent r1
 *   await revs.diff('pg_1', 1, 2, { mode: 'word' });
 *   await revs.revert({ entityId: 'pg_1', toRevision: 1, expectedRevision: 2, author: … });       // r3 = copy of r1
 *   await db.tx(async (t) => { await t.exec(…); await revs.create(t, { … }); });                  // one transaction
 *
 * Tables:
 *   <prefix>_revisions        immutable: UPDATE aborts; DELETE aborts unless the entity is purged (PL/pgSQL trigger)
 *   <prefix>_drafts           one mutable working copy per (entity, owner), based on a revision
 *   <prefix>_revision_purges  audit rows for explicit erasure (purgeEntity)
 *
 * Optimistic concurrency: every write names the revision number it was based on
 * (`expectedRevision`, 0 for a new entity). If the head moved, the write throws a PublishingError
 * with status 412 and code 'revision.conflict' carrying `expected` and `current`. Writers of one
 * entity take a transaction-scoped advisory lock, so a check and its insert never interleave with
 * another writer or a purge; the UNIQUE (entity_id, number) index stays the last line of defence.
 *
 * This module stores content, not publication state: which revision is live is the product's
 * decision, kept in the product's own tables.
 */
const {
    PublishingError, assertDb, sqlOf, bindHandles, lockKey, boundedLimit, toInt4, jsonValue, revisionRefs, refKey, assertPrefix, clockOf,
    newId, sha256, stableStringify, assertEntityId, assertRevisionNumber, immutableTriggers,
} = require('./internal');
const { diffText } = require('./diff');

const KINDS = ['edit', 'revert', 'import'];

function conflict(entityId, expected, current) {
    return new PublishingError(412, 'revision.conflict',
        `Revision conflict on ${entityId}: expected ${expected}, current is ${current}`,
        { entityId, expected, current });
}

function shape(row) {
    if (!row || row.id == null) return null;
    return {
        id: row.id,
        entityId: row.entity_id,
        number: row.number,
        parentId: row.parent_id,
        parentNumber: row.parent_number,
        kind: row.kind,
        revertedTo: row.reverted_to,
        content: row.content,
        fields: jsonValue(row.fields, {}),
        meta: jsonValue(row.meta, {}),
        contentHash: row.content_hash,
        author: row.author,
        message: row.message,
        createdAt: new Date(row.created_at).toISOString(),
    };
}

function draftShape(row) {
    if (!row) return null;
    return {
        entityId: row.entity_id, owner: row.owner, baseRevision: row.base_revision, content: row.content,
        fields: jsonValue(row.fields, {}), meta: jsonValue(row.meta, {}),
        createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
        stale: row.base_revision !== row.head_number,
    };
}

/** The DDL for one prefix (idempotent), for the service's migration file. */
function schema(prefix) {
    assertPrefix(prefix);
    const T = `${prefix}_revisions`;
    const D = `${prefix}_drafts`;
    const P = `${prefix}_revision_purges`;
    return `CREATE TABLE IF NOT EXISTS ${T} (
    id            text PRIMARY KEY,
    entity_id     text COLLATE "C" NOT NULL,
    number        integer NOT NULL CHECK (number >= 1),
    parent_id     text,
    parent_number integer,
    kind          text NOT NULL CHECK (kind IN ('edit','revert','import')),
    reverted_to   integer,
    content       text NOT NULL,
    fields        jsonb NOT NULL DEFAULT '{}',
    meta          jsonb NOT NULL DEFAULT '{}',
    content_hash  text NOT NULL,
    author        text,
    message       text,
    created_at    bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ${T}_entity_num ON ${T} (entity_id, number);
CREATE TABLE IF NOT EXISTS ${D} (
    entity_id     text COLLATE "C" NOT NULL,
    owner         text COLLATE "C" NOT NULL,
    base_revision integer NOT NULL,
    content       text NOT NULL,
    fields        jsonb NOT NULL DEFAULT '{}',
    meta          jsonb NOT NULL DEFAULT '{}',
    created_at    bigint NOT NULL,
    updated_at    bigint NOT NULL,
    PRIMARY KEY (entity_id, owner)
);
CREATE INDEX IF NOT EXISTS ${D}_updated ON ${D} (entity_id, updated_at DESC, owner);
CREATE TABLE IF NOT EXISTS ${P} (
    entity_id   text COLLATE "C" PRIMARY KEY,
    reason      text NOT NULL,
    purged_by   text,
    purged_at   bigint NOT NULL
);
${immutableTriggers(T, P)}`;
}

function createRevisionStore(db, { prefix, now } = {}) {
    assertDb(db);
    assertPrefix(prefix);
    const sql = sqlOf(db);
    const clock = clockOf(now);
    const T = `${prefix}_revisions`;
    const D = `${prefix}_drafts`;
    const P = `${prefix}_revision_purges`;
    const t$ = sql.ident(T);
    const d$ = sql.ident(D);
    const p$ = sql.ident(P);
    const headNum = (entity) => sql`(SELECT COALESCE(max(number), 0) FROM ${t$} WHERE entity_id = ${entity})`;

    function contentHash(content, fields) {
        return sha256(`${content}\u0000${stableStringify(fields || {})}`);
    }

    async function headNumber(h, entityId) {
        return h.value(sql`SELECT ${headNum(entityId)} AS n`);
    }

    async function byNumber(h, entityId, number) {
        const n = toInt4(number);
        if (n == null || n < 1) return null;
        return h.maybe(sql`SELECT * FROM ${t$} WHERE entity_id = ${entityId} AND number = ${n}`);
    }

    function checkWrite({ entityId, expectedRevision, content, fields, meta, kind }) {
        assertEntityId(entityId);
        assertRevisionNumber(expectedRevision, 'expectedRevision');
        if (typeof content !== 'string') throw new TypeError('content must be a string');
        if (fields != null && (typeof fields !== 'object' || Array.isArray(fields))) throw new TypeError('fields must be an object');
        if (meta != null && typeof meta !== 'function' && (typeof meta !== 'object' || Array.isArray(meta))) throw new TypeError('meta must be an object');
        if (!KINDS.includes(kind)) throw new TypeError(`kind must be one of ${KINDS.join(', ')}`);
    }

    /** Inside a transaction holding the entity's lock. `meta` may be a function of the current head number. */
    async function insertRevision(t, { entityId, expectedRevision, content, fields, meta, author, message, kind, revertedTo, allowUnchanged }) {
        const cur = await t.one(sql`SELECT EXISTS (SELECT 1 FROM ${p$} WHERE entity_id = ${entityId}) AS purged, h.*
            FROM (SELECT 1) AS one LEFT JOIN LATERAL (SELECT * FROM ${t$} WHERE entity_id = ${entityId} ORDER BY number DESC LIMIT 1) AS h ON true`);
        if (cur.purged) throw new PublishingError(410, 'entity.purged', `${entityId} was purged; its id cannot be reused`);
        const head = cur.id == null ? null : cur;
        const current = head ? head.number : 0;
        if (current !== expectedRevision) throw conflict(entityId, expectedRevision, current);
        const hash = contentHash(content, fields);
        if (head && head.content_hash === hash && !allowUnchanged) return { revision: shape(head), created: false };
        const at = clock();
        const m = typeof meta === 'function' ? meta(current) : meta;
        const row = await t.maybe(sql`INSERT INTO ${t$} (id, entity_id, number, parent_id, parent_number, kind, reverted_to, content, fields, meta, content_hash, author, message, created_at)
            VALUES (${newId('rev', at)}, ${entityId}, ${current + 1}, ${head ? head.id : null}, ${head ? head.number : null}, ${kind},
                    ${revertedTo == null ? null : revertedTo}, ${content}, ${sql.json(fields || {})}, ${sql.json(m || {})}, ${hash},
                    ${author == null ? null : String(author)}, ${message == null ? null : String(message).slice(0, 2000)}, ${at})
            ON CONFLICT (entity_id, number) DO NOTHING
            RETURNING *`);
        if (!row) throw conflict(entityId, expectedRevision, await headNumber(t, entityId));
        return { revision: shape(row), created: true };
    }

    const lock = (t, entityId) => lockKey(t, sql, `${T}:${entityId}`);

    const impl = {
        /** Latest revision of an entity, or null. */
        async head(h, entityId) {
            return shape(await h.maybe(sql`SELECT * FROM ${t$} WHERE entity_id = ${assertEntityId(entityId)} ORDER BY number DESC LIMIT 1`));
        },

        /** Current head number (0 when the entity has no revision yet). */
        async headNumber(h, entityId) { return headNumber(h, assertEntityId(entityId)); },

        async get(h, entityId, number) { return shape(await byNumber(h, assertEntityId(entityId), number)); },

        /** true when (entityId, number) exists, without reading the content. */
        async exists(h, entityId, number) {
            const n = toInt4(number);
            if (n == null || n < 1) return false;
            return Boolean(await h.maybe(sql`SELECT 1 AS ok FROM ${t$} WHERE entity_id = ${assertEntityId(entityId)} AND number = ${n}`));
        },

        /**
         * Several revisions in one query (a sitemap or feed of published entities, no N+1):
         * refs [{ entityId, revision }] (up to 1000) → revisions in the same order, null where absent.
         */
        async getMany(h, refs = []) {
            const keys = revisionRefs(refs).filter((k) => k.number != null);
            if (!keys.length) return refs.map(() => null);
            const rows = await h.many(sql`SELECT r.* FROM unnest(${keys.map((k) => k.entityId)}::text[], ${keys.map((k) => k.number)}::integer[]) AS k(entity_id, number)
                JOIN ${t$} r ON r.entity_id = k.entity_id AND r.number = k.number`);
            const by = new Map(rows.map((r) => [refKey(r.entity_id, r.number), r]));
            return revisionRefs(refs).map((k) => (k.number == null ? null : shape(by.get(refKey(k.entityId, k.number)))));
        },

        async getById(h, id) { return shape(await h.maybe(sql`SELECT * FROM ${t$} WHERE id = ${String(id)}`)); },

        /** Newest first. `before` is an exclusive revision number cursor (keyset). */
        async list(h, entityId, { limit = 50, before } = {}) {
            const lim = boundedLimit(limit, 50, 500);
            let cursor = sql``;
            if (before != null) {
                const b = Number(before);
                if (!Number.isFinite(b)) throw new TypeError('before must be a revision number');
                cursor = sql` AND number < ${Math.min(2147483647, Math.max(-2147483648, Math.ceil(b)))}`;
            }
            return (await h.many(sql`SELECT * FROM ${t$} WHERE entity_id = ${assertEntityId(entityId)}${cursor} ORDER BY number DESC LIMIT ${lim}`)).map(shape);
        },

        /** Walks parent pointers from `number` (default: head) back to revision 1, in one query. */
        async lineage(h, entityId, number, { limit = 1000 } = {}) {
            assertEntityId(entityId);
            const lim = boundedLimit(limit, 1000, 10000);
            let start;
            if (number == null) start = sql`(SELECT max(number) FROM ${t$} WHERE entity_id = ${entityId})`;
            else {
                const n = toInt4(number);
                if (n == null) return [];
                start = sql`${n}`;
            }
            const rows = await h.many(sql`WITH RECURSIVE chain AS (
                    SELECT r.*, 1 AS depth FROM ${t$} r WHERE r.entity_id = ${entityId} AND r.number = ${start}
                    UNION ALL
                    SELECT r.*, c.depth + 1 FROM ${t$} r JOIN chain c ON r.id = c.parent_id WHERE c.depth < ${lim})
                SELECT * FROM chain ORDER BY depth`);
            return rows.map(shape);
        },

        /**
         * New immutable revision. Returns { revision, created }. An edit identical to the head
         * (same content and fields) returns the head with created: false unless allowUnchanged.
         */
        async create(h, { entityId, expectedRevision, content, fields = {}, meta = {}, author = null, message = null, kind = 'edit', allowUnchanged = false } = {}) {
            if (kind === 'revert') throw new TypeError('use revert() to create a revert revision');
            const o = { entityId, expectedRevision, content, fields, meta, author, message, kind, allowUnchanged };
            checkWrite(o);
            return h.tx(async (t) => { await lock(t, entityId); return insertRevision(t, o); });
        },

        /** Revert as a new revision: copies revision `toRevision`'s content and fields; history is never rewritten. */
        async revert(h, { entityId, toRevision, expectedRevision, author = null, message = null, meta = {} } = {}) {
            assertEntityId(entityId);
            assertRevisionNumber(expectedRevision, 'expectedRevision');
            if (meta != null && (typeof meta !== 'object' || Array.isArray(meta))) throw new TypeError('meta must be an object');
            return h.tx(async (t) => {
                await lock(t, entityId);
                const target = await byNumber(t, entityId, toRevision);
                if (!target) throw new PublishingError(404, 'revision.not_found', `No revision ${toRevision} of ${entityId}`);
                return insertRevision(t, {
                    entityId, expectedRevision, content: target.content, fields: jsonValue(target.fields, {}),
                    meta: (current) => ({ ...meta, revertedFrom: current }), author,
                    message: message == null ? `Revert to revision ${toRevision}` : message,
                    kind: 'revert', revertedTo: toRevision, allowUnchanged: true,
                });
            });
        },

        /** Line or word diff of the content plus a field-by-field comparison (both revisions in one query). */
        async diff(h, entityId, fromNumber, toNumber, { mode = 'line' } = {}) {
            assertEntityId(entityId);
            const nums = [toInt4(fromNumber), toInt4(toNumber)].filter((n) => n != null);
            const rows = nums.length ? await h.many(sql`SELECT * FROM ${t$} WHERE entity_id = ${entityId} AND number = ANY(${nums}::integer[])`) : [];
            const a = rows.find((r) => r.number === toInt4(fromNumber));
            const b = rows.find((r) => r.number === toInt4(toNumber));
            if (!a || !b) throw new PublishingError(404, 'revision.not_found', `No revision ${!a ? fromNumber : toNumber} of ${entityId}`);
            const fa = jsonValue(a.fields, {});
            const fb = jsonValue(b.fields, {});
            const fields = [];
            for (const key of [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort()) {
                if (stableStringify(fa[key]) !== stableStringify(fb[key])) fields.push({ field: key, from: fa[key] === undefined ? null : fa[key], to: fb[key] === undefined ? null : fb[key] });
            }
            return { entityId, from: fromNumber, to: toNumber, content: diffText(a.content, b.content, { mode }), fields };
        },

        /** Save (create or replace) the owner's working copy. baseRevision defaults to the current head. One statement. */
        async saveDraft(h, { entityId, owner, content, fields = {}, meta = {}, baseRevision } = {}) {
            assertEntityId(entityId);
            if (typeof owner !== 'string' || !owner) throw new TypeError('owner must be a subject string');
            if (typeof content !== 'string') throw new TypeError('content must be a string');
            const base = baseRevision == null ? headNum(entityId) : sql`${assertRevisionNumber(baseRevision, 'baseRevision')}::integer`;
            const at = clock();
            const row = await h.one(sql`INSERT INTO ${d$} AS d (entity_id, owner, base_revision, content, fields, meta, created_at, updated_at)
                VALUES (${entityId}, ${owner}, ${base}, ${content}, ${sql.json(fields || {})}, ${sql.json(meta || {})}, ${at}, ${at})
                ON CONFLICT (entity_id, owner) DO UPDATE SET base_revision = excluded.base_revision, content = excluded.content,
                    fields = excluded.fields, meta = excluded.meta, updated_at = excluded.updated_at
                RETURNING d.*, ${headNum(entityId)} AS head_number`);
            return draftShape(row);
        },

        async getDraft(h, entityId, owner) {
            assertEntityId(entityId);
            return draftShape(await h.maybe(sql`SELECT d.*, ${headNum(entityId)} AS head_number FROM ${d$} d WHERE d.entity_id = ${entityId} AND d.owner = ${String(owner)}`));
        },

        /** Every draft of an entity, most recently updated first, in one query. */
        async drafts(h, entityId, { limit = 500 } = {}) {
            assertEntityId(entityId);
            const rows = await h.many(sql`SELECT d.*, ${headNum(entityId)} AS head_number FROM ${d$} d
                WHERE d.entity_id = ${entityId} ORDER BY d.updated_at DESC, d.owner LIMIT ${boundedLimit(limit, 500, 10000)}`);
            return rows.map(draftShape);
        },

        async discardDraft(h, entityId, owner) {
            return (await h.exec(sql`DELETE FROM ${d$} WHERE entity_id = ${assertEntityId(entityId)} AND owner = ${String(owner)}`)) > 0;
        },

        /**
         * Turn a draft into a revision, based on the revision the draft started from. If someone
         * published in between, this is a 412 conflict and the draft is kept.
         */
        async commitDraft(h, { entityId, owner, message = null, author } = {}) {
            assertEntityId(entityId);
            return h.tx(async (t) => {
                await lock(t, entityId);
                const d = await t.maybe(sql`SELECT * FROM ${d$} WHERE entity_id = ${entityId} AND owner = ${String(owner)}`);
                if (!d) throw new PublishingError(404, 'draft.not_found', `No draft of ${entityId} for ${owner}`);
                const out = await insertRevision(t, {
                    entityId, expectedRevision: d.base_revision, content: d.content, fields: jsonValue(d.fields, {}),
                    meta: jsonValue(d.meta, {}), author: author || owner, message, kind: 'edit',
                });
                await t.exec(sql`DELETE FROM ${d$} WHERE entity_id = ${entityId} AND owner = ${String(owner)}`);
                return out;
            });
        },

        /**
         * Explicit, audited erasure of every revision and draft of one entity (legal removal).
         * The purge row stays as the record that it happened.
         */
        async purgeEntity(h, entityId, { reason, purgedBy = null } = {}) {
            if (!reason) throw new TypeError('a purge needs a recorded reason');
            assertEntityId(entityId);
            return h.tx(async (t) => {
                await lock(t, entityId);
                await t.exec(sql`INSERT INTO ${p$} (entity_id, reason, purged_by, purged_at) VALUES (${entityId}, ${String(reason)}, ${purgedBy}, ${clock()})
                    ON CONFLICT (entity_id) DO NOTHING`);
                const n = await t.exec(sql`DELETE FROM ${t$} WHERE entity_id = ${entityId}`);
                await t.exec(sql`DELETE FROM ${d$} WHERE entity_id = ${entityId}`);
                return { deleted: n };
            });
        },
    };

    const store = bindHandles(db, impl);
    store.prefix = prefix;
    store.tables = { revisions: T, drafts: D, purges: P };
    store.schema = () => schema(prefix);
    /** Create the tables where the handle may (tests, PGlite); services put schema() in a migration. */
    store.ensureSchema = async () => { await db.query(schema(prefix)); return store; };
    return store;
}

module.exports = { createRevisionStore, schema, diffText, PublishingError, KINDS };
