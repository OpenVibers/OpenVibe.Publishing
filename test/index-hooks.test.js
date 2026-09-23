'use strict';
const assert = require('assert');
const contracts = require('openvibe-contracts');
const hooks = require('../lib/index-hooks');
const seo = require('../lib/seo');
const authorship = require('../lib/authorship');
const { openDb, fakeClock, suite } = require('./helpers/db');

const { test, run } = suite();
const USER = 'usr_01J8Z6Q3KX0000000000000000';
const RUN = 'run_01J8Z6Q3KX0000000000000000';

const valid = (doc) => {
    const v = contracts.validate('search.index-document@1', doc);
    assert.ok(v.valid, `search.index-document@1: ${JSON.stringify(v.errors)} in ${JSON.stringify(doc)}`);
    return doc;
};
const validEnvelope = (env) => {
    const v = contracts.validate('events.event-envelope@1', { ...env, event_id: contracts.ids.newId('event') });
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
    owner: 'wiki', type: 'page', id: 'pg_1', revision: 4, state: 'published', visibility: 'public',
    canonicalUrl: 'https://openvibe.wiki/p/rye', title: 'Rye', summary: 'A cereal grass.', body: 'Rye is a grass grown as a grain.',
    facets: { space: 'food', tags: ['grain', 'bread'], words: 400 },
    authorship: authorship.record({ mode: 'human', authors: [USER] }),
    citations: [
        { id: 7, sourceItemId: 'src_1', url: 'https://example.org/rye', title: 'Rye', retrievedAt: '2026-09-20T10:00:00Z' },
        { id: 8, url: 'https://example.org/other' },
    ],
    decision: decisionFor(), publishedAt: '2026-09-20T12:00:00Z', updatedAt: '2026-09-21T12:00:00Z', language: 'en', ...extra,
});

test('a published revision becomes exactly the released search.index-document@1 shape', () => {
    const doc = valid(hooks.buildIndexDocument(input()));
    assert.deepStrictEqual(Object.keys(doc), ['owner', 'type', 'id', 'revision', 'deleted', 'visibility', 'canonical_url', 'title', 'summary', 'body',
        'facets', 'language', 'authorship', 'provenance', 'publication_state', 'published_at', 'updated_at', 'indexability']);
    assert.strictEqual(doc.owner, 'wiki');
    assert.strictEqual(doc.visibility, 'public');
    assert.ok(!('acl' in doc), 'a public document carries no ACL');
    assert.strictEqual(doc.authorship, 'human');
    assert.deepStrictEqual(doc.indexability, { decision: 'index', reasons: [] });
    assert.deepStrictEqual(doc.provenance, [
        { service: 'sources', type: 'item', id: 'src_1', label: 'Rye', url: 'https://example.org/rye', retrieved_at: '2026-09-20T10:00:00.000Z' },
        { service: 'wiki', type: 'citation', id: '8', url: 'https://example.org/other' },
    ], 'no retrieved_at invented for the second citation');
});

test('authorship, visibility and reason codes map onto the contract enums', () => {
    const ai = authorship.record({ mode: 'ai', workflow: { id: 'wiki.generate_page', runId: RUN }, stubProvider: true });
    const hybrid = authorship.record({ mode: 'hybrid', authors: [USER], workflow: { id: 'blog.draft_post', runId: RUN } });
    const imported = authorship.record({ mode: 'imported', importedFrom: { label: 'legacy' } });
    assert.strictEqual(valid(hooks.buildIndexDocument(input({ authorship: hybrid }))).authorship, 'ai_assisted');
    assert.strictEqual(valid(hooks.buildIndexDocument(input({ authorship: imported }))).authorship, 'imported');
    const aiDoc = valid(hooks.buildIndexDocument(input({ authorship: ai, decision: decisionFor(authorship.gateFacts(ai)) })));
    assert.strictEqual(aiDoc.authorship, 'ai_generated');
    assert.deepStrictEqual(aiDoc.provenance[0], { service: 'ai', type: 'run', id: RUN, label: 'wiki.generate_page', stub: true });
    assert.deepStrictEqual(aiDoc.indexability, { decision: 'noindex', reasons: ['ai_unreviewed', 'stub_provider'] });

    const thin = valid(hooks.buildIndexDocument(input({ decision: decisionFor({ wordCount: 3, citationCount: 0, noindex: true, canonicalUrl: undefined }) })));
    assert.deepStrictEqual(thin.indexability.reasons, ['thin_content', 'unsourced', 'missing_canonical_url', 'owner_decision']);
    const dup = valid(hooks.buildIndexDocument(input({ decision: decisionFor({ duplicateOf: 'https://openvibe.wiki/p/x' }) })));
    assert.deepStrictEqual(dup.indexability.reasons, ['duplicate_of']);
    for (const code of Object.keys(hooks.SEARCH_REASONS)) assert.match(hooks.SEARCH_REASONS[code], /^[a-z][a-z0-9_]{1,63}$/);
});

