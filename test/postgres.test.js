'use strict';
/**
 * Integration: the stores on PostgreSQL 18 through PgBouncer in transaction mode (ADR-035), the way a
 * service runs them: DDL on the owner's direct connection (as its migration would), everything else
 * through the pooler with several connections at once. PGlite is one connection, so what only real
 * concurrency shows is here: racing writers of one entity, racing workers, racing get-or-create, a purge
 * racing new revisions, and savepoints inside callers' transactions behind the pooler.
 *
 * Runs when OV_TEST_PG_URL (PgBouncer) and OV_TEST_PG_DIRECT_URL are set:
 *   eval "$(node_modules/openvibe-sdk/scripts/test-services.sh up)" && npm test
 * Tables are prefixed ovpubit_ and dropped before and after the run.
 */
const assert = require('assert');
const { createDb, sql } = require('openvibe-sdk/db');
const publishing = require('..');
const { createRevisionStore } = require('../lib/revisions');
const { createCitationStore } = require('../lib/citations');
const { createTaxonomy } = require('../lib/taxonomy');
const { createScheduler } = require('../lib/schedule');
const { createAttachmentStore } = require('../lib/media');
const { createReviewLog } = require('../lib/authorship');
const { createRedirectStore } = require('../lib/seo');
const { createDiscussionRefs } = require('../lib/discussion');
const { createIndexSequencer, tombstone } = require('../lib/index-hooks');

const LABEL = 'postgresql+pgbouncer';
if (!process.env.OV_TEST_PG_URL || !process.env.OV_TEST_PG_DIRECT_URL) {
    console.log(`${LABEL}: skipped (OV_TEST_PG_URL not set; start the containers with node_modules/openvibe-sdk/scripts/test-services.sh up)`);
    process.exit(0);
}

const P = 'ovpubit';
const MED = 'med_01J8Z6Q3KX0000000000000000';
const USER = 'usr_01J8Z6Q3KX0000000000000000';
const quiet = { warn() {}, error: console.error, log() {} };

