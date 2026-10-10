'use strict';
/**
 * openvibe-publishing/search-feed — a product's own pages in OpenVibe.Search, for the products whose pages are
 * records rather than publications (listings, job ads, help articles, catalog items, quests). It is the
 * publication glue (sequencer revision → search.index-document@1 → the product's outbox, on the caller's
 * transaction) plus what such a product needs on top: a document described from one row, and a sweep that brings
 * Search level with the table.
 *
 *   const feed = createSearchFeed({
 *       owner: 'rent', db, outbox, baseUrl: config.baseUrl, now: store.now, indexnow,
 *       types: {
 *           listing: {
 *               page: (row) => `/listings/${row.id}`,
 *               document: (row) => ({ listed, noindex, title, summary, body, facets, publishedAt, updatedAt, … }),
 *               rows: (afterId, limit) => …,   // rows with id > afterId, in id order, in EVERY state
 *               exists: (ids) => …,            // the ids of `ids` that still have a row (optional)
 *           },
 *       },
 *   });
 *   await db.tx(async (t) => { …the write…; await feed.sync(t, 'listing', row); });
 *   await db.tx(async (t) => { …the delete…; await feed.remove(t, 'listing', id); });
 *   await feed.sweep();      // → { listing: { seen, sent, removed, failed } }
 *
 * document(row) describes the page:
 *   listed      false → a tombstone (draft, hidden, removed, expired): Search drops its copy
 *   noindex     true → kept in Search but marked noindex, as the page's own robots say
 *   title (required), summary, body, facets, language, publishedAt, updatedAt, expiresAt,
 *   authorship ({ mode: human | ai | hybrid | imported }), provenance (refs, as hooks.buildIndexDocument takes)
 * Every document is visibility public: a feed carries what anyone may read. Indexability follows the page's own
 * robots and expiry, not the publication gate's word counts (a listing is not an article).
 *
 * The sweep re-sends nothing that did not change (the sequencer gives an unchanged document its old revision), so
 * it is safe to run at boot, on a timer and after an ingest; with exists(), ids Search holds whose row is gone get a
 * tombstone. One row is one transaction: a row that fails is counted and logged, and the sweep goes on.
 */
const hooks = require('./index-hooks');
const seo = require('./seo');
const { createPublication } = require('./publication');
const { isHandle, sqlOf } = require('./internal');

const PAGE = 200;
const OWNER_RE = /^[a-z][a-z0-9_]{1,39}$/;
const TYPE_RE = /^[a-z][a-z0-9_]{1,39}$/;
const POLICY = Object.freeze({ minWords: 0 });

