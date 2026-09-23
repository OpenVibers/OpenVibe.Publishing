'use strict';
/**
 * openvibe-publishing/discussion — Community comment-thread references. Reference, never copy.
 *
 *   const { createDiscussionClient, createDiscussionRefs } = require('openvibe-publishing/discussion');
 *   const community = createDiscussionClient({ communityUrl: 'https://openvibe.community', tokenClient });
 *   const refs = createDiscussionRefs(db, { prefix: 'wiki' });          // wiki_discussion_refs
 *   const { threadId } = await refs.threadFor('pg_1', { service: 'wiki', type: 'page', id: 'pg_1', label: 'Sourdough' }, { client: community });
 *
 * The thread and its comments live in OpenVibe.Community. This module calls
 * `POST /api/v1/comments/threads/resolve { ref: EntityRef }` (get-or-create; 201 created, 200
 * existing) with the product's Network service token (`community.comment.write`, audience
 * `openvibe.community`), and stores only the thread id next to the entity. There is no column for
 * comment text, counts or authors, on purpose: products render the thread by embedding or by
 * reading Community, so moderation and deletion there are always what readers see.
 *
 * tokenClient is anything with `authHeaders()` → { Authorization } (openvibe-contracts'
 * serviceAuth.createTokenClient). Failures are errors (code 'discussion.unavailable' or the
 * problem code Community returned) — never a fabricated thread.
 */
const { PublishingError, assertDb, assertPrefix, clockOf, assertEntityId, parseJson } = require('./internal');

const SERVICE_RE = /^[a-z][a-z0-9-]{1,39}$/;
const TYPE_RE = /^[a-z][a-z0-9_]{1,39}$/;
const SUBJECT_RE = /^(usr|gst)_[0-9A-HJKMNP-TV-Z]{26}$/;
const TRACEPARENT_RE = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** Validates and normalises an EntityRef (common.entity-ref@1). */
function entityRef({ service, type, id, label, revision } = {}) {
    if (!SERVICE_RE.test(String(service || ''))) throw new TypeError('ref.service must be a service slug');
    if (!TYPE_RE.test(String(type || ''))) throw new TypeError('ref.type must match ^[a-z][a-z0-9_]{1,39}$');
    if (typeof id !== 'string' || !id || id.length > 128) throw new TypeError('ref.id must be a 1–128 character string');
    const ref = { service, type, id };
    if (Number.isInteger(revision) && revision >= 0) ref.revision = revision;
    if (label != null && label !== '') ref.label = String(label).slice(0, 200);
    return ref;
}

function createDiscussionClient({ communityUrl, tokenClient, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
    if (!communityUrl) throw new TypeError('communityUrl is required');
    if (!tokenClient || typeof tokenClient.authHeaders !== 'function') throw new TypeError('tokenClient with authHeaders() is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
    const base = String(communityUrl).replace(/\/+$/, '');

    return {
        base,
        /**
         * Get-or-create the Community thread for an entity.
         * opts: subject (usr_/gst_ id the product acts for; omit to act as the service),
         *       traceparent, requestId.
         * → { threadId, created, visibility }
         */
        async resolveThread(ref, { subject, traceparent, requestId } = {}) {
            const body = { ref: entityRef(ref) };
            const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...(await tokenClient.authHeaders()) };
            if (subject) {
                if (!SUBJECT_RE.test(subject)) throw new TypeError('subject must be a usr_… or gst_… id');
                headers['X-OV-Subject'] = subject;
            }
            if (traceparent && TRACEPARENT_RE.test(traceparent)) headers.traceparent = traceparent;
            if (requestId) headers['X-OpenVibe-Request-Id'] = String(requestId).slice(0, 128);
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), timeoutMs);
            let res;
            try {
                res = await fetchImpl(`${base}/api/v1/comments/threads/resolve`, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
            } catch (err) {
                throw new PublishingError(503, 'discussion.unavailable', `Community did not answer: ${err && err.name === 'AbortError' ? 'timeout' : String(err && err.message || err)}`);
            } finally {
                clearTimeout(timer);
            }
            const text = await res.text().catch(() => '');
            const json = parseJson(text, null);
            if (res.status === 401 && typeof tokenClient.invalidate === 'function') tokenClient.invalidate();
            if (!res.ok) {
                const code = json && typeof json.code === 'string' ? json.code : 'discussion.unavailable';
                throw new PublishingError(res.status >= 500 ? 503 : res.status, code, (json && (json.detail || json.title)) || `Community answered ${res.status}`, { upstreamStatus: res.status });
            }
            const thread = json && json.thread;
            if (!thread || typeof thread.id !== 'string' && typeof thread.id !== 'number') {
                throw new PublishingError(502, 'discussion.bad_response', 'Community returned no thread id');
            }
            return { threadId: String(thread.id), created: res.status === 201 || Boolean(json.created), visibility: thread.visibility || null };
        },
    };
}

/** Local table of entity → Community thread id. Stores the reference only. */
function createDiscussionRefs(db, { prefix, now } = {}) {
    assertDb(db);
    assertPrefix(prefix);
    const clock = clockOf(now);
    const R = `${prefix}_discussion_refs`;
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${R} (
            entity_id   TEXT PRIMARY KEY,
            thread_id   TEXT NOT NULL,
            ref         TEXT NOT NULL,
            resolved_at INTEGER NOT NULL
        );
    `);
    const q = {
        get: db.prepare(`SELECT * FROM ${R} WHERE entity_id = ?`),
        put: db.prepare(`INSERT INTO ${R} (entity_id, thread_id, ref, resolved_at) VALUES (?, ?, ?, ?)
                         ON CONFLICT (entity_id) DO UPDATE SET thread_id = excluded.thread_id, ref = excluded.ref, resolved_at = excluded.resolved_at`),
        del: db.prepare(`DELETE FROM ${R} WHERE entity_id = ?`),
    };
    const shape = (row) => (row ? { entityId: row.entity_id, threadId: row.thread_id, ref: parseJson(row.ref, null), resolvedAt: new Date(row.resolved_at).toISOString() } : null);

    const api = {
        table: R,
        get(entityId) { return shape(q.get.get(assertEntityId(entityId))); },
        /** Record a thread id obtained elsewhere (e.g. from a Community event). */
        set(entityId, threadId, ref) {
            q.put.run(assertEntityId(entityId), String(threadId), JSON.stringify(entityRef(ref)), clock());
            return api.get(entityId);
        },
        forget(entityId) { return q.del.run(assertEntityId(entityId)).changes > 0; },
        /** The stored thread id, or resolve it through Community once and store it. */
        async threadFor(entityId, ref, { client, ...opts } = {}) {
            const known = api.get(entityId);
            if (known) return { threadId: known.threadId, created: false, cached: true };
            if (!client) throw new TypeError('client (createDiscussionClient) is required to resolve a new thread');
            const out = await client.resolveThread(ref, opts);
            api.set(entityId, out.threadId, ref);
            return { ...out, cached: false };
        },
    };
    return api;
}

module.exports = { createDiscussionClient, createDiscussionRefs, entityRef };
