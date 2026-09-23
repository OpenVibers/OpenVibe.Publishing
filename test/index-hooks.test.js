'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const contracts = require('openvibe-contracts');
const hooks = require('../lib/index-hooks');
const seo = require('../lib/seo');
const { suite } = require('./helpers/db');

const { test, run } = suite();
const USER = 'usr_01J8Z6Q3KX0000000000000000';
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateDoc = ajv.compile(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'contracts-proposal', 'search.index-document.v1.json'), 'utf8')));

const facts = { state: 'published', visibility: 'public', canonicalUrl: 'https://openvibe.wiki/p/rye', wordCount: 400, citationCount: 2 };
const decision = seo.evaluate(facts, { policy: { requireSources: true } });
const input = (extra = {}) => ({
    service: 'wiki', type: 'page', id: 'pg_1', revision: 4, state: 'published', visibility: 'public',
    canonicalUrl: 'https://openvibe.wiki/p/rye', title: 'Rye', summary: 'A cereal grass.', body: 'Rye is a grass grown as a grain.',
    facets: { space: 'food', tags: ['grain', 'bread'] },
    provenance: { authorship: { mode: 'human' }, citations: [{ sourceItemId: 'src_1', url: 'https://example.org/rye', retrievedAt: '2026-09-20T10:00:00Z' }] },
    decision, publishedAt: '2026-09-20T12:00:00Z', updatedAt: '2026-09-21T12:00:00Z', ...extra,
});

function withEventId(env) { return { ...env, event_id: contracts.ids.newId('event') }; }

test('a published revision becomes a full index document with every §12.3 field', () => {
    const doc = hooks.buildIndexDocument(input());
    for (const k of ['owner_service', 'resource_type', 'resource_id', 'revision', 'visibility', 'acl', 'canonical_url', 'title', 'summary', 'body', 'facets', 'provenance', 'publication_state', 'deleted', 'indexability']) {
        assert.ok(k in doc, `missing ${k}`);
    }
    assert.deepStrictEqual(doc.acl, { public: true });
    assert.deepStrictEqual(doc.indexability, { indexable: true, listable: true, reasons: [], gate: 'openvibe-publishing/seo@1' });
    assert.deepStrictEqual(doc.provenance.citations, [{ source_item_id: 'src_1', url: 'https://example.org/rye', retrieved_at: '2026-09-20T10:00:00.000Z' }]);
    assert.ok(validateDoc(doc), JSON.stringify(validateDoc.errors));
});

test('deleted, unpublished, draft and unlisted resources become tombstones with no content', () => {
    for (const extra of [{ deleted: true }, { state: 'unpublished' }, { state: 'draft' }, { visibility: 'unlisted' }]) {
        const doc = hooks.buildIndexDocument(input(extra));
        assert.strictEqual(doc.deleted, true, JSON.stringify(extra));
        for (const k of ['title', 'summary', 'body', 'canonical_url', 'acl']) assert.ok(!(k in doc), `${k} leaked in a tombstone`);
        assert.ok(validateDoc(doc), JSON.stringify(validateDoc.errors));
    }
});

test('private content needs an ACL of subjects; gated content needs entitlements', () => {
    const priv = seo.evaluate({ ...facts, visibility: 'private' }, { policy: { requireSources: true } });
    assert.throws(() => hooks.buildIndexDocument(input({ visibility: 'private', decision: priv })), /acl.subjects/);
    assert.throws(() => hooks.buildIndexDocument(input({ visibility: 'private', decision: priv, acl: { subjects: ['everyone'] } })), /acl.subjects/);
    const doc = hooks.buildIndexDocument(input({ visibility: 'private', decision: priv, acl: { subjects: [USER] } }));
    assert.deepStrictEqual(doc.acl, { public: false, subjects: [USER] });
    assert.strictEqual(doc.indexability.listable, false);
    assert.throws(() => hooks.buildIndexDocument(input({ visibility: 'gated', decision: priv })), /entitlements/);
    const vip = hooks.buildIndexDocument(input({ visibility: 'gated', decision: priv, acl: { entitlements: ['vip.tier.gold'] } }));
    assert.deepStrictEqual(vip.acl, { public: false, entitlements: ['vip.tier.gold'] });
    assert.ok(validateDoc(vip));
    assert.throws(() => hooks.buildIndexDocument(input({ decision: undefined })), /decision/);
});

