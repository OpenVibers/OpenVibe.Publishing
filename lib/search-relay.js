'use strict';
/**
 * openvibe-publishing/search-relay — deliver the Search documents a product queued in its own outbox table through
 * OpenVibe.Search's owner API (PUT and DELETE /api/v1/documents/:owner/:type/:id, a service token holding
 * search.document.write on openvibe.search).
 *
 * Meme, Exchange and Fun write one search.index-document@1 (or a tombstone, `deleted: true`) per change into
 * `<product>_outbox` in the same transaction as the change, and nothing delivered them: 118 meme entries and 104
 * Exchange listings had waited since their launch (2026-11-02). This is that delivery, for any table of this shape:
 *
 *   event_id text PRIMARY KEY, topic text, payload jsonb, created_at timestamptz, published_at timestamptz,
 *   attempts integer, last_error text, next_attempt_at timestamptz, claimed_at timestamptz, claimed_by text
 *
 *   const relay = createSearchRelay({ db, table: 'meme_outbox', owner: 'meme', searchUrl, auth, log });
 *   relay.start();          // a tick a few seconds after boot, then every minute (never under a drill: the caller decides)
 *   relay.kick();           // after a change: a tick in two seconds
 *   await relay.drain();    // one tick now → { sent, stale, superseded, rejected, failed, deferred }
 *   relay.stop();
 *   await relay.status();   // { enabled, pending, totals, last_run_at, last_error }
 *
 * auth is the product's service-token client for audience openvibe.search, scope search.document.write
 * (openvibe-contracts serviceAuth.createTokenClient): { authHeaders(), invalidate() }. Without searchUrl or auth the
 * relay is off and the rows keep waiting.
 *
 * What each answer does to a row:
 *   2xx                         sent: published_at is set
 *   409 search.stale_revision   Search holds a newer revision: the row is done (last_error says stale)
 *   409 search.revision_conflict the same revision is indexed with other content (a change that did not move the
 *                               revision): sent again once as the stored revision + 1
 *   429                         the tick stops; the row and the rest wait for Retry-After (default a minute)
 *   401                         the token is dropped; the row is retried with backoff
 *   other 4xx                   refused for good (bad document, not the owner): published_at is set and last_error
 *                               starts "rejected", so the row stops blocking the queue and the log says why
 *   5xx, network                retried with backoff: 15 s doubling to an hour
 * Rows go oldest first; within one tick only the newest row of a document is sent and the older ones are marked
 * superseded. A claim is a lease (five minutes), so two processes never send one row at once and a crash frees it.
 * At most `maxPerTick` rows (default 100) go per tick: Search's owner API allows a service 120 writes a minute.
 */

const TABLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const OWNER_RE = /^[a-z][a-z0-9-]{1,39}$/;
const LEASE_MS = 5 * 60_000;
const BACKOFF_MIN_MS = 15_000;
const BACKOFF_MAX_MS = 60 * 60_000;
const RETRY_AFTER_DEFAULT_MS = 60_000;
const TIMEOUT_MS = 15_000;

const isoOf = (ms) => new Date(ms).toISOString();
const backoff = (attempts) => Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempts - 1));

function retryAfterMs(res) {
    const h = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
    const n = Number(h);
    return Number.isFinite(n) && n > 0 ? Math.min(BACKOFF_MAX_MS, n * 1000) : RETRY_AFTER_DEFAULT_MS;
}