test('private needs subjects; gated becomes members with entitlements/groups; nothing non-public reads as public', () => {
    const priv = decisionFor({ visibility: 'private' });
    assert.throws(() => hooks.buildIndexDocument(input({ visibility: 'private', decision: priv })), /acl.subjects/);
    assert.throws(() => hooks.buildIndexDocument(input({ visibility: 'private', decision: priv, acl: { subjects: ['everyone'] } })), /not valid/);
    const doc = valid(hooks.buildIndexDocument(input({ visibility: 'private', decision: priv, acl: { subjects: [USER, USER] } })));
    assert.strictEqual(doc.visibility, 'private');
    assert.deepStrictEqual(doc.acl, { subjects: [USER] });
    assert.deepStrictEqual(doc.indexability.reasons, ['private']);
    const gated = decisionFor({ visibility: 'gated' });
    assert.throws(() => hooks.buildIndexDocument(input({ visibility: 'gated', decision: gated })), /members/);
    const vip = valid(hooks.buildIndexDocument(input({ visibility: 'gated', decision: gated, acl: { entitlements: ['vip.plan:pln_gold'], groups: ['wiki.space:food:member'] } })));
    assert.strictEqual(vip.visibility, 'members');
    assert.deepStrictEqual(vip.acl, { groups: ['wiki.space:food:member'], entitlements: ['vip.plan:pln_gold'] });
    assert.deepStrictEqual(vip.indexability.reasons, ['members_only']);
    assert.throws(() => hooks.buildIndexDocument(input({ visibility: 'friends' })), /visibility/);
    assert.throws(() => hooks.buildIndexDocument(input({ decision: undefined })), /decision/);
});

test('tombstones are exactly { owner, type, id, revision, deleted: true } for anything that must leave Search', () => {
    for (const extra of [{ deleted: true }, { state: 'unpublished' }, { state: 'draft' }, { state: 'scheduled' }, { state: 'retracted' }, { state: 'archived' }, { visibility: 'unlisted' }]) {
        const doc = valid(hooks.buildIndexDocument(input(extra)));
        assert.deepStrictEqual(doc, { owner: 'wiki', type: 'page', id: 'pg_1', revision: 4, deleted: true }, JSON.stringify(extra));
    }
    const unlisted = valid(hooks.buildIndexDocument(input({ visibility: 'unlisted', includeUnlisted: true, decision: decisionFor({ visibility: 'unlisted' }) })));
    assert.strictEqual(unlisted.visibility, 'unlisted');
    assert.deepStrictEqual(unlisted.indexability.reasons, ['unlisted']);
});

test('limits of the contract are respected: long text is clipped, bad facets and ids refused', () => {
    const doc = valid(hooks.buildIndexDocument(input({ title: 't'.repeat(900), summary: 's'.repeat(5000), body: 'b'.repeat(60000) })));
    assert.strictEqual(doc.title.length, 500);
    assert.strictEqual(doc.summary.length, 4000);
    assert.strictEqual(doc.body.length, 48000);
    assert.throws(() => hooks.buildIndexDocument(input({ facets: { tags: [1, 2] } })), /strings/);
    assert.throws(() => hooks.buildIndexDocument(input({ facets: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, 'x'])) })), /20 facets/);
    assert.throws(() => hooks.buildIndexDocument(input({ id: 'has space' })), /id must match/);
    assert.throws(() => hooks.buildIndexDocument(input({ owner: 'open-re' })), /owner/);
    assert.throws(() => hooks.buildIndexDocument(input({ language: 'english!' })), /BCP 47/);
    assert.ok(!('summary' in valid(hooks.buildIndexDocument(input({ summary: null })))));
});

test('index events are what Search consumes: <owner>.index_document.upserted|deleted', () => {
    const doc = hooks.buildIndexDocument(input());
    const up = validEnvelope(hooks.indexEvent({ document: doc, now: Date.parse('2026-09-22T12:00:00Z') }));
    assert.strictEqual(up.event_type, 'wiki.index_document.upserted');
    assert.strictEqual(up.source, 'wiki');
    assert.deepStrictEqual(up.actor, { type: 'service', id: 'wiki' });
    assert.deepStrictEqual(up.subject, { type: 'page', id: 'pg_1', revision: 4 });
    assert.ok(!('event_id' in up), 'the outbox assigns event_id');
    assert.deepStrictEqual(searchReads(up), doc);

    const tomb = hooks.tombstone({ owner: 'wiki', type: 'page', id: 'pg_1', revision: 5 });
    const del = validEnvelope(hooks.indexEvent({ document: tomb, actor: USER }));
    assert.strictEqual(del.event_type, 'wiki.index_document.deleted');
    assert.deepStrictEqual(del.payload, { type: 'page', id: 'pg_1', revision: 5 });
    assert.deepStrictEqual(searchReads(del), tomb);
    assert.throws(() => hooks.indexEvent({}), /document/);
});

