'use strict';
/**
 * openvibe-publishing/authorship — who made a revision (human | ai | hybrid | imported), which
 * OpenVibe.AI workflow run produced it, the disclosure label, and the human review that lets
 * AI-generated content leave draft/noindex.
 *
 *   const authorship = require('openvibe-publishing/authorship');
 *   const rec = authorship.record({ mode: 'ai', workflow: { id: 'wiki.generate_page', version: 3, runId: 'run_…' }, source: { label: 'Sources item src_…' } });
 *   authorship.initialState(rec)        // → { state: 'draft', noindex: true, reason: 'ai_generated_unreviewed' }
 *   authorship.disclosure(rec).short    // → 'AI-generated'
 *   const reviews = authorship.createReviewLog(db, { prefix: 'wiki_page' });   // wiki_page_reviews (schema('wiki_page'))
 *   await reviews.record({ entityId, revision: 4, reviewer: 'usr_…', decision: 'approved' });
 *   authorship.gateFacts(rec, await reviews.latest(entityId, 4))   // → { authorship: { mode: 'ai', reviewed: true } }
 *
 * Modes (§15.12 names in brackets): human; ai [AI-generated]; hybrid [AI-assisted: a person wrote or
 * cut it from an AI suggestion]; imported [legacy/imported, keeps the original author].
 * Rules:
 *   - ai and hybrid records must name the AI workflow and run (workflow.id + workflow.runId).
 *   - human records must not carry a workflow (that would hide AI involvement the other way round).
 *   - AI-generated content starts as draft + noindex; only a review by a person (a usr_ subject,
 *     never a service or the AI itself) marks it reviewed.
 *   - The record is metadata the product stores with the revision (revisions `meta.authorship`);
 *     reviews are append-only rows, so the revision itself stays immutable.
 * Authorship is data, not a sentence: surfaces render the disclosure from this record.
 */
const {
    PublishingError, assertDb, sqlOf, bindHandles, boundedLimit, toInt4, revisionRefs, refKey, assertPrefix, clockOf, assertEntityId, assertRevisionNumber, immutableTriggers,
} = require('./internal');

const MODES = ['human', 'ai', 'hybrid', 'imported'];
const USER_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUBJECT_RE = /^(usr|gst)_[0-9A-HJKMNP-TV-Z]{26}$/;
const WORKFLOW_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

function record({ mode, authors = [], workflow = null, stubProvider = false, source = null, importedFrom = null } = {}) {
    if (!MODES.includes(mode)) throw new TypeError(`mode must be one of ${MODES.join(', ')}`);
    for (const a of authors) if (!SUBJECT_RE.test(String(a))) throw new TypeError('authors must be usr_/gst_ subject ids');
    let wf = null;
    if (workflow != null) {
        if (!workflow.id || !WORKFLOW_RE.test(workflow.id)) throw new TypeError('workflow.id must be an OpenVibe.AI workflow key like "wiki.generate_page"');
        if (!workflow.runId || typeof workflow.runId !== 'string') throw new TypeError('workflow.runId is required');
        wf = { id: workflow.id, runId: workflow.runId };
        if (workflow.version != null) wf.version = workflow.version;
        if (workflow.model != null) wf.model = String(workflow.model);
    }
    if ((mode === 'ai' || mode === 'hybrid') && !wf) throw new PublishingError(400, 'authorship.workflow_required', `${mode} authorship must reference the AI workflow and run`);
    if (mode === 'human' && wf) throw new PublishingError(400, 'authorship.workflow_on_human', 'human authorship cannot carry an AI workflow; use hybrid');
    if ((mode === 'human' || mode === 'hybrid') && !authors.length) throw new PublishingError(400, 'authorship.author_required', `${mode} authorship names the person accountable`);
    if (mode === 'imported' && !importedFrom) throw new PublishingError(400, 'authorship.import_source_required', 'imported authorship names where it came from');
    const out = { mode, authors: [...authors] };
    if (wf) out.workflow = wf;
    if (stubProvider) out.stubProvider = true;
    if (source) out.source = { label: source.label == null ? null : String(source.label), ref: source.ref || null };
    if (importedFrom) out.importedFrom = { label: String(importedFrom.label || ''), originalAuthor: importedFrom.originalAuthor == null ? null : String(importedFrom.originalAuthor) };
    return out;
}

/** Only AI-generated content needs a review before it may be published and indexed. */
function needsReview(rec) { return rec.mode === 'ai' || Boolean(rec.stubProvider); }

function isReviewed(rec, review) {
    return Boolean(review && review.decision === 'approved' && USER_RE.test(String(review.reviewer)));
}

/** Where a new revision starts. AI-generated → draft + noindex until reviewed. */
function initialState(rec, review = null) {
    if (needsReview(rec) && !isReviewed(rec, review)) return { state: 'draft', noindex: true, reason: rec.mode === 'ai' ? 'ai_generated_unreviewed' : 'stub_provider' };
    return { state: 'draft', noindex: false, reason: null };
}

/** { ok, reason } — whether this revision may be published now. */
function canPublish(rec, review = null) {
    if (needsReview(rec) && !isReviewed(rec, review)) return { ok: false, reason: rec.mode === 'ai' ? 'ai_generated_unreviewed' : 'stub_provider' };
    return { ok: true, reason: null };
}

/** Facts for seo.evaluate: { authorship: { mode, reviewed }, stubProvider }. */
function gateFacts(rec, review = null) {
    const reviewed = isReviewed(rec, review);
    const out = { authorship: { mode: rec.mode, reviewed } };
    if (rec.stubProvider) out.stubProvider = true;
    return out;
}

