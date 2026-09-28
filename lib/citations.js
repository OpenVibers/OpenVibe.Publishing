'use strict';
/**
 * openvibe-publishing/citations — source references attached to one specific revision.
 *
 *   const { createCitationStore, schema } = require('openvibe-publishing/citations');
 *   const cites = createCitationStore(db, { prefix: 'wiki', revisions });   // wiki_citations
 *   await cites.attach({ entityId: 'pg_1', revision: 2, url: 'https://example.org/a', retrievedAt: '2026-09-20T10:00:00Z',
 *                        quote: { text: '…', start: 120, end: 180 }, licenseNote: 'CC BY 4.0', sourceItemId: 'src_…' });
 *   await cites.carryForward({ entityId: 'pg_1', fromRevision: 2, toRevision: 3 });  // reuse in r3
 *   await cites.forRevision('pg_1', 2);   // still there after r3 dropped them
 *
 * Rules:
 *   - A citation belongs to (entity, revision). It is never dropped: the table is append-only
 *     (UPDATE and DELETE abort in a PL/pgSQL trigger), so a later revision that does not reuse a
 *     source leaves the earlier revision's citations intact. Only purgeEntity (audited) removes rows.
 *   - Every citation names a source: a Sources item id, an http(s) URL, or both.
 *   - Nothing is filled in: a missing retrieved_at, title or license note stays null. This module
 *     never stamps "now" as a retrieval time.
 *   - If a revisions store is passed, attach() refuses revisions that do not exist.
 * Several citations go in one INSERT (attachMany, carryForward), never one statement per row.
 */
const {
    PublishingError, assertDb, sqlOf, bindHandles, lockKey, boundedLimit, toId, toInt4, revisionRefs, refKey, assertPrefix, clockOf,
    assertEntityId, assertRevisionNumber, isoOrNull, immutableTriggers,
} = require('./internal');

const COLUMNS = ['entity_id', 'revision', 'anchor', 'source_item_id', 'url', 'title', 'retrieved_at', 'quote_text', 'quote_start',
    'quote_end', 'license_note', 'carried_from', 'attached_by', 'attached_at'];

function shape(row) {
    if (!row) return null;
    const quote = row.quote_text == null && row.quote_start == null ? null
        : { text: row.quote_text, start: row.quote_start, end: row.quote_end };
    return {
        id: row.id,
        entityId: row.entity_id,
        revision: row.revision,
        anchor: row.anchor,
        sourceItemId: row.source_item_id,
        url: row.url,
        title: row.title,
        retrievedAt: row.retrieved_at == null ? null : new Date(row.retrieved_at).toISOString(),
        quote,
        licenseNote: row.license_note,
        carriedFrom: row.carried_from,
        attachedBy: row.attached_by,
        attachedAt: new Date(row.attached_at).toISOString(),
    };
}