test('actionFor maps state transitions to event actions', () => {
    const pub = { state: 'published', visibility: 'public', revision: 1 };
    assert.strictEqual(hooks.actionFor(null, pub), 'published');
    assert.strictEqual(hooks.actionFor({ state: 'draft', revision: 1 }, pub), 'published');
    assert.strictEqual(hooks.actionFor(pub, { ...pub, revision: 2 }), 'updated');
    assert.strictEqual(hooks.actionFor(pub, { ...pub, visibility: 'private' }), 'updated');
    assert.strictEqual(hooks.actionFor(pub, pub), null);
    assert.strictEqual(hooks.actionFor(pub, { ...pub, state: 'unpublished' }), 'unpublished');
    assert.strictEqual(hooks.actionFor(pub, { ...pub, state: 'deleted' }), 'deleted');
    assert.strictEqual(hooks.actionFor({ state: 'deleted' }, { state: 'deleted' }), null);
    assert.strictEqual(hooks.actionFor({ state: 'draft' }, { state: 'draft' }), null);
});

test('publication events are valid contracts envelopes: <product>.<type>.<action>', () => {
    const doc = hooks.buildIndexDocument(input());
    const env = hooks.publicationEvent({ product: 'wiki', type: 'page', action: 'published', id: 'pg_1', revision: 4, actor: USER, document: doc, decision, now: Date.parse('2026-09-22T12:00:00Z') });
    assert.strictEqual(env.event_type, 'wiki.page.published');
    assert.strictEqual(env.visibility, 'public');
    assert.deepStrictEqual(env.actor, { type: 'user', id: USER });
    assert.deepStrictEqual(env.subject, { type: 'page', id: 'pg_1', revision: 4 });
    assert.strictEqual(env.payload.document, doc);
    assert.ok(!('event_id' in env), 'the outbox assigns event_id');
    const check = contracts.validate('events.event-envelope@1', withEventId(env));
    assert.ok(check.valid, JSON.stringify(check.errors));

    const tomb = hooks.buildIndexDocument(input({ deleted: true }));
    const del = hooks.publicationEvent({ product: 'blog', type: 'post', action: 'deleted', id: 'pg_1', revision: 4, actor: 'svc:blog', document: tomb });
    assert.strictEqual(del.event_type, 'blog.post.deleted');
    assert.strictEqual(del.visibility, 'internal');
    assert.deepStrictEqual(del.actor, { type: 'service', id: 'blog' });
    assert.ok(contracts.validate('events.event-envelope@1', withEventId(del)).valid);
    assert.throws(() => hooks.publicationEvent({ product: 'blog', type: 'post', action: 'deleted', id: 'pg_1', revision: 4, actor: USER, document: doc }), /tombstone/);
    assert.throws(() => hooks.publicationEvent({ product: 'blog', type: 'post', action: 'published', id: 'pg_1', revision: 4, actor: USER, document: tomb }), /published document/);
    assert.throws(() => hooks.publicationEvent({ product: 'blog', type: 'post', action: 'moved', id: 'pg_1', revision: 4, actor: USER, document: doc }), /action/);
});

test('events about private or non-listable content are internal', () => {
    const priv = seo.evaluate({ ...facts, visibility: 'private' }, { policy: { requireSources: true } });
    const doc = hooks.buildIndexDocument(input({ visibility: 'private', decision: priv, acl: { subjects: [USER] } }));
    const env = hooks.publicationEvent({ product: 'wiki', type: 'page', action: 'updated', id: 'pg_1', revision: 4, actor: USER, document: doc });
    assert.strictEqual(env.visibility, 'internal');
    const unlisted = hooks.buildIndexDocument(input({ visibility: 'unlisted' }));
    const env2 = hooks.publicationEvent({ product: 'wiki', type: 'page', action: 'updated', id: 'pg_1', revision: 4, actor: USER, document: unlisted });
    assert.strictEqual(env2.visibility, 'internal');
    assert.ok(contracts.validate('events.event-envelope@1', withEventId(env2)).valid);
});

run();
