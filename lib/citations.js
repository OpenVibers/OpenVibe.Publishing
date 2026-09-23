'use strict';
/**
 * openvibe-publishing/citations — source references attached to one specific revision.
 *
 *   const { createCitationStore } = require('openvibe-publishing/citations');
 *   const cites = createCitationStore(db, { prefix: 'wiki', revisions });   // wiki_citations
 *   cites.attach({ entityId: 'pg_1', revision: 2, url: 'https://example.org/a', retrievedAt: '2026-09-20T10:00:00Z',
 *                  quote: { text: '…', start: 120, end: 180 }, licenseNote: 'CC BY 4.0', sourceItemId: 'src_…' });
 *   cites.carryForward({ entityId: 'pg_1', fromRevision: 2, toRevision: 3 });  // reuse in r3
 *   cites.forRevision('pg_1', 2);   // still there after r3 dropped them
 *
 * Rules:
 *   - A citation belongs to (entity, revision). It is never dropped: the table is append-only
 *     (UPDATE and DELETE abort in SQLite triggers), so a later revision that does not reuse a
 *     source leaves the earlier revision's citations intact. Only purgeEntity (audited) removes rows.
 *   - Every citation names a source: a Sources item id, an http(s) URL, or both.
 *   - Nothing is filled in: a missing retrieved_at, title or license note stays null. This module
 *     never stamps "now" as a retrieval time.
 *   - If a revisions store is passed, attach() refuses revisions that do not exist.
 */
const { PublishingError, assertDb, assertPrefix, clockOf, assertEntityId, assertRevisionNumber, isoOrNull, immutableTriggers } = require('./internal');

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
        retrievedAt: row.retrieved_at,
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
    if (start != null && (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start)) throw new TypeError('quote span must be 0 <= start <= end');
    if (text == null && start == null) return { text: null, start: null, end: null };
    return { text, start, end };
}

