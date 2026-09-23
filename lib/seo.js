'use strict';
/**
 * openvibe-publishing/seo — the deterministic indexability gate and the discovery artifacts that
 * obey it: canonical URLs, history-aware redirects, meta/robots tags, sitemaps, RSS/Atom/JSON
 * Feed, and JSON-LD built only from fields the product actually has.
 *
 *   const seo = require('openvibe-publishing/seo');
 *   const decision = seo.evaluate({ state: 'published', visibility: 'public', canonicalUrl, text, citationCount: 3 },
 *                                 { policy: { minWords: 150, requireSources: true } });
 *   // → { indexable: true, listable: true, robots: 'index, follow', reasons: [], codes: [], canonical, gate }
 *   seo.metaTags({ title, description, decision })          // robots come from the decision, never a default
 *   seo.sitemap([{ loc, lastmod, decision }])               // only indexable entries
 *   seo.atomFeed(channel, [{ id, url, title, published, decision, … }])   // only listable items
 *   seo.structuredData.article({ headline, url, datePublished, authors })  // missing → omitted
 *
 * Generic primitives (head tag layout, sitemap XML, robots.txt, JSON-LD script escaping) are the
 * network's single implementation in openvibe-shared/seo; this module adds the publication rules.
 *
 * THE GATE. evaluate(facts, { policy, now }) is a pure function: the same facts, policy and `now`
 * always give the same decision, and every "no" names a stable reason code (REASONS, in evaluation
 * order). Each reason has an effect:
 *   hidden   — not indexable and not listable: never in search, sitemaps or feeds
 *   noindex  — may be served and listed in feeds, but never indexed or put in a sitemap
 * Unknown fact names throw (a typo must not silently pass the gate), and so do missing facts a
 * rule needs — there is no default that makes content indexable.
 */
const sharedSeo = require('openvibe-shared/seo');
const { assertDb, assertPrefix, clockOf, assertEntityId } = require('./internal');
const { wordCount } = require('./ssr');

const GATE = 'openvibe-publishing/seo@1';

const REASONS = Object.freeze([
    { code: 'deleted', effect: 'hidden', description: 'The resource is deleted.' },
    { code: 'takedown', effect: 'hidden', description: 'Removed by a moderation, legal or owner takedown.' },
    { code: 'private', effect: 'hidden', description: 'Visibility is private.' },
    { code: 'gated', effect: 'hidden', description: 'Only entitled members (e.g. VIP) may read it.' },
    { code: 'unlisted', effect: 'hidden', description: 'Reachable by link only; never listed or indexed.' },
    { code: 'draft', effect: 'hidden', description: 'Not published yet (draft or scheduled).' },
    { code: 'unpublished', effect: 'hidden', description: 'Was published, has been unpublished.' },
    { code: 'ai_generated_unreviewed', effect: 'hidden', description: 'AI-generated and no human review is recorded.' },
    { code: 'stub_provider', effect: 'hidden', description: 'Produced while only the AI stub provider was available, and not reviewed.' },
    { code: 'unreviewed_sensitive', effect: 'hidden', description: 'Sensitive or regulated category without a recorded review.' },
    { code: 'retracted', effect: 'noindex', description: 'Retracted; kept visible with its correction, not indexed.' },
    { code: 'expired', effect: 'noindex', description: 'Past its expiry time.' },
    { code: 'stale_price', effect: 'noindex', description: 'A price is shown without a recent enough observation time.' },
    { code: 'duplicate_of', effect: 'noindex', description: 'Duplicates another canonical page.' },
    { code: 'thin', effect: 'noindex', description: 'Below the product\'s minimum amount of text.' },
    { code: 'unsourced', effect: 'noindex', description: 'Fewer citations than the product requires.' },
    { code: 'unsupported_claims', effect: 'noindex', description: 'Contains claims flagged as lacking a source.' },
    { code: 'missing_canonical', effect: 'noindex', description: 'No canonical URL was provided.' },
    { code: 'noindex_requested', effect: 'noindex', description: 'The author or an editor asked for noindex.' },
]);
const REASON_BY_CODE = Object.freeze(Object.fromEntries(REASONS.map((r) => [r.code, r])));

