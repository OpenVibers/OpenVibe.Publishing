'use strict';
/**
 * openvibe-publishing/ingest (1.1.0): the shared ingest chassis.
 *
 *   - normalize/hosts byte-for-byte against fixtures captured from the five current product copies
 *     (test/fixtures/normalize.json; each case cites its source file:line);
 *   - createSourcesClient against an in-process stub of OpenVibe.Sources (fake keys made at runtime);
 *   - createChangeCursor/pullChanges: cursor advancement, per-item savepoint isolation, hold;
 *   - createEventConsumer: signature window and inbox exactly-once.
 */
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { openDb, fakeClock, suite, sql } = require('./helpers/db');
const ingest = require('../lib/ingest');
const { signDeliveryHeaders } = require('openvibe-sdk/events');

const { test, run } = suite();
const FIXTURES = require('./fixtures/normalize.json');

test('normalize/hosts match the five current copies byte-for-byte (fixtures, source file:line cited)', () => {
    let checked = 0;
    for (const c of FIXTURES.cases) {
        const fn = ingest[c.ns][c.fn];
        assert.strictEqual(typeof fn, 'function', `${c.ns}.${c.fn} (source ${c.source})`);
        if (c.resultMode === 'jaccardPair') {
            const got = fn(ingest.normalize.shingles(c.args[0]), ingest.normalize.shingles(c.args[1]));
            assert.strictEqual(got, c.value, `${c.fn}(${JSON.stringify(c.args)}) [${c.source}]`);
        } else if (c.throws) {
            assert.throws(
                () => fn(...c.args),
                (e) => e.status === c.throws.status && e.code === c.throws.code && e.message === c.throws.message,
                `${c.ns}.${c.fn}(${JSON.stringify(c.args)}) should throw ${JSON.stringify(c.throws)} [${c.source}]`,
            );
        } else {
            let got = fn(...c.args);
            if (c.resultMode === 'set') got = [...got].sort();
            if (c.resultMode === 'groups') got = got.map((g) => [...g].sort()).sort((a, b) => a.join().localeCompare(b.join()));
            assert.deepStrictEqual(got, c.value, `${c.ns}.${c.fn}(${JSON.stringify(c.args)}) [${c.source}]`);
        }
        checked++;
    }
    assert.strictEqual(checked, FIXTURES.cases.length);
    assert.ok(checked > 100, `only ${checked} fixture cases`);
});

test('freshness.verdict is the generic staleness rule: fresh inside the window, stale after, never invented', () => {
    const def = 3600;
    const now = Date.parse('2026-09-22T12:00:00Z');
    assert.deepStrictEqual(ingest.freshness.verdict(null, now, def), { known: false, stale: true, staleSince: null, window: def, lastSuccessAt: null });
    const fresh = ingest.freshness.verdict({ last_success_at: now - 60 * 1000, stale_after_sec: null }, now, def);
    assert.deepStrictEqual([fresh.stale, fresh.window, fresh.staleSince], [false, def, null]);
    const stale = ingest.freshness.verdict({ last_success_at: now - 2 * 3600 * 1000, stale_after_sec: null, stale_since: null }, now, def);
    assert.strictEqual(stale.stale, true);
    assert.strictEqual(stale.staleSince, now - 2 * 3600 * 1000 + def * 1000);
    const never = ingest.freshness.verdict({ last_success_at: null, stale_since: 5 }, now, def);
    assert.deepStrictEqual([never.known, never.stale, never.lastSuccessAt], [true, true, null]);
    assert.strictEqual(ingest.freshness.view(null, 'k', now, def).status, 'unknown');
    assert.strictEqual(ingest.freshness.view(null, 'k', now, def).last_success_at, null);
});

// ── Sources client against a stub server ──────────────────────────────────────

function listen(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler).listen(0, '127.0.0.1', () => {
            const base = `http://127.0.0.1:${server.address().port}`;
            resolve({ base, close: () => new Promise((r) => server.close(r)) });
        });
    });
}

