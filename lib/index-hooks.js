'use strict';
/**
 * openvibe-publishing/index-hooks — OpenVibe.Search index documents and the events that carry them.
 *
 *   const hooks = require('openvibe-publishing/index-hooks');
 *   const doc = hooks.buildIndexDocument({ owner: 'wiki', type: 'page', id: 'pg_1', revision: 4, state: 'published',
 *       visibility: 'public', canonicalUrl, title, summary, body, facets: { space: 'food' },
 *       authorship: rec, citations, decision });
 *   outbox.enqueue(hooks.indexEvent({ document: doc, actor: 'svc:wiki' }));      // wiki.index_document.upserted|deleted
 *   const action = hooks.actionFor(before, after);                              // product domain event, optional
 *   if (action) outbox.enqueue(hooks.publicationEvent({ product: 'wiki', type: 'page', action, id, revision, actor, document: doc, decision }));
 *
 * Documents follow the released contract `search.index-document@1` (openvibe-contracts ≥ 0.12.0,
 * contracts/search/index-document.v1.json) exactly: { owner, type, id, revision, deleted,
 * visibility, acl, canonical_url, title, summary, body, facets, language, authorship, provenance,
 * publication_state, published_at, updated_at, indexability { decision, reasons } }, and a
 * tombstone is exactly { owner, type, id, revision, deleted: true }.
 *
 * Mapping from this package's vocabulary:
 *   visibility  public → public · unlisted → unlisted (only with includeUnlisted; else a tombstone)
 *               gated → members (acl entitlements/groups/subjects) · private → private (acl.subjects)
 *   authorship  human → human · hybrid → ai_assisted · ai → ai_generated · imported → imported
 *   reasons     the gate's codes, renamed to Search's known reasons where one exists (SEARCH_REASONS)
 *   provenance  Sources items → { service: 'sources', type: 'item', id }; URL-only citations →
 *               the owner's own citation record { service: owner, type: 'citation', id };
 *               the AI run → { service: 'ai', type: 'run', id, stub? }; plus any refs passed in
 *
 * Stricter than the schema requires, on purpose: anything not published (draft, scheduled,
 * unpublished, retracted, archived, deleted) and unlisted content (unless includeUnlisted) is sent
 * as a tombstone, so a state or visibility change always removes the old copy from Search. A
 * private document must name its subjects and a members document its audience — there is no way to
 * build a non-public document that reads as world-visible.
 *
 * Revisions: Search orders by the document's `revision`; at an equal revision a different
 * document is a conflict (first write wins) and a tombstone wins, so the number must grow with
 * EVERY change to what is indexed (content, visibility, state, canonical URL, gate decision), not
 * only with content revisions. createIndexSequencer(db, { prefix }) keeps that counter in the
 * product's database: same document → same revision (a safe replay), anything different → +1.
 *
 * Events: Search consumes `<owner>.index_document.upserted` (payload = the document) and
 * `<owner>.index_document.deleted` (payload = { type, id, revision }), subject { type, id, revision },
 * visibility internal (OpenVibe.Search server/api/webhook.js). Envelopes carry no event_id; the
 * OpenVibe.Events outbox assigns evt_<ULID>. Owners must be slugs without dashes because event
 * types are dot-separated [a-z0-9_] segments.
 */
const OWNER_RE = /^[a-z][a-z0-9_]{1,39}$/; // service slug that is also a valid event_type segment
const TYPE_RE = /^[a-z][a-z0-9_]{1,39}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/;
const PERSON_RE = /^(usr|gst)_[0-9A-HJKMNP-TV-Z]{26}$/;
const KEY_RE = /^[a-z][a-z0-9_.:-]{0,127}$/;
const FACET_RE = /^[a-z][a-z0-9_]{0,39}$/;
const LANG_RE = /^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const REF_SERVICE_RE = /^[a-z][a-z0-9-]{1,39}$/;

const SCHEMA = 'search.index-document@1';
const ACTIONS = ['published', 'updated', 'unpublished', 'deleted'];
const LIMITS = Object.freeze({ title: 500, summary: 4000, body: 48000, facets: 20, facetArray: 50, facetString: 200, provenance: 50, reasons: 20, acl: { subjects: 200, groups: 100, entitlements: 100 } });

