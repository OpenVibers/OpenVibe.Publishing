'use strict';
/**
 * openvibe-publishing/publication (1.1.0): the shared publication glue.
 *
 *   - createPublication stamps + enqueues on the CALLER's transaction handle: the sequencer revision and
 *     the outbox row commit together or roll back together (ADR-004);
 *   - it emits exactly search.index-document@1 (carried by <owner>.index_document.upserted|deleted,
 *     checked the way OpenVibe.Search's webhook reads it) and valid <owner>.<type>.<action> events;
 *   - tombstones on unpublish/merge, and nothing for a resource that was never indexed;
 *   - the IndexNow ping for an indexable page that appeared/changed or a page that went away.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { createPgOutbox } = require('openvibe-sdk/events');
const { openDb, fakeClock, suite, sql } = require('./helpers/db');
const hooks = require('../lib/index-hooks');
const seo = require('../lib/seo');
const { createIndexSequencer } = require('../lib/index-hooks');
const { createPublication } = require('../lib/publication');

const { test, run } = suite();
const USER = 'usr_01J8Z6Q3KX0000000000000000';

const valid = (doc) => {
    const v = contracts.validate('search.index-document@1', doc);
    assert.ok(v.valid, `search.index-document@1: ${JSON.stringify(v.errors)} in ${JSON.stringify(doc)}`);
    return doc;
};
const validEnvelope = (env) => {
    const v = contracts.validate('events.event-envelope@1', { ...env, event_id: env.event_id || contracts.ids.newId('event') });
    assert.ok(v.valid, `events.event-envelope@1: ${JSON.stringify(v.errors)}`);
    return env;
};
/** What OpenVibe.Search's webhook (server/api/webhook.js documentFromEvent) does with an envelope. */
function searchReads(env) {
    const m = /^([a-z][a-z0-9-]{1,39})\.index_document\.(upserted|deleted)$/.exec(env.event_type);
    assert.ok(m, `not an index_document event: ${env.event_type}`);
    assert.strictEqual(m[1], env.source, 'event_type owner must be the source');
    const p = env.payload;
    if (p.owner !== undefined) assert.strictEqual(p.owner, env.source);
    const doc = m[2] === 'deleted' ? { owner: env.source, type: p.type, id: p.id, revision: p.revision, deleted: true } : { ...p, owner: env.source };
    assert.strictEqual(env.subject.type, doc.type);
    assert.strictEqual(env.subject.id, doc.id);
    assert.strictEqual(env.subject.revision, doc.revision);
    assert.strictEqual(env.visibility, 'internal');
    return valid(doc);
}

const facts = { state: 'published', visibility: 'public', canonicalUrl: 'https://openvibe.wiki/p/rye', wordCount: 400, citationCount: 2 };
const decisionFor = (extra = {}) => seo.evaluate({ ...facts, ...extra }, { policy: { requireSources: true } });
const input = (extra = {}) => ({
    owner: 'wiki', type: 'page', id: 'pg_1', revision: 0, state: 'published', visibility: 'public',
    canonicalUrl: 'https://openvibe.wiki/p/rye', title: 'Rye', summary: 'A cereal grass.', body: 'Rye is a grass grown as a grain.',
    facets: { space: 'food' }, authorship: { mode: 'human' },
    decision: decisionFor(), publishedAt: '2026-09-20T12:00:00Z', updatedAt: '2026-09-21T12:00:00Z', language: 'en', ...extra,
});

/** A publication wired to a real pg outbox with a stub Events client (only enqueue is exercised). */
async function setup() {
    const db = await openDb();
    const clock = fakeClock();
    const sequencer = await createIndexSequencer(db, { prefix: 'x', now: clock }).ensureSchema();
    const events = { prepare: (env) => ({ ...env, event_id: contracts.ids.newId('event') }), publish: async () => ({ results: [] }) };
    const outbox = createPgOutbox(db, { events, table: 'x_outbox', now: clock });
    await outbox.ensureSchema();
    const indexnow = { enabled: true, pings: [], pingSoon(urls) { this.pings.push(urls); } };
    const publication = createPublication({ owner: 'wiki', sequencer, outbox, baseUrl: 'https://openvibe.wiki', indexnow, now: clock });
    const envelopes = () => db.many(sql`SELECT envelope FROM x_outbox ORDER BY id`);
    return { db, clock, sequencer, outbox, indexnow, publication, envelopes };
}