const STATES = ['draft', 'scheduled', 'published', 'unpublished', 'deleted'];
const VISIBILITIES = ['public', 'unlisted', 'private', 'gated'];
const FACT_KEYS = new Set([
    'state', 'visibility', 'takedown', 'canonicalUrl', 'duplicateOf', 'text', 'wordCount', 'citationCount',
    'unsupportedClaims', 'authorship', 'stubProvider', 'sensitive', 'category', 'sensitiveReviewed',
    'expiresAt', 'price', 'retracted', 'noindex',
]);
const DEFAULT_POLICY = Object.freeze({
    minWords: 150,
    requireSources: false,
    minSources: 1,
    priceMaxAgeMs: 24 * 60 * 60 * 1000,
    sensitiveCategories: [],
});

function timeOf(value, name) {
    const t = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(t)) throw new TypeError(`${name} must be a valid date`);
    return t;
}

/**
 * The indexability decision. facts (see FACT_KEYS):
 *   state (required)       draft | scheduled | published | unpublished | deleted
 *   visibility (required)  public | unlisted | private | gated
 *   canonicalUrl, duplicateOf (URL of the original this duplicates)
 *   text or wordCount      (required when policy.minWords > 0)
 *   citationCount          (required when policy.requireSources)
 *   unsupportedClaims      number of claims flagged unsourced
 *   authorship             { mode: human|ai|hybrid|imported, reviewed: bool } (authorship.gateFacts)
 *   stubProvider, sensitive, category, sensitiveReviewed, takedown, retracted, noindex (booleans/strings)
 *   expiresAt              instant; price { observedAt } — both need options.now
 */
function evaluate(facts, { policy = {}, now } = {}) {
    if (!facts || typeof facts !== 'object') throw new TypeError('facts must be an object');
    for (const k of Object.keys(facts)) if (!FACT_KEYS.has(k)) throw new TypeError(`unknown fact "${k}"`);
    const p = { ...DEFAULT_POLICY, ...policy };
    if (!STATES.includes(facts.state)) throw new TypeError(`facts.state must be one of ${STATES.join(', ')}`);
    if (!VISIBILITIES.includes(facts.visibility)) throw new TypeError(`facts.visibility must be one of ${VISIBILITIES.join(', ')}`);
    const nowMs = now == null ? null : timeOf(now, 'now');
    const needNow = (what) => { if (nowMs == null) throw new TypeError(`${what} needs options.now (the gate has no hidden clock)`); return nowMs; };

    const found = new Map();
    const hit = (code, detail = null) => { if (!found.has(code)) found.set(code, detail); };

    if (facts.state === 'deleted') hit('deleted');
    if (facts.takedown) hit('takedown');
    if (facts.visibility === 'private') hit('private');
    if (facts.visibility === 'gated') hit('gated');
    if (facts.visibility === 'unlisted') hit('unlisted');
    if (facts.state === 'draft' || facts.state === 'scheduled') hit('draft', facts.state);
    if (facts.state === 'unpublished') hit('unpublished');

    const a = facts.authorship;
    if (a != null) {
        if (typeof a !== 'object' || !a.mode) throw new TypeError('facts.authorship must be { mode, reviewed }');
        if (a.mode === 'ai' && !a.reviewed) hit('ai_generated_unreviewed');
    }
    const reviewed = Boolean(a && a.reviewed);
    if (facts.stubProvider && !reviewed) hit('stub_provider');

    const sensitive = Boolean(facts.sensitive) || (facts.category != null && p.sensitiveCategories.includes(facts.category));
    if (sensitive && !facts.sensitiveReviewed) hit('unreviewed_sensitive', facts.category != null ? String(facts.category) : null);

    if (facts.retracted) hit('retracted');
    if (facts.expiresAt != null && timeOf(facts.expiresAt, 'expiresAt') <= needNow('expiresAt')) hit('expired', new Date(timeOf(facts.expiresAt, 'expiresAt')).toISOString());
    if (facts.price != null) {
        const observed = facts.price && facts.price.observedAt;
        if (observed == null || observed === '') hit('stale_price', 'price has no observation time');
        else if (needNow('price.observedAt') - timeOf(observed, 'price.observedAt') > p.priceMaxAgeMs) hit('stale_price', `observed ${new Date(timeOf(observed, 'price.observedAt')).toISOString()}`);
    }
    if (facts.duplicateOf && facts.duplicateOf !== facts.canonicalUrl) hit('duplicate_of', String(facts.duplicateOf));

    if (p.minWords > 0) {
        let words;
        if (Number.isInteger(facts.wordCount)) words = facts.wordCount;
        else if (typeof facts.text === 'string') words = wordCount(facts.text);
        else throw new TypeError('facts.text or facts.wordCount is required when policy.minWords > 0');
        if (words < p.minWords) hit('thin', `${words} of ${p.minWords} words`);
    }
    if (p.requireSources) {
        if (!Number.isInteger(facts.citationCount)) throw new TypeError('facts.citationCount is required when policy.requireSources');
        if (facts.citationCount < p.minSources) hit('unsourced', `${facts.citationCount} of ${p.minSources} sources`);
    }
    if (Number(facts.unsupportedClaims) > 0) hit('unsupported_claims', `${Number(facts.unsupportedClaims)} claims`);
    if (!facts.canonicalUrl) hit('missing_canonical');
    if (facts.noindex) hit('noindex_requested');

    const reasons = REASONS.filter((r) => found.has(r.code)).map((r) => ({ code: r.code, effect: r.effect, detail: found.get(r.code) }));
    const hidden = reasons.some((r) => r.effect === 'hidden');
    const indexable = reasons.length === 0;
    return {
        gate: GATE,
        indexable,
        listable: !hidden,
        robots: indexable ? 'index, follow' : hidden ? 'noindex, nofollow' : 'noindex, follow',
        canonical: found.has('duplicate_of') ? String(facts.duplicateOf) : (facts.canonicalUrl || null),
        reasons,
        codes: reasons.map((r) => r.code),
    };
}

