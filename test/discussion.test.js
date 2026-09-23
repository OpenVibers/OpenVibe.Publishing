'use strict';
const assert = require('assert');
const http = require('http');
const contracts = require('openvibe-contracts');
const { openDb, fakeClock, suite } = require('./helpers/db');
const { createDiscussionClient, createDiscussionRefs, entityRef } = require('../lib/discussion');

const { test, run } = suite();
const USER = 'usr_01J8Z6Q3KX0000000000000000';

/** A stand-in for OpenVibe.Community's POST /api/v1/comments/threads/resolve (get-or-create). */
function fakeCommunity() {
    const threads = new Map();
    const requests = [];
    let mode = 'ok';
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            requests.push({ method: req.method, url: req.url, headers: req.headers, body });
            const send = (status, obj, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(JSON.stringify(obj)); };
            if (mode === 'down') return send(503, { type: 'x', title: 'Service Unavailable', status: 503, code: 'service.unavailable', error: 'down' }, 'application/problem+json');
            if (req.method !== 'POST' || req.url !== '/api/v1/comments/threads/resolve') return send(404, { code: 'route.not_found' });
            if (req.headers.authorization !== 'Bearer svc-token') return send(401, { code: 'auth.invalid_token', error: 'no' });
            const { ref } = JSON.parse(body);
            if (!contracts.validate('common.entity-ref@1', ref).valid) return send(400, { code: 'ref.invalid' });
            const key = `${ref.service}/${ref.type}/${ref.id}`;
            if (threads.has(key)) return send(200, { thread: threads.get(key), created: false });
            const thread = { id: `thr_${threads.size + 1}`, ref, visibility: 'public', comment_count: 0 };
            threads.set(key, thread);
            return send(201, { thread, created: true });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${server.address().port}`, requests, setMode: (m) => { mode = m; }, close: () => server.close(),
    })));
}

const tokenClient = { authHeaders: async () => ({ Authorization: 'Bearer svc-token' }), invalidated: 0, invalidate() { this.invalidated++; } };

test('resolveThread: get-or-create over the Community contract, with service auth and trace headers', async () => {
    const community = await fakeCommunity();
    try {
        const client = createDiscussionClient({ communityUrl: community.url + '/', tokenClient });
        const ref = { service: 'wiki', type: 'page', id: 'pg_1', label: 'Rye' };
        const first = await client.resolveThread(ref, { subject: USER, traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', requestId: 'req-1' });
        const second = await client.resolveThread(ref);
        assert.deepStrictEqual(first, { threadId: 'thr_1', created: true, visibility: 'public' });
        assert.strictEqual(second.threadId, 'thr_1');
        assert.strictEqual(second.created, false);
        const h = community.requests[0].headers;
        assert.strictEqual(h['x-ov-subject'], USER);
        assert.strictEqual(h.traceparent, '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
        assert.strictEqual(h['x-openvibe-request-id'], 'req-1');
        assert.strictEqual(community.requests[1].headers['x-ov-subject'], undefined, 'acts as the service when no subject');
    } finally { community.close(); }
});

test('failures are errors, never a fabricated thread', async () => {
    const community = await fakeCommunity();
    try {
        const client = createDiscussionClient({ communityUrl: community.url, tokenClient });
        community.setMode('down');
        await assert.rejects(client.resolveThread({ service: 'blog', type: 'post', id: 'p' }), (e) => e.status === 503 && e.code === 'service.unavailable');
        const bad = createDiscussionClient({ communityUrl: community.url, tokenClient: { authHeaders: async () => ({ Authorization: 'Bearer wrong' }), invalidate() { this.hit = true; } } });
        community.setMode('ok');
        await assert.rejects(bad.resolveThread({ service: 'blog', type: 'post', id: 'p' }), (e) => e.status === 401 && e.code === 'auth.invalid_token');
        const nowhere = createDiscussionClient({ communityUrl: 'http://127.0.0.1:1', tokenClient, timeoutMs: 500 });
        await assert.rejects(nowhere.resolveThread({ service: 'blog', type: 'post', id: 'p' }), (e) => e.code === 'discussion.unavailable');
        await assert.rejects(client.resolveThread({ service: 'Blog!', type: 'post', id: 'p' }), /service/);
        await assert.rejects(client.resolveThread({ service: 'blog', type: 'post', id: 'p' }, { subject: '42' }), /subject/);
    } finally { community.close(); }
});

test('the local table stores the reference only — no comment content columns — and resolves once', async () => {
    const community = await fakeCommunity();
    try {
        const db = openDb('disc');
        const refs = createDiscussionRefs(db, { prefix: 'wiki', now: fakeClock() });
        const client = createDiscussionClient({ communityUrl: community.url, tokenClient });
        const ref = { service: 'wiki', type: 'page', id: 'pg_9' };
        const a = await refs.threadFor('pg_9', ref, { client });
        const b = await refs.threadFor('pg_9', ref, { client });
        assert.strictEqual(a.cached, false);
        assert.strictEqual(b.cached, true);
        assert.strictEqual(a.threadId, b.threadId);
        assert.strictEqual(community.requests.length, 1);
        const cols = db.prepare('PRAGMA table_info(wiki_discussion_refs)').all().map((c) => c.name).sort();
        assert.deepStrictEqual(cols, ['entity_id', 'ref', 'resolved_at', 'thread_id']);
        assert.ok(contracts.validate('common.entity-ref@1', refs.get('pg_9').ref).valid);
    } finally { community.close(); }
});

test('entityRef validation matches common.entity-ref@1', () => {
    const r = entityRef({ service: 'news', type: 'story', id: 'st_1', label: 'x'.repeat(500), revision: 3 });
    assert.strictEqual(r.label.length, 200);
    assert.ok(contracts.validate('common.entity-ref@1', r).valid);
});

run();
