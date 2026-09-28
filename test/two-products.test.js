'use strict';
/**
 * Wave 15 exit proof: two different products share revision, citation, SEO-gate and feed code
 * without sharing a database or an authority.
 */
const assert = require('assert');
const http = require('http');
const path = require('path');
const contracts = require('openvibe-contracts');
const { newDb, resetDb, countQueries, fakeClock, suite, sql } = require('./helpers/db');
const { createWiki } = require('../examples/two-products/wiki/app');
const { createBlog } = require('../examples/two-products/blog/app');
const migrations = require('../examples/two-products/migrations');

const { test, run } = suite();
const ALEX = 'usr_01J8Z6Q3KX0000000000000000';
const EDITOR = 'usr_01J8Z6Q3KX0000000000000001';
const LONG = 'Rye is a grass grown extensively as a grain, a cover crop and a forage crop. It is closely related to wheat and barley, and its grain is used for flour, bread, beer, whiskey and animal fodder.';
const MED = 'med_01J8Z6Q3KX0000000000000000';

/** Every table, index, trigger and function in the database (the SDK's ov_migrations bookkeeping aside). */
async function objectsOf(db) {
    const rows = await db.many(sql`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'i', 'S')
        UNION ALL SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND NOT t.tgisinternal
        UNION ALL SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`);
    return rows.map((r) => r.name).filter((n) => !/^ov_migrations/.test(n)).sort();
}

function listen(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler).listen(0, '127.0.0.1', () => {
            const base = `http://127.0.0.1:${server.address().port}`;
            resolve({ base, close: () => server.close(), get: (p) => fetch(base + p, { redirect: 'manual' }) });
        });
    });
}

// Two databases, one per product (two PGlite instances: nothing shared, not even the server), emptied per test.
let dbs = null;
async function setup() {
    if (!dbs) dbs = { wiki: await newDb(), blog: await newDb() };
    await resetDb(dbs.wiki);
    await resetDb(dbs.blog);
    const clock = fakeClock(Date.parse('2026-09-22T12:00:00Z'));
    const wiki = await createWiki({ db: dbs.wiki, now: clock });
    const blog = await createBlog({ db: dbs.blog, now: clock });
    return { clock, wiki, blog, wikiDb: dbs.wiki, blogDb: dbs.blog };
}

test('same code: both products run the very same package modules', async () => {
    const { wiki, blog } = await setup();
    const revisionsFile = require.resolve('openvibe-publishing/revisions');
    assert.strictEqual(revisionsFile, path.join(__dirname, '..', 'lib', 'revisions.js'));
    for (const mod of ['revisions', 'citations', 'seo', 'ssr']) {
        const file = require.resolve(`openvibe-publishing/${mod}`);
        const users = Object.values(require.cache).filter((m) => m.children.some((c) => c.filename === file)).map((m) => path.basename(path.dirname(m.filename)));
        assert.ok(users.includes('wiki') && users.includes('blog'), `${mod} is loaded by both apps (${users})`);
    }
    wiki.close(); blog.close();
});

test('the migrations are the stores\' schema(prefix) DDL, as a service writes them', () => {
    for (const { file, expected, actual } of migrations.check()) {
        assert.strictEqual(actual, expected, `${path.relative(process.cwd(), file)} is stale: node examples/two-products/migrations.js --write`);
    }
});

test('no shared database: two databases, each holding only its own product\'s tables', async () => {
    const { wiki, blog, wikiDb, blogDb } = await setup();
    assert.notStrictEqual(wikiDb, blogDb);
    const wt = await objectsOf(wikiDb);
    const bt = await objectsOf(blogDb);
    assert.ok(wt.length > 5 && bt.length > 5);
    assert.ok(wt.every((n) => n.startsWith('wiki_')), `wiki db: ${wt.filter((n) => !n.startsWith('wiki_'))}`);
    assert.ok(bt.every((n) => n.startsWith('blog_')), `blog db: ${bt.filter((n) => !n.startsWith('blog_'))}`);
    for (const t of ['wiki_page_revisions', 'wiki_citations', 'wiki_page_redirects', 'wiki_pages', 'wiki_page_revisions_guard', 'wiki_page_revisions_no_update']) assert.ok(wt.includes(t), t);
    for (const t of ['blog_post_revisions', 'blog_post_citations', 'blog_schedule_jobs', 'blog_terms', 'blog_post_attachments', 'blog_posts']) assert.ok(bt.includes(t), t);
    assert.strictEqual(await wikiDb.value(sql`SELECT count(*) FROM pg_foreign_server`), 0, 'nothing attached across products');
    wiki.close(); blog.close();
});

