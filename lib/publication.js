'use strict';
/**
 * openvibe-publishing/publication — the shared publication glue: gate decision → index document →
 * sequencer.stamp → events → outbox.enqueue, plus the IndexNow ping. It is the half the five content
 * products each re-implement (News domain/publication.js, Reviews service.js, Deals domain/indexing.js,
 * Coupons domain/publication.js, Trade domain/indexing.js).
 *
 *   const publication = createPublication({
 *       owner: 'deals', baseUrl: config.baseUrl, sequencer: store.sequencer, outbox,
 *       indexnow,                                     // optional { enabled, pingSoon([urls]) }
 *       decide: (offer, now) => publication.decideOffer(offer),   // the product's gate facts
 *       document: (offer, decision) => offerDocument(offer),      // hooks.buildIndexDocument/tombstone
 *       page: (offer) => `/d/${offer.slug}`,
 *   });
 *   await db.tx(async (t) => {
 *       await t.exec(sql`UPDATE deal_offers SET … WHERE id = ${id}`);
 *       await publication.sync(t, offer);              // stamps + enqueues in the SAME transaction
 *   });
 *
 * What stays per product: the gate facts, the facets, the document body and the domain tables. This
 * module only owns the mechanics — the sequencer revision, the two events, the outbox write and the
 * IndexNow ping — and it always writes them on the CALLER's transaction handle, so an index document,
 * its event and the product's own change commit or roll back together (ADR-004).
 *
 * Events are exactly what OpenVibe.Search consumes: `search.index-document@1` carried by
 * `<owner>.index_document.upserted|deleted` (openvibe-publishing/index-hooks), and the product's own
 * `<owner>.<type>.<action>` publication events. Nothing non-listable is ever sent as a document: it is
 * a tombstone, so a state or visibility change always removes the old copy from Search. A resource
 * that was never indexed gets no tombstone.
 */
const seo = require('./seo');
const hooks = require('./index-hooks');
const { isHandle } = require('./internal');

const OWNER_RE = /^[a-z][a-z0-9_]{1,39}$/;

/** outbox.enqueue(t, envelope, { traceparent }) is the SDK's pg outbox; emitIn is the service kit's. */
function writerOf(outbox) {
    if (outbox && typeof outbox.enqueue === 'function') return (t, env, opts) => outbox.enqueue(t, env, opts);
    if (outbox && typeof outbox.emitIn === 'function') return (t, env, opts) => outbox.emitIn(t, env, opts);
    throw new TypeError('createPublication needs an outbox with enqueue(t, envelope) (or emitIn)');
}

/**
 * The product's publication factory. `sequencer` is openvibe-publishing/index-hooks'
 * createIndexSequencer (its stamp(t, doc) takes the caller's handle); `outbox` is the SDK's pg outbox
 * (or the service kit's). `decide`/`document`/`page` are the product's gate, document builder and
 * canonical path.
 */
function createPublication({
    owner, sequencer, outbox, baseUrl = null, indexnow = null, db = null,
    now = () => Date.now(), decide = null, document = null, page = null,
} = {}) {
    if (!OWNER_RE.test(String(owner || ''))) throw new TypeError('owner must be a service slug of [a-z0-9_], e.g. "deals"');
    if (!sequencer || typeof sequencer.stamp !== 'function' || typeof sequencer.current !== 'function') {
        throw new TypeError('sequencer must be openvibe-publishing/index-hooks createIndexSequencer');
    }
    const enqueue = writerOf(outbox);
    const clock = () => {
        const t = Number(now());
        if (!Number.isFinite(t)) throw new TypeError('now() must return epoch milliseconds');
        return t;
    };
    const abs = (p) => (baseUrl ? seo.canonicalUrl(baseUrl, p) : p);

    /**
     * Stamp and enqueue one document on the caller's transaction handle. The revision is the sequencer's
     * (same document → same revision → no event). Never-indexed tombstones send nothing.
     */
    async function index(t, { document: doc, page: pagePath = null, traceparent } = {}) {
        if (!isHandle(t)) throw new TypeError('index(t, …): pass the transaction handle db.tx gives you (or db)');
        if (!doc || typeof doc !== 'object') throw new TypeError('index needs a document (buildIndexDocument/tombstone)');
        const current = await sequencer.current(t, owner, doc.type, doc.id);
        if (doc.deleted && current == null) return null;                 // never indexed: nothing to remove
        const stamped = await sequencer.stamp(t, doc);
        if (current != null && stamped.revision === current) return null;   // unchanged: no event
        await enqueue(t, hooks.indexEvent({ document: stamped, now: clock() }), { traceparent });
        // IndexNow: an indexable page appeared or changed, or a page Search already had went away.
        // A draft, private or noindex page never pings. pingSoon never throws and is a no-op without a key.
        if (indexnow && indexnow.enabled && pagePath) {
            const indexable = !stamped.deleted && stamped.indexability && stamped.indexability.decision === 'index';
            const removed = stamped.deleted && current != null;
            if (indexable || removed) indexnow.pingSoon([abs(pagePath), abs('/sitemap.xml')]);
        }
        return stamped;
    }

    /** A tombstone for (type, id): sends nothing when the resource was never indexed. */
    async function tombstone(t, { type, id, page: pagePath = null, traceparent } = {}) {
        return await index(t, { document: hooks.tombstone({ owner, type, id, revision: 0 }), page: pagePath, traceparent });
    }

    /** The product event `<owner>.<type>.<action>` for a transition, on the caller's transaction handle. */
    async function publication(t, { type, action, id, revision, document: doc, decision = null, actor = null, extra = {}, traceparent } = {}) {
        if (!isHandle(t)) throw new TypeError('publication(t, …): pass the transaction handle db.tx gives you (or db)');
        const env = hooks.publicationEvent({ product: owner, type, action, id, revision, actor, document: doc, decision, now: clock(), extra });
        await enqueue(t, env, { traceparent });
        return env;
    }

    /**
     * gate → document → stamp → event → outbox, on the caller's handle: the whole chain for one entity,
     * when the product supplied decide/document. `forSearch` is passed to document() so a product can
     * render a full document for its own events and a tombstone for Search.
     */
    async function sync(t, entity, { traceparent, forSearch = true } = {}) {
        if (typeof decide !== 'function' || typeof document !== 'function') throw new TypeError('sync needs decide(entity, now) and document(entity, decision, now)');
        const decision = await decide(entity, clock());
        const doc = await document(entity, decision, clock(), { forSearch });
        return await index(t, { document: doc, page: page ? page(entity) : null, traceparent });
    }

    return { owner, db, sequencer, outbox, indexnow, abs, index, tombstone, publication, sync };
}

module.exports = { createPublication };
