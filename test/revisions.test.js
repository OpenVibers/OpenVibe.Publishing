'use strict';
const assert = require('assert');
const { openDb, countQueries, fakeClock, suite, sql } = require('./helpers/db');
const { createRevisionStore, diffText, schema } = require('../lib/revisions');
const { formatLines } = require('../lib/diff');

const { test, run } = suite();
const USER = 'user:usr_01J8Z6Q3KX0000000000000000';

async function store(prefix, opts = {}) {
    const db = opts.db || await openDb();
    const revs = await createRevisionStore(db, { prefix, ...opts }).ensureSchema();
    return { db, revs };
}

test('create → edit → revert keeps an immutable lineage with parent pointers', async () => {
    const { revs } = await store('wiki_page', { now: fakeClock() });
    const r1 = (await revs.create({ entityId: 'pg_1', expectedRevision: 0, content: 'Bread is baked.\n', fields: { title: 'Bread' }, author: USER })).revision;
    const r2 = (await revs.create({ entityId: 'pg_1', expectedRevision: 1, content: 'Bread is baked dough.\nIt is old.\n', fields: { title: 'Bread' }, author: USER })).revision;
    assert.strictEqual(r1.number, 1);
    assert.strictEqual(r1.parentId, null);
    assert.strictEqual(r2.parentId, r1.id);
    assert.strictEqual(r2.parentNumber, 1);
    const r3 = (await revs.revert({ entityId: 'pg_1', toRevision: 1, expectedRevision: 2, author: USER })).revision;
    assert.strictEqual(r3.number, 3);
    assert.strictEqual(r3.kind, 'revert');
    assert.strictEqual(r3.revertedTo, 1);
    assert.strictEqual(r3.parentId, r2.id);
    assert.strictEqual(r3.content, r1.content);
    assert.deepStrictEqual(r3.meta, { revertedFrom: 2 });
    assert.deepStrictEqual(r3.fields, { title: 'Bread' }, 'jsonb comes back parsed');
    assert.deepStrictEqual((await revs.lineage('pg_1')).map((r) => r.number), [3, 2, 1]);
    assert.deepStrictEqual((await revs.lineage('pg_1', 2)).map((r) => r.number), [2, 1]);
    assert.deepStrictEqual((await revs.lineage('pg_1', null, { limit: 2 })).map((r) => r.number), [3, 2], 'lineage is bounded');
    assert.strictEqual((await revs.get('pg_1', 2)).content, 'Bread is baked dough.\nIt is old.\n', 'revert did not rewrite history');
    assert.strictEqual(await revs.exists('pg_1', 2), true);
    assert.strictEqual(await revs.exists('pg_1', 9), false);
    assert.strictEqual((await revs.getById(r2.id)).number, 2);
    assert.deepStrictEqual(Object.keys(revs.tables), ['revisions', 'drafts', 'purges']);
    assert.strictEqual(revs.tables.revisions, 'wiki_page_revisions');
    assert.strictEqual(r1.createdAt, '2026-09-22T12:00:00.000Z', 'epoch milliseconds (bigint) round-trip');
});

test('rows are immutable in PostgreSQL itself (UPDATE and DELETE abort in the PL/pgSQL trigger)', async () => {
    const { db, revs } = await store('blog_post');
    await revs.create({ entityId: 'p', expectedRevision: 0, content: 'x' });
    await assert.rejects(db.exec(sql`UPDATE blog_post_revisions SET content = ${'y'}`), (e) => /immutable/.test(e.message) && e.code === '23001');
    await assert.rejects(db.exec(sql`DELETE FROM blog_post_revisions`), /never deleted/);
    assert.strictEqual((await revs.head('p')).content, 'x');
});

test('optimistic concurrency: a stale expectedRevision is a 412 conflict', async () => {
    const { revs } = await store('wiki_page');
    await revs.create({ entityId: 'pg', expectedRevision: 0, content: 'a' });
    await revs.create({ entityId: 'pg', expectedRevision: 1, content: 'b' });
    let err;
    try { await revs.create({ entityId: 'pg', expectedRevision: 1, content: 'c' }); } catch (e) { err = e; }
    assert.ok(err, 'conflict thrown');
    assert.strictEqual(err.status, 412);
    assert.strictEqual(err.code, 'revision.conflict');
    assert.strictEqual(err.expected, 1);
    assert.strictEqual(err.current, 2);
    assert.strictEqual(await revs.headNumber('pg'), 2);
    await assert.rejects(revs.create({ entityId: 'new', content: 'x' }), /expectedRevision/, 'expectedRevision is required');
});