test('index: the sequencer revision and the Search event commit on the caller\'s handle, exactly search.index-document@1', async () => {
    const { db, sequencer, publication, envelopes, indexnow } = await setup();
    const doc = hooks.buildIndexDocument(input());
    let stamped;
    await db.tx(async (t) => { stamped = await publication.index(t, { document: doc, page: '/p/rye' }); });
    assert.strictEqual(stamped.revision, 1);
    assert.strictEqual(await sequencer.current('wiki', 'page', 'pg_1'), 1);
    const rows = await envelopes();
    assert.strictEqual(rows.length, 1);
    const env = validEnvelope(rows[0].envelope);
    assert.strictEqual(env.event_type, 'wiki.index_document.upserted');
    assert.deepStrictEqual(searchReads(env), stamped);
    assert.deepStrictEqual(indexnow.pings, [['https://openvibe.wiki/p/rye', 'https://openvibe.wiki/sitemap.xml']]);
    // An unchanged document is a no-op: same revision, no event, no ping.
    indexnow.pings.length = 0;
    const again = await db.tx(async (t) => await publication.index(t, { document: doc }));
    assert.strictEqual(again, null);
    assert.strictEqual((await envelopes()).length, 1);
    assert.deepStrictEqual(indexnow.pings, []);
});

test('index: a failed transaction rolls back the sequencer revision and its event together', async () => {
    const { db, sequencer, publication, envelopes } = await setup();
    const doc = hooks.buildIndexDocument(input());
    await db.tx(async (t) => { await publication.index(t, { document: doc }); });
    assert.strictEqual(await sequencer.current('wiki', 'page', 'pg_1'), 1);
    const changed = hooks.buildIndexDocument(input({ title: 'Rye (revised)' }));
    await assert.rejects(db.tx(async (t) => { await publication.index(t, { document: changed }); throw new Error('the product write failed'); }), /the product write failed/);
    assert.strictEqual(await sequencer.current('wiki', 'page', 'pg_1'), 1, 'the stamp rolled back with the product write');
    assert.strictEqual((await envelopes()).length, 1, 'no event survived the rollback');
    await assert.rejects(publication.index(doc), /transaction handle/);
});

test('tombstones on unpublish and merge; never-indexed resources send nothing', async () => {
    const { db, publication, envelopes, indexnow } = await setup();
    const doc = hooks.buildIndexDocument(input());
    await db.tx(async (t) => { await publication.index(t, { document: doc, page: '/p/rye' }); });
    indexnow.pings.length = 0;
    const tomb = await db.tx(async (t) => await publication.tombstone(t, { type: 'page', id: 'pg_1', page: '/p/rye' }));
    assert.strictEqual(tomb.revision, 2);
    const rows = await envelopes();
    const del = validEnvelope(rows[rows.length - 1].envelope);
    assert.strictEqual(del.event_type, 'wiki.index_document.deleted');
    assert.deepStrictEqual(del.payload, { type: 'page', id: 'pg_1', revision: 2 });
    assert.deepStrictEqual(searchReads(del), { owner: 'wiki', type: 'page', id: 'pg_1', revision: 2, deleted: true });
    assert.deepStrictEqual(indexnow.pings, [['https://openvibe.wiki/p/rye', 'https://openvibe.wiki/sitemap.xml']], 'a page Search had that went away is announced');
    // A second tombstone is a no-op.
    assert.strictEqual(await db.tx(async (t) => await publication.tombstone(t, { type: 'page', id: 'pg_1', page: '/p/rye' })), null);
    // A merge: the duplicate had been indexed, so its page is removed and announced.
    await db.tx(async (t) => { await publication.index(t, { document: hooks.buildIndexDocument(input({ id: 'pg_2', canonicalUrl: 'https://openvibe.wiki/p/rye-2' })), page: '/p/rye-2' }); });
    const before = (await envelopes()).length;
    const merged = await db.tx(async (t) => await publication.tombstone(t, { type: 'page', id: 'pg_2', page: '/p/rye-2' }));
    assert.strictEqual(merged.revision, 2);
    assert.strictEqual((await envelopes()).length, before + 1);
    // A resource that was never indexed gets no tombstone.
    assert.strictEqual(await db.tx(async (t) => await publication.tombstone(t, { type: 'page', id: 'pg_nope' })), null);
});

