'use strict';
const assert = require('assert');
const { openDb, fakeClock, suite } = require('./helpers/db');
const { createRevisionStore, diffText } = require('../lib/revisions');
const { formatLines } = require('../lib/diff');

const { test, run } = suite();
const USER = 'user:usr_01J8Z6Q3KX0000000000000000';

test('create → edit → revert keeps an immutable lineage with parent pointers', () => {
    const db = openDb('rev');
    const revs = createRevisionStore(db, { prefix: 'wiki_page', now: fakeClock() });
    const r1 = revs.create({ entityId: 'pg_1', expectedRevision: 0, content: 'Bread is baked.\n', fields: { title: 'Bread' }, author: USER }).revision;
    const r2 = revs.create({ entityId: 'pg_1', expectedRevision: 1, content: 'Bread is baked dough.\nIt is old.\n', fields: { title: 'Bread' }, author: USER }).revision;
    assert.strictEqual(r1.number, 1);
    assert.strictEqual(r1.parentId, null);
    assert.strictEqual(r2.parentId, r1.id);
    assert.strictEqual(r2.parentNumber, 1);
    const r3 = revs.revert({ entityId: 'pg_1', toRevision: 1, expectedRevision: 2, author: USER }).revision;
    assert.strictEqual(r3.number, 3);
    assert.strictEqual(r3.kind, 'revert');
    assert.strictEqual(r3.revertedTo, 1);
    assert.strictEqual(r3.parentId, r2.id);
    assert.strictEqual(r3.content, r1.content);
    assert.deepStrictEqual(revs.lineage('pg_1').map((r) => r.number), [3, 2, 1]);
    assert.strictEqual(revs.get('pg_1', 2).content, 'Bread is baked dough.\nIt is old.\n', 'revert did not rewrite history');
    assert.deepStrictEqual(Object.keys(revs.tables), ['revisions', 'drafts', 'purges']);
    assert.strictEqual(revs.tables.revisions, 'wiki_page_revisions');
});

