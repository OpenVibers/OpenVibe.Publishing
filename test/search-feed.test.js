'use strict';
/**
 * openvibe-publishing/search-feed (1.4.0): a product's record pages in OpenVibe.Search.
 *
 *   - sync() stamps and enqueues exactly search.index-document@1 (as Search's webhook reads it) on the caller's
 *     handle, and an unchanged row sends nothing;
 *   - listed:false and remove() are tombstones, and nothing is sent for an id Search never had;
 *   - noindex and expiry keep the document with a noindex decision; there is no word-count gate;
 *   - sweep() pages through rows in id order, re-sends only what changed, tombstones ids whose row is gone,
 *     counts a failing row and goes on;
 *   - a rolled-back write leaves neither the revision nor the event.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { createPgOutbox } = require('openvibe-sdk/events');
const { openDb, fakeClock, suite, sql } = require('./helpers/db');
const { createSearchFeed } = require('../lib/search-feed');

const { test, run } = suite();

function searchReads(env) {
    const m = /^([a-z][a-z0-9-]{1,39})\.index_document\.(upserted|deleted)$/.exec(env.event_type);
    assert.ok(m, `not an index_document event: ${env.event_type}`);
    assert.strictEqual(m[1], env.source);
    const p = env.payload;
    const doc = m[2] === 'deleted' ? { owner: env.source, type: p.type, id: p.id, revision: p.revision, deleted: true } : { ...p, owner: env.source };
    assert.strictEqual(env.subject.id, doc.id);
    assert.strictEqual(env.subject.revision, doc.revision);
    const v = contracts.validate('search.index-document@1', doc);
    assert.ok(v.valid, `search.index-document@1: ${JSON.stringify(v.errors)}`);
    const e = contracts.validate('events.event-envelope@1', env);
    assert.ok(e.valid, `events.event-envelope@1: ${JSON.stringify(e.errors)}`);
    return doc;
}

const silent = { warn() {}, log() {} };

async function setup({ log = silent } = {}) {
    const db = await openDb();
    const clock = fakeClock();
    await db.query(`CREATE TABLE listings (id text COLLATE "C" PRIMARY KEY, title text NOT NULL, body text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT 'active', city text, expires_at bigint, flagged boolean NOT NULL DEFAULT false)`);
    const events = { prepare: (env) => ({ ...env, event_id: contracts.ids.newId('event') }), publish: async () => ({ results: [] }) };
    const outbox = createPgOutbox(db, { events, table: 'event_outbox', now: clock });
    await outbox.ensureSchema();
    const feed = createSearchFeed({
        owner: 'rent', db, outbox, baseUrl: 'https://openvibe.rent', now: clock, log,
        types: {
            listing: {
                page: (r) => `/listings/${r.id}`,
                document: (r) => {
                    if (r.title === 'boom') throw new TypeError('bad row');
                    return {
                        listed: r.status === 'active', noindex: r.flagged, expiresAt: r.expires_at == null ? null : Number(r.expires_at),
                        title: r.title, summary: r.body.slice(0, 40), body: r.body, facets: { city: r.city },
                        authorship: { mode: 'human' }, updatedAt: '2026-09-22T12:00:00Z',
                    };
                },
                rows: (after, limit) => db.many(sql`SELECT * FROM listings WHERE id > ${after} ORDER BY id LIMIT ${limit}`),
                exists: async (ids) => (await db.many(sql`SELECT id FROM listings WHERE id = ANY(${ids})`)).map((r) => r.id),
            },
        },
    });
    await feed.sequencer.ensureSchema();
    const envelopes = async () => (await db.many(sql`SELECT envelope FROM event_outbox ORDER BY id`)).map((r) => r.envelope);
    const add = (id, extra = {}) => db.exec(sql`INSERT INTO listings (id, title, body, city, status, expires_at, flagged)
        VALUES (${id}, ${extra.title || `Flat ${id}`}, ${extra.body || 'Two rooms near the park.'}, ${extra.city || 'Leeds'},
                ${extra.status || 'active'}, ${extra.expires_at == null ? null : extra.expires_at}, ${Boolean(extra.flagged)})`);
    const row = (id) => db.one(sql`SELECT * FROM listings WHERE id = ${id}`);
    return { db, clock, feed, envelopes, add, row };
}

test('sync: one search.index-document@1 on the caller\'s handle; an unchanged row sends nothing; a change is revision + 1', async () => {
    const { db, feed, envelopes, add, row } = await setup();
    await add('lst_a');
    const first = await db.tx(async (t) => await feed.sync(t, 'listing', await row('lst_a')));
    assert.strictEqual(first.revision, 1);
    let envs = await envelopes();
    assert.strictEqual(envs.length, 1);
    const doc = searchReads(envs[0]);
    assert.strictEqual(envs[0].event_type, 'rent.index_document.upserted');
    assert.strictEqual(doc.canonical_url, 'https://openvibe.rent/listings/lst_a');
    assert.strictEqual(doc.visibility, 'public');
    assert.deepStrictEqual(doc.indexability, { decision: 'index', reasons: [] }, 'no word-count gate on records');
    assert.deepStrictEqual(doc.facets, { city: 'Leeds' });
    assert.strictEqual(await db.tx(async (t) => await feed.sync(t, 'listing', await row('lst_a'))), null, 'unchanged → nothing');
    assert.strictEqual((await envelopes()).length, 1);
    await db.exec(sql`UPDATE listings SET title = 'Flat A, renovated' WHERE id = 'lst_a'`);
    const second = await db.tx(async (t) => await feed.sync(t, 'listing', await row('lst_a')));
    assert.strictEqual(second.revision, 2);
    envs = await envelopes();
    assert.strictEqual(searchReads(envs[1]).title, 'Flat A, renovated');
});

test('listed:false and remove() are tombstones; nothing for an id Search never had', async () => {
    const { db, feed, envelopes, add, row } = await setup();
    await add('lst_hidden', { status: 'hidden' });
    assert.strictEqual(await db.tx(async (t) => await feed.sync(t, 'listing', await row('lst_hidden'))), null, 'never indexed → no tombstone');
    assert.strictEqual(await db.tx(async (t) => await feed.remove(t, 'listing', 'lst_never')), null);
    assert.strictEqual((await envelopes()).length, 0);
    await add('lst_b');
    await db.tx(async (t) => feed.sync(t, 'listing', await row('lst_b')));
    await db.exec(sql`UPDATE listings SET status = 'hidden' WHERE id = 'lst_b'`);
    const gone = await db.tx(async (t) => await feed.sync(t, 'listing', await row('lst_b')));
    assert.strictEqual(gone.deleted, true);
    const envs = await envelopes();
    assert.strictEqual(envs[1].event_type, 'rent.index_document.deleted');
    assert.deepStrictEqual(searchReads(envs[1]), { owner: 'rent', type: 'listing', id: 'lst_b', revision: 2, deleted: true });
    assert.strictEqual(await db.tx(async (t) => await feed.remove(t, 'listing', 'lst_b')), null, 'already a tombstone → nothing');
});

test('noindex and expiry keep the document, marked noindex', async () => {
    const { db, clock, feed, envelopes, add, row } = await setup();
    await add('lst_f', { flagged: true });
    await add('lst_e', { expires_at: clock() - 1000 });
    await db.tx(async (t) => { await feed.sync(t, 'listing', await row('lst_f')); await feed.sync(t, 'listing', await row('lst_e')); });
    const [f, e] = (await envelopes()).map(searchReads);
    assert.strictEqual(f.indexability.decision, 'noindex');
    assert.strictEqual(e.indexability.decision, 'noindex');
    assert.ok(e.indexability.reasons.includes('expired'));
    assert.strictEqual(f.deleted, false);
});

test('a rolled-back write leaves neither the revision nor the event', async () => {
    const { db, feed, envelopes, add, row } = await setup();
    await add('lst_r');
    await assert.rejects(db.tx(async (t) => { await feed.sync(t, 'listing', await row('lst_r')); throw new Error('the write failed'); }), /the write failed/);
    assert.strictEqual((await envelopes()).length, 0);
    assert.strictEqual(await feed.sequencer.current('rent', 'listing', 'lst_r'), null);
});

test('sweep: every page in id order, only changes re-sent, vanished ids tombstoned, a failing row counted', async () => {
    const warnings = [];
    const { db, feed, envelopes, add } = await setup({ log: { warn: (m) => warnings.push(m) } });
    for (let i = 0; i < 205; i += 1) await add(`lst_${String(i).padStart(3, '0')}`);
    await add('lst_zzz', { title: 'boom' });
    let out = await feed.sweep();
    assert.deepStrictEqual(out, { listing: { seen: 206, sent: 205, removed: 0, failed: 1 } });
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /rent listing lst_zzz: bad row/);
    assert.strictEqual((await envelopes()).length, 205);
    out = await feed.sweep();
    assert.deepStrictEqual(out.listing, { seen: 206, sent: 0, removed: 0, failed: 1 }, 'a second pass sends nothing');
    await db.exec(sql`DELETE FROM listings WHERE id IN ('lst_003', 'lst_150')`);
    await db.exec(sql`UPDATE listings SET body = 'Three rooms now.' WHERE id = 'lst_010'`);
    out = await feed.sweep();
    assert.deepStrictEqual(out.listing, { seen: 204, sent: 1, removed: 2, failed: 1 });
    const envs = await envelopes();
    const tail = envs.slice(-3).map((e) => e.event_type);
    assert.deepStrictEqual(tail, ['rent.index_document.upserted', 'rent.index_document.deleted', 'rent.index_document.deleted']);
    assert.deepStrictEqual(envs.slice(-2).map((e) => e.payload.id), ['lst_003', 'lst_150']);
    out = await feed.sweep();
    assert.deepStrictEqual(out.listing, { seen: 204, sent: 0, removed: 0, failed: 1 }, 'tombstones are not re-sent');
});

test('sweep: concurrent calls share one pass', async () => {
    const { feed, add } = await setup();
    await add('lst_1');
    const [a, b] = await Promise.all([feed.sweep(), feed.sweep()]);
    assert.strictEqual(a, b);
    assert.strictEqual(a.listing.sent, 1);
});

test('the factory refuses what it cannot run', async () => {
    const { db } = await setup();
    const outbox = { enqueue: async () => {} };
    const base = { owner: 'rent', db, outbox, baseUrl: 'https://openvibe.rent' };
    assert.throws(() => createSearchFeed({ ...base, owner: 'Rent!', types: { x: {} } }), /owner/);
    assert.throws(() => createSearchFeed({ ...base, types: {} }), /types/);
    assert.throws(() => createSearchFeed({ ...base, types: { listing: { page: () => '/', document: () => ({}) } } }), /rows/);
    assert.throws(() => createSearchFeed({ ...base, baseUrl: null, types: { listing: { page: () => '/', document: () => ({}), rows: async () => [] } } }), /baseUrl/);
    const feed = createSearchFeed({ ...base, types: { listing: { page: () => '/', document: () => ({}), rows: async () => [] } } });
    assert.throws(() => feed.documentOf('job', { id: 'x' }), /unknown document type/);
});

run();
