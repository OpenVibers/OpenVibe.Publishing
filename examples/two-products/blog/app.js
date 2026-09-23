'use strict';
/**
 * Mini blog — the second example consumer of openvibe-publishing, with its own SQLite file and its
 * own publication state (blog_posts). Different editorial rules from the wiki (sources optional,
 * shorter minimum), same shared mechanics.
 *
 *   node examples/two-products/blog/app.js      # http://127.0.0.1:4811 with a temp database
 *
 * Uses: revisions (blog_post_*), citations (blog_post_citations), taxonomy (blog_terms), schedule
 * (blog_schedule_jobs), media attachments (blog_post_attachments), seo gate + sitemap + RSS/JSON
 * Feed, ssr.
 */
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');
const { createRevisionStore } = require('openvibe-publishing/revisions');
const { createCitationStore } = require('openvibe-publishing/citations');
const { createTaxonomy, slugify } = require('openvibe-publishing/taxonomy');
const { createScheduler } = require('openvibe-publishing/schedule');
const { createAttachmentStore, figureHtml } = require('openvibe-publishing/media');
const seo = require('openvibe-publishing/seo');
const ssr = require('openvibe-publishing/ssr');

const POLICY = { minWords: 20, requireSources: false };

function createBlog({ dbPath, origin = 'https://openvibe.blog', mediaOrigin = 'https://openvibe.media', now = () => Date.now() } = {}) {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS blog_posts (
            id                 TEXT PRIMARY KEY,
            slug               TEXT NOT NULL UNIQUE,
            author_name        TEXT,
            visibility         TEXT NOT NULL DEFAULT 'public',
            state              TEXT NOT NULL DEFAULT 'draft',
            published_revision INTEGER,
            published_at       INTEGER,
            updated_at         INTEGER NOT NULL
        );
    `);
    const revisions = createRevisionStore(db, { prefix: 'blog_post', now });
    const citations = createCitationStore(db, { prefix: 'blog_post', now, revisions });
    const taxonomy = createTaxonomy(db, { prefix: 'blog', now });
    const scheduler = createScheduler(db, { prefix: 'blog', now, leaseMs: 60000 });
    const media = createAttachmentStore(db, { prefix: 'blog_post', now });

    const urlOf = (slug) => seo.canonicalUrl(origin, ['posts', slug]);
    const getPost = (id) => db.prepare('SELECT * FROM blog_posts WHERE id = ?').get(id);

    function decide(post, rev) {
        return seo.evaluate({
            state: post.state, visibility: post.visibility, canonicalUrl: urlOf(post.slug),
            text: ssr.markdownToText(rev.content), citationCount: citations.forRevision(post.id, rev.number).length,
        }, { policy: POLICY, now: now() });
    }

    /** The idempotent effect a scheduled job applies: "revision N is the published one". */
    function applyPublish(id, revision) {
        const info = db.prepare("UPDATE blog_posts SET state = 'published', published_revision = ?, published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ? AND (state IS NOT 'published' OR published_revision IS NOT ?)")
            .run(revision, now(), now(), id, revision);
        return { changed: info.changes };
    }

    const api = {
        db, revisions, citations, taxonomy, scheduler, media, policy: POLICY,

        draft({ title, body, authorName = null, tags = [], sources = [] }) {
            return db.transaction(() => {
                const slug = slugify(title);
                const id = `post_${slug}`;
                db.prepare('INSERT INTO blog_posts (id, slug, author_name, updated_at) VALUES (?, ?, ?, ?)').run(id, slug, authorName, now());
                const { revision } = revisions.create({ entityId: id, expectedRevision: 0, content: body, fields: { title } });
                citations.attachMany(id, revision.number, sources);
                taxonomy.setTerms(id, 'tag', tags);
                return { id, revision: revision.number };
            })();
        },

        edit(id, { expectedRevision, body, title }) {
            const head = revisions.head(id);
            return revisions.create({ entityId: id, expectedRevision, content: body, fields: { title: title || head.fields.title } }).revision.number;
        },

        publishNow(id, revision) { return applyPublish(id, revision); },
        schedulePublish(id, { revision, at }) { return scheduler.schedule({ entityId: id, action: 'publish', runAt: at, revision }); },
        runScheduled(worker) {
            return scheduler.runDue({ worker, handler: (job) => (job.action === 'publish' ? applyPublish(job.entityId, job.revision) : null) });
        },
        setVisibility(id, visibility) { db.prepare('UPDATE blog_posts SET visibility = ?, updated_at = ? WHERE id = ?').run(visibility, now(), id); },

        published() {
            return db.prepare("SELECT * FROM blog_posts WHERE state = 'published' ORDER BY published_at DESC, id").all().map((post) => {
                const rev = revisions.get(post.id, post.published_revision);
                return { post, rev, decision: decide(post, rev) };
            });
        },

        feedItems() {
            return api.published().map(({ post, rev, decision }) => ({
                id: `tag:openvibe.blog,2026:post/${post.id}`, url: urlOf(post.slug), title: rev.fields.title,
                summary: ssr.markdownToText(rev.content, 200), contentHtml: ssr.renderMarkdown(rev.content),
                published: post.published_at, updated: rev.createdAt, decision,
                authors: post.author_name ? [{ name: post.author_name }] : [],
                tags: taxonomy.termsFor(post.id, 'tag').map((t) => t.name),
            }));
        },
        rss() { return seo.rssFeed({ title: 'Mini blog', link: `${origin}/`, description: 'Posts from the mini blog example', feedUrl: `${origin}/feed.xml` }, api.feedItems()); },
        jsonFeedDoc() { return seo.jsonFeed({ title: 'Mini blog', link: `${origin}/`, feedUrl: `${origin}/feed.json` }, api.feedItems()); },
        sitemapXml() { return seo.sitemap(api.published().map(({ post, rev, decision }) => ({ loc: urlOf(post.slug), lastmod: rev.createdAt, decision }))).files[0]; },

        renderPost(post) {
            const rev = revisions.get(post.id, post.published_revision);
            const decision = decide(post, rev);
            const figures = media.list(post.id).map((a) => ssr.raw(figureHtml(a, { urlFor: (id) => `${mediaOrigin}/o/${id}` })));
            const tags = taxonomy.termsFor(post.id, 'tag');
            const head = seo.metaTags({ title: rev.fields.title, description: ssr.markdownToText(rev.content, 160), decision, type: 'article',
                jsonLd: seo.structuredData.article({ type: 'BlogPosting', headline: rev.fields.title, url: urlOf(post.slug),
                    datePublished: post.published_at ? new Date(post.published_at).toISOString() : null, dateModified: rev.createdAt,
                    authors: post.author_name ? [{ name: post.author_name }] : [], keywords: tags.map((t) => t.name) }) });
            return String(ssr.html`<!doctype html><html lang="en"><head><meta charset="utf-8">${ssr.raw(head)}${ssr.raw(seo.feedLinks([{ type: 'rss', href: '/feed.xml', title: 'RSS' }]))}</head><body>
<article><h1>${rev.fields.title}</h1><p>${post.author_name ? ssr.html`By ${post.author_name} · ` : ''}${ssr.raw(ssr.timeTag(post.published_at))}</p>
${figures}
${ssr.raw(ssr.renderMarkdown(rev.content))}
<p>${tags.map((t) => ssr.html`<a href="/tags/${t.slug}">#${t.name}</a> `)}</p></article></body></html>`);
        },

        handler(req, res) {
            const url = new URL(req.url, origin);
            const send = (status, type, body) => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };
            if (url.pathname === '/feed.xml') return send(200, 'application/rss+xml', api.rss());
            if (url.pathname === '/feed.json') return send(200, 'application/feed+json', JSON.stringify(api.jsonFeedDoc()));
            if (url.pathname === '/sitemap.xml') return send(200, 'application/xml', api.sitemapXml());
            const m = url.pathname.match(/^\/posts\/([^/]+)$/);
            const post = m && db.prepare('SELECT * FROM blog_posts WHERE slug = ?').get(decodeURIComponent(m[1]));
            if (!post || post.state !== 'published' || post.visibility === 'private' || post.visibility === 'gated') return send(404, 'text/plain', 'Not found');
            return send(200, 'text/html; charset=utf-8', api.renderPost(post));
        },

        close() { db.close(); },
    };
    return api;
}

module.exports = { createBlog };

if (require.main === module) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-blog-'));
    const blog = createBlog({ dbPath: path.join(dir, 'blog.db'), origin: 'http://127.0.0.1:4811' });
    const { id, revision } = blog.draft({ title: 'First loaf', authorName: 'Alex', tags: ['bread', 'rye'],
        body: 'My first rye loaf came out dense but tasty. Next time I will give the starter a longer rise and bake it a little hotter.' });
    blog.publishNow(id, revision);
    http.createServer(blog.handler).listen(4811, '127.0.0.1', () => console.log(`mini blog on http://127.0.0.1:4811/posts/first-loaf (db ${dir}/blog.db)`));
}
