'use strict';
const assert = require('assert');
const { openDb, fakeClock, suite } = require('./helpers/db');
const authorship = require('../lib/authorship');
const seo = require('../lib/seo');

const { test, run } = suite();
const USER = 'usr_01J8Z6Q3KX0000000000000000';
const WF = { id: 'wiki.generate_page', version: 3, runId: 'run_01J8Z6Q3KX0000000000000000', model: 'stub' };
const facts = (extra) => ({ state: 'published', visibility: 'public', canonicalUrl: 'https://openvibe.wiki/p/x', wordCount: 500, ...extra });

test('records: ai/hybrid need a workflow run, human cannot carry one', () => {
    assert.deepStrictEqual(authorship.record({ mode: 'human', authors: [USER] }), { mode: 'human', authors: [USER] });
    const ai = authorship.record({ mode: 'ai', workflow: WF, source: { label: 'goosely\'s stream' } });
    assert.deepStrictEqual(ai.workflow, WF);
    assert.throws(() => authorship.record({ mode: 'ai' }), (e) => e.code === 'authorship.workflow_required');
    assert.throws(() => authorship.record({ mode: 'hybrid', authors: [USER] }), (e) => e.code === 'authorship.workflow_required');
    assert.throws(() => authorship.record({ mode: 'human', authors: [USER], workflow: WF }), (e) => e.code === 'authorship.workflow_on_human');
    assert.throws(() => authorship.record({ mode: 'human' }), (e) => e.code === 'authorship.author_required');
    assert.throws(() => authorship.record({ mode: 'imported' }), (e) => e.code === 'authorship.import_source_required');
    assert.throws(() => authorship.record({ mode: 'robot' }), /mode/);
    assert.throws(() => authorship.record({ mode: 'ai', workflow: { id: 'Bad Id', runId: 'r' } }), /workflow.id/);
    assert.throws(() => authorship.record({ mode: 'human', authors: ['42'] }), /subject/);
});

test('AI-generated defaults to draft + noindex until a person reviews it', () => {
    const db = openDb('auth');
    const reviews = authorship.createReviewLog(db, { prefix: 'wiki_page', now: fakeClock() });
    const rec = authorship.record({ mode: 'ai', workflow: WF });
    assert.deepStrictEqual(authorship.initialState(rec), { state: 'draft', noindex: true, reason: 'ai_generated_unreviewed' });
    assert.deepStrictEqual(authorship.canPublish(rec), { ok: false, reason: 'ai_generated_unreviewed' });
    const before = seo.evaluate(facts(authorship.gateFacts(rec, reviews.latest('pg', 1))));
    assert.deepStrictEqual(before.codes, ['ai_generated_unreviewed']);

    assert.throws(() => reviews.record({ entityId: 'pg', revision: 1, reviewer: 'svc:wiki', decision: 'approved' }), (e) => e.code === 'review.reviewer_not_person');
    reviews.record({ entityId: 'pg', revision: 1, reviewer: USER, decision: 'rejected', note: 'wrong facts' });
    assert.strictEqual(authorship.canPublish(rec, reviews.latest('pg', 1)).ok, false);
    reviews.record({ entityId: 'pg', revision: 1, reviewer: USER, decision: 'approved' });
    const review = reviews.latest('pg', 1);
    assert.strictEqual(authorship.canPublish(rec, review).ok, true);
    assert.strictEqual(seo.evaluate(facts(authorship.gateFacts(rec, review))).indexable, true);
    assert.strictEqual(reviews.latest('pg', 2), null, 'a review covers one revision only');
    assert.strictEqual(reviews.history('pg').length, 2);
    assert.throws(() => db.prepare("UPDATE wiki_page_reviews SET decision = 'approved'").run(), /immutable/);
});

test('stub-provider output is held like AI output', () => {
    const rec = authorship.record({ mode: 'hybrid', authors: [USER], workflow: WF, stubProvider: true });
    assert.deepStrictEqual(authorship.canPublish(rec), { ok: false, reason: 'stub_provider' });
    assert.deepStrictEqual(seo.evaluate(facts(authorship.gateFacts(rec))).codes, ['stub_provider']);
});

test('human and hybrid content publishes without an AI review', () => {
    assert.strictEqual(authorship.canPublish(authorship.record({ mode: 'human', authors: [USER] })).ok, true);
    assert.strictEqual(authorship.canPublish(authorship.record({ mode: 'hybrid', authors: [USER], workflow: WF })).ok, true);
});

test('disclosure labels name the workflow and the source; human content has none', () => {
    assert.strictEqual(authorship.disclosure(authorship.record({ mode: 'human', authors: [USER] })), null);
    const ai = authorship.record({ mode: 'ai', workflow: WF, source: { label: 'goosely\'s stream' } });
    assert.deepStrictEqual(authorship.disclosure(ai), {
        mode: 'ai', short: 'AI-generated',
        long: 'AI-generated from goosely\'s stream by workflow wiki.generate_page v3, not yet reviewed by a person.',
    });
    assert.match(authorship.disclosure(ai, { decision: 'approved', reviewer: USER }).long, /reviewed by a person\.$/);
    assert.strictEqual(authorship.disclosure(authorship.record({ mode: 'hybrid', authors: [USER], workflow: WF })).short, 'Written with AI assistance');
    const imp = authorship.record({ mode: 'imported', importedFrom: { label: 'the legacy Live pastes', originalAuthor: 'goosely' } });
    assert.strictEqual(authorship.disclosure(imp).long, 'Imported from the legacy Live pastes; originally by goosely.');
});

run();
