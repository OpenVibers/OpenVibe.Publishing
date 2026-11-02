'use strict';
/**
 * openvibe-publishing/search-relay (1.5.0): a product's queued Search documents delivered through Search's owner API.
 *
 *   - oldest first; a document's older rows in one claim are superseded; upserts PUT the whole document, tombstones
 *     DELETE with ?revision=; sent rows get published_at and leave the queue;
 *   - 409 stale is done, 409 conflict is sent once more as the stored revision + 1;
 *   - 5xx and network errors back off (the row waits, then goes), 401 drops the token, 429 stops the tick until
 *     Retry-After and leaves the rest unclaimed;
 *   - any other 4xx and a payload for another owner are rejected for good, and logged;
 *   - maxPerTick caps a tick; without searchUrl or auth the relay is off and the rows wait.
 */
const assert = require('assert');
const { openDb, fakeClock, suite } = require('./helpers/db');
const { createSearchRelay } = require('../lib/search-relay');

const { test, run } = suite();
const silent = { warn() {}, log() {} };

/** A Search owner API that keeps documents and answers like Search's store: applied, unchanged, stale, conflict. */
function fakeSearch({ owner = 'meme' } = {}) {
    const docs = new Map();
    const calls = [];
    const script = [];
    const hash = (d) => JSON.stringify({ ...d, revision: undefined });
    const answer = (status, body, headers = {}) => ({ status, json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });
    async function fetchImpl(url, init) {
        const u = new URL(url);
        const m = /^\/api\/v1\/documents\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(u.pathname);
        assert.ok(m, `unexpected path ${u.pathname}`);
        assert.strictEqual(decodeURIComponent(m[1]), owner);
        assert.match(init.headers.Authorization || '', /^Bearer /);
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ method: init.method, type: m[2], id: decodeURIComponent(m[3]), revision: body ? body.revision : Number(u.searchParams.get('revision')), body });
        const next = script.shift();
        if (next) { if (next instanceof Error) throw next; return answer(next.status, next.body || {}, next.headers); }
        const key = `${m[2]}/${decodeURIComponent(m[3])}`;
        const doc = body || { revision: Number(u.searchParams.get('revision')), deleted: true };
        const cur = docs.get(key);
        if (cur) {
            if (doc.revision < cur.revision || (doc.revision === cur.revision && cur.deleted && !doc.deleted)) {
                return answer(409, { code: 'search.stale_revision', stored_revision: cur.revision });
            }
            if (doc.revision === cur.revision && hash(cur) === hash(doc)) return answer(200, { outcome: 'unchanged' });
            if (doc.revision === cur.revision && !(doc.deleted && !cur.deleted)) return answer(409, { code: 'search.revision_conflict', stored_revision: cur.revision });
        }
        docs.set(key, { ...doc, deleted: Boolean(doc.deleted) });
        return answer(200, { outcome: 'applied', revision: doc.revision });
    }
    return { fetchImpl, docs, calls, script };
}

function tokens() {
    const t = { invalidated: 0, async authHeaders() { return { Authorization: 'Bearer test' }; }, invalidate() { t.invalidated++; } };
    return t;
}

async function setup({ owner = 'meme', maxPerTick = 100, log = silent } = {}) {
    const db = await openDb();
    const now = fakeClock();
    await db.query(`CREATE TABLE ${owner}_outbox (
        event_id text COLLATE "C" PRIMARY KEY, topic text NOT NULL, payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz, attempts integer NOT NULL DEFAULT 0,
        last_error text, next_attempt_at timestamptz NOT NULL DEFAULT now(), claimed_at timestamptz, claimed_by text)`);
    const search = fakeSearch({ owner });
    const auth = tokens();
    let n = 0;
    const queue = async (payload, { at = now() } = {}) => {
        n++;
        const id = `evt_${String(n).padStart(4, '0')}`;
        const iso = new Date(at + n).toISOString();
        await db.exec(`INSERT INTO ${owner}_outbox (event_id, topic, payload, created_at, next_attempt_at) VALUES ($1, $2, $3::jsonb, $4::timestamptz, $4::timestamptz)`,
            [id, payload.deleted ? `${owner}.index_document.deleted` : `${owner}.index_document.upserted`, JSON.stringify(payload), iso]);
        return id;
    };
    const relay = createSearchRelay({ db, table: `${owner}_outbox`, owner, searchUrl: 'http://search.test/', auth, fetchImpl: search.fetchImpl, now, log, maxPerTick });
    const row = (id) => db.maybe(`SELECT * FROM ${owner}_outbox WHERE event_id = $1`, [id]);
    return { db, now, search, auth, queue, relay, row };
}

const entry = (id, revision, title = `Entry ${id}`) => ({
    owner: 'meme', type: 'entry', id, revision, deleted: false, visibility: 'public',
    canonical_url: `https://openvibe.meme/m/${id}`, title, body: title, publication_state: 'published', indexability: { decision: 'index' },
});

test('oldest first, older rows of one document superseded, upserts PUT and tombstones DELETE', async () => {
    const { search, queue, relay, row, now } = await setup();
    const a1 = await queue(entry('a', 1, 'First title'));
    const b1 = await queue(entry('b', 1));
    const a2 = await queue(entry('a', 2, 'Second title'));
    const c1 = await queue({ owner: 'meme', type: 'entry', id: 'c', revision: 3, deleted: true });
    now.advance(1000);
    const out = await relay.drain();
    assert.deepStrictEqual(out, { sent: 3, stale: 0, superseded: 1, rejected: 0, failed: 0, deferred: 0 });
    assert.deepStrictEqual(search.calls.map((c) => `${c.method} ${c.id} r${c.revision}`), ['PUT b r1', 'PUT a r2', 'DELETE c r3']);
    assert.strictEqual(search.docs.get('entry/a').title, 'Second title');
    assert.strictEqual(search.docs.get('entry/c').deleted, true);
    assert.strictEqual((await row(a1)).last_error, 'superseded');
    for (const id of [a1, b1, a2, c1]) assert.ok((await row(id)).published_at, `${id} left the queue`);
    assert.strictEqual((await relay.status()).pending, 0);
    assert.deepStrictEqual(await relay.drain(), { sent: 0, stale: 0, superseded: 0, rejected: 0, failed: 0, deferred: 0 }, 'nothing left to send');
});