function requireDecision(decision, where) {
    if (!decision || typeof decision.indexable !== 'boolean' || typeof decision.robots !== 'string') {
        throw new TypeError(`${where} needs the gate's decision (seo.evaluate): publication state, not rendering, decides indexability`);
    }
    return decision;
}

// ---- Canonical URLs and redirects --------------------------------------------------------------

/**
 * Absolute canonical URL: https/http origin + path segments (each encoded), no fragment, no
 * trailing slash (except the root), and only whitelisted query parameters, sorted.
 *   canonicalUrl('https://openvibe.wiki', ['spaces', 'food', 'pages', 'Crème brûlée'])
 *   canonicalUrl('https://openvibe.blog', '/alex/posts/bread?page=2&utm_source=x', { query: ['page'] })
 */
function canonicalUrl(origin, path = '/', { query = [] } = {}) {
    let base;
    try { base = new URL(String(origin)); } catch { throw new TypeError('origin must be an absolute URL'); }
    if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new TypeError('origin must be http(s)');
    let pathname;
    let search = '';
    if (Array.isArray(path)) {
        pathname = '/' + path.filter((s) => s != null && s !== '').map((s) => encodeURIComponent(String(s))).join('/');
    } else {
        const u = new URL(String(path || '/'), base.origin);
        if (u.origin !== base.origin) throw new TypeError('path must stay on the origin');
        pathname = u.pathname;
        const keep = [...u.searchParams.entries()].filter(([k]) => query.includes(k)).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
        if (keep.length) search = '?' + new URLSearchParams(keep).toString();
    }
    pathname = pathname.replace(/\/{2,}/g, '/');
    if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '');
    return `${base.protocol}//${base.host.toLowerCase()}${pathname}${search}`;
}

