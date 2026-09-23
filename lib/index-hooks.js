'use strict';
/**
 * openvibe-publishing/index-hooks — Search index documents and publication event envelopes.
 *
 *   const hooks = require('openvibe-publishing/index-hooks');
 *   const doc = hooks.buildIndexDocument({ service: 'wiki', type: 'page', id: 'pg_1', revision: 4, state: 'published',
 *       visibility: 'public', canonicalUrl, title, summary, body, facets: { space: 'food' }, provenance, decision });
 *   const action = hooks.actionFor(before, after);                  // 'published' | 'updated' | 'unpublished' | 'deleted' | null
 *   const env = hooks.publicationEvent({ product: 'wiki', type: 'page', action, id: 'pg_1', revision: 4,
 *       actor: 'usr_…', document: doc, decision, now: Date.now() });
 *   outbox.enqueue(env);   // OpenVibe.Events createOutbox, in the same transaction as the product's change
 *
 * The index document is the Search contract of [REF] §12.3 (owner service, resource type/id,
 * revision, visibility + ACL, canonical URL, title, summary, body, facets, provenance, publication
 * state, deletion marker) plus the gate's indexability decision. Proposed schema:
 * docs/contracts-proposal/search.index-document.v1.json.
 *
 * Safety rules built in:
 *   - Anything not published, deleted, or unlisted becomes a tombstone (deletion marker, no
 *     title/summary/body), so a visibility change or deletion removes content from the index.
 *   - private content must carry an ACL naming subjects; gated content must name entitlements.
 *     There is no way to build a private document that reads as world-visible.
 *   - Events about non-public or non-listable content are 'internal', never 'public'.
 *   - The envelope carries no event_id; the outbox assigns evt_<ULID> (or pass eventId).
 */
const SERVICE_RE = /^[a-z][a-z0-9-]{1,39}$/;
const SEGMENT_RE = /^[a-z][a-z0-9_]{0,39}$/;
const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const SUBJECT_ID_RE = new RegExp(`^(usr|gst|app|mod)_${ULID}$`);
const ACTIONS = ['published', 'updated', 'unpublished', 'deleted'];
const SCHEMA = 'search.index-document@1';
const MAX_BODY = 100000;

function assertDecision(d) {
    if (!d || typeof d.indexable !== 'boolean' || typeof d.listable !== 'boolean') throw new TypeError('decision (seo.evaluate) is required');
    return { indexable: d.indexable, listable: d.listable, reasons: Array.isArray(d.codes) ? [...d.codes] : [], gate: d.gate || null };
}

function iso(v, name) {
    if (v == null || v === '') return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new TypeError(`${name} must be a valid date`);
    return d.toISOString();
}

function checkFacets(facets) {
    const out = {};
    for (const [k, v] of Object.entries(facets || {})) {
        if (!SEGMENT_RE.test(k)) throw new TypeError(`facet name "${k}" must match ${SEGMENT_RE}`);
        if (v == null) continue;
        const ok = (x) => typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x));
        if (Array.isArray(v) ? !v.every(ok) : !ok(v)) throw new TypeError(`facet "${k}" must be a string, number, boolean or an array of them`);
        out[k] = Array.isArray(v) ? [...v] : v;
    }
    return out;
}

function checkProvenance(p = {}) {
    const out = {};
    if (p.authorship) {
        out.authorship = { mode: p.authorship.mode };
        if (p.authorship.workflow) out.authorship.workflow = { id: p.authorship.workflow.id, run_id: p.authorship.workflow.runId };
        if (p.authorship.reviewed != null) out.authorship.reviewed = Boolean(p.authorship.reviewed);
    }
    if (Array.isArray(p.citations)) {
        out.citations = p.citations.map((c) => {
            const o = {};
            if (c.sourceItemId) o.source_item_id = String(c.sourceItemId);
            if (c.url) o.url = String(c.url);
            if (c.retrievedAt) o.retrieved_at = iso(c.retrievedAt, 'citation.retrievedAt');
            if (c.licenseNote) o.license_note = String(c.licenseNote);
            return o;
        }).filter((o) => o.source_item_id || o.url);
    }
    if (p.derivedFrom) out.derived_from = p.derivedFrom;
    return out;
}

function checkIdentity({ service, type, id, revision }) {
    if (!SERVICE_RE.test(String(service || ''))) throw new TypeError('service must be a service slug');
    if (!SEGMENT_RE.test(String(type || ''))) throw new TypeError('type must match ^[a-z][a-z0-9_]{0,39}$');
    if (typeof id !== 'string' || !id || id.length > 200) throw new TypeError('id must be a non-empty string');
    if (!Number.isInteger(revision) || revision < 0) throw new TypeError('revision must be a non-negative integer');
}