function createCitationStore(db, { prefix, now, revisions = null } = {}) {
    assertDb(db);
    assertPrefix(prefix);
    const clock = clockOf(now);
    const C = `${prefix}_citations`;
    const P = `${prefix}_citation_purges`;

    db.exec(`
        CREATE TABLE IF NOT EXISTS ${C} (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_id      TEXT NOT NULL,
            revision       INTEGER NOT NULL CHECK (revision >= 1),
            anchor         TEXT,
            source_item_id TEXT,
            url            TEXT,
            title          TEXT,
            retrieved_at   TEXT,
            quote_text     TEXT,
            quote_start    INTEGER,
            quote_end      INTEGER,
            license_note   TEXT,
            carried_from   INTEGER REFERENCES ${C}(id),
            attached_by    TEXT,
            attached_at    INTEGER NOT NULL,
            CHECK (source_item_id IS NOT NULL OR url IS NOT NULL)
        );
        CREATE INDEX IF NOT EXISTS ${C}_rev ON ${C} (entity_id, revision);
        CREATE INDEX IF NOT EXISTS ${C}_source ON ${C} (source_item_id);
        CREATE TABLE IF NOT EXISTS ${P} (
            entity_id TEXT PRIMARY KEY,
            reason    TEXT NOT NULL,
            purged_by TEXT,
            purged_at INTEGER NOT NULL
        );
        ${immutableTriggers(C, P)}
    `);

    const q = {
        insert: db.prepare(`INSERT INTO ${C} (entity_id, revision, anchor, source_item_id, url, title, retrieved_at, quote_text, quote_start, quote_end, license_note, carried_from, attached_by, attached_at)
                            VALUES (@entity_id, @revision, @anchor, @source_item_id, @url, @title, @retrieved_at, @quote_text, @quote_start, @quote_end, @license_note, @carried_from, @attached_by, @attached_at)`),
        byId: db.prepare(`SELECT * FROM ${C} WHERE id = ?`),
        forRevision: db.prepare(`SELECT * FROM ${C} WHERE entity_id = ? AND revision = ? ORDER BY id`),
        history: db.prepare(`SELECT * FROM ${C} WHERE entity_id = ? ORDER BY revision, id`),
        bySource: db.prepare(`SELECT * FROM ${C} WHERE source_item_id = ? ORDER BY entity_id, revision, id`),
        purged: db.prepare(`SELECT 1 FROM ${P} WHERE entity_id = ?`),
    };

    function checkRevision(entityId, revision) {
        assertRevisionNumber(revision, 'revision');
        if (revision < 1) throw new TypeError('revision must be >= 1');
        if (revisions && !revisions.get(entityId, revision)) throw new PublishingError(404, 'revision.not_found', `No revision ${revision} of ${entityId}`);
    }

    function insert(entityId, revision, c, carriedFrom = null) {
        const sourceItemId = c.sourceItemId == null || c.sourceItemId === '' ? null : String(c.sourceItemId).slice(0, 128);
        const url = checkUrl(c.url);
        if (!sourceItemId && !url) throw new PublishingError(400, 'citation.no_source', 'A citation needs a Sources item id or an http(s) URL');
        const quote = checkQuote(c.quote);
        const row = {
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
            attached_at: clock(),
        };
        return shape(q.byId.get(q.insert.run(row).lastInsertRowid));
    }

    const api = {
        table: C,

        /** Attach one citation to (entityId, revision). */
        attach({ entityId, revision, ...citation } = {}) {
            assertEntityId(entityId);
            checkRevision(entityId, revision);
            if (q.purged.get(entityId)) throw new PublishingError(410, 'entity.purged', `${entityId} was purged`);
            return insert(entityId, revision, citation);
        },

        /** Attach several in one transaction. */
        attachMany(entityId, revision, list = []) {
            assertEntityId(entityId);
            checkRevision(entityId, revision);
            if (q.purged.get(entityId)) throw new PublishingError(410, 'entity.purged', `${entityId} was purged`);
            return db.transaction(() => list.map((c) => insert(entityId, revision, c)))();
        },

        /**
         * Reuse citations of `fromRevision` in `toRevision` (all, or only `ids`). New rows point back
         * with carried_from; the originals are untouched.
         */
        carryForward({ entityId, fromRevision, toRevision, ids = null, attachedBy = null } = {}) {
            assertEntityId(entityId);
            checkRevision(entityId, toRevision);
            return db.transaction(() => {
                const wanted = ids ? new Set(ids.map(Number)) : null;
                return q.forRevision.all(entityId, fromRevision)
                    .filter((r) => !wanted || wanted.has(r.id))
                    .map((r) => {
                        const c = shape(r);
                        return insert(entityId, toRevision, { ...c, attachedBy: attachedBy || c.attachedBy }, r.carried_from || r.id);
                    });
            })();
        },

        get(id) { return shape(q.byId.get(Number(id))); },
        forRevision(entityId, revision) { return q.forRevision.all(assertEntityId(entityId), revision).map(shape); },
        /** Every citation any revision of the entity ever had, oldest revision first. */
        history(entityId) { return q.history.all(assertEntityId(entityId)).map(shape); },
        /** Where a Sources item is cited — for correction/removal propagation (a source changed → revise). */
        bySourceItem(sourceItemId) { return q.bySource.all(String(sourceItemId)).map(shape); },

        /** Audited erasure of every citation of one entity. */
        purgeEntity(entityId, { reason, purgedBy = null } = {}) {
            if (!reason) throw new TypeError('a purge needs a recorded reason');
            return db.transaction(() => {
                db.prepare(`INSERT OR IGNORE INTO ${P} (entity_id, reason, purged_by, purged_at) VALUES (?, ?, ?, ?)`).run(assertEntityId(entityId), String(reason), purgedBy, clock());
                return { deleted: db.prepare(`DELETE FROM ${C} WHERE entity_id = ?`).run(entityId).changes };
            })();
        },
    };
    return api;
}

/** Plain facts for the SEO gate: how many citations, and how many name a retrieval time. */
function gateFacts(citations = []) {
    return {
        citationCount: citations.length,
        datedCitationCount: citations.filter((c) => c && c.retrievedAt).length,
    };
}

module.exports = { createCitationStore, gateFacts };