test('the sequencer bumps the index revision on every indexed change and replays unchanged documents', () => {
    const seq = hooks.createIndexSequencer(openDb('idx'), { prefix: 'wiki', now: fakeClock() });
    const a = seq.stamp(hooks.buildIndexDocument(input({ revision: 0 })));
    assert.strictEqual(a.revision, 1);
    assert.strictEqual(seq.stamp(hooks.buildIndexDocument(input({ revision: 0 }))).revision, 1, 'same document, same revision');
    const priv = seq.stamp(hooks.buildIndexDocument(input({ revision: 0, visibility: 'private', acl: { subjects: [USER] }, decision: decisionFor({ visibility: 'private' }) })));
    assert.strictEqual(priv.revision, 2, 'a visibility change with the same content still gets a new revision');
    const gone = seq.stamp(hooks.tombstone({ owner: 'wiki', type: 'page', id: 'pg_1', revision: 0 }));
    assert.strictEqual(gone.revision, 3);
    const back = seq.stamp(hooks.buildIndexDocument(input({ revision: 0 })));
    assert.strictEqual(back.revision, 4, 'a restore outranks the tombstone');
    assert.strictEqual(seq.current('wiki', 'page', 'pg_1'), 4);
    valid(back);
    assert.strictEqual(seq.table, 'wiki_index_revisions');
});

test('actionFor maps state transitions to product events', () => {
    const pub = { state: 'published', visibility: 'public', revision: 1 };
    assert.strictEqual(hooks.actionFor(null, pub), 'published');
    assert.strictEqual(hooks.actionFor({ state: 'draft', revision: 1 }, pub), 'published');
    assert.strictEqual(hooks.actionFor(pub, { ...pub, revision: 2 }), 'updated');
    assert.strictEqual(hooks.actionFor(pub, { ...pub, visibility: 'private' }), 'updated');
    assert.strictEqual(hooks.actionFor(pub, pub), null);
    assert.strictEqual(hooks.actionFor(pub, { ...pub, state: 'unpublished' }), 'unpublished');
    assert.strictEqual(hooks.actionFor(pub, { ...pub, state: 'deleted' }), 'deleted');
    assert.strictEqual(hooks.actionFor({ state: 'deleted' }, { state: 'deleted' }), null);
});

test('product events <product>.<type>.<action> are valid envelopes, internal unless public and listable', () => {
    const decision = decisionFor();
    const doc = hooks.buildIndexDocument(input());
    const env = validEnvelope(hooks.publicationEvent({ product: 'wiki', type: 'page', action: 'published', id: 'pg_1', revision: 4, actor: USER, document: doc, decision }));
    assert.strictEqual(env.event_type, 'wiki.page.published');
    assert.strictEqual(env.visibility, 'public');
    assert.deepStrictEqual(env.payload, { canonical_url: 'https://openvibe.wiki/p/rye', publication_state: 'published', indexability: { decision: 'index', reasons: [] } });
    assert.ok(!('body' in env.payload), 'no body in the product event');
    const priv = decisionFor({ visibility: 'private' });
    const pdoc = hooks.buildIndexDocument(input({ visibility: 'private', acl: { subjects: [USER] }, decision: priv }));
    assert.strictEqual(validEnvelope(hooks.publicationEvent({ product: 'wiki', type: 'page', action: 'updated', id: 'pg_1', revision: 4, actor: USER, document: pdoc, decision: priv })).visibility, 'internal');
    const tomb = hooks.tombstone({ owner: 'blog', type: 'post', id: 'pg_1', revision: 9 });
    const del = validEnvelope(hooks.publicationEvent({ product: 'blog', type: 'post', action: 'deleted', id: 'pg_1', revision: 4, actor: 'svc:blog', document: tomb }));
    assert.strictEqual(del.visibility, 'internal');
    assert.strictEqual(del.payload.publication_state, 'deleted');
    assert.throws(() => hooks.publicationEvent({ product: 'blog', type: 'post', action: 'deleted', id: 'pg_1', revision: 4, actor: USER, document: doc }), /tombstone/);
    assert.throws(() => hooks.publicationEvent({ product: 'blog', type: 'post', action: 'published', id: 'pg_1', revision: 4, actor: USER, document: tomb }), /published document/);
    assert.throws(() => hooks.publicationEvent({ product: 'blog', type: 'post', action: 'moved', id: 'pg_1', revision: 4, actor: USER, document: doc }), /action/);
});

run();