test('a second store instance on the same database (another process) with a stale base revision gets 412', async () => {
    const db = await openDb();
    const a = await createRevisionStore(db, { prefix: 'wiki_page' }).ensureSchema();
    const b = createRevisionStore(db, { prefix: 'wiki_page' });
    await a.create({ entityId: 'pg', expectedRevision: 0, content: 'base' });
    await a.create({ entityId: 'pg', expectedRevision: 1, content: 'from a' });
    await assert.rejects(b.create({ entityId: 'pg', expectedRevision: 1, content: 'from b' }), (e) => e.status === 412);
    // Concurrent writers of one entity with the same base: exactly one lands.
    const results = await Promise.allSettled([2, 2, 2].map((n, i) => b.create({ entityId: 'pg', expectedRevision: n, content: `race ${i}` })));
    assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.status === 412));
    assert.strictEqual(await a.headNumber('pg'), 3);
});

test('unchanged edits do not create empty revisions', async () => {
    const { revs } = await store('w');
    await revs.create({ entityId: 'e', expectedRevision: 0, content: 'same', fields: { a: 1, b: 2 } });
    const again = await revs.create({ entityId: 'e', expectedRevision: 1, content: 'same', fields: { b: 2, a: 1 } });
    assert.strictEqual(again.created, false);
    assert.strictEqual(await revs.headNumber('e'), 1);
});

test('line and word diffs', async () => {
    const { revs } = await store('w');
    await revs.create({ entityId: 'e', expectedRevision: 0, content: 'one\ntwo\nthree\n', fields: { title: 'A' } });
    await revs.create({ entityId: 'e', expectedRevision: 1, content: 'one\n2\nthree\nfour\n', fields: { title: 'B', tag: 'x' } });
    const d = await revs.diff('e', 1, 2);
    assert.strictEqual(d.content.mode, 'line');
    assert.deepStrictEqual(d.content.ops, [
        { op: 'equal', text: 'one\n' }, { op: 'delete', text: 'two\n' }, { op: 'insert', text: '2\n' },
        { op: 'equal', text: 'three\n' }, { op: 'insert', text: 'four\n' },
    ]);
    assert.strictEqual(d.content.added, 2);
    assert.strictEqual(d.content.removed, 1);
    assert.deepStrictEqual(d.fields, [{ field: 'tag', from: null, to: 'x' }, { field: 'title', from: 'A', to: 'B' }]);
    assert.strictEqual(formatLines(d.content), '  one\n- two\n+ 2\n  three\n+ four');
    await assert.rejects(revs.diff('e', 1, 7), (e) => e.code === 'revision.not_found');

    const w = diffText('The quick brown fox', 'The slow brown fox jumps', { mode: 'word' });
    const rebuiltOld = w.ops.filter((o) => o.op !== 'insert').map((o) => o.text).join('');
    const rebuiltNew = w.ops.filter((o) => o.op !== 'delete').map((o) => o.text).join('');
    assert.strictEqual(rebuiltOld, 'The quick brown fox');
    assert.strictEqual(rebuiltNew, 'The slow brown fox jumps');
    assert.ok(w.ops.some((o) => o.op === 'delete' && o.text === 'quick'));
    assert.ok(w.ops.some((o) => o.op === 'insert' && o.text === 'slow'));
});

test('diff reconstructs both sides on random inputs', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const words = ['a', 'b', 'c', 'd', 'e'];
    for (let i = 0; i < 200; i++) {
        const mk = () => Array.from({ length: Math.floor(rnd() * 12) }, () => words[Math.floor(rnd() * words.length)]).join('\n');
        const a = mk();
        const b = mk();
        const r = diffText(a, b, { mode: 'line' });
        assert.strictEqual(r.ops.filter((o) => o.op !== 'insert').map((o) => o.text).join(''), a);
        assert.strictEqual(r.ops.filter((o) => o.op !== 'delete').map((o) => o.text).join(''), b);
    }
});

test('a huge rewrite falls back to an approximate diff instead of exhausting memory', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
    const r = diffText(a, b, { maxEdits: 100 });
    assert.strictEqual(r.approximate, true);
    assert.strictEqual(r.ops.filter((o) => o.op !== 'insert').map((o) => o.text).join(''), a);
});

