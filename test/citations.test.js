'use strict';
const assert = require('assert');
const { openDb, countQueries, fakeClock, suite, sql } = require('./helpers/db');
const { createRevisionStore } = require('../lib/revisions');
const { createCitationStore, gateFacts } = require('../lib/citations');

const { test, run } = suite();

async function setup() {
    const db = await openDb();
    const now = fakeClock();
    const revisions = await createRevisionStore(db, { prefix: 'wiki_page', now }).ensureSchema();
    const cites = await createCitationStore(db, { prefix: 'wiki', now, revisions }).ensureSchema();
    await revisions.create({ entityId: 'pg', expectedRevision: 0, content: 'Rye is a grass.' });
    await revisions.create({ entityId: 'pg', expectedRevision: 1, content: 'Rye is a grass grown as a grain.' });
    await revisions.create({ entityId: 'pg', expectedRevision: 2, content: 'Rye is a cereal.' });
    return { db, now, revisions, cites };
}

test('a citation records source, retrieval time, quote span and license on one revision', async () => {
    const { cites } = await setup();
    const c = await cites.attach({
        entityId: 'pg', revision: 1, sourceItemId: 'src_01J8Z6Q3KX0000000000000001', url: 'https://example.org/rye',
        title: 'Rye', retrievedAt: '2026-09-20T10:00:00Z', quote: { text: 'Rye is a grass', start: 0, end: 14 },
        licenseNote: 'CC BY-SA 4.0', anchor: '1', attachedBy: 'usr_01J8Z6Q3KX0000000000000000',
    });
    assert.strictEqual(c.revision, 1);
    assert.strictEqual(typeof c.id, 'number', 'bigint identity comes back as a Number');
    assert.strictEqual(c.retrievedAt, '2026-09-20T10:00:00.000Z');
    assert.deepStrictEqual(c.quote, { text: 'Rye is a grass', start: 0, end: 14 });
    assert.strictEqual(c.licenseNote, 'CC BY-SA 4.0');
    assert.strictEqual(cites.table, 'wiki_citations');
    assert.deepStrictEqual(await cites.get(c.id), c);
    assert.strictEqual(await cites.get('nope'), null);
});

test('nothing is filled in: unknown retrieval time and title stay null', async () => {
    const { cites } = await setup();
    const c = await cites.attach({ entityId: 'pg', revision: 1, url: 'https://example.org/x' });
    assert.strictEqual(c.retrievedAt, null);
    assert.strictEqual(c.title, null);
    assert.strictEqual(c.licenseNote, null);
    assert.strictEqual(c.quote, null);
    assert.deepStrictEqual(gateFacts([c]), { citationCount: 1, datedCitationCount: 0 });
});

test('citations stay attached to the revision that used them after later revisions drop them', async () => {
    const { cites } = await setup();
    const a = await cites.attach({ entityId: 'pg', revision: 1, url: 'https://example.org/a' });
    const b = await cites.attach({ entityId: 'pg', revision: 1, url: 'https://example.org/b' });
    const carried = await cites.carryForward({ entityId: 'pg', fromRevision: 1, toRevision: 2, ids: [a.id] });
    assert.strictEqual(carried.length, 1);
    assert.strictEqual(carried[0].carriedFrom, a.id);
    assert.strictEqual(carried[0].revision, 2);
    // revision 3 reuses nothing
    assert.deepStrictEqual(await cites.forRevision('pg', 3), []);
    assert.deepStrictEqual((await cites.forRevision('pg', 1)).map((c) => c.url), ['https://example.org/a', 'https://example.org/b']);
    assert.deepStrictEqual((await cites.forRevision('pg', 2)).map((c) => c.url), ['https://example.org/a']);
    assert.strictEqual((await cites.history('pg')).length, 3);
    assert.ok(await cites.get(b.id));
    // carrying a carried citation points at the original, not the copy
    const again = await cites.carryForward({ entityId: 'pg', fromRevision: 2, toRevision: 3, attachedBy: 'usr_x' });
    assert.strictEqual(again[0].carriedFrom, a.id);
    assert.strictEqual(again[0].attachedBy, 'usr_x');
});