async function dropAll(owner) {
    const tables = (await owner.many(sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE ${`${P}\\_%`}`)).map((r) => r.tablename);
    if (tables.length) await owner.query(`DROP TABLE IF EXISTS ${tables.map((t) => `"${t}"`).join(', ')} CASCADE`);
    const fns = (await owner.many(sql`SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND proname LIKE ${`${P}\\_%`}`)).map((r) => r.proname);
    for (const f of fns) await owner.query(`DROP FUNCTION IF EXISTS "${f}"() CASCADE`);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let owner;
let db;
let s;

test('the schema applies on PostgreSQL 18 over the owner\'s direct connection (as a migration would)', async () => {
    await dropAll(owner);
    const text = publishing.schema({
        revisions: `${P}_wiki_page`, citations: `${P}_wiki`, taxonomy: `${P}_blog`, schedule: `${P}_blog`, media: `${P}_blog_post`,
        authorship: `${P}_wiki_page`, seo: `${P}_wiki_page`, discussion: `${P}_wiki`, indexHooks: `${P}_wiki`,
    });
    await owner.query(text);
    await owner.query(text);   // idempotent on the real server too
    const version = await db.value(sql`SELECT current_setting('server_version_num')::int AS v`);
    assert.ok(version >= 180000, `PostgreSQL ${version}`);
    const r = await db.ready();
    assert.strictEqual(r.detail.store, 'postgresql');
});

test('every store works through the pooler', async () => {
    const { revisions, citations, taxonomy, scheduler, media, reviews, redirects, refs, seq } = s;
    const r1 = (await revisions.create({ entityId: 'pg_1', expectedRevision: 0, content: 'Rye is a grass.', fields: { title: 'Rye' } })).revision;
    await revisions.create({ entityId: 'pg_1', expectedRevision: 1, content: 'Rye is a cereal.', fields: { title: 'Rye' } });
    assert.deepStrictEqual((await revisions.lineage('pg_1')).map((r) => r.number), [2, 1]);
    assert.strictEqual((await revisions.diff('pg_1', 1, 2)).content.added, 1);
    assert.deepStrictEqual(r1.fields, { title: 'Rye' });
    await revisions.saveDraft({ entityId: 'pg_1', owner: USER, content: 'draft', baseRevision: 1 });
    assert.strictEqual((await revisions.drafts('pg_1'))[0].stale, true);
    const cites = await citations.attachMany('pg_1', 1, [{ url: 'https://example.org/a', retrievedAt: '2026-09-20T10:00:00Z' }, { sourceItemId: 'src_1' }]);
    assert.strictEqual(cites[0].retrievedAt, '2026-09-20T10:00:00.000Z');
    await citations.carryForward({ entityId: 'pg_1', fromRevision: 1, toRevision: 2 });
    assert.deepStrictEqual((await citations.forRevisions([{ entityId: 'pg_1', revision: 1 }, { entityId: 'pg_1', revision: 2 }])).map((l) => l.length), [2, 2]);
    await taxonomy.setTerms('post_1', 'tag', ['Rye', 'Oats', 'rye']);
    assert.deepStrictEqual((await taxonomy.termsFor('post_1', 'tag')).map((t) => t.slug), ['rye', 'oats']);
    const job = await scheduler.schedule({ entityId: 'post_1', action: 'publish', runAt: Date.now() - 1000, revision: 1 });
    assert.strictEqual((await scheduler.runDue({ worker: 'w', handler: () => ({ ok: true }) })).done[0].id, job.job.id);
    await media.attach({ entityId: 'post_1', mediaId: MED });
    assert.deepStrictEqual(await media.markBroken(MED, 'deleted'), ['post_1']);
    await reviews.record({ entityId: 'pg_1', revision: 2, reviewer: USER, decision: 'approved' });
    assert.strictEqual((await reviews.latestMany([{ entityId: 'pg_1', revision: 2 }]))[0].decision, 'approved');
    await redirects.recordMove('pg_1', '/p/old', '/p/rye');
    assert.strictEqual((await redirects.resolve('/p/old', { currentPath: async () => '/p/rye' })).status, 301);
    await refs.set('pg_1', 'thr_1', { service: 'wiki', type: 'page', id: 'pg_1' });
    assert.strictEqual((await refs.get('pg_1')).ref.id, 'pg_1');
    const doc = tombstone({ owner: 'wiki', type: 'page', id: 'pg_1', revision: 0 });
    assert.strictEqual((await db.tx((t) => seq.stamp(t, doc))).revision, 1);
    assert.strictEqual((await db.tx((t) => seq.stamp(t, doc))).revision, 1);
});

test('immutability triggers hold on PostgreSQL 18', async () => {
    await assert.rejects(db.exec(sql`UPDATE ${sql.ident(`${P}_wiki_page_revisions`)} SET content = 'x'`), (e) => e.code === '23001');
    await assert.rejects(db.exec(sql`DELETE FROM ${sql.ident(`${P}_wiki_citations`)}`), (e) => e.code === '23001');
    await assert.rejects(db.exec(sql`UPDATE ${sql.ident(`${P}_wiki_page_reviews`)} SET note = 'x'`), (e) => e.code === '23001');
});

test('racing writers of one entity (separate connections): exactly one revision lands, the rest are 412', async () => {
    const { revisions } = s;
    await revisions.create({ entityId: 'race', expectedRevision: 0, content: 'base' });
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => revisions.create({ entityId: 'race', expectedRevision: 1, content: `writer ${i}` })));
    const ok = results.filter((r) => r.status === 'fulfilled');
    assert.strictEqual(ok.length, 1, JSON.stringify(results.filter((r) => r.status === 'rejected').map((r) => r.reason.message).slice(0, 3)));
    assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.status === 412 && r.reason.current === 2));
    assert.strictEqual(await revisions.headNumber('race'), 2);
});

test('a purge racing new revisions: nothing of the entity survives, and later writes are 410', async () => {
    const { revisions } = s;
    await revisions.create({ entityId: 'doomed', expectedRevision: 0, content: 'v1' });
    const writes = Array.from({ length: 8 }, (_, i) => revisions.create({ entityId: 'doomed', expectedRevision: 1 + i, content: `v${i + 2}` }).catch((e) => e));
    const purge = revisions.purgeEntity('doomed', { reason: 'legal' });
    await Promise.all([...writes, purge]);
    assert.strictEqual(await revisions.head('doomed'), null);
    await assert.rejects(revisions.create({ entityId: 'doomed', expectedRevision: 0, content: 'again' }), (e) => e.status === 410);
});

test('racing workers (separate connections) never claim the same job', async () => {
    const { scheduler } = s;
    const runAt = Date.now() - 1000;
    for (let i = 0; i < 30; i++) await scheduler.schedule({ entityId: `bulk_${i}`, action: 'publish', runAt, revision: 1 });
    const seen = [];
    await Promise.all(Array.from({ length: 6 }, (_, w) => scheduler.runDue({ worker: `w${w}`, limit: 10, handler: async (job) => { seen.push(job.id); await new Promise((r) => setTimeout(r, 5)); } })));
    assert.strictEqual(seen.length, 30);
    assert.strictEqual(new Set(seen).size, 30);
});

test('racing get-or-create and setTerms: one term per slug, and one writer\'s set wins whole', async () => {
    const { taxonomy } = s;
    const terms = await Promise.all(Array.from({ length: 8 }, () => taxonomy.ensureTerm({ vocabulary: 'tag', name: 'Spelt' })));
    assert.strictEqual(new Set(terms.map((t) => t.id)).size, 1);
    const sets = [['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', 'h']];
    await Promise.all(sets.map((set) => taxonomy.setTerms('post_race', 'tag', set)));
    const final = (await taxonomy.termsFor('post_race', 'tag')).map((t) => t.slug);
    assert.ok(sets.some((set) => JSON.stringify(set) === JSON.stringify(final)), `one set, not a mix: ${final}`);
});

test('a caller\'s transaction through the pooler: store writes and its own commit together, roll back together, and savepoints work', async () => {
    const { revisions, citations, taxonomy } = s;
    const T = sql.ident(`${P}_pages`);
    await owner.query(`CREATE TABLE IF NOT EXISTS "${P}_pages" (id text PRIMARY KEY)`);
    await assert.rejects(db.tx(async (t) => {
        await t.exec(sql`INSERT INTO ${T} (id) VALUES ('tx_1')`);
        await revisions.create(t, { entityId: 'tx_1', expectedRevision: 0, content: 'x' });
        await citations.attachMany(t, 'tx_1', 1, [{ url: 'https://example.org/' }]);
        throw new Error('abort');
    }), /abort/);
    assert.strictEqual(await db.value(sql`SELECT count(*) FROM ${T}`), 0);
    assert.strictEqual(await revisions.head('tx_1'), null);
    const n = await db.tx(async (t) => {
        await t.exec(sql`INSERT INTO ${T} (id) VALUES ('tx_1')`);
        await revisions.create(t, { entityId: 'tx_1', expectedRevision: 0, content: 'x' });
        const stale = await revisions.create(t, { entityId: 'tx_1', expectedRevision: 0, content: 'y' }).catch((e) => e);
        assert.strictEqual(stale.status, 412);
        const refused = await taxonomy.setTerms(t, 'tx_1', 'tag', [99999999]).catch((e) => e);
        assert.strictEqual(refused.code, 'term.not_found');
        await citations.attachMany(t, 'tx_1', 1, [{ url: 'https://example.org/' }]);
        return revisions.headNumber(t, 'tx_1');
    });
    assert.strictEqual(n, 1);
    assert.strictEqual((await citations.forRevision('tx_1', 1)).length, 1);
});

(async () => {
    owner = createDb({ url: process.env.OV_TEST_PG_DIRECT_URL, service: 'publishing-test', log: quiet });
    db = createDb({ url: process.env.OV_TEST_PG_URL, service: 'publishing-test', max: 8, log: quiet });
    const revisions = createRevisionStore(db, { prefix: `${P}_wiki_page` });
    s = {
        revisions,
        citations: createCitationStore(db, { prefix: `${P}_wiki`, revisions }),
        taxonomy: createTaxonomy(db, { prefix: `${P}_blog` }),
        scheduler: createScheduler(db, { prefix: `${P}_blog` }),
        media: createAttachmentStore(db, { prefix: `${P}_blog_post` }),
        reviews: createReviewLog(db, { prefix: `${P}_wiki_page` }),
        redirects: createRedirectStore(db, { prefix: `${P}_wiki_page` }),
        refs: createDiscussionRefs(db, { prefix: `${P}_wiki` }),
        seq: createIndexSequencer(db, { prefix: `${P}_wiki` }),
    };
    let failed = 0;
    try {
        for (const t of tests) {
            try { await t.fn(); console.log(`  ok   ${LABEL}: ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${LABEL}: ${t.name}\n${err && err.stack || err}`); }
        }
    } finally {
        await dropAll(owner).catch(() => {});
        await db.close();
        await owner.close();
    }
    console.log(`${tests.length - failed}/${tests.length} passed`);
    if (failed) process.exit(1);
})().catch((err) => { console.error(err); process.exit(1); });