/** A deletion marker: Search removes (resource, revision ≤ this) and caches purge it. */
function tombstone({ service, type, id, revision, state = 'deleted', updatedAt = null }) {
    checkIdentity({ service, type, id, revision });
    return {
        schema: SCHEMA, owner_service: service, resource_type: type, resource_id: id, revision,
        publication_state: state, deleted: true, updated_at: iso(updatedAt, 'updatedAt'),
    };
}

/**
 * Build the Search document for a revision. Non-published, deleted and unlisted resources come
 * back as tombstones.
 */
function buildIndexDocument({
    service, type, id, revision, state, visibility, acl = {}, canonicalUrl, title, summary = null, body = '',
    facets = {}, provenance = {}, decision, publishedAt = null, updatedAt = null, locale = null, deleted = false,
} = {}) {
    checkIdentity({ service, type, id, revision });
    if (deleted || state !== 'published' || visibility === 'unlisted') {
        return tombstone({ service, type, id, revision, state: deleted ? 'deleted' : state || 'deleted', updatedAt });
    }
    const indexability = assertDecision(decision);
    let docAcl;
    if (visibility === 'public') docAcl = { public: true };
    else if (visibility === 'private') {
        const subjects = (acl.subjects || []).map(String);
        if (!subjects.length || !subjects.every((s) => SUBJECT_ID_RE.test(s))) throw new TypeError('private documents need acl.subjects (usr_/gst_/app_/mod_ ids)');
        docAcl = { public: false, subjects };
    } else if (visibility === 'gated') {
        const entitlements = (acl.entitlements || []).map(String).filter(Boolean);
        if (!entitlements.length) throw new TypeError('gated documents need acl.entitlements');
        docAcl = { public: false, entitlements, ...(acl.subjects && acl.subjects.length ? { subjects: acl.subjects.map(String) } : {}) };
    } else {
        throw new TypeError('visibility must be public, private, gated or unlisted');
    }
    if (!canonicalUrl || !/^https?:\/\//.test(canonicalUrl)) throw new TypeError('canonicalUrl must be absolute');
    if (!title) throw new TypeError('title is required');
    const text = String(body == null ? '' : body);
    const doc = {
        schema: SCHEMA, owner_service: service, resource_type: type, resource_id: id, revision,
        visibility, acl: docAcl, canonical_url: canonicalUrl, title: String(title),
        summary: summary == null ? null : String(summary), body: text.slice(0, MAX_BODY),
        facets: checkFacets(facets), provenance: checkProvenance(provenance),
        publication_state: 'published', deleted: false, indexability,
        published_at: iso(publishedAt, 'publishedAt'), updated_at: iso(updatedAt, 'updatedAt'),
    };
    if (text.length > MAX_BODY) doc.body_truncated = true;
    if (locale) doc.locale = String(locale);
    return doc;
}

/**
 * Which publication event a transition produces. before/after: { state, visibility, revision }
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

/**
 * `<product>.<type>.<action>` envelope (contracts events/event-envelope@1) for the product's outbox.
 * document: the index document (or tombstone) for this revision — it becomes the payload.
 */
function publicationEvent({ product, type, action, id, revision, actor, document, decision = null, now = Date.now(), traceId = null, eventId = null, extra = {} } = {}) {
    if (!SERVICE_RE.test(String(product || '')) || !SEGMENT_RE.test(String(product))) throw new TypeError('product must be a lowercase service slug without dashes, e.g. "wiki"');
    if (!SEGMENT_RE.test(String(type || ''))) throw new TypeError('type must match ^[a-z][a-z0-9_]{0,39}$');
    if (!ACTIONS.includes(action)) throw new TypeError(`action must be one of ${ACTIONS.join(', ')}`);
    if (!document || document.resource_id !== id) throw new TypeError('document (buildIndexDocument/tombstone) for this resource is required');
    if ((action === 'deleted' || action === 'unpublished') && !document.deleted) throw new TypeError(`${action} events carry a tombstone`);
    // A published-but-unlisted resource is a tombstone with publication_state 'published': it may be updated, not listed.
    if ((action === 'published' || action === 'updated') && document.publication_state !== 'published') throw new TypeError(`${action} events carry a published document`);
    const isPublic = !document.deleted && document.visibility === 'public' && document.indexability && document.indexability.listable;
    const env = {
        event_type: `${product}.${type}.${action}`,
        version: 1,
        source: product,
        actor: subjectRef(actor),
        timestamp: new Date(now).toISOString(),
        visibility: isPublic ? 'public' : 'internal',
        subject: { type, id, revision },
        payload: {
            canonical_url: document.canonical_url || null,
            publication_state: document.publication_state,
            indexability: decision ? assertDecision(decision) : document.indexability || null,
            document,
            ...extra,
        },
    };
    if (eventId) env.event_id = eventId;
    if (traceId && /^[0-9a-f]{32}$/.test(traceId)) env.trace_id = traceId;
    return env;
}

module.exports = { SCHEMA, ACTIONS, buildIndexDocument, tombstone, actionFor, publicationEvent, subjectRef };
