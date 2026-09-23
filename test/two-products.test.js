'use strict';
/**
 * Wave 15 exit proof: two different products share revision, citation, SEO-gate and feed code
 * without sharing a database or an authority.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { tempDir, fakeClock, suite } = require('./helpers/db');
const { createWiki } = require('../examples/two-products/wiki/app');
const { createBlog } = require('../examples/two-products/blog/app');

const { test, run } = suite();
const ALEX = 'usr_01J8Z6Q3KX0000000000000000';
const EDITOR = 'usr_01J8Z6Q3KX0000000000000001';
const LONG = 'Rye is a grass grown extensively as a grain, a cover crop and a forage crop. It is closely related to wheat and barley, and its grain is used for flour, bread, beer, whiskey and animal fodder.';
const MED = 'med_01J8Z6Q3KX0000000000000000';

function tablesOf(db) {
    return db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name).sort();
}

function listen(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler).listen(0, '127.0.0.1', () => {
            const base = `http://127.0.0.1:${server.address().port}`;
            resolve({ base, close: () => server.close(), get: (p) => fetch(base + p, { redirect: 'manual' }) });
        });
    });
}

function setup() {
    const clock = fakeClock(Date.parse('2026-09-22T12:00:00Z'));
    const wikiDir = tempDir('wiki');
    const blogDir = tempDir('blog');
    const wiki = createWiki({ dbPath: path.join(wikiDir, 'wiki.db'), now: clock });
    const blog = createBlog({ dbPath: path.join(blogDir, 'blog.db'), now: clock });
    return { clock, wiki, blog, wikiFile: path.join(wikiDir, 'wiki.db'), blogFile: path.join(blogDir, 'blog.db') };
}

test('same code: both products run the very same package modules', () => {
    const { wiki, blog } = setup();
    const revisionsFile = require.resolve('openvibe-publishing/revisions');
    assert.strictEqual(revisionsFile, path.join(__dirname, '..', 'lib', 'revisions.js'));
    for (const mod of ['revisions', 'citations', 'seo', 'ssr']) {
        const file = require.resolve(`openvibe-publishing/${mod}`);
        const users = Object.values(require.cache).filter((m) => m.children.some((c) => c.filename === file)).map((m) => path.basename(path.dirname(m.filename)));
        assert.ok(users.includes('wiki') && users.includes('blog'), `${mod} is loaded by both apps (${users})`);
    }
    wiki.close(); blog.close();
});

test('no shared database: two files, each holding only its own product\'s tables', () => {
    const { wiki, blog, wikiFile, blogFile } = setup();
    assert.notStrictEqual(fs.realpathSync(wikiFile), fs.realpathSync(blogFile));
    const wt = tablesOf(wiki.db);
    const bt = tablesOf(blog.db);
    assert.ok(wt.length > 5 && bt.length > 5);
    assert.ok(wt.every((n) => n.startsWith('wiki_')), `wiki db: ${wt.filter((n) => !n.startsWith('wiki_'))}`);
    assert.ok(bt.every((n) => n.startsWith('blog_')), `blog db: ${bt.filter((n) => !n.startsWith('blog_'))}`);
    for (const t of ['wiki_page_revisions', 'wiki_citations', 'wiki_page_redirects', 'wiki_pages']) assert.ok(wt.includes(t), t);
    for (const t of ['blog_post_revisions', 'blog_post_citations', 'blog_schedule_jobs', 'blog_terms', 'blog_post_attachments', 'blog_posts']) assert.ok(bt.includes(t), t);
    const attached = wiki.db.prepare('PRAGMA database_list').all();
    assert.deepStrictEqual(attached.map((d) => d.name), ['main'], 'nothing attached across products');
    wiki.close(); blog.close();
});

test('each product owns its state: writes in one never appear in the other', () => {
    const { wiki, blog } = setup();
    const { id: pageId } = wiki.createPage({ title: 'Rye', body: LONG, author: ALEX, sources: [{ url: 'https://example.org/rye', retrievedAt: '2026-09-20T10:00:00Z' }] });
    wiki.publish(pageId, { revision: 1, actor: ALEX });
    const { id: postId } = blog.draft({ title: 'First loaf', body: LONG, authorName: 'Alex', tags: ['rye'] });
    assert.strictEqual(wiki.db.prepare('SELECT COUNT(*) AS n FROM wiki_page_revisions').get().n, 1);
    assert.strictEqual(blog.db.prepare('SELECT COUNT(*) AS n FROM blog_post_revisions').get().n, 1);
    assert.strictEqual(wiki.revisions.head(postId), null);
    assert.strictEqual(blog.revisions.head(pageId), null);
    assert.strictEqual(blog.citations.history(postId).length, 0);
    assert.strictEqual(wiki.citations.history(pageId).length, 1);
    wiki.close(); blog.close();
});

test('revisions and citations: edit, diff, revert; citations stay on the revision that used them', () => {
    const { wiki, clock } = setup();
    const { id } = wiki.createPage({ title: 'Rye', body: LONG, author: ALEX, sources: [{ url: 'https://example.org/a' }, { url: 'https://example.org/b' }] });
    const [a] = wiki.citations.forRevision(id, 1);
    clock.advance(1000);
    const r2 = wiki.edit(id, { expectedRevision: 1, body: LONG.replace('grass', 'cereal grass'), author: ALEX, keepSources: [a.id] });
    assert.throws(() => wiki.edit(id, { expectedRevision: 1, body: 'lost update', author: ALEX }), (e) => e.status === 412);
    const diff = wiki.revisions.diff(id, 1, r2, { mode: 'word' });
    assert.ok(diff.content.ops.some((o) => o.op === 'insert' && o.text.includes('cereal')));
    assert.deepStrictEqual(wiki.citations.forRevision(id, 1).map((c) => c.url), ['https://example.org/a', 'https://example.org/b']);
    assert.deepStrictEqual(wiki.citations.forRevision(id, r2).map((c) => c.url), ['https://example.org/a']);
    const r3 = wiki.revert(id, { toRevision: 1, expectedRevision: r2, author: ALEX });
    assert.strictEqual(wiki.revisions.get(id, r3).content, LONG);
    assert.deepStrictEqual(wiki.citations.forRevision(id, r3).map((c) => c.url), ['https://example.org/a', 'https://example.org/b']);
    assert.deepStrictEqual(wiki.revisions.lineage(id).map((r) => r.number), [3, 2, 1]);
    wiki.close();
});

test('one gate, two editorial policies: the wiki needs sources, the blog does not', () => {
    const { wiki, blog } = setup();
    const { id: unsourced } = wiki.createPage({ title: 'Barley', body: LONG, author: ALEX });
    wiki.publish(unsourced, { revision: 1, actor: ALEX });
    const { id: post, revision } = blog.draft({ title: 'Barley notes', body: LONG });
    blog.publishNow(post, revision);
    const [w] = wiki.published();
    const [b] = blog.published();
    assert.deepStrictEqual(w.decision.codes, ['unsourced']);
    assert.strictEqual(b.decision.indexable, true);
    assert.doesNotMatch(wiki.sitemapXml(), /barley/, 'unsourced page stays out of the sitemap');
    assert.match(wiki.atom(), /Barley/, 'but is listable in the feed (noindex, not hidden)');
    assert.match(blog.sitemapXml(), /posts\/barley-notes/);
    wiki.close(); blog.close();
});

test('AI-generated wiki page: draft + noindex until a person reviews it', () => {
    const { wiki } = setup();
    const authorship = require('openvibe-publishing/authorship');
    const rec = authorship.record({ mode: 'ai', workflow: { id: 'wiki.generate_page', version: 1, runId: 'run_1' } });
    const { id, initial } = wiki.createPage({ title: 'Spelt', body: LONG, author: EDITOR, authorship: rec, sources: [{ sourceItemId: 'src_9' }] });
    assert.deepStrictEqual(initial, { state: 'draft', noindex: true, reason: 'ai_generated_unreviewed' });
    assert.throws(() => wiki.publish(id, { revision: 1, actor: EDITOR }), /ai_generated_unreviewed/);
    wiki.reviews.record({ entityId: id, revision: 1, reviewer: EDITOR, decision: 'approved' });
    wiki.publish(id, { revision: 1, actor: EDITOR });
    const [p] = wiki.published();
    assert.strictEqual(p.decision.indexable, true);
    assert.match(wiki.renderPage(p.page), /AI-generated by workflow wiki.generate_page v1, reviewed by a person/);
    wiki.close();
});

test('scheduled blog publication is idempotent across a worker restart', async () => {
    const { blog, clock, blogFile } = setup();
    const { id, revision } = blog.draft({ title: 'Scheduled', body: LONG });
    const at = clock() + 3600e3;
    blog.schedulePublish(id, { revision, at });
    blog.schedulePublish(id, { revision, at });
    assert.strictEqual(blog.scheduler.jobs(id).length, 1);
    clock.set(at);
    const [job] = blog.scheduler.claim({ worker: 'w1' }); // worker 1 dies before finishing
    assert.ok(job);
    blog.close();
    const blog2 = createBlog({ dbPath: blogFile, now: clock }); // "restart"
    clock.advance(60001);
    const out = await blog2.runScheduled('w2');
    assert.strictEqual(out.done.length, 1);
    assert.strictEqual(blog2.published().length, 1);
    await blog2.runScheduled('w3');
    assert.strictEqual(blog2.scheduler.jobs(id)[0].attempts, 2);
    blog2.close();
});

test('HTTP: pages useful without JavaScript, 301 for old slugs, private/deleted leave feeds and sitemaps', async () => {
    const { wiki, blog, clock } = setup();
    const { id } = wiki.createPage({ title: 'Rye', body: `${LONG}\n\nSee [wheat](/p/wheat).`, author: ALEX, sources: [{ url: 'https://example.org/rye', title: 'Rye facts', retrievedAt: '2026-09-20T10:00:00Z', licenseNote: 'CC BY 4.0' }] });
    wiki.publish(id, { revision: 1, actor: ALEX });
    wiki.rename(id, 'Rye (grain)');
    const { id: post, revision } = blog.draft({ title: 'Crumb shots', body: LONG, authorName: 'Alex', tags: ['bread'] });
    blog.media.attach({ entityId: post, mediaId: MED, role: 'inline', alt: 'crumb' });
    blog.publishNow(post, revision);
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
        blog.media.markBroken(MED, 'deleted');
        html = await (await b.get('/posts/crumb-shots')).text();
        assert.match(html, /data-state="broken"/);
        assert.doesNotMatch(html, /<img/);

        // private: gone from page, feeds and sitemap; the event is internal
        wiki.setVisibility(id, 'private', { actor: ALEX });
        assert.strictEqual((await w.get('/p/rye-grain')).status, 404);
        assert.doesNotMatch(await (await w.get('/sitemap.xml')).text(), /rye/);
        assert.doesNotMatch(await (await w.get('/feed.atom')).text(), /<entry>/);
        assert.strictEqual(JSON.parse(await (await w.get('/feed.json')).text()).items.length, 0);
        const events = wiki.outbox();
        assert.deepStrictEqual(events.map((e) => e.event_type), ['wiki.page.published', 'wiki.page.updated']);
        assert.strictEqual(events[1].visibility, 'internal');
        assert.deepStrictEqual(events[1].payload.document.acl, { public: false, subjects: [ALEX] });

        blog.setVisibility(post, 'gated');
        assert.strictEqual((await b.get('/posts/crumb-shots')).status, 404);
        assert.doesNotMatch(await (await b.get('/feed.xml')).text(), /Crumb/);
        assert.doesNotMatch(await (await b.get('/sitemap.xml')).text(), /crumb/);

        // deleted: 410 on the page and on its old slug; tombstone event
        clock.advance(1000);
        wiki.remove(id, { actor: ALEX });
        assert.strictEqual((await w.get('/p/rye-grain')).status, 410);
        assert.strictEqual((await w.get('/p/rye')).status, 410);
        const last = wiki.outbox().pop();
        assert.strictEqual(last.event_type, 'wiki.page.deleted');
        assert.strictEqual(last.payload.document.deleted, true);
        assert.ok(!('body' in last.payload.document));
    } finally { w.close(); b.close(); wiki.close(); blog.close(); }
});

test('feeds from both products carry only provided dates and authors', () => {
    const { wiki, blog } = setup();
    const { id } = wiki.createPage({ title: 'Oats', body: LONG, author: ALEX, sources: [{ url: 'https://example.org/oats' }] });
    wiki.publish(id, { revision: 1, actor: ALEX });
    const { id: post, revision } = blog.draft({ title: 'No byline', body: LONG });
    blog.publishNow(post, revision);
    const rss = blog.rss();
    assert.doesNotMatch(rss, /dc:creator/, 'no author invented for a post without a byline');
    assert.match(rss, /<pubDate>Tue, 22 Sep 2026 12:00:00 GMT<\/pubDate>/);
    const jf = blog.jsonFeedDoc();
    assert.ok(!('authors' in jf.items[0]));
    const atom = wiki.atom();
    assert.doesNotMatch(atom, /<author>/);
    assert.match(atom, /<published>2026-09-22T12:00:00.000Z<\/published>/);
    wiki.close(); blog.close();
});

run();