/**
 * Disclosure text, rendered at the item (not in a footer). Returns null for plain human content.
 * { short, long, mode }
 */
function disclosure(rec, review = null, { sourceLabel } = {}) {
    const src = sourceLabel || (rec.source && rec.source.label) || null;
    const wf = rec.workflow ? `${rec.workflow.id}${rec.workflow.version != null ? ` v${rec.workflow.version}` : ''}` : null;
    const reviewed = isReviewed(rec, review);
    switch (rec.mode) {
    case 'human': return null;
    case 'ai': return {
        mode: 'ai',
        short: 'AI-generated',
        long: `AI-generated${src ? ` from ${src}` : ''} by workflow ${wf}${reviewed ? ', reviewed by a person' : ', not yet reviewed by a person'}.`,
    };
    case 'hybrid': return { mode: 'hybrid', short: 'Written with AI assistance', long: `Written by a person with AI assistance (workflow ${wf})${src ? `, from ${src}` : ''}.` };
    case 'imported': return {
        mode: 'imported',
        short: 'Imported',
        long: `Imported from ${rec.importedFrom.label}${rec.importedFrom.originalAuthor ? `; originally by ${rec.importedFrom.originalAuthor}` : ''}.`,
    };
    default: return null;
    }
}

/** The review log's DDL for one prefix (idempotent), for the service's migration file. */
function schema(prefix) {
    assertPrefix(prefix);
    const R = `${prefix}_reviews`;
    return `CREATE TABLE IF NOT EXISTS ${R} (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id   text COLLATE "C" NOT NULL,
    revision    integer NOT NULL,
    reviewer    text NOT NULL,
    decision    text NOT NULL CHECK (decision IN ('approved','rejected')),
    note        text,
    reviewed_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS ${R}_rev ON ${R} (entity_id, revision, id);
CREATE INDEX IF NOT EXISTS ${R}_entity ON ${R} (entity_id, id);
${immutableTriggers(R)}`;
}

/** Append-only review log: <prefix>_reviews (UPDATE aborts in a PL/pgSQL trigger). */
function createReviewLog(db, { prefix, now } = {}) {
    assertDb(db);
    assertPrefix(prefix);
    const sql = sqlOf(db);
    const clock = clockOf(now);
    const R = `${prefix}_reviews`;
    const r$ = sql.ident(R);
    const shape = (r) => (r ? { id: r.id, entityId: r.entity_id, revision: r.revision, reviewer: r.reviewer, decision: r.decision, note: r.note, reviewedAt: new Date(r.reviewed_at).toISOString() } : null);
    const impl = {
        /** A person's review of one revision. The reviewer must be a usr_ subject. */
        async record(h, { entityId, revision, reviewer, decision, note = null } = {}) {
            assertEntityId(entityId);
            assertRevisionNumber(revision, 'revision');
            if (revision > 2147483647) throw new TypeError('revision is out of range');
            if (!USER_RE.test(String(reviewer))) throw new PublishingError(400, 'review.reviewer_not_person', 'Only a person (usr_ subject) can review');
            if (decision !== 'approved' && decision !== 'rejected') throw new TypeError('decision must be approved or rejected');
            return shape(await h.one(sql`INSERT INTO ${r$} (entity_id, revision, reviewer, decision, note, reviewed_at)
                VALUES (${entityId}, ${revision}, ${reviewer}, ${decision}, ${note == null ? null : String(note).slice(0, 2000)}, ${clock()})
                RETURNING *`));
        },
        async latest(h, entityId, revision) {
            const n = toInt4(revision);
            if (n == null) return null;
            return shape(await h.maybe(sql`SELECT * FROM ${r$} WHERE entity_id = ${assertEntityId(entityId)} AND revision = ${n} ORDER BY id DESC LIMIT 1`));
        },
        /** The latest review of several revisions in one query: refs [{ entityId, revision }] → reviews (or null), same order. */
        async latestMany(h, refs = []) {
            const keys = revisionRefs(refs).filter((k) => k.number != null);
            const by = new Map();
            if (keys.length) {
                const rows = await h.many(sql`SELECT DISTINCT ON (r.entity_id, r.revision) r.*
                    FROM unnest(${keys.map((k) => k.entityId)}::text[], ${keys.map((k) => k.number)}::integer[]) AS k(entity_id, revision)
                    JOIN ${r$} r ON r.entity_id = k.entity_id AND r.revision = k.revision
                    ORDER BY r.entity_id, r.revision, r.id DESC`);
                for (const r of rows) by.set(refKey(r.entity_id, r.revision), shape(r));
            }
            return revisionRefs(refs).map((k) => by.get(refKey(k.entityId, k.number)) || null);
        },
        async history(h, entityId, { limit = 1000 } = {}) {
            return (await h.many(sql`SELECT * FROM ${r$} WHERE entity_id = ${assertEntityId(entityId)} ORDER BY id LIMIT ${boundedLimit(limit)}`)).map(shape);
        },
    };
    const api = bindHandles(db, impl);
    api.table = R;
    api.schema = () => schema(prefix);
    /** Create the table where the handle may (tests, PGlite); services put schema() in a migration. */
    api.ensureSchema = async () => { await db.query(schema(prefix)); return api; };
    return api;
}

module.exports = { MODES, record, needsReview, isReviewed, initialState, canPublish, gateFacts, disclosure, createReviewLog, schema };
