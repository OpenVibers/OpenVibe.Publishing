'use strict';
const assert = require('assert');
const { openDb, fakeClock, suite } = require('./helpers/db');
const { createRevisionStore } = require('../lib/revisions');
const { createCitationStore, gateFacts } = require('../lib/citations');

const { test, run } = suite();

function setup() {
    const db = openDb('cite');
    const now = fakeClock();
    const revisions = createRevisionStore(db, { prefix: 'wiki_page', now });
    const cites = createCitationStore(db, { prefix: 'wiki', now, revisions });
    revisions.create({ entityId: 'pg', expectedRevision: 0, content: 'Rye is a grass.' });
    revisions.create({ entityId: 'pg', expectedRevision: 1, content: 'Rye is a grass grown as a grain.' });
    revisions.create({ entityId: 'pg', expectedRevision: 2, content: 'Rye is a cereal.' });
    return { db, now, revisions, cites };
}

test('a citation records source, retrieval time, quote span and license on one revision', () => {
    const { cites } = setup();
    const c = cites.attach({
        entityId: 'pg', revision: 1, sourceItemId: 'src_01J8Z6Q3KX0000000000000001', url: 'https://example.org/rye',
        title: 'Rye', retrievedAt: '2026-09-20T10:00:00Z', quote: { text: 'Rye is a grass', start: 0, end: 14 },
        licenseNote: 'CC BY-SA 4.0', anchor: '1', attachedBy: 'usr_01J8Z6Q3KX0000000000000000',
    });
    assert.strictEqual(c.revision, 1);
    assert.strictEqual(c.retrievedAt, '2026-09-20T10:00:00.000Z');
    assert.deepStrictEqual(c.quote, { text: 'Rye is a grass', start: 0, end: 14 });
    assert.strictEqual(c.licenseNote, 'CC BY-SA 4.0');
    assert.strictEqual(cites.table, 'wiki_citations');
});

test('nothing is filled in: unknown retrieval time and title stay null', () => {
    const { cites } = setup();
    const c = cites.attach({ entityId: 'pg', revision: 1, url: 'https://example.org/x' });
    assert.strictEqual(c.retrievedAt, null);
    assert.strictEqual(c.title, null);
    assert.strictEqual(c.licenseNote, null);
    assert.strictEqual(c.quote, null);
    assert.deepStrictEqual(gateFacts([c]), { citationCount: 1, datedCitationCount: 0 });
});

test('citations stay attached to the revision that used them after later revisions drop them', () => {
    const { cites } = setup();
    const a = cites.attach({ entityId: 'pg', revision: 1, url: 'https://example.org/a' });
    const b = cites.attach({ entityId: 'pg', revision: 1, url: 'https://example.org/b' });
    const carried = cites.carryForward({ entityId: 'pg', fromRevision: 1, toRevision: 2, ids: [a.id] });
    assert.strictEqual(carried.length, 1);
    assert.strictEqual(carried[0].carriedFrom, a.id);
    // revision 3 reuses nothing
    assert.deepStrictEqual(cites.forRevision('pg', 3), []);
    assert.deepStrictEqual(cites.forRevision('pg', 1).map((c) => c.url), ['https://example.org/a', 'https://example.org/b']);
    assert.deepStrictEqual(cites.forRevision('pg', 2).map((c) => c.url), ['https://example.org/a']);
    assert.strictEqual(cites.history('pg').length, 3);
    assert.ok(cites.get(b.id));
});

test('citation rows cannot be updated or deleted outside an audited purge', () => {
    const { db, cites } = setup();
    cites.attach({ entityId: 'pg', revision: 1, url: 'https://example.org/a' });
    assert.throws(() => db.prepare("UPDATE wiki_citations SET url = 'https://evil.test'").run(), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM wiki_citations').run(), /never deleted/);
    assert.deepStrictEqual(cites.purgeEntity('pg', { reason: 'legal' }), { deleted: 1 });
    assert.throws(() => cites.attach({ entityId: 'pg', revision: 1, url: 'https://example.org/a' }), (e) => e.status === 410);
});

test('validation: a source is required, URLs are http(s), revisions must exist, spans are ordered', () => {
    const { cites } = setup();
    assert.throws(() => cites.attach({ entityId: 'pg', revision: 1 }), (e) => e.code === 'citation.no_source');
    assert.throws(() => cites.attach({ entityId: 'pg', revision: 1, url: 'javascript:alert(1)' }), /http/);
    assert.throws(() => cites.attach({ entityId: 'pg', revision: 9, url: 'https://example.org' }), (e) => e.code === 'revision.not_found');
    assert.throws(() => cites.attach({ entityId: 'pg', revision: 1, url: 'https://example.org', quote: { start: 5, end: 2 } }), /span/);
    assert.throws(() => cites.attach({ entityId: 'pg', revision: 1, url: 'https://example.org', retrievedAt: 'yesterday' }), /retrievedAt/);
});

test('bySourceItem finds every revision citing a source (correction propagation)', () => {
    const { cites } = setup();
    cites.attach({ entityId: 'pg', revision: 1, sourceItemId: 'src_A' });
    cites.attach({ entityId: 'pg', revision: 3, sourceItemId: 'src_A' });
    assert.deepStrictEqual(cites.bySourceItem('src_A').map((c) => c.revision), [1, 3]);
});

run();