/** A stub OpenVibe.Sources: token endpoint + items / items/:id / sources / sources/:key. */
async function stubSources() {
    const seen = { tokens: 0, items: 0, item: 0, sources: 0, source: 0 };
    const server = await listen((req, res) => {
        const url = new URL(req.url, 'http://x');
        const send = (status, body, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
        if (url.pathname === '/oauth/token') { seen.tokens++; return send(200, { access_token: 'tok', token_type: 'Bearer', expires_in: 300 }); }
        if (url.pathname === '/api/v1/items') {
            seen.items++;
            if (!/^Bearer /.test(req.headers.authorization || '')) return send(401, { code: 'unauthorized' });
            const cat = url.searchParams.get('category');
            if (cat === 'boom') return send(500, { code: 'sources.error' });
            if (cat === 'bad') return send(200, 'not json', 'text/plain');
            return send(200, { items: [{ id: 'itm_01J8Z6Q3KX0000000000000000', revision: 1, source_key: 's1', canonical_url: 'https://example.com/a' }], next_after: 5, more: false, sources: { s1: { status: 'ok', stale: false, last_success_at: '2026-09-20T10:00:00Z' } } });
        }
        if (/^\/api\/v1\/items\/.+/.test(url.pathname)) { seen.item++; return send(200, { item: { id: decodeURIComponent(url.pathname.split('/').pop()) }, source: { key: 's1' } }); }
        if (url.pathname === '/api/v1/sources') { seen.sources++; return send(200, { sources: [{ key: 's1', category: 'reviews', health: { status: 'ok' } }] }); }
        if (/^\/api\/v1\/sources\/.+/.test(url.pathname)) { seen.source++; return send(200, { source: { key: url.pathname.split('/').pop(), name: 'S1' } }); }
        send(404, { code: 'route.not_found' });
    });
    return { seen, server };
}

const creds = () => ({ clientId: 'svc:reviews', clientSecret: crypto.randomBytes(24).toString('hex') });

test('createSourcesClient: items/item/sources, one token per scope, stable error codes', async () => {
    const { seen, server } = await stubSources();
    try {
        const config = { networkInternalUrl: server.base, oauth: creds(), sources: { internalUrl: server.base, category: 'reviews', timeoutMs: 2000 } };
        const src = ingest.createSourcesClient({ config });
        assert.strictEqual(src.enabled, true);
        const page = await src.listItems({ after: 0, limit: 50 });
        assert.strictEqual(page.next_after, 5);
        assert.strictEqual(page.items[0].id, 'itm_01J8Z6Q3KX0000000000000000');
        assert.strictEqual((await src.getItem('itm_01J8Z6Q3KX0000000000000000')).item.id, 'itm_01J8Z6Q3KX0000000000000000');
        assert.strictEqual((await src.listSources()).sources[0].key, 's1');
        assert.strictEqual((await src.getSource('s1')).name, 'S1');
        assert.strictEqual(seen.items, 1);
        assert.strictEqual(seen.tokens, 2, 'one cached token per scope (items, sources), reused at the second call');

        const boom = ingest.createSourcesClient({ config: { ...config, oauth: creds(), sources: { ...config.sources, category: 'boom' } } });
        await assert.rejects(boom.listItems({}), (e) => e instanceof ingest.SourcesError && e.code === 'sources.http_500' && e.status === 500);
        const bad = ingest.createSourcesClient({ config: { ...config, oauth: creds(), sources: { ...config.sources, category: 'bad' } } });
        await assert.rejects(bad.listItems({}), (e) => e.code === 'sources.bad_response');
    } finally { await server.close(); }
});

test('createSourcesClient: not configured is a stable code, never an invented page', async () => {
    const off = ingest.createSourcesClient({ config: { sources: { internalUrl: 'http://127.0.0.1:1', category: 'reviews' } } });
    assert.strictEqual(off.enabled, false);
    await assert.rejects(off.listItems({}), (e) => e instanceof ingest.SourcesError && e.code === 'sources.not_configured');
});

// ── Change cursor + pull ──────────────────────────────────────────────────────

test('pullChanges: one page transaction, per-item savepoint isolation, hold does not stall the cursor', async () => {
    const db = await openDb();
    const cursor = await ingest.createChangeCursor(db, { prefix: 't', now: fakeClock() }).ensureSchema();
    assert.strictEqual(cursor.table, 't_ingest_cursor');
    await db.query('CREATE TABLE t_seen (item text PRIMARY KEY)');
    const pages = [
        { items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], next_after: 10, more: true },
        { items: [{ id: 'e' }], next_after: 12, more: false },
    ];
    let p = 0;
    const source = { async listItems() { return pages[p++] || { items: [], next_after: 12, more: false }; } };
    const apply = async (item, t) => {
        await t.exec(sql`INSERT INTO t_seen (item) VALUES (${item.id})`);
        if (item.id === 'b') throw new Error('unreadable item');       // its savepoint rolls back alone
        if (item.id === 'c') return 'hold';                            // no merchant yet: counted, cursor moves on
        if (item.id === 'd') return { outcome: 'removed' };            // the object form is accepted too
        return 'applied';
    };
    const summary = await ingest.pullChanges({ db, cursor, source, apply, pageSize: 10 });
    assert.deepStrictEqual(summary, { pages: 2, applied: 2, hold: 1, removed: 1, failed: 1, after: 12 });
    assert.strictEqual(await cursor.get('default'), 12, 'the cursor advanced past both pages');
    assert.deepStrictEqual((await db.many(sql`SELECT item FROM t_seen ORDER BY item`)).map((r) => r.item), ['a', 'c', 'd', 'e'], 'the bad item b rolled back; every other item committed');
    assert.strictEqual((await ingest.pullChanges({ db, cursor, source, apply })).pages, 1, 'a replay from the advanced cursor finds nothing new');
    assert.strictEqual(await cursor.get('default'), 12);
    const bad = await ingest.pullChanges({ db, cursor, source: { async listItems() { return { items: [{ id: 'f' }], next_after: 13, more: false }; } }, apply: async () => 'created' });
    assert.deepStrictEqual(bad, { pages: 1, applied: 0, hold: 0, removed: 0, failed: 1, after: 13 }, 'a value outside the contract is isolated as failed');
});

