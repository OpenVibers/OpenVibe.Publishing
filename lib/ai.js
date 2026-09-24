'use strict';
/**
 * openvibe-publishing/ai — how a content product asks OpenVibe.AI for a draft (roadmap W13, §12.4):
 * run one of its registered workflows (wiki.generate_page, blog.draft_post, reviews.summarize_entity,
 * deals.enrich_deal, trade.summarize_market_context, …) with the product's service token, and get
 * back the output, the run id and version for the authorship record, and the run's citations.
 * The product then files the result as an AI-authored draft (openvibe-publishing/authorship): it is
 * never published or indexed until a person reviews it.
 *
 *   const { createAiClient } = require('openvibe-publishing/ai');
 *   const ai = createAiClient({ baseUrl: 'http://127.0.0.1:4700', tokenClient });   // audience openvibe.ai
 *   const r = await ai.run('blog.draft_post', { topic: 'Why we self-host' },
 *       { onBehalfOf: { type: 'user', id: subject }, target: { service: 'blog', type: 'blog', id: blog.id } });
 *   r.output                 the workflow's output (its output_schema)
 *   r.workflow               { id, version, runId, model } for authorship.record({ mode: 'ai', workflow })
 *   r.synthetic              true when a stub provider answered (the draft must say so)
 *   r.citations              [{ url, title, snippet, … }] the run recorded
 *
 * POST {baseUrl}/api/v1/runs?wait=<ms> (capability ai.run.create in the product's namespace) and
 * GET /api/v1/runs/:id/citations (ai.run.read). A run still going after `waitMs` is polled until
 * `timeoutMs`. Every failure throws AiRunError with a code (ai.not_configured, ai.refused,
 * ai.run_failed, ai.timeout, ai.unreachable) and never returns a partial draft. tokenClient is
 * anything with authHeaders() (and optionally invalidate()): openvibe-contracts serviceAuth or
 * openvibe-sdk/auth. The request's traceparent goes along when given.
 */

class AiRunError extends Error {
    constructor(code, message, { status = 502, runId = null } = {}) {
        super(message);
        this.name = 'AiRunError';
        this.code = code;
        this.status = status;
        this.runId = runId;
    }
}

const WORKFLOW_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

function createAiClient({ baseUrl, tokenClient = null, fetch: fetchImpl = globalThis.fetch, waitMs = 55_000, timeoutMs = 120_000, pollMs = 2000 } = {}) {
    const base = baseUrl ? String(baseUrl).replace(/\/+$/, '') : '';
    const enabled = Boolean(base && tokenClient && typeof tokenClient.authHeaders === 'function');

    async function call(method, path, body, { traceparent, retried = false } = {}) {
        let res;
        try {
            res = await fetchImpl(`${base}${path}`, {
                method,
                headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(traceparent ? { traceparent } : {}), ...(await tokenClient.authHeaders()) },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(Math.min(waitMs + 10_000, timeoutMs)),
            });
        } catch (err) {
            throw new AiRunError(err && err.name === 'TimeoutError' ? 'ai.timeout' : 'ai.unreachable', `OpenVibe.AI could not be reached: ${err.message}`, { status: 503 });
        }
        if (res.status === 401 && !retried && typeof tokenClient.invalidate === 'function') {
            tokenClient.invalidate();
            return call(method, path, body, { traceparent, retried: true });
        }
        const json = await res.json().catch(() => ({}));
        return { status: res.status, ok: res.ok, body: json };
    }

    function unwrap(runBody) {
        const run = runBody && runBody.run ? runBody.run : runBody;
        if (!run || !run.id) throw new AiRunError('ai.bad_answer', 'OpenVibe.AI answered without a run');
        return run;
    }

    async function run(workflow, input = {}, { onBehalfOf = null, target = null, attribution = null, idempotencyKey = null, version = null, traceparent = null } = {}) {
        if (!enabled) throw new AiRunError('ai.not_configured', 'OpenVibe.AI is not configured for this product (its URL or service secret is missing)', { status: 503 });
        if (!WORKFLOW_RE.test(String(workflow || ''))) throw new AiRunError('ai.bad_workflow', `not a workflow key: ${workflow}`, { status: 400 });
        const body = { workflow, input, ...(version ? { version } : {}), ...(onBehalfOf ? { on_behalf_of: onBehalfOf } : {}), ...(target ? { target } : {}), ...(attribution ? { attribution } : {}), ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}) };
        const created = await call('POST', `/api/v1/runs?wait=${Math.max(0, Math.min(waitMs, 60_000))}`, body, { traceparent });
        if (!created.ok) {
            const code = created.body && (created.body.code || created.body.error) || `http_${created.status}`;
            throw new AiRunError(created.status === 403 || created.status === 401 ? 'ai.refused' : 'ai.run_failed', `OpenVibe.AI refused the run (${code}): ${(created.body && created.body.detail) || ''}`.trim(), { status: created.status >= 500 ? 502 : created.status });
        }
        let r = unwrap(created.body);
        const deadline = Date.now() + timeoutMs;
        while (r.status === 'queued' || r.status === 'running') {
            if (Date.now() > deadline) throw new AiRunError('ai.timeout', `run ${r.id} did not finish in time`, { status: 504, runId: r.id });
            await new Promise((ok) => setTimeout(ok, pollMs));
            const got = await call('GET', `/api/v1/runs/${encodeURIComponent(r.id)}`, null, { traceparent });
            if (!got.ok) throw new AiRunError('ai.run_failed', `reading run ${r.id} failed (${got.status})`, { runId: r.id });
            r = unwrap(got.body);
        }
        if (r.status !== 'succeeded' && r.status !== 'cached') {
            const e = r.error || {};
            throw new AiRunError('ai.run_failed', `run ${r.id} ${r.status}${e.code ? ` (${e.code}: ${e.detail || ''})` : ''}`, { runId: r.id });
        }
        let citations = [];
        const c = await call('GET', `/api/v1/runs/${encodeURIComponent(r.id)}/citations`, null, { traceparent });
        if (c.ok && c.body && Array.isArray(c.body.citations)) citations = c.body.citations;
        const prov = r.provenance || {};
        return {
            runId: r.id,
            status: r.status,
            output: r.output,
            synthetic: Boolean(r.synthetic),
            citations,
            workflow: { id: (r.workflow && r.workflow.key) || workflow, version: r.workflow && r.workflow.version, runId: r.id, ...(prov.model ? { model: prov.model } : {}) },
        };
    }

    return { enabled, run };
}

module.exports = { createAiClient, AiRunError };