const AUTHORSHIP = Object.freeze({ human: 'human', hybrid: 'ai_assisted', ai: 'ai_generated', imported: 'imported' });

/** Gate reason code → Search's known reason (roadmap §32.3 names as listed in the contract). */
const SEARCH_REASONS = Object.freeze({
    deleted: 'deleted',
    private: 'private',
    gated: 'members_only',
    unlisted: 'unlisted',
    draft: 'draft',
    unpublished: 'not_published',
    ai_generated_unreviewed: 'ai_unreviewed',
    stub_provider: 'stub_provider',
    unreviewed_sensitive: 'sensitive_unreviewed',
    thin: 'thin_content',
    unsourced: 'unsourced',
    unsupported_claims: 'unsupported_claims',
    missing_canonical: 'missing_canonical_url',
    noindex_requested: 'owner_decision',
    // no Search equivalent; sent under the gate's own stable code
    takedown: 'takedown',
    retracted: 'retracted',
    expired: 'expired',
    stale_price: 'stale_price',
    duplicate_of: 'duplicate_of',
});

const clip = (s, max) => {
    const t = String(s == null ? '' : s);
    return t.length > max ? t.slice(0, max) : t;
};

function iso(v, name) {
    if (v == null || v === '') return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new TypeError(`${name} must be a valid date`);
    return d.toISOString();
}

function checkIdentity({ owner, type, id, revision }) {
    if (!OWNER_RE.test(String(owner || ''))) throw new TypeError('owner must be a service slug of [a-z0-9_] (it prefixes event types)');
    if (!TYPE_RE.test(String(type || ''))) throw new TypeError('type must match ^[a-z][a-z0-9_]{1,39}$');
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new TypeError('id must match ^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$');
    if (!Number.isInteger(revision) || revision < 0) throw new TypeError('revision must be a non-negative integer');
}

/** The gate decision as Search's indexability { decision, reasons }. */
function searchIndexability(decision) {
    if (!decision || typeof decision.indexable !== 'boolean' || typeof decision.listable !== 'boolean') throw new TypeError('decision (seo.evaluate) is required');
    const codes = Array.isArray(decision.codes) ? decision.codes : [];
    const reasons = [...new Set(codes.map((c) => SEARCH_REASONS[c] || c))].slice(0, LIMITS.reasons);
    return { decision: decision.indexable ? 'index' : 'noindex', reasons };
}

function uniqueKeys(list, re, max, what) {
    const out = [...new Set((list || []).map(String))];
    if (out.length > max) throw new TypeError(`acl.${what} holds at most ${max} entries`);
    for (const k of out) if (!re.test(k)) throw new TypeError(`acl.${what} entry "${k}" is not valid`);
    return out;
}

function checkFacets(facets) {
    const entries = Object.entries(facets || {}).filter(([, v]) => v != null);
    if (entries.length > LIMITS.facets) throw new TypeError(`at most ${LIMITS.facets} facets`);
    const out = {};
    for (const [k, v] of entries) {
        if (!FACET_RE.test(k)) throw new TypeError(`facet name "${k}" must match ${FACET_RE}`);
        if (Array.isArray(v)) {
            if (v.length > LIMITS.facetArray) throw new TypeError(`facet "${k}" holds at most ${LIMITS.facetArray} values`);
            if (!v.every((x) => typeof x === 'string')) throw new TypeError(`facet "${k}": arrays must hold strings`);
            out[k] = v.map((x) => clip(x, LIMITS.facetString));
        } else if (typeof v === 'string') out[k] = clip(v, LIMITS.facetString);
        else if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
        else throw new TypeError(`facet "${k}" must be a string, number, boolean or an array of strings`);
    }
    return out;
}

function httpUrl(u) {
    if (!u) return null;
    try { const x = new URL(String(u)); return x.protocol === 'http:' || x.protocol === 'https:' ? x.toString() : null; } catch { return null; }
}