test('rows are immutable in SQLite itself (UPDATE and DELETE abort)', () => {
    const db = openDb('rev');
    const revs = createRevisionStore(db, { prefix: 'blog_post' });
    revs.create({ entityId: 'p', expectedRevision: 0, content: 'x' });
    assert.throws(() => db.prepare('UPDATE blog_post_revisions SET content = ?').run('y'), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM blog_post_revisions').run(), /never deleted/);
    assert.strictEqual(revs.head('p').content, 'x');
});

test('optimistic concurrency: a stale expectedRevision is a 412 conflict', () => {
    const db = openDb('rev');
    const revs = createRevisionStore(db, { prefix: 'wiki_page' });
    revs.create({ entityId: 'pg', expectedRevision: 0, content: 'a' });
    revs.create({ entityId: 'pg', expectedRevision: 1, content: 'b' });
    let err;
    try { revs.create({ entityId: 'pg', expectedRevision: 1, content: 'c' }); } catch (e) { err = e; }
    assert.ok(err, 'conflict thrown');
    assert.strictEqual(err.status, 412);
    assert.strictEqual(err.code, 'revision.conflict');
    assert.strictEqual(err.expected, 1);
    assert.strictEqual(err.current, 2);
    assert.strictEqual(revs.headNumber('pg'), 2);
    assert.throws(() => revs.create({ entityId: 'new', content: 'x' }), /expectedRevision/, 'expectedRevision is required');
});

test('a second connection on the same file with a stale base revision gets 412', () => {
    const db = openDb('race');
    const other = new (require('better-sqlite3'))(db.name);
    const a = createRevisionStore(db, { prefix: 'wiki_page' });
    const b = createRevisionStore(other, { prefix: 'wiki_page' });
    a.create({ entityId: 'pg', expectedRevision: 0, content: 'base' });
    a.create({ entityId: 'pg', expectedRevision: 1, content: 'from a' });
    assert.throws(() => b.create({ entityId: 'pg', expectedRevision: 1, content: 'from b' }), (e) => e.status === 412);
    other.close();
});

test('unchanged edits do not create empty revisions', () => {
    const revs = createRevisionStore(openDb('rev'), { prefix: 'w' });
    revs.create({ entityId: 'e', expectedRevision: 0, content: 'same', fields: { a: 1, b: 2 } });
    const again = revs.create({ entityId: 'e', expectedRevision: 1, content: 'same', fields: { b: 2, a: 1 } });
    assert.strictEqual(again.created, false);
    assert.strictEqual(revs.headNumber('e'), 1);
});

test('line and word diffs', () => {
    const revs = createRevisionStore(openDb('rev'), { prefix: 'w' });
    revs.create({ entityId: 'e', expectedRevision: 0, content: 'one\ntwo\nthree\n', fields: { title: 'A' } });
    revs.create({ entityId: 'e', expectedRevision: 1, content: 'one\n2\nthree\nfour\n', fields: { title: 'B', tag: 'x' } });
    const d = revs.diff('e', 1, 2);
    assert.strictEqual(d.content.mode, 'line');
    assert.deepStrictEqual(d.content.ops, [
        { op: 'equal', text: 'one\n' }, { op: 'delete', text: 'two\n' }, { op: 'insert', text: '2\n' },
        { op: 'equal', text: 'three\n' }, { op: 'insert', text: 'four\n' },
    ]);
    assert.strictEqual(d.content.added, 2);
    assert.strictEqual(d.content.removed, 1);
    assert.deepStrictEqual(d.fields, [{ field: 'tag', from: null, to: 'x' }, { field: 'title', from: 'A', to: 'B' }]);
    assert.strictEqual(formatLines(d.content), '  one\n- two\n+ 2\n  three\n+ four');

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

test('drafts: save, commit on the base revision, conflict keeps the draft', () => {
    const revs = createRevisionStore(openDb('rev'), { prefix: 'blog_post', now: fakeClock() });
    revs.create({ entityId: 'p1', expectedRevision: 0, content: 'v1' });
    const d = revs.saveDraft({ entityId: 'p1', owner: USER, content: 'my edit' });
    assert.strictEqual(d.baseRevision, 1);
    assert.strictEqual(d.stale, false);
    revs.create({ entityId: 'p1', expectedRevision: 1, content: 'someone else' });
    assert.strictEqual(revs.getDraft('p1', USER).stale, true);
    assert.throws(() => revs.commitDraft({ entityId: 'p1', owner: USER }), (e) => e.status === 412);
    assert.ok(revs.getDraft('p1', USER), 'draft survives a conflict');
    revs.saveDraft({ entityId: 'p1', owner: USER, content: 'rebased edit', baseRevision: 2 });
    const out = revs.commitDraft({ entityId: 'p1', owner: USER, message: 'rebased' });
    assert.strictEqual(out.revision.number, 3);
    assert.strictEqual(out.revision.author, USER);
    assert.strictEqual(revs.getDraft('p1', USER), null);
});

test('purge is explicit, audited and final', () => {
    const db = openDb('rev');
    const revs = createRevisionStore(db, { prefix: 'w' });
    revs.create({ entityId: 'gone', expectedRevision: 0, content: 'x' });
    revs.create({ entityId: 'kept', expectedRevision: 0, content: 'y' });
    assert.throws(() => revs.purgeEntity('gone'), /reason/);
    assert.deepStrictEqual(revs.purgeEntity('gone', { reason: 'legal request #12', purgedBy: USER }), { deleted: 1 });
    assert.strictEqual(revs.head('gone'), null);
    assert.ok(revs.head('kept'));
    assert.strictEqual(db.prepare('SELECT reason FROM w_revision_purges WHERE entity_id = ?').get('gone').reason, 'legal request #12');
    assert.throws(() => revs.create({ entityId: 'gone', expectedRevision: 0, content: 'again' }), (e) => e.status === 410);
    assert.throws(() => db.prepare("DELETE FROM w_revisions WHERE entity_id = 'kept'").run(), /never deleted/);
});

test('prefix and handle are validated; schema creation is idempotent', () => {
    const db = openDb('rev');
    assert.throws(() => createRevisionStore(db, { prefix: 'Bad-Prefix' }), /prefix/);
    assert.throws(() => createRevisionStore(db, { prefix: 'x; DROP TABLE y' }), /prefix/);
    assert.throws(() => createRevisionStore({}, { prefix: 'ok' }), /better-sqlite3/);
    createRevisionStore(db, { prefix: 'twice' });
    createRevisionStore(db, { prefix: 'twice' });
});

run();