test('409 stale is done; 409 conflict goes again as the stored revision + 1', async () => {
    const { search, queue, relay, row, now } = await setup();
    search.docs.set('entry/a', { ...entry('a', 5), deleted: false });
    search.docs.set('entry/b', { ...entry('b', 2, 'Old words'), deleted: false });
    const a = await queue(entry('a', 4));
    const b = await queue(entry('b', 2, 'New words'));
    now.advance(1000);
    const out = await relay.drain();
    assert.strictEqual(out.stale, 1);
    assert.strictEqual(out.sent, 1);
    assert.match((await row(a)).last_error, /^stale: Search holds revision 5/);
    assert.strictEqual(search.docs.get('entry/b').revision, 3);
    assert.strictEqual(search.docs.get('entry/b').title, 'New words');
    assert.strictEqual((await row(b)).last_error, null);
});

test('5xx and network errors back off, then the row goes; 401 drops the token', async () => {
    const { search, auth, queue, relay, row, now } = await setup();
    const a = await queue(entry('a', 1));
    now.advance(1000);
    search.script.push({ status: 503, body: { code: 'unavailable' } });
    assert.strictEqual((await relay.drain()).failed, 1);
    let r = await row(a);
    assert.strictEqual(r.attempts, 1);
    assert.strictEqual(r.published_at, null);
    assert.strictEqual(r.claimed_at, null, 'the claim is released');
    assert.strictEqual((await relay.drain()).sent, 0, 'not due yet');
    now.advance(16_000);
    search.script.push(new Error('connect ECONNREFUSED'));
    assert.strictEqual((await relay.drain()).failed, 1);
    r = await row(a);
    assert.strictEqual(r.attempts, 2);
    assert.match(r.last_error, /^network: connect ECONNREFUSED/);
    now.advance(31_000);
    search.script.push({ status: 401, body: { code: 'unauthorized' } });
    await relay.drain();
    assert.strictEqual(auth.invalidated, 1);
    now.advance(61_000);
    assert.strictEqual((await relay.drain()).sent, 1);
    assert.ok((await row(a)).published_at);
});

test('429 stops the tick until Retry-After and leaves the rest unclaimed', async () => {
    const { search, queue, relay, row, now } = await setup();
    const a = await queue(entry('a', 1));
    const b = await queue(entry('b', 1));
    const c = await queue(entry('c', 1));
    now.advance(1000);
    search.script.push({ status: 200, body: {} }, { status: 429, body: { code: 'rate_limited' }, headers: { 'retry-after': '30' } });
    const out = await relay.drain();
    assert.deepStrictEqual([out.sent, out.deferred], [1, 2]);
    for (const id of [b, c]) {
        const r = await row(id);
        assert.strictEqual(r.claimed_at, null);
        assert.strictEqual(r.attempts, 0, 'a 429 is not a failed attempt');
        assert.strictEqual(r.published_at, null);
    }
    assert.ok((await row(a)).published_at);
    assert.ok((await relay.status()).paused_until);
    assert.strictEqual((await relay.drain()).sent, 0, 'paused');
    now.advance(31_000);
    assert.strictEqual((await relay.drain()).sent, 2);
});

test('other 4xx and a payload for another owner are rejected for good, and logged', async () => {
    const warned = [];
    const { search, queue, relay, row, now } = await setup({ log: { log() {}, warn: (m) => warned.push(m) } });
    const bad = await queue(entry('a', 1));
    const other = await queue({ ...entry('b', 1), owner: 'rent' });
    now.advance(1000);
    search.script.push({ status: 422, body: { code: 'search.bad_document', detail: 'document does not match search.index-document@1' } });
    const out = await relay.drain();
    assert.strictEqual(out.rejected, 2);
    assert.match((await row(bad)).last_error, /^rejected: 422 search\.bad_document/);
    assert.match((await row(other)).last_error, /payload owner rent is not meme/);
    assert.ok((await row(bad)).published_at && (await row(other)).published_at, 'neither blocks the queue');
    assert.strictEqual(search.calls.length, 1, 'the other owner\'s row was never sent');
    assert.ok(warned.some((m) => /entry\/a r1 refused: 422/.test(m)));
});

test('maxPerTick caps a tick; without searchUrl or auth the relay is off', async () => {
    const { db, search, queue, relay, now } = await setup({ maxPerTick: 2 });
    for (const id of ['a', 'b', 'c', 'd', 'e']) await queue(entry(id, 1));
    now.advance(1000);
    assert.strictEqual((await relay.drain()).sent, 2);
    assert.strictEqual((await relay.drain()).sent, 2);
    assert.strictEqual((await relay.drain()).sent, 1);
    assert.strictEqual(search.calls.length, 5);
    const off = createSearchRelay({ db, table: 'meme_outbox', owner: 'meme', searchUrl: '', auth: tokens(), now });
    assert.strictEqual(off.enabled, false);
    assert.strictEqual(off.start(), false);
    assert.strictEqual(await off.drain(), null);
    assert.throws(() => createSearchRelay({ db, table: 'meme_outbox; DROP TABLE x', owner: 'meme' }), /plain table name/);
});

run();
