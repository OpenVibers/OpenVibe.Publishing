'use strict';
/**
 * openvibe-publishing/schedule — scheduled publish/unpublish jobs that survive worker restarts.
 *
 *   const { createScheduler, schema } = require('openvibe-publishing/schedule');
 *   const sched = createScheduler(db, { prefix: 'blog', leaseMs: 60000, now: () => Date.now() });
 *   await sched.schedule({ entityId: 'post_1', action: 'publish', runAt: Date.parse('2026-10-01T09:00:00Z'), revision: 3 });
 *   // in the product's worker loop (any number of processes and hosts):
 *   await sched.runDue({ worker: 'blog-1', handler: async (job) => { await publishPost(job.entityId, job.revision); } });
 *
 * Table <prefix>_schedule_jobs. Guarantees:
 *   - schedule() is idempotent: the same (entity, action, runAt, revision) — or the same explicit
 *     `key` — returns the existing job instead of adding a second one.
 *   - claim() takes a lease (lease_owner, lease_until) in one UPDATE … FOR UPDATE SKIP LOCKED, so
 *     concurrent workers never take the same job. A worker that dies mid-job leaves the lease
 *     to expire, and the next claim re-runs the job: at-least-once. The handler must therefore be
 *     re-run safe ("make revision N the published one" is; "append a publish" is not). Each job
 *     carries a stable `key` the handler can use as its own idempotency key.
 *   - complete()/fail() only count when the caller still holds the lease, so a worker whose lease
 *     was taken over cannot overwrite the new owner's result.
 *   - failures retry with backoff up to maxAttempts, then the job is 'failed' (the product emits
 *     its `<product>.schedule.failed` event from runDue's summary).
 * The clock is injectable (`now`), so tests and replays are deterministic.
 */
const {
    PublishingError, assertDb, sqlOf, bindHandles, boundedLimit, jsonValue, assertPrefix, clockOf, newId, assertEntityId,
} = require('./internal');

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
        result: jsonValue(row.result, null),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
    };
}

function toMs(v, name) {
    const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
    if (!Number.isFinite(t)) throw new TypeError(`${name} must be a date, ISO string or epoch milliseconds`);
    return t;
}

