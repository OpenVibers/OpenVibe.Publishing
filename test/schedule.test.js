'use strict';
const assert = require('assert');
const { openDb, fakeClock, suite, sql } = require('./helpers/db');
const { createScheduler } = require('../lib/schedule');

const { test, run } = suite();
const T0 = Date.parse('2026-10-01T09:00:00Z');

const scheduler = async (opts) => createScheduler(opts.db || await openDb(), { prefix: 'blog', ...opts }).ensureSchema();

test('schedule() is idempotent for the same job', async () => {
    const s = await scheduler({ now: fakeClock(T0 - 60000) });
    const a = await s.schedule({ entityId: 'post_1', action: 'publish', runAt: T0, revision: 3 });
    const b = await s.schedule({ entityId: 'post_1', action: 'publish', runAt: new Date(T0).toISOString(), revision: 3 });
    assert.strictEqual(a.created, true);
    assert.strictEqual(b.created, false);
    assert.strictEqual(a.job.id, b.job.id);
    assert.strictEqual((await s.jobs('post_1')).length, 1);
    assert.strictEqual(s.table, 'blog_schedule_jobs');
    assert.strictEqual(a.job.runAt, '2026-10-01T09:00:00.000Z');
    assert.strictEqual(a.job.key, 'post_1:publish:1790845200000:3');
});

test('jobs are not due before runAt, and run once when due', async () => {
    const clock = fakeClock(T0 - 60000);
    const s = await scheduler({ now: clock });
    await s.schedule({ entityId: 'post_1', action: 'publish', runAt: T0, revision: 2 });
    let calls = 0;
    const handler = () => { calls++; return { published: 2 }; };
    assert.deepStrictEqual((await s.runDue({ worker: 'w1', handler })).done, []);
    clock.set(T0);
    const out = await s.runDue({ worker: 'w1', handler });
    assert.strictEqual(out.done.length, 1);
    assert.deepStrictEqual(out.done[0].result, { published: 2 });
    await s.runDue({ worker: 'w1', handler });
    assert.strictEqual(calls, 1);
});

test('a worker that dies mid-job: the lease expires and a restarted worker re-runs it; the effect happens once', async () => {
    const clock = fakeClock(T0);
    const db = await openDb();
    const s = await scheduler({ db, now: clock, leaseMs: 30000 });
    // the product's own state, updated idempotently by the handler
    await db.query('CREATE TABLE posts (id text PRIMARY KEY, published_revision integer, publish_count integer NOT NULL DEFAULT 0)');
    await db.exec(sql`INSERT INTO posts (id) VALUES ('post_1')`);
    const handler = async (job) => {
        const changed = await db.exec(sql`UPDATE posts SET published_revision = ${job.revision}, publish_count = publish_count + 1
            WHERE id = ${job.entityId} AND published_revision IS DISTINCT FROM ${job.revision}::integer`);
        return { changed };
    };
    await s.schedule({ entityId: 'post_1', action: 'publish', runAt: T0, revision: 4 });

    // worker A claims, applies the effect, then "crashes" before complete()
    const [claimed] = await s.claim({ worker: 'A' });
    await handler(claimed);
    assert.strictEqual((await s.get(claimed.id)).status, 'running');

    // restart: a new scheduler instance (like a new process on the same database)
    const s2 = createScheduler(db, { prefix: 'blog', now: clock, leaseMs: 30000 });
    assert.strictEqual((await s2.claim({ worker: 'B' })).length, 0, 'lease still held');
    clock.advance(30001);
    const out = await s2.runDue({ worker: 'B', handler });
    assert.strictEqual(out.done.length, 1);
    assert.strictEqual(out.done[0].attempts, 2);
    assert.deepStrictEqual(out.done[0].result, { changed: 0 });
    const post = await db.one(sql`SELECT * FROM posts WHERE id = 'post_1'`);
    assert.strictEqual(post.published_revision, 4);
    assert.strictEqual(post.publish_count, 1, 'published exactly once');
    // the crashed worker coming back cannot overwrite the result
    assert.strictEqual(await s.complete(claimed.id, 'A', { late: true }), false);
    assert.deepStrictEqual((await s.get(claimed.id)).result, { changed: 0 });
});

