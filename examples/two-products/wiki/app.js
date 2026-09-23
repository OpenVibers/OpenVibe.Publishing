'use strict';
/**
 * Mini wiki — an example consumer of openvibe-publishing. It owns its own SQLite file and its own
 * publication state (wiki_pages); the packages only supply the mechanics.
 *
 *   node examples/two-products/wiki/app.js      # http://127.0.0.1:4801 with a temp database
 *
 * Uses: revisions (wiki_page_*), citations (wiki_citations), seo gate + redirects + sitemap +
 * Atom/JSON feeds, authorship (AI pages start as drafts), index-hooks (Search index events + product events into wiki_outbox), ssr.
 */
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');
// The package's public entry points, exactly as a product would import them.
const { createRevisionStore } = require('openvibe-publishing/revisions');
const { createCitationStore } = require('openvibe-publishing/citations');
const seo = require('openvibe-publishing/seo');
const authorship = require('openvibe-publishing/authorship');
const hooks = require('openvibe-publishing/index-hooks');
const ssr = require('openvibe-publishing/ssr');
const { slugify } = require('openvibe-publishing/taxonomy');

const POLICY = { minWords: 30, requireSources: true, minSources: 1 };

function createWiki({ dbPath, origin = 'https://openvibe.wiki', now = () => Date.now() } = {}) {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS wiki_pages (
            id                 TEXT PRIMARY KEY,
            slug               TEXT NOT NULL UNIQUE,
            owner              TEXT NOT NULL,
            visibility         TEXT NOT NULL DEFAULT 'public',
            state              TEXT NOT NULL DEFAULT 'draft',
            published_revision INTEGER,
            published_at       INTEGER,
            updated_at         INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS wiki_outbox (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            envelope TEXT NOT NULL
        );
    `);
    const revisions = createRevisionStore(db, { prefix: 'wiki_page', now });
    const citations = createCitationStore(db, { prefix: 'wiki', now, revisions });
    const redirects = seo.createRedirectStore(db, { prefix: 'wiki_page', now });
    const reviews = authorship.createReviewLog(db, { prefix: 'wiki_page', now });
    const sequencer = hooks.createIndexSequencer(db, { prefix: 'wiki', now });

    const pathOf = (slug) => `/p/${slug}`;
    const urlOf = (slug) => seo.canonicalUrl(origin, pathOf(slug));
    const getPage = (id) => db.prepare('SELECT * FROM wiki_pages WHERE id = ?').get(id);
    const bySlug = (slug) => db.prepare('SELECT * FROM wiki_pages WHERE slug = ?').get(slug);

    function decide(page, rev) {
        const rec = rev.meta.authorship;
        return seo.evaluate({
            state: page.state, visibility: page.visibility, canonicalUrl: urlOf(page.slug),
            text: ssr.markdownToText(rev.content), citationCount: citations.forRevision(page.id, rev.number).length,
            ...(rec ? authorship.gateFacts(rec, reviews.latest(page.id, rev.number)) : {}),
        }, { policy: POLICY, now: now() });
    }

    function document(page, rev, decision) {
        return hooks.buildIndexDocument({
            owner: 'wiki', type: 'page', id: page.id, revision: 0, state: page.state, visibility: page.visibility,
            canonicalUrl: urlOf(page.slug), title: rev ? rev.fields.title : page.slug, summary: rev ? ssr.markdownToText(rev.content, 160) : null,
            body: rev ? ssr.markdownToText(rev.content) : '', decision, acl: { subjects: [page.owner] },
            authorship: rev && rev.meta.authorship, citations: rev ? citations.forRevision(page.id, rev.number) : [],
            facets: { content_revision: rev ? rev.number : 0 },
            publishedAt: page.published_at, updatedAt: page.updated_at,
        });
    }

    /**
     * After any change: send Search the current document (or tombstone) when it differs from the
     * last one sent, and the product event when the publication state moved. Both go to the
     * outbox in the caller's transaction.
     */
    function sync(before, page, actor) {
        const rev = page.published_revision ? revisions.get(page.id, page.published_revision) : null;
        const decision = rev ? decide(page, rev) : null;
        const sentBefore = sequencer.current('wiki', 'page', page.id);
        const doc = sequencer.stamp(document(page, rev, decision));
        const out = [];
        if (doc.revision !== sentBefore) out.push(hooks.indexEvent({ document: doc, now: now() }));
        const action = hooks.actionFor(before && { state: before.state, visibility: before.visibility, revision: before.published_revision },
            { state: page.state, visibility: page.visibility, revision: page.published_revision });
        if (action) out.push(hooks.publicationEvent({ product: 'wiki', type: 'page', action, id: page.id, revision: page.published_revision || 0, actor, document: doc, decision, now: now() }));
        for (const env of out) db.prepare('INSERT INTO wiki_outbox (envelope) VALUES (?)').run(JSON.stringify(env));
        return out;
    }

    const api = {
        db, revisions, citations, redirects, reviews, policy: POLICY,

        createPage({ title, body, author, sources = [], authorship: rec = authorship.record({ mode: 'human', authors: [author] }) }) {
            return db.transaction(() => {
                const id = `pg_${slugify(title)}`;
                db.prepare('INSERT INTO wiki_pages (id, slug, owner, updated_at) VALUES (?, ?, ?, ?)').run(id, slugify(title), author, now());
                const { revision } = revisions.create({ entityId: id, expectedRevision: 0, content: body, fields: { title }, meta: { authorship: rec }, author });
                citations.attachMany(id, revision.number, sources);
                return { id, revision: revision.number, initial: authorship.initialState(rec) };
            })();
        },

        /** Edit: new revision; `keepSources` carries earlier citations forward, `sources` adds new ones. */
        edit(id, { expectedRevision, body, title, author, sources = [], keepSources = [] }) {
            return db.transaction(() => {
                const head = revisions.head(id);
                const { revision } = revisions.create({
                    entityId: id, expectedRevision, content: body, fields: { title: title || head.fields.title },
                    meta: { authorship: authorship.record({ mode: 'human', authors: [author] }) }, author,
                });
                if (keepSources.length) citations.carryForward({ entityId: id, fromRevision: head.number, toRevision: revision.number, ids: keepSources });
                citations.attachMany(id, revision.number, sources);
                return revision.number;
            })();
        },

        revert(id, { toRevision, expectedRevision, author }) {
            return db.transaction(() => {
                const { revision } = revisions.revert({ entityId: id, toRevision, expectedRevision, author });
                citations.carryForward({ entityId: id, fromRevision: toRevision, toRevision: revision.number });
                return revision.number;
            })();
        },

        publish(id, { revision, actor }) {
            return db.transaction(() => {
                const before = getPage(id);
                const rev = revisions.get(id, revision);
                const rec = rev.meta.authorship;
                const ok = authorship.canPublish(rec, reviews.latest(id, revision));
                if (!ok.ok) throw Object.assign(new Error(`cannot publish: ${ok.reason}`), { status: 409, code: ok.reason });
                db.prepare("UPDATE wiki_pages SET state = 'published', published_revision = ?, published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?").run(revision, now(), now(), id);
                return sync(before, getPage(id), actor);
            })();
        },

        setVisibility(id, visibility, { actor }) {
            return db.transaction(() => {
                const before = getPage(id);
                db.prepare('UPDATE wiki_pages SET visibility = ?, updated_at = ? WHERE id = ?').run(visibility, now(), id);
                return sync(before, getPage(id), actor);
            })();
        },

        rename(id, newTitle) {
            return db.transaction(() => {
                const page = getPage(id);
                const slug = slugify(newTitle);
                redirects.recordMove(id, pathOf(page.slug), pathOf(slug));
                db.prepare('UPDATE wiki_pages SET slug = ?, updated_at = ? WHERE id = ?').run(slug, now(), id);
                sync(page, getPage(id), 'svc:wiki'); // the canonical URL changed: Search gets a new revision
                return slug;
            })();
        },

        remove(id, { actor }) {
            return db.transaction(() => {
                const before = getPage(id);
                db.prepare("UPDATE wiki_pages SET state = 'deleted', updated_at = ? WHERE id = ?").run(now(), id);
                return sync(before, getPage(id), actor);
            })();
        },

        outbox() { return db.prepare('SELECT envelope FROM wiki_outbox ORDER BY id').all().map((r) => JSON.parse(r.envelope)); },

        /** Every page with its live revision and gate decision. */
        published() {
            return db.prepare("SELECT * FROM wiki_pages WHERE state = 'published' ORDER BY published_at DESC, id").all().map((page) => {
                const rev = revisions.get(page.id, page.published_revision);
                return { page, rev, decision: decide(page, rev) };
            });
        },

        sitemapXml() {
            return seo.sitemap(api.published().map(({ page, rev, decision }) => ({ loc: urlOf(page.slug), lastmod: rev.createdAt, decision }))).files[0];
        },

        feedItems() {
            return api.published().map(({ page, rev, decision }) => ({
                id: `tag:openvibe.wiki,2026:page/${page.id}`, url: urlOf(page.slug), title: rev.fields.title,
                summary: ssr.markdownToText(rev.content, 200), contentHtml: ssr.renderMarkdown(rev.content, { rel: 'noopener' }),
                published: page.published_at, updated: rev.createdAt, decision,
            }));
        },

        atom() {
            // Atom needs a feed-level <updated>: the last real change to any page (never "now").
            const last = db.prepare('SELECT MAX(updated_at) AS t FROM wiki_pages').get().t;
            return seo.atomFeed({ title: 'Mini wiki: recent pages', link: origin + '/', feedUrl: `${origin}/feed.atom`, updated: last }, api.feedItems());
        },
        jsonFeedDoc() { return seo.jsonFeed({ title: 'Mini wiki: recent pages', link: origin + '/', feedUrl: `${origin}/feed.json` }, api.feedItems()); },

        renderPage(page) {
            const rev = revisions.get(page.id, page.published_revision);
            const decision = decide(page, rev);
            const cites = citations.forRevision(page.id, rev.number);
            const disclosure = authorship.disclosure(rev.meta.authorship, reviews.latest(page.id, rev.number));
            const crumbs = [{ name: 'Wiki', url: `${origin}/` }, { name: rev.fields.title, url: urlOf(page.slug) }];
            const head = seo.metaTags({ title: rev.fields.title, description: ssr.markdownToText(rev.content, 160), decision, type: 'article',
                jsonLd: [seo.structuredData.article({ headline: rev.fields.title, url: urlOf(page.slug), dateModified: rev.createdAt,
                    datePublished: page.published_at ? new Date(page.published_at).toISOString() : null, citations: cites }), seo.structuredData.breadcrumbs(crumbs)].filter(Boolean) });
            return String(ssr.html`<!doctype html><html lang="en"><head><meta charset="utf-8">${ssr.raw(head)}</head><body>
${ssr.raw(ssr.breadcrumbsHtml(crumbs))}
<article><h1>${rev.fields.title}</h1>${disclosure ? ssr.html`<p class="disclosure">${disclosure.long}</p>` : ''}
${ssr.raw(ssr.renderMarkdown(rev.content, { rel: 'noopener' }))}
<p>Revision ${rev.number}, ${ssr.raw(ssr.timeTag(rev.createdAt))} · <a href="${pathOf(page.slug)}/history">history</a></p>
<section><h2>Sources</h2><ol>${cites.map((c) => ssr.html`<li>${c.url ? ssr.html`<a href="${c.url}" rel="noopener">${c.title || c.url}</a>` : c.sourceItemId}${c.retrievedAt ? ssr.html`, retrieved ${ssr.raw(ssr.timeTag(c.retrievedAt))}` : ''}${c.licenseNote ? ` (${c.licenseNote})` : ''}</li>`)}</ol></section>
</article></body></html>`);
        },

        /** Node http handler: pages, 301/410 history, sitemap, feeds. No JavaScript anywhere. */
        handler(req, res) {
            const url = new URL(req.url, origin);
            const send = (status, type, body, headers = {}) => { res.writeHead(status, { 'Content-Type': type, ...headers }); res.end(body); };
            if (url.pathname === '/sitemap.xml') return send(200, 'application/xml', api.sitemapXml());
            if (url.pathname === '/feed.atom') return send(200, 'application/atom+xml', api.atom());
            if (url.pathname === '/feed.json') return send(200, 'application/feed+json', JSON.stringify(api.jsonFeedDoc()));
            if (url.pathname === '/robots.txt') return send(200, 'text/plain', seo.robotsTxt({ sitemaps: [`${origin}/sitemap.xml`] }));
            const m = url.pathname.match(/^\/p\/([^/]+)(\/history)?$/);
            if (!m) return send(404, 'text/plain', 'Not found');
            const page = bySlug(decodeURIComponent(m[1]));
            if (!page) {
                const r = redirects.resolve(url.pathname.replace(/\/history$/, ''), { currentPath: (id) => { const p = getPage(id); return p && p.state !== 'deleted' ? pathOf(p.slug) : null; } });
                if (r && r.status === 301) return send(301, 'text/plain', 'Moved', { Location: r.location + (m[2] || '') });
                if (r && r.status === 410) return send(410, 'text/plain', 'Gone');
                return send(404, 'text/plain', 'Not found');
            }
            if (page.state === 'deleted') return send(410, 'text/plain', 'Gone');
            if (page.state !== 'published' || page.visibility === 'private' || page.visibility === 'gated') return send(404, 'text/plain', 'Not found');
            if (m[2]) {
                const list = revisions.list(page.id).map((r) => ssr.html`<li>r${r.number} ${r.kind} ${ssr.raw(ssr.timeTag(r.createdAt))}</li>`);
                return send(200, 'text/html; charset=utf-8', String(ssr.html`<!doctype html><title>History</title><meta name="robots" content="noindex"><ol>${list}</ol>`));
            }
            return send(200, 'text/html; charset=utf-8', api.renderPage(page));
        },

        close() { db.close(); },
    };
    return api;
}

module.exports = { createWiki };

if (require.main === module) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-wiki-'));
    const wiki = createWiki({ dbPath: path.join(dir, 'wiki.db'), origin: 'http://127.0.0.1:4801' });
    const { id } = wiki.createPage({
        title: 'Rye', author: 'usr_01J8Z6Q3KX0000000000000000',
        body: 'Rye is a grass grown extensively as a grain, a cover crop and a forage crop. It is closely related to wheat and barley, and its grain is used for flour, bread, beer, whiskey and animal fodder.',
        sources: [{ url: 'https://en.wikipedia.org/wiki/Rye', title: 'Rye — Wikipedia', licenseNote: 'CC BY-SA 4.0' }],
    });
    wiki.publish(id, { revision: 1, actor: 'usr_01J8Z6Q3KX0000000000000000' });
    http.createServer(wiki.handler).listen(4801, '127.0.0.1', () => console.log(`mini wiki on http://127.0.0.1:4801/p/rye (db ${dir}/wiki.db)`));
}