function createSearchRelay({
    db, table, owner, searchUrl, auth, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console,
    maxPerTick = 100, intervalMs = 60_000, firstDelayMs = 5_000, kickDelayMs = 2_000, workerId = null,
} = {}) {
    if (!db) throw new TypeError('db is required');
    if (!TABLE_RE.test(String(table || ''))) throw new TypeError('table must be a plain table name, e.g. "meme_outbox"');
    if (!OWNER_RE.test(String(owner || ''))) throw new TypeError('owner must be the service id, e.g. "meme"');
    const base = String(searchUrl || '').replace(/\/+$/, '');
    const enabled = Boolean(base && auth && typeof auth.authHeaders === 'function');
    const me = workerId || `${owner}-relay-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const totals = { sent: 0, stale: 0, superseded: 0, rejected: 0, failed: 0, deferred: 0 };
    let lastRunAt = null;
    let lastError = null;
    let pausedUntil = 0;
    let running = null;
    let timer = null;
    let first = null;
    let kicked = null;

    const docUrl = (p) => `${base}/api/v1/documents/${encodeURIComponent(owner)}/${encodeURIComponent(p.type)}/${encodeURIComponent(p.id)}`;

    async function call(method, url, body) {
        const res = await fetchImpl(url, {
            method,
            headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await auth.authHeaders()) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const json = await res.json().catch(() => ({}));
        return { res, status: res.status, body: json || {} };
    }

    function send(p, revision) {
        if (p.deleted) return call('DELETE', `${docUrl(p)}?revision=${Number(revision)}`);
        return call('PUT', docUrl(p), { ...p, owner, revision });
    }

    // UPDATE … RETURNING does not keep the subquery's order: the claimed rows are sorted again, oldest first.
    const created = (r) => new Date(r.created_at).getTime();
    async function claim(limit) {
        const t = now();
        const rows = await db.many(
            `UPDATE ${table} o SET claimed_at = $1::timestamptz, claimed_by = $2
              WHERE o.event_id IN (
                    SELECT o2.event_id FROM ${table} o2
                     WHERE o2.published_at IS NULL AND o2.next_attempt_at <= $1::timestamptz
                       AND (o2.claimed_at IS NULL OR o2.claimed_at < $3::timestamptz)
                     ORDER BY o2.created_at, o2.event_id
                     LIMIT $4
                     FOR UPDATE SKIP LOCKED)
          RETURNING o.event_id, o.payload, o.attempts, o.created_at`,
            [isoOf(t), me, isoOf(t - LEASE_MS), limit],
        );
        return rows.sort((a, b) => created(a) - created(b) || (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0));
    }

    const done = (eventId, note = null) => db.exec(
        `UPDATE ${table} SET published_at = $1::timestamptz, last_error = $2, claimed_at = NULL, claimed_by = NULL WHERE event_id = $3`,
        [isoOf(now()), note, eventId],
    );
    const retry = (row, message, waitMs) => db.exec(
        `UPDATE ${table} SET attempts = attempts + 1, last_error = $1, next_attempt_at = $2::timestamptz, claimed_at = NULL, claimed_by = NULL
          WHERE event_id = $3`,
        [String(message).slice(0, 500), isoOf(now() + waitMs), row.event_id],
    );
    const release = (eventIds, untilMs) => (eventIds.length ? db.exec(
        `UPDATE ${table} SET next_attempt_at = GREATEST(next_attempt_at, $1::timestamptz), claimed_at = NULL, claimed_by = NULL
          WHERE event_id = ANY($2::text[]) AND claimed_by = $3`,
        [isoOf(untilMs), eventIds, me],
    ) : null);

    const problem = (r) => `${r.status} ${(r.body && (r.body.code || r.body.type || r.body.title)) || ''}`.trim();

    /** One row: send it and record what Search said. Returns the outcome name, or 'paused' on a 429. */
    async function deliver(row) {
        const p = row.payload || {};
        if (p.owner !== undefined && p.owner !== owner) { await done(row.event_id, `rejected: payload owner ${p.owner} is not ${owner}`); return 'rejected'; }
        if (!p.type || !p.id || !Number.isFinite(Number(p.revision))) { await done(row.event_id, 'rejected: payload has no type, id or revision'); return 'rejected'; }
        let r;
        try {
            r = await send(p, Number(p.revision));
            if (r.status === 409 && r.body && r.body.code === 'search.revision_conflict' && !p.deleted) {
                const stored = Number(r.body.stored_revision);
                if (Number.isFinite(stored)) r = await send(p, stored + 1);
            }
        } catch (err) {
            await retry(row, `network: ${(err && err.message) || err}`, backoff(row.attempts + 1));
            lastError = `network: ${(err && err.message) || err}`;
            return 'failed';
        }
        if (r.status >= 200 && r.status < 300) { await done(row.event_id); return 'sent'; }
        if (r.status === 409 && r.body && r.body.code === 'search.stale_revision') {
            await done(row.event_id, `stale: Search holds revision ${r.body.stored_revision}`);
            return 'stale';
        }
        if (r.status === 429) { pausedUntil = now() + retryAfterMs(r.res); lastError = problem(r); return 'paused'; }
        if (r.status === 401 && typeof auth.invalidate === 'function') auth.invalidate();
        if (r.status === 401 || r.status === 408 || r.status >= 500) {
            lastError = problem(r);
            await retry(row, lastError, backoff(row.attempts + 1));
            return 'failed';
        }
        lastError = `rejected: ${problem(r)}`;
        log.warn(`[${owner} → Search] ${p.type}/${p.id} r${p.revision} refused: ${problem(r)}${r.body && r.body.detail ? ` (${String(r.body.detail).slice(0, 200)})` : ''}`);
        await done(row.event_id, lastError.slice(0, 500));
        return 'rejected';
    }

    async function tick() {
        const out = { sent: 0, stale: 0, superseded: 0, rejected: 0, failed: 0, deferred: 0 };
        if (!enabled) return null;
        if (now() < pausedUntil) return out;
        const rows = await claim(maxPerTick);
        // Within one claim, only the newest row of a document matters: the older ones are superseded.
        const newest = new Map();
        for (const row of rows) {
            const p = row.payload || {};
            newest.set(`${p.type}\u0000${p.id}`, row.event_id);
        }
        const queue = [];
        for (const row of rows) {
            const p = row.payload || {};
            if (newest.get(`${p.type}\u0000${p.id}`) !== row.event_id) { await done(row.event_id, 'superseded'); out.superseded++; } else queue.push(row);
        }
        for (let i = 0; i < queue.length; i++) {
            const o = await deliver(queue[i]);
            if (o === 'paused') {
                const rest = queue.slice(i).map((r) => r.event_id);
                await release(rest, pausedUntil);
                out.deferred += rest.length;
                break;
            }
            out[o]++;
        }
        for (const k of Object.keys(out)) totals[k] += out[k];
        lastRunAt = isoOf(now());
        if (out.sent || out.rejected || out.failed || out.deferred) {
            log.log(`[${owner} → Search] ${out.sent} sent, ${out.stale} stale, ${out.superseded} superseded, ${out.rejected} rejected, ${out.failed} failed, ${out.deferred} deferred`);
        }
        return out;
    }

    /** One tick now (never two at once in this process). */
    function drain() {
        if (!running) running = tick().finally(() => { running = null; });
        return running;
    }
    const quietly = () => { drain().catch((err) => { lastError = (err && err.message) || String(err); log.warn(`[${owner} → Search] relay tick failed: ${lastError}`); }); };

    return {
        enabled,
        drain,
        kick() {
            if (!enabled || !timer || kicked) return;
            kicked = setTimeout(() => { kicked = null; quietly(); }, kickDelayMs);
            if (kicked.unref) kicked.unref();
        },
        start() {
            if (!enabled || timer) return false;
            first = setTimeout(quietly, firstDelayMs);
            if (first.unref) first.unref();
            timer = setInterval(quietly, intervalMs);
            if (timer.unref) timer.unref();
            return true;
        },
        stop() {
            clearTimeout(first); clearInterval(timer); clearTimeout(kicked);
            first = null; timer = null; kicked = null;
        },
        async status() {
            const pending = Number(await db.value(`SELECT COUNT(*)::int AS n FROM ${table} WHERE published_at IS NULL`));
            return { enabled, pending, totals: { ...totals }, last_run_at: lastRunAt, last_error: lastError, paused_until: pausedUntil > now() ? isoOf(pausedUntil) : null };
        },
    };
}

module.exports = { createSearchRelay };