const byRunAt = (a, b) => (a.run_at - b.run_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The DDL for one prefix (idempotent), for the service's migration file. */
function schema(prefix) {
    assertPrefix(prefix);
    const J = `${prefix}_schedule_jobs`;
    return `CREATE TABLE IF NOT EXISTS ${J} (
    id          text COLLATE "C" PRIMARY KEY,
    idem_key    text NOT NULL UNIQUE,
    entity_id   text COLLATE "C" NOT NULL,
    action      text NOT NULL CHECK (action IN ('publish','unpublish')),
    revision    integer,
    run_at      bigint NOT NULL,
    status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
    attempts    integer NOT NULL DEFAULT 0,
    lease_owner text,
    lease_until bigint,
    last_error  text,
    result      jsonb,
    created_at  bigint NOT NULL,
    updated_at  bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS ${J}_due ON ${J} (run_at, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ${J}_lease ON ${J} (lease_until) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS ${J}_entity ON ${J} (entity_id, run_at, id);
`;
}

function createScheduler(db, { prefix, now, leaseMs = 60000, maxAttempts = 5, backoffMs = [5000, 30000, 120000, 600000] } = {}) {
    assertDb(db);
    assertPrefix(prefix);
    const sql = sqlOf(db);
    const clock = clockOf(now);
    if (!(leaseMs > 0)) throw new TypeError('leaseMs must be positive');
    if (!Array.isArray(backoffMs) || !backoffMs.every((n) => Number.isSafeInteger(n) && n >= 0)) throw new TypeError('backoffMs must be a list of non-negative integers');
    const J = `${prefix}_schedule_jobs`;
    const j$ = sql.ident(J);

    /**
     * Lease up to `limit` due jobs in one statement: pending and due, or running with an expired
     * lease. FOR UPDATE SKIP LOCKED lets any number of workers (processes, hosts) claim from one table
     * without taking the same job twice. A job whose workers keep dying stops after maxAttempts
     * (marked failed, reported as abandoned) instead of looping forever.
     */
    async function claimDue(h, worker, limit) {
        if (typeof worker !== 'string' || !worker) throw new TypeError('worker must be a non-empty string');
        const t = clock();
        const lim = boundedLimit(limit, 10, 100);
        const rows = await h.many(sql`WITH due AS (
                SELECT id, (status = 'running' AND attempts >= ${maxAttempts}::integer) AS dead FROM ${j$}
                WHERE (status = 'pending' AND run_at <= ${t}::bigint) OR (status = 'running' AND lease_until <= ${t}::bigint)
                ORDER BY run_at, id LIMIT ${lim}
                FOR UPDATE SKIP LOCKED)
            UPDATE ${j$} AS j SET
                status = CASE WHEN due.dead THEN 'failed' ELSE 'running' END,
                lease_owner = CASE WHEN due.dead THEN NULL ELSE ${worker}::text END,
                lease_until = CASE WHEN due.dead THEN NULL ELSE ${t + leaseMs}::bigint END,
                attempts = CASE WHEN due.dead THEN j.attempts ELSE j.attempts + 1 END,
                last_error = CASE WHEN due.dead THEN 'lease expired on every attempt' ELSE j.last_error END,
                updated_at = ${t}::bigint
            FROM due WHERE j.id = due.id
            RETURNING j.*, due.dead`);
        rows.sort(byRunAt);
        return { jobs: rows.filter((r) => !r.dead).map(shape), abandoned: rows.filter((r) => r.dead).map(shape) };
    }

    async function completeRow(h, id, worker, result) {
        return h.maybe(sql`UPDATE ${j$} SET status = 'done', result = ${sql.json(result == null ? null : result)}, lease_owner = NULL, lease_until = NULL,
                last_error = NULL, updated_at = ${clock()}
            WHERE id = ${String(id)} AND status = 'running' AND lease_owner = ${String(worker)}
            RETURNING *`);
    }

    const impl = {
        /** Idempotent. Returns { job, created }. */
        async schedule(h, { entityId, action, runAt, revision = null, key } = {}) {
            assertEntityId(entityId);
            if (!ACTIONS.includes(action)) throw new TypeError(`action must be one of ${ACTIONS.join(', ')}`);
            const at = toMs(runAt, 'runAt');
            if (revision != null && (!Number.isInteger(revision) || revision < 1 || revision > 2147483647)) throw new TypeError('revision must be a positive integer');
            const idem = key ? String(key) : `${entityId}:${action}:${at}:${revision == null ? '-' : revision}`;
            const t = clock();
            const row = await h.maybe(sql`INSERT INTO ${j$} (id, idem_key, entity_id, action, revision, run_at, created_at, updated_at)
                VALUES (${newId('job', t)}, ${idem}, ${entityId}, ${action}, ${revision}, ${at}, ${t}, ${t})
                ON CONFLICT (idem_key) DO NOTHING RETURNING *`);
            if (row) return { job: shape(row), created: true };
            return { job: shape(await h.one(sql`SELECT * FROM ${j$} WHERE idem_key = ${idem}`)), created: false };
        },

        async get(h, id) { return shape(await h.maybe(sql`SELECT * FROM ${j$} WHERE id = ${String(id)}`)); },

        async jobs(h, entityId, { limit = 1000 } = {}) {
            return (await h.many(sql`SELECT * FROM ${j$} WHERE entity_id = ${assertEntityId(entityId)} ORDER BY run_at, id LIMIT ${boundedLimit(limit)}`)).map(shape);
        },

        /** Cancel one pending job (a running job finishes or its lease expires; it cannot be cancelled mid-flight). */
        async cancel(h, id) {
            return (await h.exec(sql`UPDATE ${j$} SET status = 'cancelled', updated_at = ${clock()} WHERE id = ${String(id)} AND status = 'pending'`)) > 0;
        },

        /** Cancel every pending job of an entity, optionally only one action. Returns the count. */
        async cancelPending(h, entityId, action = null) {
            assertEntityId(entityId);
            const only = action == null ? sql`` : sql` AND action = ${String(action)}`;
            return h.exec(sql`UPDATE ${j$} SET status = 'cancelled', updated_at = ${clock()} WHERE entity_id = ${entityId} AND status = 'pending'${only}`);
        },

        /** Lease up to `limit` due jobs (pending and due, or running with an expired lease). */
        async claim(h, { worker, limit = 10 } = {}) { return (await claimDue(h, worker, limit)).jobs; },

        /** true when recorded; false when this worker no longer holds the lease. */
        async complete(h, id, worker, result = null) { return Boolean(await completeRow(h, id, worker, result)); },

        /** Returns { status: 'retry' | 'failed' | 'lost' }, in one statement. */
        async fail(h, id, worker, error) {
            const t = clock();
            const msg = String(error && error.message ? error.message : error || 'failed').slice(0, 1000);
            const row = await h.maybe(sql`UPDATE ${j$} SET
                    status = CASE WHEN attempts >= ${maxAttempts}::integer THEN 'failed' ELSE 'pending' END,
                    run_at = CASE WHEN attempts >= ${maxAttempts}::integer THEN run_at
                             ELSE ${t}::bigint + COALESCE((${backoffMs}::bigint[])[LEAST(attempts, ${backoffMs.length}::integer)], 0) END,
                    last_error = ${msg}, lease_owner = NULL, lease_until = NULL, updated_at = ${t}::bigint
                WHERE id = ${String(id)} AND status = 'running' AND lease_owner = ${String(worker)}
                RETURNING *`);
            if (!row) return { status: 'lost' };
            return { status: row.status === 'failed' ? 'failed' : 'retry', job: shape(row) };
        },

        /**
         * Claim and run due jobs one by one. handler(job) may be async; a throw counts as a failure.
         * Returns { done: [job], retried: [job], failed: [job], lost: [job] }.
         */
        async runDue(h, { worker, handler, limit = 10 } = {}) {
            if (typeof handler !== 'function') throw new TypeError('handler must be a function');
            const { jobs, abandoned } = await claimDue(h, worker, limit);
            const summary = { done: [], retried: [], failed: [...abandoned], lost: [] };
            for (const job of jobs) {
                try {
                    const result = await handler(job);
                    const row = await completeRow(h, job.id, worker, result === undefined ? null : result);
                    if (row) summary.done.push(shape(row));
                    else summary.lost.push(await impl.get(h, job.id));
                } catch (err) {
                    const f = await impl.fail(h, job.id, worker, err);
                    if (f.status === 'failed') summary.failed.push(f.job);
                    else if (f.status === 'retry') summary.retried.push(f.job);
                    else summary.lost.push(await impl.get(h, job.id));
                }
            }
            return summary;
        },
    };

    const api = bindHandles(db, impl);
    api.table = J;
    api.ACTIONS = ACTIONS;
    api.STATUSES = STATUSES;
    api.schema = () => schema(prefix);
    /** Create the table where the handle may (tests, PGlite); services put schema() in a migration. */
    api.ensureSchema = async () => { await db.query(schema(prefix)); return api; };
    return api;
}

module.exports = { createScheduler, schema, ACTIONS, STATUSES, PublishingError };
