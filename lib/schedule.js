'use strict';
/**
 * openvibe-publishing/schedule — scheduled publish/unpublish jobs that survive worker restarts.
 *
 *   const { createScheduler } = require('openvibe-publishing/schedule');
 *   const sched = createScheduler(db, { prefix: 'blog', leaseMs: 60000, now: () => Date.now() });
 *   sched.schedule({ entityId: 'post_1', action: 'publish', runAt: Date.parse('2026-10-01T09:00:00Z'), revision: 3 });
 *   // in the product's worker loop:
 *   await sched.runDue({ worker: 'blog-1', handler: async (job) => { publishPost(job.entityId, job.revision); } });
 *
 * Table <prefix>_schedule_jobs. Guarantees:
 *   - schedule() is idempotent: the same (entity, action, runAt, revision) — or the same explicit
 *     `key` — returns the existing job instead of adding a second one.
 *   - claim() takes a lease (lease_owner, lease_until). A worker that dies mid-job leaves the lease
 *     to expire, and the next claim re-runs the job: at-least-once. The handler must therefore be
 *     re-run safe ("make revision N the published one" is; "append a publish" is not). Each job
 *     carries a stable `key` the handler can use as its own idempotency key.
 *   - complete()/fail() only count when the caller still holds the lease, so a worker whose lease
 *     was taken over cannot overwrite the new owner's result.
 *   - failures retry with backoff up to maxAttempts, then the job is 'failed' (the product emits
 *     its `<product>.schedule.failed` event from runDue's summary).
 * The clock is injectable (`now`), so tests and replays are deterministic.
 */
const { PublishingError, assertDb, assertPrefix, clockOf, newId, parseJson, assertEntityId } = require('./internal');

const ACTIONS = ['publish', 'unpublish'];
const STATUSES = ['pending', 'running', 'done', 'failed', 'cancelled'];

function shape(row) {
    if (!row) return null;
    return {
        id: row.id,
        key: row.idem_key,
        entityId: row.entity_id,
        action: row.action,
        revision: row.revision,
        runAt: new Date(row.run_at).toISOString(),
        status: row.status,
        attempts: row.attempts,
        leaseOwner: row.lease_owner,
        leaseUntil: row.lease_until == null ? null : new Date(row.lease_until).toISOString(),
        lastError: row.last_error,
        result: parseJson(row.result, null),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
    };
}

function toMs(v, name) {
    const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
    if (!Number.isFinite(t)) throw new TypeError(`${name} must be a date, ISO string or epoch milliseconds`);
    return t;
}

