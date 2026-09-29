'use strict';
/**
 * schema(prefix) (1.0.0): each storing module gives its DDL as text for the service's migration; the
 * text is idempotent, every identifier fits PostgreSQL's 63 bytes at the longest prefix, it applies
 * through db.migrate() as a service's 0001_initial.sql, the types are PostgreSQL's (bigint identity,
 * jsonb, bigint ms, timestamptz), the append-only guards are PL/pgSQL triggers, and every query the
 * stores send is served by an index (checked by EXPLAIN with sequential scans switched off).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openDb, tempDir, fakeClock, suite, sql } = require('./helpers/db');
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
const { createChangeCursor } = require('../lib/ingest');

const { test, run } = suite();
const MODULES = ['revisions', 'citations', 'media', 'discussion', 'schedule', 'authorship', 'taxonomy', 'seo', 'indexHooks', 'ingest'];
const LONGEST = `p${'x'.repeat(39)}`;   // PREFIX_RE allows 40 characters
const all = (prefix) => publishing.schema(Object.fromEntries(MODULES.map((m) => [m, prefix])));

test('every storing module exports its DDL; the root schema() joins them', () => {
    assert.strictEqual(typeof require('../lib/revisions').schema, 'function');
    for (const m of ['citations', 'media', 'discussion', 'schedule', 'authorship', 'taxonomy']) assert.strictEqual(typeof require(`../lib/${m}`).schema, 'function', m);
    assert.strictEqual(typeof require('../lib/seo').redirectsSchema, 'function');
    assert.strictEqual(typeof require('../lib/index-hooks').sequencerSchema, 'function');
    assert.strictEqual(typeof require('../lib/ingest').schema, 'function');
    const text = publishing.schema({ revisions: ['wiki_page', 'wiki_talk'], seo: 'wiki_page' });
    assert.match(text, /-- openvibe-publishing\/revisions \(prefix wiki_page\)/);
    assert.match(text, /CREATE TABLE IF NOT EXISTS wiki_talk_revisions/);
    assert.match(text, /CREATE TABLE IF NOT EXISTS wiki_page_redirects/);
    assert.match(publishing.schema({ ingest: 'news' }), /-- openvibe-publishing\/ingest \(prefix news\)\nCREATE TABLE IF NOT EXISTS news_ingest_cursor/);
    assert.throws(() => publishing.schema({ ssr: 'x' }), /no store in module "ssr"/);
    assert.throws(() => publishing.schema({ publication: 'x' }), /no store in module "publication"/);
    assert.throws(() => publishing.schema({ revisions: 'Bad Prefix' }), /prefix/);
    assert.strictEqual(require('../lib/media').schema('blog_post'), createAttachmentStore({ query() {}, tx() {}, many() {}, maybe() {}, exec() {}, sql }, { prefix: 'blog_post' }).schema());
});

test('every identifier fits in 63 bytes at the longest prefix, and none is reused', async () => {
    const text = all(LONGEST);
    const names = [...text.matchAll(/CREATE (?:UNIQUE )?(?:TABLE|INDEX) IF NOT EXISTS (\w+)|FUNCTION (\w+)\(|TRIGGER (\w+) /g)].map((m) => m[1] || m[2] || m[3]);
    assert.ok(names.length > 30, `found ${names.length} names`);
    for (const n of names) assert.ok(Buffer.byteLength(n) <= 63, `${n} is ${Buffer.byteLength(n)} bytes`);
    const tablesAndIndexes = [...text.matchAll(/CREATE (?:UNIQUE )?(?:TABLE|INDEX) IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    assert.strictEqual(new Set(tablesAndIndexes).size, tablesAndIndexes.length, 'no two objects share a name');
    const db = await openDb();
    await db.query(text);
    const made = (await db.many(sql`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND relkind IN ('r', 'i')`)).map((r) => r.relname);
    for (const n of tablesAndIndexes) assert.ok(made.includes(n), `${n} exists under its full name`);
});

test('the DDL is idempotent and applies as a service migration (db.migrate), once', async () => {
    const db = await openDb();
    await db.query(all('wiki'));
    await db.query(all('wiki'));   // twice: IF NOT EXISTS / OR REPLACE everywhere
    const dir = tempDir('migrations');
    fs.writeFileSync(path.join(dir, '0001_initial.sql'), `-- phase: expand\n${all('blog')}`);
    const quiet = { log() {} };
    assert.deepStrictEqual((await db.migrate({ dir, log: quiet })).applied.map((m) => m.id), ['0001']);
    assert.deepStrictEqual((await db.migrate({ dir, log: quiet })).applied, []);
    assert.ok(await db.value(sql`SELECT to_regclass('blog_revisions') IS NOT NULL AS ok`));
});

test('the ingest cursor DDL: one <prefix>_ingest_cursor keyed by feed name, idempotent, served by its PK', async () => {
    const db = await openDb();
    const cursor = await createChangeCursor(db, { prefix: 'news', now: fakeClock() }).ensureSchema();
    assert.strictEqual(cursor.table, 'news_ingest_cursor');
    await db.query(cursor.schema());   // idempotent
    const cols = await db.many(sql`SELECT column_name, data_type, collation_name FROM information_schema.columns WHERE table_name = 'news_ingest_cursor' ORDER BY ordinal_position`);
    assert.deepStrictEqual(cols.map((c) => c.column_name), ['name', 'cursor', 'updated_at']);
    assert.deepStrictEqual(cols.map((c) => c.data_type), ['text', 'bigint', 'bigint']);
    assert.strictEqual(cols[0].collation_name, 'C');
    assert.strictEqual(await cursor.get('default'), 0);
    await db.tx((t) => cursor.set(t, 'sources', 7));
    assert.strictEqual(await cursor.get('sources'), 7);
    await db.tx((t) => cursor.set(t, 'sources', 3));
    assert.strictEqual(await cursor.get('sources'), 7, 'the cursor never goes back');
    await db.exec(sql`SET enable_seqscan = off`);
    const plan = await db.one(sql`EXPLAIN SELECT cursor FROM news_ingest_cursor WHERE name = 'sources'`);
    assert.match(String(Object.values(plan)[0]), /Index/, 'the primary key serves the cursor lookup');
});

test('PostgreSQL types: bigint identities, jsonb, bigint epoch ms, timestamptz for datetime text', async () => {
    const db = await openDb();
    await db.query(all('t'));
    const cols = await db.many(sql`SELECT table_name, column_name, data_type, is_identity, identity_generation, collation_name
        FROM information_schema.columns WHERE table_schema = 'public'`);
    const col = (t, c) => cols.find((r) => r.table_name === t && r.column_name === c);
    for (const t of ['t_citations', 't_attachments', 't_reviews', 't_terms']) {
        assert.deepStrictEqual([col(t, 'id').data_type, col(t, 'id').is_identity, col(t, 'id').identity_generation], ['bigint', 'YES', 'ALWAYS'], t);
    }
    for (const [t, c] of [['t_revisions', 'fields'], ['t_revisions', 'meta'], ['t_drafts', 'fields'], ['t_discussion_refs', 'ref'], ['t_schedule_jobs', 'result']]) {
        assert.strictEqual(col(t, c).data_type, 'jsonb', `${t}.${c}`);
    }
    for (const [t, c] of [['t_revisions', 'created_at'], ['t_schedule_jobs', 'run_at'], ['t_schedule_jobs', 'lease_until'], ['t_attachments', 'checked_at'], ['t_redirects', 'created_at']]) {
        assert.strictEqual(col(t, c).data_type, 'bigint', `${t}.${c} stays epoch milliseconds`);
    }
    assert.strictEqual(col('t_citations', 'retrieved_at').data_type, 'timestamp with time zone');
    assert.strictEqual(col('t_revisions', 'entity_id').collation_name, 'C', 'identifiers compare in byte order, as SQLite did');
    const checks = (await db.many(sql`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype = 'c'`)).map((r) => r.def).join('\n');
    for (const needle of ["'edit'::text, 'revert'::text, 'import'::text", "'publish'::text, 'unpublish'::text", "'approved'::text, 'rejected'::text",
        "'unverified'::text, 'available'::text, 'broken'::text", "(state = 'broken'::text) = (broken_reason IS NOT NULL)", 'source_item_id IS NOT NULL) OR (url IS NOT NULL)', 'number >= 1']) {
        assert.ok(checks.includes(needle), `CHECK kept: ${needle}`);
    }
});

test('immutability triggers: UPDATE always aborts; DELETE only after a recorded purge; reviews refuse UPDATE only', async () => {
    const db = await openDb();
    const revs = await createRevisionStore(db, { prefix: 'w' }).ensureSchema();
    const cites = await createCitationStore(db, { prefix: 'w', revisions: revs }).ensureSchema();
    const reviews = await createReviewLog(db, { prefix: 'w' }).ensureSchema();
    await revs.create({ entityId: 'e', expectedRevision: 0, content: 'x' });
    await cites.attach({ entityId: 'e', revision: 1, url: 'https://example.org/' });
    await reviews.record({ entityId: 'e', revision: 1, reviewer: 'usr_01J8Z6Q3KX0000000000000000', decision: 'approved' });
    const triggers = (await db.many(sql`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`)).map((r) => r.tgname);
    assert.deepStrictEqual(triggers, ['w_citations_no_delete', 'w_citations_no_update', 'w_reviews_no_update', 'w_revisions_no_delete', 'w_revisions_no_update']);
    for (const table of ['w_revisions', 'w_citations']) {
        await assert.rejects(db.exec(sql`UPDATE ${sql.ident(table)} SET entity_id = entity_id`), (e) => e.code === '23001' && /immutable/.test(e.message), table);
        await assert.rejects(db.exec(sql`DELETE FROM ${sql.ident(table)} WHERE entity_id = 'e'`), (e) => e.code === '23001' && /never deleted outside a recorded purge/.test(e.message), table);
    }
    // Registering the purge (what purgeEntity does first) is what allows the DELETE; UPDATE stays refused.
    await db.exec(sql`INSERT INTO w_revision_purges (entity_id, reason, purged_at) VALUES ('e', 'test', 0)`);
    await assert.rejects(db.exec(sql`UPDATE w_revisions SET content = 'changed'`), /immutable/);
    assert.strictEqual(await db.exec(sql`DELETE FROM w_revisions WHERE entity_id = 'e'`), 1);
    await assert.rejects(db.exec(sql`DELETE FROM w_citations WHERE entity_id = 'e'`), /never deleted/, 'each table checks its own purge record');
    await assert.rejects(db.exec(sql`UPDATE w_reviews SET note = 'x'`), /immutable/);
    assert.strictEqual(await db.exec(sql`DELETE FROM w_reviews WHERE entity_id = 'e'`), 1, 'reviews: only UPDATE is refused, as in 0.4');
    // The guards hold inside a transaction too, and the failed statement leaves the table as it was.
    await assert.rejects(db.tx(async (t) => { await t.exec(sql`UPDATE w_citations SET title = 'x'`); }), /immutable/);
    assert.strictEqual(await db.value(sql`SELECT count(*) FROM w_citations WHERE title IS NULL`), 1);
});

/** A handle that records every statement a store sends (the text and values), for EXPLAIN. */
function recording(h, log) {
    const rec = (q, values) => log.push(typeof q === 'string' ? { text: q, values: values || [] } : q.compile());
    const w = { sql: h.sql };
    for (const m of ['query', 'many', 'maybe', 'one', 'value', 'exec']) w[m] = (q, v) => { rec(q, v); return h[m](q, v); };
    w.tx = (fn, opts) => h.tx((t) => fn(recording(t, log)), opts);
    return w;
}