/**
 * Provenance references from citations (citations store rows), the authorship record and extra refs
 * ([{ service, type, id, revision?, label?, url?, retrievedAt?, stub? }]).
 */
function buildProvenance(owner, { citations = [], authorship = null, refs = [] } = {}) {
    const out = [];
    const push = (r) => {
        const o = { service: r.service, type: r.type, id: clip(r.id, 128) };
        if (!REF_SERVICE_RE.test(o.service) || !TYPE_RE.test(o.type) || !o.id) throw new TypeError(`invalid provenance reference ${JSON.stringify(r)}`);
        if (Number.isInteger(r.revision) && r.revision >= 0) o.revision = r.revision;
        if (r.label) o.label = clip(r.label, 200);
        const url = httpUrl(r.url);
        if (url) o.url = url;
        const at = iso(r.retrievedAt, 'retrievedAt');
        if (at) o.retrieved_at = at;
        if (r.stub === true) o.stub = true;
        out.push(o);
    };
    if (authorship && authorship.workflow) push({ service: 'ai', type: 'run', id: authorship.workflow.runId, label: authorship.workflow.id, stub: Boolean(authorship.stubProvider) });
    for (const c of citations) {
        if (!c) continue;
        if (c.sourceItemId) push({ service: 'sources', type: 'item', id: c.sourceItemId, label: c.title, url: c.url, retrievedAt: c.retrievedAt });
        else if (c.url && c.id != null) push({ service: owner.replace(/_/g, '-'), type: 'citation', id: String(c.id), label: c.title, url: c.url, retrievedAt: c.retrievedAt });
    }
    for (const r of refs) push(r);
    if (out.length > LIMITS.provenance) throw new TypeError(`at most ${LIMITS.provenance} provenance references`);
    return out;
}

/** The deletion marker: removes (owner, type, id) at this revision or older from every result. */
function tombstone({ owner, type, id, revision }) {
    checkIdentity({ owner, type, id, revision });
    return { owner, type, id, revision, deleted: true };
}

/**
 * The Search document for one revision, or a tombstone when the resource must not be in Search.
 * state: draft | scheduled | published | unpublished | retracted | archived | deleted
 * visibility: public | unlisted | gated | private
 */
function buildIndexDocument({
    owner, type, id, revision, state, visibility, acl = {}, canonicalUrl, title, summary = null, body = '',
    facets = {}, authorship = null, citations = [], provenance = [], decision, publishedAt = null, updatedAt = null,
    language = null, deleted = false, includeUnlisted = false,
} = {}) {
    checkIdentity({ owner, type, id, revision });
    if (deleted || state !== 'published' || (visibility === 'unlisted' && !includeUnlisted)) return tombstone({ owner, type, id, revision });

    const doc = { owner, type, id, revision, deleted: false };
    if (visibility === 'public') {
        doc.visibility = 'public';
    } else if (visibility === 'unlisted') {
        doc.visibility = 'unlisted';
        const subjects = uniqueKeys(acl.subjects, PERSON_RE, LIMITS.acl.subjects, 'subjects');
        if (subjects.length) doc.acl = { subjects };
    } else if (visibility === 'private') {
        const subjects = uniqueKeys(acl.subjects, PERSON_RE, LIMITS.acl.subjects, 'subjects');
        if (!subjects.length) throw new TypeError('private documents need acl.subjects (usr_/gst_ ids)');
        doc.visibility = 'private';
        doc.acl = { subjects };
    } else if (visibility === 'gated' || visibility === 'members') {
        const a = {
            subjects: uniqueKeys(acl.subjects, PERSON_RE, LIMITS.acl.subjects, 'subjects'),
            groups: uniqueKeys(acl.groups, KEY_RE, LIMITS.acl.groups, 'groups'),
            entitlements: uniqueKeys(acl.entitlements, KEY_RE, LIMITS.acl.entitlements, 'entitlements'),
        };
        for (const k of Object.keys(a)) if (!a[k].length) delete a[k];
        if (!Object.keys(a).length) throw new TypeError('gated (members) documents need acl.entitlements, acl.groups or acl.subjects');
        doc.visibility = 'members';
        doc.acl = a;
    } else {
        throw new TypeError('visibility must be public, unlisted, gated or private');
    }

    const url = httpUrl(canonicalUrl);
    if (!url) throw new TypeError('canonicalUrl must be an absolute http(s) URL');
    if (!title) throw new TypeError('title is required');
    doc.canonical_url = url;
    doc.title = clip(title, LIMITS.title);
    if (summary != null && summary !== '') doc.summary = clip(summary, LIMITS.summary);
    doc.body = clip(body, LIMITS.body);
    doc.facets = checkFacets(facets);
    if (language) {
        if (!LANG_RE.test(language)) throw new TypeError('language must be a BCP 47 tag');
        doc.language = language;
    }
    if (authorship) {
        if (!AUTHORSHIP[authorship.mode]) throw new TypeError('authorship.mode must be human, ai, hybrid or imported');
        doc.authorship = AUTHORSHIP[authorship.mode];
    }
    doc.provenance = buildProvenance(owner, { citations, authorship, refs: provenance });
    doc.publication_state = 'published';
    doc.published_at = iso(publishedAt, 'publishedAt');
    doc.updated_at = iso(updatedAt, 'updatedAt');
    doc.indexability = searchIndexability(decision);
    return doc;
}

