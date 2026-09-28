'use strict';
/**
 * Transaction handles (1.0.0): every store method takes the caller's transaction handle as an optional
 * first argument, so a product's own write and the stores' writes commit together or not at all; a
 * store write that fails inside the caller's transaction rolls back only its own savepoint.
 */
const assert = require('assert');
const { openDb, fakeClock, suite, sql } = require('./helpers/db');
const { createRevisionStore } = require('../lib/revisions');
const { createCitationStore } = require('../lib/citations');
const { createTaxonomy } = require('../lib/taxonomy');
const { createScheduler } = require('../lib/schedule');
const { createAttachmentStore } = require('../lib/media');
const { createReviewLog } = require('../lib/authorship');
const { createRedirectStore } = require('../lib/seo');
const { createDiscussionRefs } = require('../lib/discussion');

const { test, run } = suite();
const MED = 'med_01J8Z6Q3KX0000000000000000';
const USER = 'usr_01J8Z6Q3KX0000000000000000';

async function setup() {
    const db = await openDb();
    const now = fakeClock();
    await db.query('CREATE TABLE pages (id text PRIMARY KEY, title text NOT NULL)');
    const revisions = await createRevisionStore(db, { prefix: 'wiki_page', now }).ensureSchema();
    const s = {
        db,
        revisions,
        citations: await createCitationStore(db, { prefix: 'wiki', now, revisions }).ensureSchema(),
        taxonomy: await createTaxonomy(db, { prefix: 'wiki', now }).ensureSchema(),
        scheduler: await createScheduler(db, { prefix: 'wiki', now }).ensureSchema(),
        media: await createAttachmentStore(db, { prefix: 'wiki_page', now }).ensureSchema(),
        reviews: await createReviewLog(db, { prefix: 'wiki_page', now }).ensureSchema(),
        redirects: await createRedirectStore(db, { prefix: 'wiki_page', now }).ensureSchema(),
        refs: await createDiscussionRefs(db, { prefix: 'wiki', now }).ensureSchema(),
    };
    return s;
}

/** Every store write the caller's transaction can carry, plus the product's own row. */
async function writeAll(t, s, id) {
    await t.exec(sql`INSERT INTO pages (id, title) VALUES (${id}, ${'Rye'})`);
    const { revision } = await s.revisions.create(t, { entityId: id, expectedRevision: 0, content: 'Rye is a grass.', fields: { title: 'Rye' } });
    assert.strictEqual((await s.revisions.head(t, id)).number, 1, 'a read on t sees the transaction\'s own write');
    await s.citations.attachMany(t, id, revision.number, [{ url: 'https://example.org/rye' }]);
    await s.taxonomy.setTerms(t, id, 'tag', ['grain']);
    await s.scheduler.schedule(t, { entityId: id, action: 'publish', runAt: Date.parse('2026-10-01T00:00:00Z'), revision: 1 });
    await s.media.attach(t, { entityId: id, mediaId: MED });
    await s.reviews.record(t, { entityId: id, revision: 1, reviewer: USER, decision: 'approved' });
    await s.redirects.recordMove(t, id, '/p/old', '/p/rye');
    await s.refs.set(t, id, 'thr_1', { service: 'wiki', type: 'page', id });
    await s.revisions.saveDraft(t, { entityId: id, owner: USER, content: 'draft' });
}

async function counts(db) {
    const n = async (table) => db.value(sql`SELECT count(*) FROM ${sql.ident(table)}`);
    return {
        pages: await n('pages'), revisions: await n('wiki_page_revisions'), drafts: await n('wiki_page_drafts'), citations: await n('wiki_citations'),
        links: await n('wiki_term_links'), jobs: await n('wiki_schedule_jobs'), attachments: await n('wiki_page_attachments'),
        reviews: await n('wiki_page_reviews'), redirects: await n('wiki_page_redirects'), refs: await n('wiki_discussion_refs'),
    };
}

test('a caller\'s transaction spans its own write and every store\'s writes: commit keeps all', async () => {
    const s = await setup();
    await s.db.tx((t) => writeAll(t, s, 'pg_1'));
    assert.deepStrictEqual(await counts(s.db), { pages: 1, revisions: 1, drafts: 1, citations: 1, links: 1, jobs: 1, attachments: 1, reviews: 1, redirects: 1, refs: 1 });
});

test('a rollback of the caller\'s transaction leaves neither its write nor any store write', async () => {
    const s = await setup();
    await assert.rejects(s.db.tx(async (t) => { await writeAll(t, s, 'pg_1'); throw new Error('the product changed its mind'); }), /changed its mind/);
    assert.deepStrictEqual(await counts(s.db), { pages: 0, revisions: 0, drafts: 0, citations: 0, links: 0, jobs: 0, attachments: 0, reviews: 0, redirects: 0, refs: 0 });
    assert.strictEqual(await s.taxonomy.bySlug('tag', 'grain'), null, 'a term created on demand rolled back too');
    // and the same writes succeed afterwards: nothing half-done was left behind
    await s.db.tx((t) => writeAll(t, s, 'pg_1'));
    assert.strictEqual((await counts(s.db)).revisions, 1);
});

test('a store refusal inside the caller\'s transaction undoes only that store call (its savepoint); the caller commits the rest', async () => {
    const s = await setup();
    const head = await s.db.tx(async (t) => {
        await t.exec(sql`INSERT INTO pages (id, title) VALUES ('pg_3', 'Barley')`);
        await s.revisions.create(t, { entityId: 'pg_3', expectedRevision: 0, content: 'v1' });
        // A stale write: 412 from the store; the caller catches it and carries on in the same transaction.
        const err = await s.revisions.create(t, { entityId: 'pg_3', expectedRevision: 0, content: 'lost' }).catch((e) => e);
        assert.strictEqual(err.status, 412);
        await s.taxonomy.setTerms(t, 'pg_3', 'tag', ['barley']);
        // setTerms deletes the old links before it finds the unknown id: the savepoint puts them back.
        const refused = await s.taxonomy.setTerms(t, 'pg_3', 'tag', ['rye', 987654]).catch((e) => e);
        assert.strictEqual(refused.code, 'term.not_found');
        assert.deepStrictEqual((await s.taxonomy.termsFor(t, 'pg_3', 'tag')).map((x) => x.slug), ['barley']);
        return s.revisions.headNumber(t, 'pg_3');
    });
    assert.strictEqual(head, 1);
    assert.strictEqual((await counts(s.db)).pages, 1, 'the caller\'s write committed');
    assert.deepStrictEqual((await s.taxonomy.termsFor('pg_3', 'tag')).map((x) => x.slug), ['barley']);
    assert.strictEqual(await s.taxonomy.bySlug('tag', 'rye'), null, 'the refused call\'s new term rolled back with its savepoint');
});

test('without a handle each store call is its own transaction; with db as the handle it is the same', async () => {
    const s = await setup();
    const a = await s.revisions.create({ entityId: 'e', expectedRevision: 0, content: 'x' });
    const b = await s.revisions.create(s.db, { entityId: 'e', expectedRevision: 1, content: 'y' });
    assert.deepStrictEqual([a.revision.number, b.revision.number], [1, 2]);
    assert.strictEqual(s.db.stats().pool.total, 1);
});

run();