function normalizePath(p) {
    const s = String(p == null ? '' : p).split('#')[0].split('?')[0];
    if (!s.startsWith('/') || s.startsWith('//')) throw new TypeError('paths must be site-relative and start with one "/"');
    return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

/**
 * History-aware redirects in <prefix>_redirects: every path an entity ever had points at the
 * entity, and resolve() answers with the entity's *current* path, so chains collapse into one 301.
 */
function createRedirectStore(db, { prefix, now } = {}) {
    assertDb(db);
    assertPrefix(prefix);
    const clock = clockOf(now);
    const R = `${prefix}_redirects`;
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${R} (
            from_path  TEXT PRIMARY KEY,
            entity_id  TEXT NOT NULL,
            reason     TEXT,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ${R}_entity ON ${R} (entity_id);
    `);
    const q = {
        put: db.prepare(`INSERT INTO ${R} (from_path, entity_id, reason, created_at) VALUES (?, ?, ?, ?)
                         ON CONFLICT (from_path) DO UPDATE SET entity_id = excluded.entity_id, reason = excluded.reason, created_at = excluded.created_at`),
        del: db.prepare(`DELETE FROM ${R} WHERE from_path = ?`),
        get: db.prepare(`SELECT * FROM ${R} WHERE from_path = ?`),
        history: db.prepare(`SELECT * FROM ${R} WHERE entity_id = ? ORDER BY created_at, from_path`),
    };
    return {
        table: R,
        /** An entity moved from oldPath to newPath (slug rename, space move). */
        recordMove(entityId, oldPath, newPath, { reason = 'renamed' } = {}) {
            assertEntityId(entityId);
            const from = normalizePath(oldPath);
            const to = normalizePath(newPath);
            db.transaction(() => {
                q.del.run(to); // the new path is live: it must not redirect anywhere
                if (from !== to) q.put.run(from, entityId, reason, clock());
            })();
        },
        /** Claim a path for a (new) entity: removes any redirect that used it. */
        release(path) { return q.del.run(normalizePath(path)).changes > 0; },
        /**
         * currentPath(entityId) → the entity's live path, or null when it is gone.
         * → null (not a historical path) | { status: 301, location } | { status: 410 }
         */
        resolve(path, { currentPath } = {}) {
            if (typeof currentPath !== 'function') throw new TypeError('currentPath(entityId) is required');
            let from;
            try { from = normalizePath(path); } catch { return null; }
            const row = q.get.get(from);
            if (!row) return null;
            const target = currentPath(row.entity_id);
            if (target == null) return { status: 410, entityId: row.entity_id };
            const location = normalizePath(target);
            if (location === from) return null;
            return { status: 301, location, entityId: row.entity_id };
        },
        history(entityId) { return q.history.all(assertEntityId(entityId)).map((r) => ({ path: r.from_path, reason: r.reason, at: new Date(r.created_at).toISOString() })); },
    };
}

// ---- Meta tags ---------------------------------------------------------------------------------

/** <meta name="robots"> from the decision. */
function robotsMeta(decision) {
    return `<meta name="robots" content="${sharedSeo.esc(requireDecision(decision, 'robotsMeta').robots)}">`;
}

/** X-Robots-Tag header value for non-HTML representations (JSON, feeds of private collections). */
function xRobotsTag(decision) { return requireDecision(decision, 'xRobotsTag').robots; }

/**
 * The page's <head> SEO block (openvibe-shared/seo headTags) with robots and canonical taken from
 * the decision. Options are headTags' (title, description, image, type, siteName, jsonLd, …);
 * the canonical defaults to decision.canonical (the original, for a duplicate).
 */
function metaTags({ decision, canonical, ...rest } = {}) {
    requireDecision(decision, 'metaTags');
    return sharedSeo.headTags({ ...rest, canonical: decision.canonical || canonical, robots: decision.robots });
}

// ---- Sitemaps ----------------------------------------------------------------------------------

/**
 * entries: [{ loc (absolute), lastmod? (a real revision time), decision, images? }]
 * → { files: [xml], count, skipped: [{ loc, codes }] }. Only indexable entries are written;
 * a missing lastmod is left out, never filled with "now". Split every maxUrls (50,000).
 */
function sitemap(entries = [], { maxUrls = 50000 } = {}) {
    const keep = [];
    const skipped = [];
    for (const e of entries) {
        if (!e || !e.loc) throw new TypeError('every sitemap entry needs loc');
        const d = requireDecision(e.decision, 'sitemap entries');
        if (!d.indexable || !/^https?:\/\//i.test(e.loc)) { skipped.push({ loc: e.loc, codes: d.codes || [] }); continue; }
        const u = { loc: d.canonical || e.loc };
        if (e.lastmod != null && e.lastmod !== '') u.lastmod = new Date(timeOf(e.lastmod, 'lastmod')).toISOString();
        if (Array.isArray(e.images) && e.images.length) u.images = e.images;
        keep.push(u);
    }
    const size = Math.max(1, Math.min(50000, Math.floor(maxUrls) || 50000));
    const files = [];
    for (let i = 0; i < keep.length; i += size) files.push(sharedSeo.sitemapXml(keep.slice(i, i + size)));
    if (!files.length) files.push(sharedSeo.sitemapXml([]));
    return { files, count: keep.length, skipped };
}

/** Sitemap index over per-section sitemaps: [{ loc, lastmod? }]. */
function sitemapIndex(maps = []) { return sharedSeo.sitemapIndexXml(maps); }

/** robots.txt (openvibe-shared/seo), with the sitemap locations declared. */
function robotsTxt(opts = {}) { return sharedSeo.robotsTxt(opts); }

// ---- Feeds -------------------------------------------------------------------------------------

const xml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
    // Characters XML 1.0 forbids.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
const isoOr = (v, name) => (v == null || v === '' ? null : new Date(timeOf(v, name)).toISOString());

function feedItems(items) {
    const out = [];
    const skipped = [];
    for (const it of items) {
        if (!it || it.id == null || !it.url) throw new TypeError('every feed item needs a stable id and a canonical url');
        const d = requireDecision(it.decision, 'feed items');
        if (!d.listable) { skipped.push({ id: String(it.id), codes: d.codes }); continue; }
        out.push({
            id: String(it.id), url: it.url, title: it.title == null ? null : String(it.title),
            summary: it.summary == null ? null : String(it.summary), contentHtml: it.contentHtml == null ? null : String(it.contentHtml),
            published: isoOr(it.published, 'published'), updated: isoOr(it.updated, 'updated'),
            authors: (it.authors || []).filter((a) => a && a.name).map((a) => ({ name: String(a.name), url: a.url || null })),
            tags: (it.tags || []).filter((t) => t != null && t !== '').map(String),
            image: it.image || null,
        });
    }
    return { items: out, skipped };
}

function requireChannel(c, keys) {
    for (const k of keys) if (!c || !c[k]) throw new TypeError(`feed channel needs ${k}`);
}

/** RSS 2.0. channel: { title, link, description, feedUrl?, language?, updated? }. */
function rssFeed(channel, items = []) {
    requireChannel(channel, ['title', 'link', 'description']);
    const { items: list } = feedItems(items);
    const out = ['<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">',
        '<channel>', `<title>${xml(channel.title)}</title>`, `<link>${xml(channel.link)}</link>`, `<description>${xml(channel.description)}</description>`];
    if (channel.feedUrl) out.push(`<atom:link href="${xml(channel.feedUrl)}" rel="self" type="application/rss+xml"/>`);
    if (channel.language) out.push(`<language>${xml(channel.language)}</language>`);
    if (channel.updated) out.push(`<lastBuildDate>${new Date(timeOf(channel.updated, 'channel.updated')).toUTCString()}</lastBuildDate>`);
    for (const it of list) {
        const parts = [];
        if (it.title) parts.push(`<title>${xml(it.title)}</title>`);
        parts.push(`<link>${xml(it.url)}</link>`, `<guid isPermaLink="false">${xml(it.id)}</guid>`);
        if (it.summary) parts.push(`<description>${xml(it.summary)}</description>`);
        if (it.contentHtml) parts.push(`<content:encoded>${xml(it.contentHtml)}</content:encoded>`);
        if (it.published) parts.push(`<pubDate>${new Date(it.published).toUTCString()}</pubDate>`);
        for (const a of it.authors) parts.push(`<dc:creator>${xml(a.name)}</dc:creator>`);
        for (const t of it.tags) parts.push(`<category>${xml(t)}</category>`);
        out.push(`<item>${parts.join('')}</item>`);
    }
    out.push('</channel>', '</rss>', '');
    return out.join('\n');
}

const atomId = (id) => (/^[a-z][a-z0-9+.-]*:/i.test(id) ? id : `urn:openvibe:${id}`);

/**
 * Atom 1.0. channel: { title, link, feedUrl, id?, updated?, author? { name, url }, subtitle? }.
 * Entries with neither `updated` nor `published` are left out (Atom requires a date and this
 * module will not invent one). The feed's <updated> is channel.updated or the newest entry.
 */
function atomFeed(channel, items = []) {
    requireChannel(channel, ['title', 'link', 'feedUrl']);
    const { items: list } = feedItems(items);
    const dated = list.filter((it) => it.updated || it.published);
    const newest = dated.map((it) => it.updated || it.published).sort().pop();
    const updated = channel.updated ? new Date(timeOf(channel.updated, 'channel.updated')).toISOString() : newest;
    if (!updated) throw new TypeError('an Atom feed needs channel.updated or at least one dated entry');
    const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<feed xmlns="http://www.w3.org/2005/Atom">',
        `<id>${xml(atomId(channel.id || channel.feedUrl))}</id>`, `<title>${xml(channel.title)}</title>`,
        `<link rel="alternate" type="text/html" href="${xml(channel.link)}"/>`, `<link rel="self" type="application/atom+xml" href="${xml(channel.feedUrl)}"/>`,
        `<updated>${updated}</updated>`];
    if (channel.subtitle) out.push(`<subtitle>${xml(channel.subtitle)}</subtitle>`);
    if (channel.author && channel.author.name) out.push(`<author><name>${xml(channel.author.name)}</name>${channel.author.url ? `<uri>${xml(channel.author.url)}</uri>` : ''}</author>`);
    for (const it of dated) {
        const parts = [`<id>${xml(atomId(it.id))}</id>`, `<title>${xml(it.title || '')}</title>`, `<link rel="alternate" type="text/html" href="${xml(it.url)}"/>`,
            `<updated>${it.updated || it.published}</updated>`];
        if (it.published) parts.push(`<published>${it.published}</published>`);
        for (const a of it.authors) parts.push(`<author><name>${xml(a.name)}</name>${a.url ? `<uri>${xml(a.url)}</uri>` : ''}</author>`);
        for (const t of it.tags) parts.push(`<category term="${xml(t)}"/>`);
        if (it.summary) parts.push(`<summary>${xml(it.summary)}</summary>`);
        if (it.contentHtml) parts.push(`<content type="html">${xml(it.contentHtml)}</content>`);
        out.push(`<entry>${parts.join('')}</entry>`);
    }
    out.push('</feed>', '');
    return out.join('\n');
}

/** JSON Feed 1.1 (as an object; JSON.stringify it). channel: { title, link, feedUrl, description?, language?, authors? }. */
function jsonFeed(channel, items = []) {
    requireChannel(channel, ['title', 'link', 'feedUrl']);
    const { items: list } = feedItems(items);
    const feed = { version: 'https://jsonfeed.org/version/1.1', title: String(channel.title), home_page_url: channel.link, feed_url: channel.feedUrl };
    if (channel.description) feed.description = String(channel.description);
    if (channel.language) feed.language = String(channel.language);
    const chAuthors = (channel.authors || []).filter((a) => a && a.name).map((a) => compact({ name: a.name, url: a.url }));
    if (chAuthors.length) feed.authors = chAuthors;
    feed.items = list.map((it) => compact({
        id: it.id, url: it.url, title: it.title,
        content_html: it.contentHtml || undefined,
        content_text: it.contentHtml ? undefined : (it.summary || it.title || ''),
        summary: it.summary, image: it.image,
        date_published: it.published, date_modified: it.updated,
        authors: it.authors.length ? it.authors.map((a) => compact({ name: a.name, url: a.url })) : undefined,
        tags: it.tags.length ? it.tags : undefined,
    }, { keepEmptyString: ['content_text'] }));
    return feed;
}

/** <link rel="alternate"> tags that advertise feeds: [{ type: 'rss'|'atom'|'json', href, title }]. */
function feedLinks(feeds = []) {
    const types = { rss: 'application/rss+xml', atom: 'application/atom+xml', json: 'application/feed+json' };
    return feeds.filter((f) => f && f.href && types[f.type])
        .map((f) => `<link rel="alternate" type="${types[f.type]}" href="${sharedSeo.esc(f.href)}"${f.title ? ` title="${sharedSeo.esc(f.title)}"` : ''}>`).join('\n');
}

// ---- Structured data ---------------------------------------------------------------------------

/**
 * Recursively drops null / undefined / '' / NaN / empty arrays / empty objects, and objects whose
 * only keys are '@type' / '@context' / '@id'. Nothing is ever added.
 */
function compact(value, { keepEmptyString = [] } = {}) {
    const walk = (v, key) => {
        if (v == null) return undefined;
        if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
        if (typeof v === 'string') return v === '' && !keepEmptyString.includes(key) ? undefined : v;
        if (Array.isArray(v)) { const a = v.map((x) => walk(x, key)).filter((x) => x !== undefined); return a.length ? a : undefined; }
        if (typeof v === 'object') {
            const o = {};
            for (const [k, x] of Object.entries(v)) { const w = walk(x, k); if (w !== undefined) o[k] = w; }
            const meaningful = Object.keys(o).filter((k) => k !== '@type' && k !== '@context' && k !== '@id');
            return meaningful.length ? o : undefined;
        }
        return v;
    };
    return walk(value, null);
}

const iso = (v, name) => (v == null || v === '' ? undefined : new Date(timeOf(v, name)).toISOString());
const num = (v) => (v == null || v === '' ? undefined : (Number.isFinite(Number(v)) ? Number(v) : undefined));
const CTX = 'https://schema.org';

function person(a) {
    if (!a) return undefined;
    if (typeof a === 'string') return { '@type': 'Person', name: a };
    return { '@type': a.type === 'Organization' ? 'Organization' : 'Person', name: a.name, url: a.url };
}

function org(o) {
    if (!o) return undefined;
    return { '@type': 'Organization', name: o.name, url: o.url, logo: o.logo ? { '@type': 'ImageObject', url: o.logo } : undefined };
}

/** schema.org Rating, or undefined unless a numeric value is provided. No default bestRating. */
function rating(r) {
    if (!r || num(r.value) === undefined) return undefined;
    return { '@type': 'Rating', ratingValue: num(r.value), bestRating: num(r.best), worstRating: num(r.worst) };
}

/** AggregateRating only with a numeric value AND a positive count of ratings or reviews. */
function aggregateRating(r) {
    if (!r || num(r.value) === undefined) return undefined;
    const ratingCount = Number.isInteger(r.count) && r.count > 0 ? r.count : undefined;
    const reviewCount = Number.isInteger(r.reviewCount) && r.reviewCount > 0 ? r.reviewCount : undefined;
    if (ratingCount === undefined && reviewCount === undefined) return undefined;
    return { '@type': 'AggregateRating', ratingValue: num(r.value), ratingCount, reviewCount, bestRating: num(r.best), worstRating: num(r.worst) };
}

const AVAILABILITY = {
    in_stock: 'https://schema.org/InStock', out_of_stock: 'https://schema.org/OutOfStock', preorder: 'https://schema.org/PreOrder',
    discontinued: 'https://schema.org/Discontinued', limited: 'https://schema.org/LimitedAvailability', sold_out: 'https://schema.org/SoldOut',
    online_only: 'https://schema.org/OnlineOnly', in_store_only: 'https://schema.org/InStoreOnly',
};
const CONDITION = { new: 'https://schema.org/NewCondition', used: 'https://schema.org/UsedCondition', refurbished: 'https://schema.org/RefurbishedCondition', damaged: 'https://schema.org/DamagedCondition' };

/** Offer only with a numeric price and a 3-letter currency. Availability only from a known value. */
function offer(o) {
    if (!o || num(o.price) === undefined || !/^[A-Z]{3}$/.test(String(o.priceCurrency || ''))) return undefined;
    return {
        '@type': 'Offer', price: num(o.price), priceCurrency: o.priceCurrency, url: o.url,
        availability: AVAILABILITY[o.availability], itemCondition: CONDITION[o.condition],
        priceValidUntil: o.priceValidUntil ? iso(o.priceValidUntil, 'priceValidUntil').slice(0, 10) : undefined,
        validFrom: iso(o.validFrom, 'validFrom'), validThrough: iso(o.validThrough, 'validThrough'),
        seller: o.seller ? org(o.seller) : undefined,
    };
}

function citationList(list) {
    return (list || []).map((c) => (c && c.url ? { '@type': 'CreativeWork', url: c.url, name: c.title || undefined } : undefined));
}

const structuredData = {
    /**
     * Article / BlogPosting / NewsArticle from what the page shows. Missing headline or url → null.
     * { type, headline, url, description, datePublished, dateModified, authors: [ {name,url,type} | 'Name' ],
     *   publisher: { name, url, logo }, image, section, keywords[], inLanguage, citations: [{ url, title }], wordCount }
     */
    article(a = {}) {
        if (!a.headline || !a.url) return null;
        const type = ['Article', 'BlogPosting', 'NewsArticle'].includes(a.type) ? a.type : 'Article';
        return compact({
            '@context': CTX, '@type': type, '@id': `${a.url}#article`, headline: sharedSeo.clip(a.headline, 110), url: a.url,
            mainEntityOfPage: a.url, description: a.description, datePublished: iso(a.datePublished, 'datePublished'),
            dateModified: iso(a.dateModified, 'dateModified'), author: (a.authors || []).map(person), publisher: org(a.publisher),
            image: a.image, articleSection: a.section, keywords: a.keywords && a.keywords.length ? a.keywords.join(', ') : undefined,
            inLanguage: a.inLanguage, citation: citationList(a.citations), wordCount: Number.isInteger(a.wordCount) ? a.wordCount : undefined,
        });
    },

    /** A single review. Needs the reviewed item's name; the rating appears only if provided. */
    review(r = {}) {
        if (!r.itemReviewed || !r.itemReviewed.name) return null;
        return compact({
            '@context': CTX, '@type': 'Review', url: r.url,
            itemReviewed: { '@type': r.itemReviewed.type || 'Thing', name: r.itemReviewed.name, url: r.itemReviewed.url },
            author: person(r.author), datePublished: iso(r.datePublished, 'datePublished'), reviewBody: r.body,
            reviewRating: rating(r.rating), publisher: org(r.publisher),
        });
    },

    /** Product with offers / aggregateRating only where the data exists. Missing name → null. */
    product(p = {}) {
        if (!p.name) return null;
        return compact({
            '@context': CTX, '@type': 'Product', name: p.name, url: p.url, description: p.description, image: p.image,
            brand: p.brand ? { '@type': 'Brand', name: p.brand } : undefined, sku: p.sku, gtin: p.gtin, mpn: p.mpn,
            offers: (p.offers || []).map(offer), aggregateRating: aggregateRating(p.aggregateRating),
        });
    },

    /** An entity with an aggregate rating (Reviews). Missing name → null; missing counts → no rating. */
    ratedThing(t = {}) {
        if (!t.name) return null;
        return compact({ '@context': CTX, '@type': t.type || 'Thing', name: t.name, url: t.url, description: t.description, aggregateRating: aggregateRating(t.aggregateRating) });
    },

    breadcrumbs(items = []) {
        const list = items.filter((it) => it && it.name);
        if (!list.length) return null;
        return compact({ '@context': CTX, '@type': 'BreadcrumbList', itemListElement: list.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: it.url })) });
    },

    webPage(w = {}) {
        if (!w.url) return null;
        return compact({ '@context': CTX, '@type': w.type || 'WebPage', '@id': `${w.url}#page`, url: w.url, name: w.name, description: w.description, dateModified: iso(w.dateModified, 'dateModified'), inLanguage: w.inLanguage });
    },
};

/** <script type="application/ld+json"> (safe against </script> break-out); '' for null. */
function jsonLdScript(obj) { return obj ? sharedSeo.jsonLdTag(obj) : ''; }

module.exports = {
    GATE, REASONS, REASON_BY_CODE, STATES, VISIBILITIES, DEFAULT_POLICY,
    evaluate, canonicalUrl, createRedirectStore, normalizePath,
    metaTags, robotsMeta, xRobotsTag,
    sitemap, sitemapIndex, robotsTxt,
    rssFeed, atomFeed, jsonFeed, feedLinks,
    structuredData, jsonLdScript, compact,
};