/**
 * Monotonic index revisions per resource, in <prefix>_index_revisions of the product's database.
 *   const seq = createIndexSequencer(db, { prefix: 'wiki' });
 *   const doc = seq.stamp(hooks.buildIndexDocument({ ..., revision: 0 }));   // revision replaced
 */
function createIndexSequencer(db, { prefix, now } = {}) {
    const { assertDb, assertPrefix, clockOf, sha256, stableStringify } = require('./internal');
    assertDb(db);
    assertPrefix(prefix);
    const clock = clockOf(now);
    const T = `${prefix}_index_revisions`;
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${T} (
            owner      TEXT NOT NULL,
            type       TEXT NOT NULL,
            id         TEXT NOT NULL,
            revision   INTEGER NOT NULL,
            hash       TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (owner, type, id)
        );
    `);
    const get = db.prepare(`SELECT revision, hash FROM ${T} WHERE owner = ? AND type = ? AND id = ?`);
    const put = db.prepare(`INSERT INTO ${T} (owner, type, id, revision, hash, updated_at) VALUES (@owner, @type, @id, @revision, @hash, @now)
                            ON CONFLICT (owner, type, id) DO UPDATE SET revision = excluded.revision, hash = excluded.hash, updated_at = excluded.updated_at`);
    return {
        table: T,
        /** The document with its revision set: unchanged → the last revision, changed → last + 1. */
        stamp(document) {
            checkIdentity(document);
            const { revision: _ignored, ...rest } = document;
            const hash = sha256(stableStringify(rest));
            return db.transaction(() => {
                const cur = get.get(document.owner, document.type, document.id);
                if (cur && cur.hash === hash) return { ...document, revision: cur.revision };
                const revision = Math.max(cur ? cur.revision + 1 : 1, document.revision);
                put.run({ owner: document.owner, type: document.type, id: document.id, revision, hash, now: clock() });
                return { ...document, revision };
            })();
        },
        current(owner, type, id) { const r = get.get(owner, type, id); return r ? r.revision : null; },
    };
}

/** 'usr_…' | 'svc:wiki' | 'service:wiki' | { type, id } → SubjectRef. */
function subjectRef(actor) {
    if (actor && typeof actor === 'object') return { type: actor.type, id: actor.id };
    const s = String(actor || '');
    if (/^svc:/.test(s)) return { type: 'service', id: s.slice(4) };
    const m = s.match(/^(user|guest|service|system|app|mod):(.+)$/);
    if (m) return { type: m[1], id: m[2] };
    if (/^usr_/.test(s)) return { type: 'user', id: s };
    if (/^gst_/.test(s)) return { type: 'guest', id: s };
    throw new TypeError('actor must be a subject (usr_…, gst_…, svc:<service>) or a SubjectRef');
}

function envelope({ source, eventType, actor, now, subject, payload, visibility, traceId, eventId }) {
    const env = {
        event_type: eventType,
        version: 1,
        source,
        actor: subjectRef(actor),
        timestamp: new Date(now).toISOString(),
        visibility,
        subject,
        payload,
    };
    if (eventId) env.event_id = eventId;
    if (traceId && /^[0-9a-f]{32}$/.test(traceId)) env.trace_id = traceId;
    return env;
}

/**
 * The event OpenVibe.Search consumes for a document or tombstone:
 * `<owner>.index_document.upserted` (payload = document) or `.deleted` (payload = { type, id, revision }).
 * actor defaults to the owner service itself.
 */
function indexEvent({ document, actor = null, now = Date.now(), traceId = null, eventId = null } = {}) {
    if (!document || typeof document !== 'object') throw new TypeError('document (buildIndexDocument/tombstone) is required');
    checkIdentity(document);
    const { owner, type, id, revision } = document;
    const deleted = document.deleted === true;
    return envelope({
        source: owner,
        eventType: `${owner}.index_document.${deleted ? 'deleted' : 'upserted'}`,
        actor: actor || { type: 'service', id: owner.replace(/_/g, '-') },
        now, traceId, eventId,
        subject: { type, id, revision },
        visibility: 'internal',
        payload: deleted ? { type, id, revision } : document,
    });
}

/**
 * Which product event a transition produces. before/after: { state, visibility, revision }
 * (before may be null for a new resource). → 'published' | 'updated' | 'unpublished' | 'deleted' | null
 */
function actionFor(before, after) {
    const was = Boolean(before && before.state === 'published');
    if (after.state === 'deleted') return before && before.state === 'deleted' ? null : (before ? 'deleted' : null);
    const is = after.state === 'published';
    if (!was && is) return 'published';
    if (was && !is) return 'unpublished';
    if (was && is && (before.revision !== after.revision || before.visibility !== after.visibility)) return 'updated';
    return null;
}

/**
 * The product's own domain event `<product>.<type>.<action>` (e.g. wiki.page.published), for
 * subscribers other than Search. Payload: canonical URL, publication state, Search-shaped
 * indexability — not the body (Search gets that through indexEvent). Public only when the
 * resource is public and the gate lets it be listed; otherwise internal.
 */
function publicationEvent({ product, type, action, id, revision, actor, document, decision = null, now = Date.now(), traceId = null, eventId = null, extra = {} } = {}) {
    if (!OWNER_RE.test(String(product || ''))) throw new TypeError('product must be a service slug of [a-z0-9_], e.g. "wiki"');
    if (!TYPE_RE.test(String(type || ''))) throw new TypeError('type must match ^[a-z][a-z0-9_]{1,39}$');
    if (!ACTIONS.includes(action)) throw new TypeError(`action must be one of ${ACTIONS.join(', ')}`);
    if (!document || document.id !== id) throw new TypeError('document (buildIndexDocument/tombstone) for this resource is required');
    const removal = action === 'deleted' || action === 'unpublished';
    if (action === 'published' && document.deleted) throw new TypeError('published events carry a published document');
    if (removal && !document.deleted) throw new TypeError(`${action} events carry a tombstone`);
    const isPublic = !document.deleted && document.visibility === 'public' && Boolean(decision && decision.listable);
    return envelope({
        source: product,
        eventType: `${product}.${type}.${action}`,
        actor, now, traceId, eventId,
        subject: { type, id, revision },
        visibility: isPublic ? 'public' : 'internal',
        payload: {
            canonical_url: document.canonical_url || null,
            publication_state: document.deleted ? (action === 'deleted' ? 'deleted' : 'unpublished') : document.publication_state,
            indexability: document.indexability || (decision ? searchIndexability(decision) : null),
            ...extra,
        },
    });
}

module.exports = {
    SCHEMA, ACTIONS, AUTHORSHIP, SEARCH_REASONS, LIMITS,
    buildIndexDocument, tombstone, searchIndexability, createIndexSequencer, buildProvenance, indexEvent, actionFor, publicationEvent, subjectRef,
};