test('noindex documents are sent (Search keeps the noindex copy) but never pinged', async () => {
    const { db, publication, envelopes, indexnow } = await setup();
    const decision = decisionFor({ wordCount: 3, citationCount: 0 });
    assert.strictEqual(decision.indexable, false);
    const doc = hooks.buildIndexDocument(input({ id: 'pg_3', decision }));
    await db.tx(async (t) => { await publication.index(t, { document: doc, page: '/p/thin' }); });
    assert.strictEqual((await envelopes()).length, 1, 'the noindex document still reaches Search');
    assert.deepStrictEqual(indexnow.pings, [], 'a noindex page is never announced');
});

test('publication events <owner>.<type>.<action> are valid and public only when listable', async () => {
    const { db, publication, envelopes } = await setup();
    const doc = hooks.buildIndexDocument(input());
    await db.tx(async (t) => {
        await publication.publication(t, { type: 'page', action: 'published', id: 'pg_1', revision: 1, document: doc, decision: decisionFor(), actor: USER });
    });
    const env = validEnvelope((await envelopes())[0].envelope);
    assert.strictEqual(env.event_type, 'wiki.page.published');
    assert.strictEqual(env.visibility, 'public');
    assert.deepStrictEqual(env.payload, { canonical_url: 'https://openvibe.wiki/p/rye', publication_state: 'published', indexability: { decision: 'index', reasons: [] } });
    const tomb = hooks.tombstone({ owner: 'wiki', type: 'page', id: 'pg_1', revision: 2 });
    await db.tx(async (t) => {
        await publication.publication(t, { type: 'page', action: 'unpublished', id: 'pg_1', revision: 2, document: tomb, actor: 'svc:wiki' });
    });
    const del = validEnvelope((await envelopes())[1].envelope);
    assert.strictEqual(del.event_type, 'wiki.page.unpublished');
    assert.strictEqual(del.visibility, 'internal');
    assert.strictEqual(del.payload.publication_state, 'unpublished');
});

test('sync runs gate -> document -> stamp -> event in the caller\'s transaction', async () => {
    const { db, sequencer, publication, envelopes } = await setup();
    const entity = { id: 'pg_9', slug: 'nine' };
    const decide = () => seo.evaluate({ state: 'published', visibility: 'public', canonicalUrl: 'https://openvibe.wiki/p/nine', wordCount: 400, citationCount: 2 }, { policy: { requireSources: true } });
    const document = (e, decision) => hooks.buildIndexDocument({ owner: 'wiki', type: 'page', id: e.id, revision: 0, state: 'published', visibility: 'public', canonicalUrl: 'https://openvibe.wiki/p/nine', title: 'Nine', decision });
    const pub = createPublication({ owner: 'wiki', sequencer, outbox: publication.outbox, baseUrl: 'https://openvibe.wiki', now: () => Date.now(), decide, document, page: (e) => `/p/${e.slug}` });
    let stamped;
    await db.tx(async (t) => { stamped = await pub.sync(t, entity); });
    assert.strictEqual(stamped.revision, 1);
    assert.strictEqual(await sequencer.current('wiki', 'page', 'pg_9'), 1);
    assert.strictEqual((await envelopes()).length, 1);
});

run();