test('each product owns its state: writes in one never appear in the other', async () => {
    const { wiki, blog, wikiDb, blogDb } = await setup();
    const { id: pageId } = await wiki.createPage({ title: 'Rye', body: LONG, author: ALEX, sources: [{ url: 'https://example.org/rye', retrievedAt: '2026-09-20T10:00:00Z' }] });
    await wiki.publish(pageId, { revision: 1, actor: ALEX });
    const { id: postId } = await blog.draft({ title: 'First loaf', body: LONG, authorName: 'Alex', tags: ['rye'] });
    assert.strictEqual(await wikiDb.value(sql`SELECT count(*) FROM wiki_page_revisions`), 1);
    assert.strictEqual(await blogDb.value(sql`SELECT count(*) FROM blog_post_revisions`), 1);
    assert.strictEqual(await wiki.revisions.head(postId), null);
    assert.strictEqual(await blog.revisions.head(pageId), null);
    assert.strictEqual((await blog.citations.history(postId)).length, 0);
    assert.strictEqual((await wiki.citations.history(pageId)).length, 1);
    wiki.close(); blog.close();
});

test('a product write and the stores\' writes share one transaction: a failure leaves none of them', async () => {
    const { wiki, wikiDb } = await setup();
    // The second source is invalid: the page row, revision 1 and the first citation all roll back.
    await assert.rejects(wiki.createPage({ title: 'Oats', body: LONG, author: ALEX, sources: [{ url: 'https://example.org/oats' }, { url: 'ftp://nope' }] }), /http/);
    assert.strictEqual(await wikiDb.value(sql`SELECT count(*) FROM wiki_pages`), 0);
    assert.strictEqual(await wikiDb.value(sql`SELECT count(*) FROM wiki_page_revisions`), 0);
    assert.strictEqual(await wikiDb.value(sql`SELECT count(*) FROM wiki_citations`), 0);
    const { id } = await wiki.createPage({ title: 'Oats', body: LONG, author: ALEX, sources: [{ url: 'https://example.org/oats' }] });
    assert.strictEqual((await wiki.revisions.head(id)).number, 1, 'the id is free again');
    wiki.close();
});

test('revisions and citations: edit, diff, revert; citations stay on the revision that used them', async () => {
    const { wiki, clock } = await setup();
    const { id } = await wiki.createPage({ title: 'Rye', body: LONG, author: ALEX, sources: [{ url: 'https://example.org/a' }, { url: 'https://example.org/b' }] });
    const [a] = await wiki.citations.forRevision(id, 1);
    clock.advance(1000);
    const r2 = await wiki.edit(id, { expectedRevision: 1, body: LONG.replace('grass', 'cereal grass'), author: ALEX, keepSources: [a.id] });
    await assert.rejects(wiki.edit(id, { expectedRevision: 1, body: 'lost update', author: ALEX }), (e) => e.status === 412);
    const diff = await wiki.revisions.diff(id, 1, r2, { mode: 'word' });
    assert.ok(diff.content.ops.some((o) => o.op === 'insert' && o.text.includes('cereal')));
    assert.deepStrictEqual((await wiki.citations.forRevision(id, 1)).map((c) => c.url), ['https://example.org/a', 'https://example.org/b']);
    assert.deepStrictEqual((await wiki.citations.forRevision(id, r2)).map((c) => c.url), ['https://example.org/a']);
    const r3 = await wiki.revert(id, { toRevision: 1, expectedRevision: r2, author: ALEX });
    assert.strictEqual((await wiki.revisions.get(id, r3)).content, LONG);
    assert.deepStrictEqual((await wiki.citations.forRevision(id, r3)).map((c) => c.url), ['https://example.org/a', 'https://example.org/b']);
    assert.deepStrictEqual((await wiki.revisions.lineage(id)).map((r) => r.number), [3, 2, 1]);
    wiki.close();
});

test('one gate, two editorial policies: the wiki needs sources, the blog does not', async () => {
    const { wiki, blog } = await setup();
    const { id: unsourced } = await wiki.createPage({ title: 'Barley', body: LONG, author: ALEX });
    await wiki.publish(unsourced, { revision: 1, actor: ALEX });
    const { id: post, revision } = await blog.draft({ title: 'Barley notes', body: LONG });
    await blog.publishNow(post, revision);
    const [w] = await wiki.published();
    const [b] = await blog.published();
    assert.deepStrictEqual(w.decision.codes, ['unsourced']);
    assert.strictEqual(b.decision.indexable, true);
    assert.doesNotMatch(await wiki.sitemapXml(), /barley/, 'unsourced page stays out of the sitemap');
    assert.match(await wiki.atom(), /Barley/, 'but is listable in the feed (noindex, not hidden)');
    assert.match(await blog.sitemapXml(), /posts\/barley-notes/);
    wiki.close(); blog.close();
});