/**
 * Scans of the stores' tables that nothing narrows: a sequential scan, or (with sequential scans off,
 * the planner's fallback) a whole-index scan with neither an Index Cond nor a partial index's predicate.
 * On empty tables the planner may prefer a tiny partial index whose predicate the query repeats
 * (status = 'pending'): that is narrowed by the predicate, so it counts as indexed.
 */
function unindexed(node, partial, out = []) {
    if (!node) return out;
    const type = node['Node Type'];
    const rel = node['Relation Name'] || node['Index Name'] || '';
    if (rel.startsWith('x_')) {
        if (type === 'Seq Scan') out.push(`Seq Scan on ${rel}`);
        if (/Index Scan|Index Only Scan|Bitmap Index Scan/.test(type) && !node['Index Cond'] && !partial.has(node['Index Name'])) {
            out.push(`${type} without a condition on ${node['Index Name']}`);
        }
    }
    for (const child of node.Plans || []) unindexed(child, partial, out);
    return out;
}

test('an index serves every query the stores send (EXPLAIN with sequential scans off finds none)', async () => {
    const db = await openDb();
    const log = [];
    const h = recording(db, log);
    const now = fakeClock();
    const revisions = await createRevisionStore(h, { prefix: 'x', now }).ensureSchema();
    const citations = await createCitationStore(h, { prefix: 'x', now, revisions }).ensureSchema();
    const taxonomy = await createTaxonomy(h, { prefix: 'x', now }).ensureSchema();
    const scheduler = await createScheduler(h, { prefix: 'x', now, maxAttempts: 1, leaseMs: 10 }).ensureSchema();
    const media = await createAttachmentStore(h, { prefix: 'x', now }).ensureSchema();
    const reviews = await createReviewLog(h, { prefix: 'x', now }).ensureSchema();
    const redirects = await createRedirectStore(h, { prefix: 'x', now }).ensureSchema();
    const refs = await createDiscussionRefs(h, { prefix: 'x', now }).ensureSchema();
    const seq = await createIndexSequencer(h, { prefix: 'x', now }).ensureSchema();
    log.length = 0;

    // A workload that sends every query shape of every store.
    const U = 'usr_01J8Z6Q3KX0000000000000000';
    const MED = 'med_01J8Z6Q3KX0000000000000000';
    await revisions.create({ entityId: 'e', expectedRevision: 0, content: 'a', fields: { t: 1 } });
    await revisions.create({ entityId: 'e', expectedRevision: 1, content: 'b' });
    await revisions.revert({ entityId: 'e', toRevision: 1, expectedRevision: 2 });
    await revisions.head('e'); await revisions.headNumber('e'); await revisions.get('e', 1); await revisions.exists('e', 1);
    await revisions.getById('nope'); await revisions.list('e'); await revisions.list('e', { before: 2 }); await revisions.lineage('e'); await revisions.lineage('e', 2);
    await revisions.getMany([{ entityId: 'e', revision: 1 }]); await revisions.diff('e', 1, 2);
    await revisions.saveDraft({ entityId: 'e', owner: U, content: 'd' }); await revisions.getDraft('e', U); await revisions.drafts('e');
    await revisions.commitDraft({ entityId: 'e', owner: U }).catch(() => {}); await revisions.discardDraft('e', U);
    const c = await citations.attach({ entityId: 'e', revision: 1, url: 'https://example.org/a', sourceItemId: 'src_1' });
    await citations.attachMany('e', 2, [{ url: 'https://example.org/b' }]);
    await citations.carryForward({ entityId: 'e', fromRevision: 1, toRevision: 2, ids: [c.id] });
    await citations.get(c.id); await citations.forRevision('e', 1); await citations.forRevisions([{ entityId: 'e', revision: 1 }]); await citations.history('e');
    await citations.bySourceItem('src_1'); await citations.bySourceItem('src_1', { after: c });
    const food = await taxonomy.ensureTerm({ vocabulary: 'category', name: 'Food' });
    const bread = await taxonomy.ensureTerm({ vocabulary: 'category', name: 'Bread', parentId: food.id });
    await taxonomy.setParent(bread.id, food.id); await taxonomy.rename(bread.id, 'Breads'); await taxonomy.get(food.id); await taxonomy.bySlug('category', 'food');
    await taxonomy.ancestors(bread.id); await taxonomy.descendants(food.id); await taxonomy.children(food.id); await taxonomy.tree('category');
    await taxonomy.terms('category'); await taxonomy.terms('category', { after: food });
    await taxonomy.setTerms('e', 'tag', ['rye', 'oats']); await taxonomy.setTerms('e', 'category', [bread.id]);
    await taxonomy.termsFor('e'); await taxonomy.termsFor('e', 'tag'); await taxonomy.termsForMany(['e'], 'tag');
    await taxonomy.entitiesFor(food.id); await taxonomy.entitiesFor(food.id, { includeDescendants: true, after: 'a' }); await taxonomy.remove(bread.id);
    const { job } = await scheduler.schedule({ entityId: 'e', action: 'publish', runAt: now(), revision: 1 });
    await scheduler.schedule({ entityId: 'e', action: 'publish', runAt: now(), revision: 1 });
    await scheduler.get(job.id); await scheduler.jobs('e');
    await scheduler.runDue({ worker: 'w', handler: () => { throw new Error('x'); } });
    await scheduler.schedule({ entityId: 'e', action: 'unpublish', runAt: now() });
    await scheduler.claim({ worker: 'w' }); now.advance(20); await scheduler.claim({ worker: 'w2' });
    await scheduler.runDue({ worker: 'w3', handler: () => ({ ok: true }) }); await scheduler.complete(job.id, 'w', null);
    await scheduler.cancel(job.id); await scheduler.cancelPending('e'); await scheduler.cancelPending('e', 'publish');
    const a = await media.attach({ entityId: 'e', mediaId: MED });
    await media.get(a.id); await media.list('e'); await media.list('e', { revision: 1 }); await media.broken('e');
    await media.entitiesUsing(MED); await media.entitiesUsing(MED, { after: 'a' }); await media.markBroken(MED); await media.markAvailable(MED);
    await media.verify('e', { resolve: async () => ({ exists: true }) }); await media.detach('e', a.id);
    await reviews.record({ entityId: 'e', revision: 1, reviewer: U, decision: 'approved' });
    await reviews.latest('e', 1); await reviews.latestMany([{ entityId: 'e', revision: 1 }]); await reviews.history('e');
    await redirects.recordMove('e', '/a', '/b'); await redirects.recordMove('e', '/b', '/b'); await redirects.release('/a');
    await redirects.resolve('/a', { currentPath: () => '/b' }); await redirects.history('e');
    await refs.set('e', 'thr_1', { service: 'wiki', type: 'page', id: 'e' }); await refs.get('e'); await refs.forget('e');
    await seq.stamp(h, tombstone({ owner: 'wiki', type: 'page', id: 'e', revision: 0 })); await seq.stamp(h, tombstone({ owner: 'wiki', type: 'page', id: 'e', revision: 0 }));
    await seq.current('wiki', 'page', 'e');
    await citations.purgeEntity('e', { reason: 'test' }); await revisions.purgeEntity('e', { reason: 'test' });

    const shapes = new Map();
    for (const q of log) {
        const text = q.text.trim();
        if (!/^(SELECT|UPDATE|DELETE|WITH|INSERT)/i.test(text) || /pg_advisory_xact_lock/.test(text)) continue;
        if (/^INSERT/i.test(text) && !/SELECT|ON CONFLICT/i.test(text)) continue;
        if (!shapes.has(text)) shapes.set(text, q.values);
    }
    assert.ok(shapes.size > 60, `${shapes.size} query shapes recorded`);
    const offenders = [];
    const partial = new Set((await db.many(sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexdef LIKE '% WHERE %'`)).map((r) => r.indexname));
    assert.deepStrictEqual([...partial].sort(), ['x_citations_carried', 'x_citations_source', 'x_schedule_jobs_due', 'x_schedule_jobs_lease']);
    await db.tx(async (t) => {
        await t.query('SET LOCAL enable_seqscan = off');
        // The check itself: a filter on a column without an index is caught.
        const control = await t.value('EXPLAIN (FORMAT JSON) SELECT * FROM x_revisions WHERE author = $1', ['a']);
        assert.strictEqual(unindexed(control[0].Plan, partial).length, 1, JSON.stringify(control[0].Plan));
        for (const [text, values] of shapes) {
            const plan = await t.value(`EXPLAIN (FORMAT JSON) ${text}`, values);
            const scans = unindexed(plan[0].Plan, partial);
            if (scans.length) offenders.push(`${scans.join(', ')}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
        }
    });
    assert.deepStrictEqual(offenders, [], `queries without an index:\n${offenders.join('\n')}`);
});

run();