test('concurrent claims never take the same job twice', async () => {
    const s = await scheduler({ now: fakeClock(T0) });
    for (let i = 0; i < 12; i++) await s.schedule({ entityId: `p${i}`, action: 'publish', runAt: T0 - i, revision: 1 });
    const claims = await Promise.all(['a', 'b', 'c', 'd'].map((worker) => s.claim({ worker, limit: 5 })));
    const ids = claims.flat().map((j) => j.id);
    assert.strictEqual(ids.length, 12);
    assert.strictEqual(new Set(ids).size, 12);
    assert.deepStrictEqual(claims[0].map((j) => j.entityId), ['p11', 'p10', 'p9', 'p8', 'p7'], 'oldest runAt first');
});

test('failures retry with backoff, then fail for good', async () => {
    const clock = fakeClock(T0);
    const s = await scheduler({ now: clock, maxAttempts: 2, backoffMs: [1000] });
    await s.schedule({ entityId: 'p', action: 'unpublish', runAt: T0 });
    const boom = () => { throw new Error('media service down'); };
    let out = await s.runDue({ worker: 'w', handler: boom });
    assert.strictEqual(out.retried.length, 1);
    assert.strictEqual(out.retried[0].lastError, 'media service down');
    assert.strictEqual(out.retried[0].runAt, new Date(T0 + 1000).toISOString(), 'backoff applied');
    assert.strictEqual((await s.runDue({ worker: 'w', handler: boom })).retried.length, 0, 'waits for backoff');
    clock.advance(1000);
    out = await s.runDue({ worker: 'w', handler: boom });
    assert.strictEqual(out.failed.length, 1);
    assert.strictEqual(out.failed[0].status, 'failed');
    assert.deepStrictEqual(await s.fail(out.failed[0].id, 'w', 'again'), { status: 'lost' });
});

test('a job whose workers keep crashing is abandoned after maxAttempts and reported as failed', async () => {
    const clock = fakeClock(T0);
    const s = await scheduler({ now: clock, maxAttempts: 2, leaseMs: 1000 });
    await s.schedule({ entityId: 'p', action: 'publish', runAt: T0, revision: 1 });
    await s.claim({ worker: 'a' }); clock.advance(1001);
    await s.claim({ worker: 'b' }); clock.advance(1001);
    const out = await s.runDue({ worker: 'c', handler: () => assert.fail('must not run a third time') });
    assert.strictEqual(out.failed.length, 1);
    assert.match(out.failed[0].lastError, /lease expired/);
    assert.strictEqual(out.failed[0].attempts, 2);
});

test('cancel and cancelPending', async () => {
    const s = await scheduler({ now: fakeClock(T0) });
    const { job } = await s.schedule({ entityId: 'p', action: 'publish', runAt: T0 + 1000, revision: 1 });
    await s.schedule({ entityId: 'p', action: 'unpublish', runAt: T0 + 5000 });
    await s.schedule({ entityId: 'p', action: 'unpublish', runAt: T0 + 9000 });
    assert.strictEqual(await s.cancel(job.id), true);
    assert.strictEqual(await s.cancel(job.id), false, 'only a pending job');
    assert.strictEqual(await s.cancelPending('p', 'unpublish'), 2);
    assert.deepStrictEqual((await s.jobs('p')).map((j) => j.status), ['cancelled', 'cancelled', 'cancelled']);
    assert.strictEqual(await s.cancelPending('p'), 0);
});

test('validation', async () => {
    const s = await scheduler({});
    await assert.rejects(s.schedule({ entityId: 'p', action: 'delete', runAt: T0 }), /action/);
    await assert.rejects(s.schedule({ entityId: 'p', action: 'publish', runAt: 'soon' }), /runAt/);
    await assert.rejects(s.claim({}), /worker/);
    await assert.rejects(s.runDue({ worker: 'w' }), /handler/);
});

run();