test('citation rows cannot be updated or deleted outside an audited purge', async () => {
    const { db, cites } = await setup();
    await cites.attach({ entityId: 'pg', revision: 1, url: 'https://example.org/a' });
    await assert.rejects(db.exec(sql`UPDATE wiki_citations SET url = 'https://evil.test'`), /immutable/);
    await assert.rejects(db.exec(sql`DELETE FROM wiki_citations`), /never deleted/);
    assert.deepStrictEqual(await cites.purgeEntity('pg', { reason: 'legal' }), { deleted: 1 });
    await assert.rejects(cites.attach({ entityId: 'pg', revision: 1, url: 'https://example.org/a' }), (e) => e.status === 410);
});

test('validation: a source is required, URLs are http(s), revisions must exist, spans are ordered', async () => {
    const { cites } = await setup();
    await assert.rejects(cites.attach({ entityId: 'pg', revision: 1 }), (e) => e.code === 'citation.no_source');
    await assert.rejects(cites.attach({ entityId: 'pg', revision: 1, url: 'javascript:alert(1)' }), /http/);
    await assert.rejects(cites.attach({ entityId: 'pg', revision: 9, url: 'https://example.org' }), (e) => e.code === 'revision.not_found');
    await assert.rejects(cites.attach({ entityId: 'pg', revision: 1, url: 'https://example.org', quote: { start: 5, end: 2 } }), /span/);
    await assert.rejects(cites.attach({ entityId: 'pg', revision: 1, url: 'https://example.org', retrievedAt: 'yesterday' }), /retrievedAt/);
    await assert.rejects(cites.attachMany('pg', 1, [{ url: 'https://example.org/ok' }, { title: 'no source' }]), (e) => e.code === 'citation.no_source');
    assert.deepStrictEqual(await cites.history('pg'), [], 'a refused batch writes nothing');
});

test('bySourceItem finds every revision citing a source (correction propagation), in keyset pages', async () => {
    const { cites, revisions } = await setup();
    await cites.attach({ entityId: 'pg', revision: 1, sourceItemId: 'src_A' });
    await cites.attach({ entityId: 'pg', revision: 3, sourceItemId: 'src_A' });
    await revisions.create({ entityId: 'other', expectedRevision: 0, content: 'x' });
    await cites.attach({ entityId: 'other', revision: 1, sourceItemId: 'src_A' });
    assert.deepStrictEqual((await cites.bySourceItem('src_A')).map((c) => [c.entityId, c.revision]), [['other', 1], ['pg', 1], ['pg', 3]]);
    const page1 = await cites.bySourceItem('src_A', { limit: 2 });
    const page2 = await cites.bySourceItem('src_A', { limit: 2, after: page1[1] });
    assert.deepStrictEqual([...page1, ...page2].map((c) => c.revision), [1, 1, 3]);
});

test('attachMany writes a batch in one INSERT: the statements do not grow with the batch', async () => {
    const { db, cites } = await setup();
    const few = await countQueries(db, () => cites.attachMany('pg', 1, [{ url: 'https://example.org/1' }]));
    const many = await countQueries(db, () => cites.attachMany('pg', 2, Array.from({ length: 40 }, (_, i) => ({ url: `https://example.org/${i}` }))));
    assert.strictEqual(many.count, few.count);
    assert.deepStrictEqual(many.out.map((c) => c.url).slice(0, 3), ['https://example.org/0', 'https://example.org/1', 'https://example.org/2'], 'input order kept');
    const carried = await countQueries(db, () => cites.carryForward({ entityId: 'pg', fromRevision: 2, toRevision: 3 }));
    assert.strictEqual(carried.out.length, 40);
    assert.ok(carried.count <= few.count, `carryForward is one INSERT … SELECT (${carried.count} statements)`);
});

run();