function createSearchFeed({
    owner, db, outbox, baseUrl, types, prefix = owner, now = () => Date.now(), indexnow = null, log = console,
    pageSize = PAGE,
} = {}) {
    if (!OWNER_RE.test(String(owner || ''))) throw new TypeError('owner must be the service id, e.g. "rent"');
    if (!isHandle(db)) throw new TypeError('db must be an openvibe-sdk/db handle');
    if (!baseUrl) throw new TypeError('baseUrl is the site origin the pages live on, e.g. https://openvibe.rent');
    if (!types || typeof types !== 'object' || !Object.keys(types).length) throw new TypeError('types maps each document type to { page, document, rows }');
    for (const [type, t] of Object.entries(types)) {
        if (!TYPE_RE.test(type)) throw new TypeError(`type "${type}" must match ${TYPE_RE}`);
        for (const fn of ['page', 'document', 'rows']) if (typeof t[fn] !== 'function') throw new TypeError(`types.${type}.${fn} must be a function`);
        if (t.exists !== undefined && typeof t.exists !== 'function') throw new TypeError(`types.${type}.exists must be a function`);
    }
    const sequencer = hooks.createIndexSequencer(db, { prefix, now });
    const publication = createPublication({ owner, sequencer, outbox, baseUrl, indexnow, db, now });
    const sql = sqlOf(db);
    const seqTable = sql.ident(sequencer.table);

    function typeOf(type) {
        const t = types[type];
        if (!t) throw new TypeError(`unknown document type "${type}" (this feed has ${Object.keys(types).join(', ')})`);
        return t;
    }

    /** The search.index-document@1 for one row (a tombstone when the row is not listed). */
    function documentOf(type, row) {
        const t = typeOf(type);
        const d = t.document(row) || {};
        const id = String(d.id != null ? d.id : row.id);
        if (d.listed === false) return hooks.tombstone({ owner, type, id, revision: 0 });
        const canonicalUrl = publication.abs(t.page(row));
        const facts = { state: 'published', visibility: 'public', canonicalUrl, noindex: Boolean(d.noindex) };
        if (d.expiresAt != null) facts.expiresAt = d.expiresAt;
        const decision = seo.evaluate(facts, { policy: POLICY, now: now() });
        if (!decision.listable) return hooks.tombstone({ owner, type, id, revision: 0 });
        return hooks.buildIndexDocument({
            owner, type, id, revision: 0, state: 'published', visibility: 'public', canonicalUrl,
            title: d.title, summary: d.summary || null, body: d.body || '', facets: d.facets || {},
            language: d.language || null, authorship: d.authorship || null, provenance: d.provenance || [],
            publishedAt: d.publishedAt || null, updatedAt: d.updatedAt || null, decision,
        });
    }

    /** Index one row on the caller's handle (the transaction that wrote it). → the stamped document, or null when nothing was sent. */
    async function sync(t, type, row, { traceparent } = {}) {
        if (!isHandle(t)) throw new TypeError('sync(t, type, row): pass the transaction handle (or db)');
        const doc = documentOf(type, row);
        return await publication.index(t, { document: doc, page: doc.deleted ? null : typeOf(type).page(row), traceparent });
    }

    /** A tombstone for a row that is gone (nothing is sent for an id Search never had). */
    async function remove(t, type, id, { traceparent } = {}) {
        if (!isHandle(t)) throw new TypeError('remove(t, type, id): pass the transaction handle (or db)');
        typeOf(type);
        return await publication.tombstone(t, { type, id: String(id), traceparent });
    }

    async function sweepType(type) {
        const t = typeOf(type);
        const stats = { seen: 0, sent: 0, removed: 0, failed: 0 };
        let after = '';
        for (;;) {
            const rows = await t.rows(after, pageSize);
            if (!rows || !rows.length) break;
            for (const row of rows) {
                stats.seen += 1;
                try {
                    const out = await db.tx(async (h) => await sync(h, type, row));
                    if (out) stats.sent += 1;
                } catch (err) {
                    stats.failed += 1;
                    (log.warn || log.log).call(log, `[search-feed] ${owner} ${type} ${row && row.id}: ${err.message}`);
                }
            }
            const last = rows[rows.length - 1];
            const next = String(last.id);
            if (next <= after) throw new Error(`types.${type}.rows must return rows in id order after the cursor`);
            after = next;
            if (rows.length < pageSize) break;
        }
        if (!t.exists) return stats;
        // Ids Search was given whose row is gone: a tombstone each (an id already tombstoned sends nothing).
        let cursor = '';
        for (;;) {
            const held = (await db.many(sql`SELECT id FROM ${seqTable} WHERE owner = ${owner} AND type = ${type} AND id > ${cursor}
                ORDER BY id LIMIT ${pageSize}`)).map((r) => r.id);
            if (!held.length) break;
            const alive = new Set((await t.exists(held)).map(String));
            for (const id of held) {
                if (alive.has(id)) continue;
                try {
                    const out = await db.tx(async (h) => await remove(h, type, id));
                    if (out) stats.removed += 1;
                } catch (err) {
                    stats.failed += 1;
                    (log.warn || log.log).call(log, `[search-feed] ${owner} ${type} ${id} (tombstone): ${err.message}`);
                }
            }
            cursor = held[held.length - 1];
            if (held.length < pageSize) break;
        }
        return stats;
    }

    let running = null;
    /** Bring Search level with the tables, one type after another. Concurrent calls share one pass. */
    function sweep() {
        if (!running) {
            running = (async () => {
                const out = {};
                for (const type of Object.keys(types)) out[type] = await sweepType(type);
                return out;
            })().finally(() => { running = null; });
        }
        return running;
    }

    return { owner, types: Object.keys(types), sequencer, publication, documentOf, sync, remove, sweep };
}

module.exports = { createSearchFeed };