test('drafts: save, commit on the base revision, conflict keeps the draft', async () => {
    const { revs } = await store('blog_post', { now: fakeClock() });
    await revs.create({ entityId: 'p1', expectedRevision: 0, content: 'v1' });
    const d = await revs.saveDraft({ entityId: 'p1', owner: USER, content: 'my edit' });
    assert.strictEqual(d.baseRevision, 1);
    assert.strictEqual(d.stale, false);
    await revs.create({ entityId: 'p1', expectedRevision: 1, content: 'someone else' });
    assert.strictEqual((await revs.getDraft('p1', USER)).stale, true);
    await assert.rejects(revs.commitDraft({ entityId: 'p1', owner: USER }), (e) => e.status === 412);
    assert.ok(await revs.getDraft('p1', USER), 'draft survives a conflict');
    await revs.saveDraft({ entityId: 'p1', owner: USER, content: 'rebased edit', baseRevision: 2 });
    const out = await revs.commitDraft({ entityId: 'p1', owner: USER, message: 'rebased' });
    assert.strictEqual(out.revision.number, 3);
    assert.strictEqual(out.revision.author, USER);
    assert.strictEqual(await revs.getDraft('p1', USER), null);
    await assert.rejects(revs.commitDraft({ entityId: 'p1', owner: USER }), (e) => e.code === 'draft.not_found');
    assert.strictEqual(await revs.discardDraft('p1', USER), false);
});

test('drafts() answers in one query however many drafts there are, with each one\'s staleness', async () => {
    const { db, revs } = await store('wiki_page', { now: fakeClock() });
    await revs.create({ entityId: 'pg', expectedRevision: 0, content: 'v1' });
    for (let i = 0; i < 6; i++) await revs.saveDraft({ entityId: 'pg', owner: `user:usr_${i}`, content: `edit ${i}`, baseRevision: i % 2 ? 0 : 1 });
    const { count, out } = await countQueries(db, () => revs.drafts('pg'));
    assert.strictEqual(count, 1, 'no N+1: one query for every draft and the head');
    assert.strictEqual(out.length, 6);
    assert.deepStrictEqual(out.map((d) => d.stale).sort(), [false, false, false, true, true, true]);
    const listed = await countQueries(db, () => revs.list('pg'));
    assert.strictEqual(listed.count, 1);
});

test('list() pages with a keyset cursor, newest first', async () => {
    const { revs } = await store('w');
    for (let i = 0; i < 7; i++) await revs.create({ entityId: 'e', expectedRevision: i, content: `v${i}` });
    const page1 = await revs.list('e', { limit: 3 });
    assert.deepStrictEqual(page1.map((r) => r.number), [7, 6, 5]);
    const page2 = await revs.list('e', { limit: 3, before: page1[2].number });
    assert.deepStrictEqual(page2.map((r) => r.number), [4, 3, 2]);
    assert.deepStrictEqual((await revs.list('e', { before: 2 })).map((r) => r.number), [1]);
});

test('purge is explicit, audited and final', async () => {
    const { db, revs } = await store('w');
    await revs.create({ entityId: 'gone', expectedRevision: 0, content: 'x' });
    await revs.create({ entityId: 'kept', expectedRevision: 0, content: 'y' });
    await revs.saveDraft({ entityId: 'gone', owner: USER, content: 'draft' });
    await assert.rejects(revs.purgeEntity('gone'), /reason/);
    assert.deepStrictEqual(await revs.purgeEntity('gone', { reason: 'legal request #12', purgedBy: USER }), { deleted: 1 });
    assert.strictEqual(await revs.head('gone'), null);
    assert.strictEqual(await revs.getDraft('gone', USER), null);
    assert.ok(await revs.head('kept'));
    assert.strictEqual(await db.value(sql`SELECT reason FROM w_revision_purges WHERE entity_id = ${'gone'}`), 'legal request #12');
    await assert.rejects(revs.create({ entityId: 'gone', expectedRevision: 0, content: 'again' }), (e) => e.status === 410);
    await assert.rejects(db.exec(sql`DELETE FROM w_revisions WHERE entity_id = 'kept'`), /never deleted/);
});

test('prefix and handle are validated; schema creation is idempotent', async () => {
    const db = await openDb();
    assert.throws(() => createRevisionStore(db, { prefix: 'Bad-Prefix' }), /prefix/);
    assert.throws(() => createRevisionStore(db, { prefix: 'x; DROP TABLE y' }), /prefix/);
    assert.throws(() => schema('x; DROP TABLE y'), /prefix/);
    assert.throws(() => createRevisionStore({}, { prefix: 'ok' }), /openvibe-sdk\/db/);
    assert.throws(() => createRevisionStore({ prepare() {}, transaction() {} }, { prefix: 'ok' }), /better-sqlite3 handles are 0\.4\.x/);
    await createRevisionStore(db, { prefix: 'twice' }).ensureSchema();
    await createRevisionStore(db, { prefix: 'twice' }).ensureSchema();
    assert.strictEqual(createRevisionStore(db, { prefix: 'twice' }).schema(), schema('twice'));
});

run();