test('a feed of many pages costs the same few queries as a feed of one (no N+1)', async () => {
    const { wiki, wikiDb } = await setup();
    const one = await wiki.createPage({ title: 'Page 0', body: LONG, author: ALEX, sources: [{ url: 'https://example.org/0' }] });
    await wiki.publish(one.id, { revision: 1, actor: ALEX });
    const small = await countQueries(wikiDb, () => wiki.feedItems());
    for (let i = 1; i < 12; i++) {
        const p = await wiki.createPage({ title: `Page ${i}`, body: LONG, author: ALEX, sources: [{ url: `https://example.org/${i}` }] });
        await wiki.publish(p.id, { revision: 1, actor: ALEX });
    }
    const large = await countQueries(wikiDb, () => wiki.feedItems());
    assert.strictEqual(large.out.length, 12);
    assert.strictEqual(large.count, small.count, `${small.count} queries for 1 page, ${large.count} for 12`);
    wiki.close();
});

test('AI-generated wiki page: draft + noindex until a person reviews it', async () => {
    const { wiki } = await setup();
    const authorship = require('openvibe-publishing/authorship');
    const rec = authorship.record({ mode: 'ai', workflow: { id: 'wiki.generate_page', version: 1, runId: 'run_1' } });
    const { id, initial } = await wiki.createPage({ title: 'Spelt', body: LONG, author: EDITOR, authorship: rec, sources: [{ sourceItemId: 'src_9' }] });
    assert.deepStrictEqual(initial, { state: 'draft', noindex: true, reason: 'ai_generated_unreviewed' });
    await assert.rejects(wiki.publish(id, { revision: 1, actor: EDITOR }), /ai_generated_unreviewed/);
    await wiki.reviews.record({ entityId: id, revision: 1, reviewer: EDITOR, decision: 'approved' });
    await wiki.publish(id, { revision: 1, actor: EDITOR });
    const [p] = await wiki.published();
    assert.strictEqual(p.decision.indexable, true);
    assert.match(await wiki.renderPage(p.page), /AI-generated by workflow wiki.generate_page v1, reviewed by a person/);
    wiki.close();
});

test('scheduled blog publication is idempotent across a worker restart', async () => {
    const { blog, clock, blogDb } = await setup();
    const { id, revision } = await blog.draft({ title: 'Scheduled', body: LONG });
    const at = clock() + 3600e3;
    await blog.schedulePublish(id, { revision, at });
    await blog.schedulePublish(id, { revision, at });
    assert.strictEqual((await blog.scheduler.jobs(id)).length, 1);
    clock.set(at);
    const [job] = await blog.scheduler.claim({ worker: 'w1' }); // worker 1 dies before finishing
    assert.ok(job);
    blog.close();
    const blog2 = await createBlog({ db: blogDb, now: clock }); // "restart": a new process on the same database
    clock.advance(60001);
    const out = await blog2.runScheduled('w2');
    assert.strictEqual(out.done.length, 1);
    assert.strictEqual((await blog2.published()).length, 1);
    await blog2.runScheduled('w3');
    assert.strictEqual((await blog2.scheduler.jobs(id))[0].attempts, 2);
    blog2.close();
});