function checkUrl(url) {
    if (url == null || url === '') return null;
    let u;
    try { u = new URL(String(url)); } catch { throw new TypeError('url must be an absolute URL'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new TypeError('url must be http(s)');
    return u.toString();
}

function checkQuote(quote) {
    if (quote == null) return { text: null, start: null, end: null };
    if (typeof quote !== 'object') throw new TypeError('quote must be { text, start, end }');
    const text = quote.text == null ? null : String(quote.text).slice(0, 5000);
    const start = quote.start == null ? null : Number(quote.start);
    const end = quote.end == null ? null : Number(quote.end);
    if ((start == null) !== (end == null)) throw new TypeError('quote.start and quote.end go together');
    if (start != null && (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > 2147483647)) throw new TypeError('quote span must be 0 <= start <= end');
    if (text == null && start == null) return { text: null, start: null, end: null };
    return { text, start, end };
}

/** The DDL for one prefix (idempotent), for the service's migration file. */
function schema(prefix) {
    assertPrefix(prefix);
    const C = `${prefix}_citations`;
    const P = `${prefix}_citation_purges`;
    return `CREATE TABLE IF NOT EXISTS ${C} (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id      text COLLATE "C" NOT NULL,
    revision       integer NOT NULL CHECK (revision >= 1),
    anchor         text,
    source_item_id text COLLATE "C",
    url            text,
    title          text,
    retrieved_at   timestamptz,
    quote_text     text,
    quote_start    integer,
    quote_end      integer,
    license_note   text,
    carried_from   bigint REFERENCES ${C}(id),
    attached_by    text,
    attached_at    bigint NOT NULL,
    CHECK (source_item_id IS NOT NULL OR url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ${C}_rev ON ${C} (entity_id, revision, id);
CREATE INDEX IF NOT EXISTS ${C}_source ON ${C} (source_item_id, entity_id, revision, id) WHERE source_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ${C}_carried ON ${C} (carried_from) WHERE carried_from IS NOT NULL;
CREATE TABLE IF NOT EXISTS ${P} (
    entity_id text COLLATE "C" PRIMARY KEY,
    reason    text NOT NULL,
    purged_by text,
    purged_at bigint NOT NULL
);
${immutableTriggers(C, P)}`;
}

function createCitationStore(db, { prefix, now, revisions = null } = {}) {
    assertDb(db);
    assertPrefix(prefix);
    const sql = sqlOf(db);
    const clock = clockOf(now);
    const C = `${prefix}_citations`;
    const P = `${prefix}_citation_purges`;
    const c$ = sql.ident(C);
    const p$ = sql.ident(P);
    const lock = (t, entityId) => lockKey(t, sql, `${C}:${entityId}`);

    function checkRevisionNumber(revision) {
        assertRevisionNumber(revision, 'revision');
        if (revision < 1) throw new TypeError('revision must be >= 1');
        if (revision > 2147483647) throw new TypeError('revision is out of range');
    }

    /** Inside the entity's lock: the revision exists (when a revisions store is known) and the entity is not purged. */
    async function checkTarget(t, entityId, revision, { purged = true } = {}) {
        if (revisions) {
            const ok = typeof revisions.exists === 'function' ? await revisions.exists(t, entityId, revision) : Boolean(await revisions.get(t, entityId, revision));
            if (!ok) throw new PublishingError(404, 'revision.not_found', `No revision ${revision} of ${entityId}`);
        }
        if (purged && await t.maybe(sql`SELECT 1 AS ok FROM ${p$} WHERE entity_id = ${entityId}`)) {
            throw new PublishingError(410, 'entity.purged', `${entityId} was purged`);
        }
    }

    function toRow(entityId, revision, c, at, carriedFrom = null) {
        const sourceItemId = c.sourceItemId == null || c.sourceItemId === '' ? null : String(c.sourceItemId).slice(0, 128);
        const url = checkUrl(c.url);
        if (!sourceItemId && !url) throw new PublishingError(400, 'citation.no_source', 'A citation needs a Sources item id or an http(s) URL');
        const quote = checkQuote(c.quote);
        return {
            entity_id: entityId,
            revision,
            anchor: c.anchor == null ? null : String(c.anchor).slice(0, 100),
            source_item_id: sourceItemId,
            url,
            title: c.title == null ? null : String(c.title).slice(0, 500),
            retrieved_at: isoOrNull(c.retrievedAt, 'retrievedAt'),
            quote_text: quote.text,
            quote_start: quote.start,
            quote_end: quote.end,
            license_note: c.licenseNote == null ? null : String(c.licenseNote).slice(0, 1000),
            carried_from: carriedFrom,
            attached_by: c.attachedBy == null ? null : String(c.attachedBy),
            attached_at: at,
        };
    }

    /** One INSERT for any number of rows; identities follow the input order. */
    async function insertRows(t, rows) {
        if (!rows.length) return [];
        const out = await t.many(sql`INSERT INTO ${c$} ${sql.insert(rows, COLUMNS)} RETURNING *`);
        return out.sort((a, b) => a.id - b.id).map(shape);
    }

    const impl = {
        /** Attach one citation to (entityId, revision). */
        async attach(h, { entityId, revision, ...citation } = {}) {
            assertEntityId(entityId);
            checkRevisionNumber(revision);
            const row = toRow(entityId, revision, citation, clock());
            return h.tx(async (t) => {
                await lock(t, entityId);
                await checkTarget(t, entityId, revision);
                return (await insertRows(t, [row]))[0];
            });
        },

        /** Attach several in one transaction and one INSERT. */
        async attachMany(h, entityId, revision, list = []) {
            assertEntityId(entityId);
            checkRevisionNumber(revision);
            const at = clock();
            const rows = list.map((c) => toRow(entityId, revision, c || {}, at));
            return h.tx(async (t) => {
                await lock(t, entityId);
                await checkTarget(t, entityId, revision);
                return insertRows(t, rows);
            });
        },

        /**
         * Reuse citations of `fromRevision` in `toRevision` (all, or only `ids`). New rows point back
         * with carried_from; the originals are untouched. One INSERT … SELECT.
         */
        async carryForward(h, { entityId, fromRevision, toRevision, ids = null, attachedBy = null } = {}) {
            assertEntityId(entityId);
            checkRevisionNumber(toRevision);
            const from = toInt4(fromRevision);
            const wanted = ids ? ids.map(toId).filter((x) => x != null) : null;
            return h.tx(async (t) => {
                await lock(t, entityId);
                await checkTarget(t, entityId, toRevision, { purged: false });
                if (from == null || (wanted && !wanted.length)) return [];
                const rows = await t.many(sql`INSERT INTO ${c$} (${sql.join(COLUMNS.map(sql.ident))})
                    SELECT entity_id, ${toRevision}::integer, anchor, source_item_id, url, title, retrieved_at, quote_text, quote_start, quote_end,
                           license_note, COALESCE(carried_from, id), COALESCE(${attachedBy == null ? null : String(attachedBy)}::text, attached_by), ${clock()}::bigint
                    FROM ${c$}
                    WHERE entity_id = ${entityId} AND revision = ${from}${wanted ? sql` AND id = ANY(${wanted}::bigint[])` : sql``}
                    ORDER BY id
                    RETURNING *`);
                return rows.sort((a, b) => a.id - b.id).map(shape);
            });
        },

        async get(h, id) {
            const n = toId(id);
            return n == null ? null : shape(await h.maybe(sql`SELECT * FROM ${c$} WHERE id = ${n}`));
        },

        async forRevision(h, entityId, revision, { limit = 1000 } = {}) {
            const r = toInt4(revision);
            if (r == null) return [];
            return (await h.many(sql`SELECT * FROM ${c$} WHERE entity_id = ${assertEntityId(entityId)} AND revision = ${r} ORDER BY id LIMIT ${boundedLimit(limit)}`)).map(shape);
        },

        /**
         * The citations of several revisions in one query (feeds, sitemaps, gate facts for a list):
         * refs [{ entityId, revision }] (up to 1000) → an array of citation lists in the same order.
         */
        async forRevisions(h, refs = [], { limit = 10000 } = {}) {
            const keys = revisionRefs(refs).filter((k) => k.number != null);
            const by = new Map();
            if (keys.length) {
                const rows = await h.many(sql`SELECT c.* FROM unnest(${keys.map((k) => k.entityId)}::text[], ${keys.map((k) => k.number)}::integer[]) AS k(entity_id, revision)
                    JOIN ${c$} c ON c.entity_id = k.entity_id AND c.revision = k.revision
                    ORDER BY c.entity_id, c.revision, c.id LIMIT ${boundedLimit(limit, 10000, 10000)}`);
                for (const r of rows) {
                    const key = refKey(r.entity_id, r.revision);
                    if (!by.has(key)) by.set(key, []);
                    by.get(key).push(shape(r));
                }
            }
            return revisionRefs(refs).map((k) => by.get(refKey(k.entityId, k.number)) || []);
        },

        /** Every citation any revision of the entity ever had, oldest revision first. */
        async history(h, entityId, { limit = 1000 } = {}) {
            return (await h.many(sql`SELECT * FROM ${c$} WHERE entity_id = ${assertEntityId(entityId)} ORDER BY revision, id LIMIT ${boundedLimit(limit)}`)).map(shape);
        },

        /**
         * Where a Sources item is cited — for correction/removal propagation (a source changed → revise).
         * Keyset pages: pass the last citation of a page as `after` for the next one.
         */
        async bySourceItem(h, sourceItemId, { limit = 500, after = null } = {}) {
            let cursor = sql``;
            if (after) {
                const id = toId(after.id);
                const rev = toInt4(after.revision);
                if (id == null || rev == null || typeof after.entityId !== 'string') throw new TypeError('after must be a citation from the previous page');
                cursor = sql` AND (entity_id, revision, id) > (${after.entityId}, ${rev}::integer, ${id}::bigint)`;
            }
            return (await h.many(sql`SELECT * FROM ${c$} WHERE source_item_id = ${String(sourceItemId)}${cursor}
                ORDER BY entity_id, revision, id LIMIT ${boundedLimit(limit, 500, 10000)}`)).map(shape);
        },

        /** Audited erasure of every citation of one entity. */
        async purgeEntity(h, entityId, { reason, purgedBy = null } = {}) {
            if (!reason) throw new TypeError('a purge needs a recorded reason');
            assertEntityId(entityId);
            return h.tx(async (t) => {
                await lock(t, entityId);
                await t.exec(sql`INSERT INTO ${p$} (entity_id, reason, purged_by, purged_at) VALUES (${entityId}, ${String(reason)}, ${purgedBy}, ${clock()})
                    ON CONFLICT (entity_id) DO NOTHING`);
                return { deleted: await t.exec(sql`DELETE FROM ${c$} WHERE entity_id = ${entityId}`) };
            });
        },
    };

    const api = bindHandles(db, impl);
    api.table = C;
    api.tables = { citations: C, purges: P };
    api.schema = () => schema(prefix);
    /** Create the tables where the handle may (tests, PGlite); services put schema() in a migration. */
    api.ensureSchema = async () => { await db.query(schema(prefix)); return api; };
    return api;
}

/** Plain facts for the SEO gate: how many citations, and how many name a retrieval time. */
function gateFacts(citations = []) {
    return {
        citationCount: citations.length,
        datedCitationCount: citations.filter((c) => c && c.retrievedAt).length,
    };
}

module.exports = { createCitationStore, schema, gateFacts };
