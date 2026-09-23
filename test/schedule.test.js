'use strict';
const assert = require('assert');
const Database = require('better-sqlite3');
const { openDb, fakeClock, suite } = require('./helpers/db');
const { createScheduler } = require('../lib/schedule');

const { test, run } = suite();
const T0 = Date.parse('2026-10-01T09:00:00Z');

test('schedule() is idempotent for the same job', () => {
    const s = createScheduler(openDb('sch'), { prefix: 'blog', now: fakeClock(T0 - 60000) });
    const a = s.schedule({ entityId: 'post_1', action: 'publish', runAt: T0, revision: 3 });
    const b = s.schedule({ entityId: 'post_1', action: 'publish', runAt: new Date(T0).toISOString(), revision: 3 });
    assert.strictEqual(a.created, true);
    assert.strictEqual(b.created, false);
    assert.strictEqual(a.job.id, b.job.id);
    assert.strictEqual(s.jobs('post_1').length, 1);
    assert.strictEqual(s.table, 'blog_schedule_jobs');
});

test('jobs are not due before runAt, and run once when due', async () => {
    const clock = fakeClock(T0 - 60000);
    const s = createScheduler(openDb('sch'), { prefix: 'blog', now: clock });
    s.schedule({ entityId: 'post_1', action: 'publish', runAt: T0, revision: 2 });
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
    const db = openDb('sch');
    const s = createScheduler(db, { prefix: 'blog', now: clock, leaseMs: 30000 });
    // the product's own state, updated idempotently by the handler
    db.exec('CREATE TABLE posts (id TEXT PRIMARY KEY, published_revision INTEGER, publish_count INTEGER NOT NULL DEFAULT 0)');
    db.prepare("INSERT INTO posts (id) VALUES ('post_1')").run();
    const handler = (job) => {
        const info = db.prepare('UPDATE posts SET published_revision = ?, publish_count = publish_count + 1 WHERE id = ? AND published_revision IS NOT ?').run(job.revision, job.entityId, job.revision);
        return { changed: info.changes };
    };
    s.schedule({ entityId: 'post_1', action: 'publish', runAt: T0, revision: 4 });

    // worker A claims, applies the effect, then "crashes" before complete()
    const [claimed] = s.claim({ worker: 'A' });
    handler(claimed);
    assert.strictEqual(s.get(claimed.id).status, 'running');

    // restart: a new scheduler instance on a new connection (like a new process)
    const s2 = createScheduler(new Database(db.name), { prefix: 'blog', now: clock, leaseMs: 30000 });
    assert.strictEqual(s2.claim({ worker: 'B' }).length, 0, 'lease still held');
    clock.advance(30001);
    const out = await s2.runDue({ worker: 'B', handler });
    assert.strictEqual(out.done.length, 1);
    assert.strictEqual(out.done[0].attempts, 2);
    assert.deepStrictEqual(out.done[0].result, { changed: 0 });
    const post = db.prepare("SELECT * FROM posts WHERE id = 'post_1'").get();
    assert.strictEqual(post.published_revision, 4);
    assert.strictEqual(post.publish_count, 1, 'published exactly once');
    // the crashed worker coming back cannot overwrite the result
    assert.strictEqual(s.complete(claimed.id, 'A', { late: true }), false);
    assert.deepStrictEqual(s.get(claimed.id).result, { changed: 0 });
});

test('failures retry with backoff, then fail for good', async () => {
    const clock = fakeClock(T0);
    const s = createScheduler(openDb('sch'), { prefix: 'blog', now: clock, maxAttempts: 2, backoffMs: [1000] });
    s.schedule({ entityId: 'p', action: 'unpublish', runAt: T0 });
    const boom = () => { throw new Error('media service down'); };
    let out = await s.runDue({ worker: 'w', handler: boom });
    assert.strictEqual(out.retried.length, 1);
    assert.strictEqual(out.retried[0].lastError, 'media service down');
    assert.strictEqual((await s.runDue({ worker: 'w', handler: boom })).retried.length, 0, 'waits for backoff');
    clock.advance(1000);
    out = await s.runDue({ worker: 'w', handler: boom });
    assert.strictEqual(out.failed.length, 1);
    assert.strictEqual(out.failed[0].status, 'failed');
});

test('a job whose workers keep crashing is abandoned after maxAttempts and reported as failed', async () => {
    const clock = fakeClock(T0);
    const s = createScheduler(openDb('sch'), { prefix: 'blog', now: clock, maxAttempts: 2, leaseMs: 1000 });
    s.schedule({ entityId: 'p', action: 'publish', runAt: T0, revision: 1 });
    s.claim({ worker: 'a' }); clock.advance(1001);
    s.claim({ worker: 'b' }); clock.advance(1001);
    const out = await s.runDue({ worker: 'c', handler: () => assert.fail('must not run a third time') });
    assert.strictEqual(out.failed.length, 1);
    assert.match(out.failed[0].lastError, /lease expired/);
});

test('cancel and cancelPending', () => {
    const s = createScheduler(openDb('sch'), { prefix: 'blog', now: fakeClock(T0) });
    const { job } = s.schedule({ entityId: 'p', action: 'publish', runAt: T0 + 1000, revision: 1 });
    s.schedule({ entityId: 'p', action: 'unpublish', runAt: T0 + 5000 });
    assert.strictEqual(s.cancel(job.id), true);
    assert.strictEqual(s.cancelPending('p', 'unpublish'), 1);
    assert.deepStrictEqual(s.jobs('p').map((j) => j.status), ['cancelled', 'cancelled']);
});

test('validation', () => {
    const s = createScheduler(openDb('sch'), { prefix: 'blog' });
    assert.throws(() => s.schedule({ entityId: 'p', action: 'delete', runAt: T0 }), /action/);
    assert.throws(() => s.schedule({ entityId: 'p', action: 'publish', runAt: 'soon' }), /runAt/);
    assert.throws(() => s.claim({}), /worker/);
});

run();