test('HTTP: pages useful without JavaScript, 301 for old slugs, private/deleted leave feeds and sitemaps', async () => {
    const { wiki, blog, clock } = await setup();
    const { id } = await wiki.createPage({ title: 'Rye', body: `${LONG}\n\nSee [wheat](/p/wheat).`, author: ALEX, sources: [{ url: 'https://example.org/rye', title: 'Rye facts', retrievedAt: '2026-09-20T10:00:00Z', licenseNote: 'CC BY 4.0' }] });
    await wiki.publish(id, { revision: 1, actor: ALEX });
    await wiki.rename(id, 'Rye (grain)');
    const { id: post, revision } = await blog.draft({ title: 'Crumb shots', body: LONG, authorName: 'Alex', tags: ['bread'] });
    await blog.media.attach({ entityId: post, mediaId: MED, role: 'inline', alt: 'crumb' });
    await blog.publishNow(post, revision);
    const w = await listen(wiki.handler);
    const b = await listen(blog.handler);
    try {
        let res = await w.get('/p/rye-grain');
        let html = await res.text();
        assert.strictEqual(res.status, 200);
        assert.match(html, /<h1>Rye<\/h1>/, 'renaming the slug does not touch the title field');
        assert.match(html, /grown extensively as a grain/, 'the content is in the HTML');
        assert.match(html, /<a href="https:\/\/example.org\/rye" rel="noopener">Rye facts<\/a>, retrieved <time datetime="2026-09-20T10:00:00.000Z">/);
        assert.match(html, /<meta name="robots" content="index, follow">/);
        assert.match(html, /<link rel="canonical" href="https:\/\/openvibe.wiki\/p\/rye-grain">/);
        assert.match(html, /application\/ld\+json/);
        assert.doesNotMatch(html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, ''), /<script/i, 'no JavaScript needed');

        res = await w.get('/p/rye');
        assert.strictEqual(res.status, 301);
        assert.strictEqual(res.headers.get('location'), '/p/rye-grain');

        res = await b.get('/posts/crumb-shots');
        html = await res.text();
        assert.strictEqual(res.status, 200);
        assert.match(html, /<img src="https:\/\/openvibe.media\/o\/med_/);
        await blog.media.markBroken(MED, 'deleted');
        html = await (await b.get('/posts/crumb-shots')).text();
        assert.match(html, /data-state="broken"/);
        assert.doesNotMatch(html, /<img/);

        // private: gone from page, feeds and sitemap; the event is internal
        await wiki.setVisibility(id, 'private', { actor: ALEX });
        assert.strictEqual((await w.get('/p/rye-grain')).status, 404);
        assert.doesNotMatch(await (await w.get('/sitemap.xml')).text(), /rye/);
        assert.doesNotMatch(await (await w.get('/feed.atom')).text(), /<entry>/);
        assert.strictEqual(JSON.parse(await (await w.get('/feed.json')).text()).items.length, 0);
        let events = await wiki.outbox();
        assert.deepStrictEqual(events.map((e) => e.event_type), [
            'wiki.index_document.upserted', 'wiki.page.published', // publish
            'wiki.index_document.upserted', // rename: new canonical URL, new index revision
            'wiki.index_document.upserted', 'wiki.page.updated', // made private
        ]);
        const docs = events.filter((e) => e.event_type.startsWith('wiki.index_document.')).map((e) => e.payload);
        assert.deepStrictEqual(docs.map((d) => d.revision), [1, 2, 3], 'every indexed change is a higher revision');
        assert.strictEqual(docs[1].canonical_url, 'https://openvibe.wiki/p/rye-grain');
        assert.strictEqual(docs[2].visibility, 'private');
        assert.deepStrictEqual(docs[2].acl, { subjects: [ALEX] });
        assert.strictEqual(events[4].visibility, 'internal');
        for (const e of events) {
            assert.ok(contracts.validate('events.event-envelope@1', { ...e, event_id: contracts.ids.newId('event') }).valid, e.event_type);
        }
        for (const d of docs) assert.ok(contracts.validate('search.index-document@1', d).valid);

        await blog.setVisibility(post, 'gated');
        assert.strictEqual((await b.get('/posts/crumb-shots')).status, 404);
        assert.doesNotMatch(await (await b.get('/feed.xml')).text(), /Crumb/);
        assert.doesNotMatch(await (await b.get('/sitemap.xml')).text(), /crumb/);

        // deleted: 410 on the page and on its old slug; tombstone event
        clock.advance(1000);
        await wiki.remove(id, { actor: ALEX });
        assert.strictEqual((await w.get('/p/rye-grain')).status, 410);
        assert.strictEqual((await w.get('/p/rye')).status, 410);
        events = (await wiki.outbox()).slice(-2);
        assert.deepStrictEqual(events.map((e) => e.event_type), ['wiki.index_document.deleted', 'wiki.page.deleted']);
        assert.deepStrictEqual(events[0].payload, { type: 'page', id, revision: 4 });
        assert.deepStrictEqual(events[0].subject, { type: 'page', id, revision: 4 });
        assert.strictEqual(events[1].payload.publication_state, 'deleted');
        for (const e of events) assert.ok(contracts.validate('events.event-envelope@1', { ...e, event_id: contracts.ids.newId('event') }).valid);
    } finally { w.close(); b.close(); wiki.close(); blog.close(); }
});

test('feeds from both products carry only provided dates and authors', async () => {
    const { wiki, blog } = await setup();
    const { id } = await wiki.createPage({ title: 'Oats', body: LONG, author: ALEX, sources: [{ url: 'https://example.org/oats' }] });
    await wiki.publish(id, { revision: 1, actor: ALEX });
    const { id: post, revision } = await blog.draft({ title: 'No byline', body: LONG, tags: ['oats', 'breakfast'] });
    await blog.publishNow(post, revision);
    const rss = await blog.rss();
    assert.doesNotMatch(rss, /dc:creator/, 'no author invented for a post without a byline');
    assert.match(rss, /<pubDate>Tue, 22 Sep 2026 12:00:00 GMT<\/pubDate>/);
    const jf = await blog.jsonFeedDoc();
    assert.ok(!('authors' in jf.items[0]));
    assert.deepStrictEqual(jf.items[0].tags, ['oats', 'breakfast'], 'tags from termsForMany, in the order given');
    const atom = await wiki.atom();
    assert.doesNotMatch(atom, /<author>/);
    assert.match(atom, /<published>2026-09-22T12:00:00.000Z<\/published>/);
    wiki.close(); blog.close();
});

run();