// ── Event consumer ────────────────────────────────────────────────────────────

const EVENT_ID = 'evt_01J8Z6Q3KX0000000000000000';
const ITEM_ID = 'itm_01J8Z6Q3KX0000000000000000';
function delivery(event, secret, now = Date.now()) {
    const raw = Buffer.from(JSON.stringify({ event, seq: 1 }));
    return { raw, headers: signDeliveryHeaders(raw, secret, { now }) };
}
const envelope = (id = EVENT_ID) => ({
    event_id: id, event_type: 'sources.item.created', version: 1, source: 'sources',
    actor: { type: 'service', id: 'sources' }, timestamp: '2026-09-22T12:00:00.000Z', visibility: 'internal',
    subject: { type: 'item', id: ITEM_ID }, payload: { category: 'reviews', item_id: ITEM_ID },
});

test('createEventConsumer: v2 signature within ±300 s, exactly once through the inbox', async () => {
    const db = await openDb();
    const secret = crypto.randomBytes(32).toString('hex');
    const other = crypto.randomBytes(32).toString('hex');
    const consumer = ingest.createEventConsumer({ db, secrets: [secret], consumer: 'reviews-sources' });
    await consumer.inbox.ensureSchema();
    let calls = 0;
    const a = delivery(envelope(), secret);
    const first = await consumer.apply(a.raw, a.headers, async (event) => { calls++; return `saw:${event.payload.category}`; });
    assert.deepStrictEqual([first.status, first.event_id, first.duplicate, first.outcome], [200, EVENT_ID, false, 'saw:reviews']);
    const again = await consumer.apply(a.raw, a.headers, async () => { calls++; return 'no'; });
    assert.deepStrictEqual([again.duplicate, again.outcome, calls], [true, null, 1], 'the handler runs once per event_id');

    const bad = delivery(envelope('evt_01J8Z6Q3KX0000000000000001'), other);
    assert.strictEqual((await consumer.apply(bad.raw, bad.headers, async () => 'no')).status, 401);
    const stale = delivery(envelope('evt_01J8Z6Q3KX0000000000000002'), secret, Date.now() - 10 * 60 * 1000);
    assert.strictEqual((await consumer.apply(stale.raw, stale.headers, async () => 'no')).status, 401, 'outside the ±300 s window');
    const malformed = delivery({ ...envelope('nope'), event_id: 'nope' }, secret);
    assert.strictEqual((await consumer.apply(malformed.raw, malformed.headers, async () => 'no')).status, 400);
});

test('createEventConsumer: no secrets configured is 503, never an accepted delivery', async () => {
    const db = await openDb();
    const consumer = ingest.createEventConsumer({ db, secrets: [], consumer: 'x-sources' });
    assert.deepStrictEqual(await consumer.apply(Buffer.from('{}'), {}, async () => 'no'), { status: 503, code: 'ingest.webhook_disabled' });
});

run();
