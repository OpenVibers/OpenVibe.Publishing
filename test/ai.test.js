'use strict';
// openvibe-publishing/ai: a product asks OpenVibe.AI for a draft with its service token; a slow run is
// polled, failures throw coded errors and never a partial draft, and the authorship workflow is filled.
const assert = require('assert');
const { createAiClient, AiRunError } = require('../lib/ai');

const RUN = 'run_01JAB2C3D4E5F6G7H8J9K0MNPQ';
function stub(script) {
    const calls = [];
    const fetchImpl = async (url, opts) => {
        const u = new URL(url);
        calls.push({ method: opts.method, path: u.pathname, search: u.search, auth: opts.headers.Authorization, tp: opts.headers.traceparent || null, body: opts.body ? JSON.parse(opts.body) : null });
        const step = script(u, opts, calls.length);
        return { status: step.status, ok: step.status < 300, json: async () => step.body };
    };
    return { calls, fetchImpl };
}
const done = (status = 'succeeded') => ({ run: { id: RUN, status, workflow: { key: 'blog.draft_post', version: 2 }, output: { title: 'T', body_markdown: 'B' }, synthetic: false, provenance: { model: 'm-1' } } });
const tokens = { n: 0, invalidated: 0, async authHeaders() { return { Authorization: `Bearer t${++this.n}` }; }, invalidate() { this.invalidated++; } };

(async () => {
    let n = 0; const ok = () => n++;

    { // finished within wait
        const s = stub((u) => (u.pathname.endsWith('/citations') ? { status: 200, body: { citations: [{ url: 'https://example.org/a', title: 'A' }] } } : { status: 201, body: done() }));
        const ai = createAiClient({ baseUrl: 'http://ai.test/', tokenClient: tokens, fetch: s.fetchImpl });
        const r = await ai.run('blog.draft_post', { topic: 'x' }, { onBehalfOf: { type: 'user', id: 'usr_1' }, target: { service: 'blog', type: 'blog', id: 'b1' }, traceparent: '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01' });
        assert.deepStrictEqual(r.workflow, { id: 'blog.draft_post', version: 2, runId: RUN, model: 'm-1' });
        assert.deepStrictEqual(r.output, { title: 'T', body_markdown: 'B' });
        assert.strictEqual(r.citations.length, 1);
        assert.deepStrictEqual(s.calls[0].body, { workflow: 'blog.draft_post', input: { topic: 'x' }, on_behalf_of: { type: 'user', id: 'usr_1' }, target: { service: 'blog', type: 'blog', id: 'b1' } });
        assert.ok(/^\?wait=\d+$/.test(s.calls[0].search));
        assert.ok(s.calls.every((c) => c.tp && c.auth), 'trace and token on every call');
        ok();
    }
    { // still running: polled until done
        const s = stub((u, _o, i) => (u.pathname.endsWith('/citations') ? { status: 200, body: { citations: [] } } : i === 1 ? { status: 202, body: { run: { id: RUN, status: 'running' } } } : { status: 200, body: done() }));
        const r = await createAiClient({ baseUrl: 'http://ai.test', tokenClient: tokens, fetch: s.fetchImpl, pollMs: 5 }).run('blog.draft_post', {});
        assert.strictEqual(r.status, 'succeeded');
        assert.deepStrictEqual(s.calls.map((c) => c.method + ' ' + c.path), ['POST /api/v1/runs', `GET /api/v1/runs/${RUN}`, `GET /api/v1/runs/${RUN}/citations`]);
        ok();
    }
    { // failures are coded errors
        const cases = [
            [() => ({ status: 403, body: { code: 'capability.denied' } }), 'ai.refused'],
            [() => ({ status: 201, body: { run: { id: RUN, status: 'failed', error: { code: 'provider.unavailable', detail: 'x' } } } }), 'ai.run_failed'],
            [() => { throw new Error('ECONNREFUSED'); }, 'ai.unreachable'],
        ];
        for (const [script, code] of cases) {
            const fetchImpl = async () => { const st = script(); return { status: st.status, ok: st.status < 300, json: async () => st.body }; };
            await assert.rejects(createAiClient({ baseUrl: 'http://ai.test', tokenClient: tokens, fetch: fetchImpl }).run('blog.draft_post', {}), (e) => e instanceof AiRunError && e.code === code, code);
        }
        await assert.rejects(createAiClient({ baseUrl: '', tokenClient: tokens }).run('blog.draft_post', {}), (e) => e.code === 'ai.not_configured');
        await assert.rejects(createAiClient({ baseUrl: 'http://ai.test', tokenClient: tokens, fetch: async () => ({}) }).run('../evil', {}), (e) => e.code === 'ai.bad_workflow');
        ok();
    }
    { // a refused token is invalidated and retried once
        const before = tokens.invalidated;
        const s = stub((u, _o, i) => (i === 1 ? { status: 401, body: {} } : u.pathname.endsWith('/citations') ? { status: 200, body: { citations: [] } } : { status: 201, body: done() }));
        await createAiClient({ baseUrl: 'http://ai.test', tokenClient: tokens, fetch: s.fetchImpl }).run('blog.draft_post', {});
        assert.strictEqual(tokens.invalidated, before + 1);
        ok();
    }
    console.log(`ai: ${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