function createScheduler(db, { prefix, now, leaseMs = 60000, maxAttempts = 5, backoffMs = [5000, 30000, 120000, 600000] } = {}) {
    assertDb(db);
    assertPrefix(prefix);
    const clock = clockOf(now);
    if (!(leaseMs > 0)) throw new TypeError('leaseMs must be positive');
    const J = `${prefix}_schedule_jobs`;

    db.exec(`
        CREATE TABLE IF NOT EXISTS ${J} (
            id          TEXT PRIMARY KEY,
            idem_key    TEXT NOT NULL UNIQUE,
            entity_id   TEXT NOT NULL,
            action      TEXT NOT NULL CHECK (action IN ('publish','unpublish')),
            revision    INTEGER,
            run_at      INTEGER NOT NULL,
            status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
            attempts    INTEGER NOT NULL DEFAULT 0,
            lease_owner TEXT,
            lease_until INTEGER,
            last_error  TEXT,
            result      TEXT,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ${J}_due ON ${J} (status, run_at);
        CREATE INDEX IF NOT EXISTS ${J}_entity ON ${J} (entity_id, run_at);
    `);

    const q = {
        byId: db.prepare(`SELECT * FROM ${J} WHERE id = ?`),
        byKey: db.prepare(`SELECT * FROM ${J} WHERE idem_key = ?`),
        insert: db.prepare(`INSERT OR IGNORE INTO ${J} (id, idem_key, entity_id, action, revision, run_at, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
        due: db.prepare(`SELECT * FROM ${J} WHERE (status = 'pending' AND run_at <= @now) OR (status = 'running' AND lease_until <= @now)
                         ORDER BY run_at, id LIMIT @limit`),
        take: db.prepare(`UPDATE ${J} SET status = 'running', lease_owner = @worker, lease_until = @until, attempts = attempts + 1, updated_at = @now
                          WHERE id = @id AND ((status = 'pending' AND run_at <= @now) OR (status = 'running' AND lease_until <= @now))`),
        complete: db.prepare(`UPDATE ${J} SET status = 'done', result = @result, lease_owner = NULL, lease_until = NULL, last_error = NULL, updated_at = @now
                              WHERE id = @id AND status = 'running' AND lease_owner = @worker`),
        retry: db.prepare(`UPDATE ${J} SET status = 'pending', run_at = @runAt, last_error = @error, lease_owner = NULL, lease_until = NULL, updated_at = @now
                           WHERE id = @id AND status = 'running' AND lease_owner = @worker`),
        dead: db.prepare(`UPDATE ${J} SET status = 'failed', last_error = @error, lease_owner = NULL, lease_until = NULL, updated_at = @now
                          WHERE id = @id AND status = 'running' AND lease_owner = @worker`),
        abandon: db.prepare(`UPDATE ${J} SET status = 'failed', last_error = 'lease expired on every attempt', lease_owner = NULL, lease_until = NULL, updated_at = @now
                             WHERE id = @id AND status = 'running' AND lease_until <= @now`),
        cancel: db.prepare(`UPDATE ${J} SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'`),
        cancelEntity: db.prepare(`UPDATE ${J} SET status = 'cancelled', updated_at = ? WHERE entity_id = ? AND status = 'pending' AND (? IS NULL OR action = ?)`),
        forEntity: db.prepare(`SELECT * FROM ${J} WHERE entity_id = ? ORDER BY run_at, id`),
    };

    function backoff(attempts) {
        return backoffMs[Math.min(attempts - 1, backoffMs.length - 1)] || 0;
    }

    function claimDue(worker, limit) {
        if (typeof worker !== 'string' || !worker) throw new TypeError('worker must be a non-empty string');
        return db.transaction(() => {
            const t = clock();
            const rows = q.due.all({ now: t, limit: Math.max(1, Math.min(100, limit)) });
            const jobs = [];
            const abandoned = [];
            for (const r of rows) {
                // A job whose workers keep dying stops after maxAttempts instead of looping forever.
                if (r.status === 'running' && r.attempts >= maxAttempts) {
                    if (q.abandon.run({ id: r.id, now: t }).changes === 1) abandoned.push(shape(q.byId.get(r.id)));
                    continue;
                }
                if (q.take.run({ id: r.id, worker, until: t + leaseMs, now: t }).changes === 1) jobs.push(shape(q.byId.get(r.id)));
            }
            return { jobs, abandoned };
        }).immediate();
    }

    const api = {
        table: J,
        ACTIONS,
        STATUSES,

        /** Idempotent. Returns { job, created }. */
        schedule({ entityId, action, runAt, revision = null, key } = {}) {
            assertEntityId(entityId);
            if (!ACTIONS.includes(action)) throw new TypeError(`action must be one of ${ACTIONS.join(', ')}`);
            const at = toMs(runAt, 'runAt');
            if (revision != null && (!Number.isInteger(revision) || revision < 1)) throw new TypeError('revision must be a positive integer');
            const idem = key ? String(key) : `${entityId}:${action}:${at}:${revision == null ? '-' : revision}`;
            const t = clock();
            const info = q.insert.run(newId('job', t), idem, entityId, action, revision, at, t, t);
            return { job: shape(q.byKey.get(idem)), created: info.changes === 1 };
        },

        get(id) { return shape(q.byId.get(String(id))); },

        jobs(entityId) { return q.forEntity.all(assertEntityId(entityId)).map(shape); },

        /** Cancel one pending job (a running job finishes or its lease expires; it cannot be cancelled mid-flight). */
        cancel(id) { return q.cancel.run(clock(), String(id)).changes > 0; },

        /** Cancel every pending job of an entity, optionally only one action. Returns the count. */
        cancelPending(entityId, action = null) {
            return q.cancelEntity.run(clock(), assertEntityId(entityId), action, action).changes;
        },

        /** Lease up to `limit` due jobs (pending and due, or running with an expired lease). */
        claim({ worker, limit = 10 } = {}) { return claimDue(worker, limit).jobs; },

        /** true when recorded; false when this worker no longer holds the lease. */
        complete(id, worker, result = null) {
            return q.complete.run({ id: String(id), worker, result: result == null ? null : JSON.stringify(result), now: clock() }).changes === 1;
        },

        /** Returns { status: 'retry' | 'failed' | 'lost' }. */
        fail(id, worker, error) {
            const row = q.byId.get(String(id));
            if (!row || row.status !== 'running' || row.lease_owner !== worker) return { status: 'lost' };
            const t = clock();
            const msg = String(error && error.message ? error.message : error || 'failed').slice(0, 1000);
            if (row.attempts >= maxAttempts) {
                q.dead.run({ id: row.id, worker, error: msg, now: t });
                return { status: 'failed', job: shape(q.byId.get(row.id)) };
            }
            q.retry.run({ id: row.id, worker, error: msg, runAt: t + backoff(row.attempts), now: t });
            return { status: 'retry', job: shape(q.byId.get(row.id)) };
        },

        /**
         * Claim and run due jobs one by one. handler(job) may be async; a throw counts as a failure.
         * Returns { done: [job], retried: [job], failed: [job], lost: [job] }.
         */
        async runDue({ worker, handler, limit = 10 } = {}) {
            if (typeof handler !== 'function') throw new TypeError('handler must be a function');
            const { jobs, abandoned } = claimDue(worker, limit);
            const summary = { done: [], retried: [], failed: [...abandoned], lost: [] };
            for (const job of jobs) {
                try {
                    const result = await handler(job);
                    if (api.complete(job.id, worker, result === undefined ? null : result)) summary.done.push(api.get(job.id));
                    else summary.lost.push(api.get(job.id));
                } catch (err) {
                    const f = api.fail(job.id, worker, err);
                    if (f.status === 'failed') summary.failed.push(f.job);
                    else if (f.status === 'retry') summary.retried.push(f.job);
                    else summary.lost.push(api.get(job.id));
                }
            }
            return summary;
        },
    };
    return api;
}

module.exports = { createScheduler, ACTIONS, STATUSES, PublishingError };
