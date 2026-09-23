'use strict';
const assert = require('assert');
const { openDb, fakeClock, suite } = require('./helpers/db');
const seo = require('../lib/seo');

const { test, run } = suite();
const NOW = Date.parse('2026-09-22T12:00:00Z');
const LONG = 'word '.repeat(200);
const base = (extra = {}) => ({ state: 'published', visibility: 'public', canonicalUrl: 'https://openvibe.wiki/p/rye', text: LONG, ...extra });

// ---- the gate ----------------------------------------------------------------------------------

test('published, sourced, non-duplicate content is indexable', () => {
    const d = seo.evaluate(base({ citationCount: 2 }), { policy: { requireSources: true } });
    assert.deepStrictEqual(d, {
        gate: 'openvibe-publishing/seo@1', indexable: true, listable: true, robots: 'index, follow',
        canonical: 'https://openvibe.wiki/p/rye', reasons: [], codes: [],
    });
});

test('every reason code fires on its own fact, with a stable effect', () => {
    const policy = { requireSources: true, sensitiveCategories: ['health'] };
    const cases = [
        ['deleted', { state: 'deleted' }, 'hidden'],
        ['takedown', { takedown: true }, 'hidden'],
        ['private', { visibility: 'private' }, 'hidden'],
        ['gated', { visibility: 'gated' }, 'hidden'],
        ['unlisted', { visibility: 'unlisted' }, 'hidden'],
        ['draft', { state: 'draft' }, 'hidden'],
        ['draft', { state: 'scheduled' }, 'hidden'],
        ['unpublished', { state: 'unpublished' }, 'hidden'],
        ['ai_generated_unreviewed', { authorship: { mode: 'ai', reviewed: false } }, 'hidden'],
        ['stub_provider', { stubProvider: true }, 'hidden'],
        ['unreviewed_sensitive', { category: 'health' }, 'hidden'],
        ['unreviewed_sensitive', { sensitive: true }, 'hidden'],
        ['retracted', { retracted: true }, 'noindex'],
        ['expired', { expiresAt: '2026-09-01T00:00:00Z' }, 'noindex'],
        ['stale_price', { price: { observedAt: '2026-09-01T00:00:00Z' } }, 'noindex'],
        ['stale_price', { price: {} }, 'noindex'],
        ['duplicate_of', { duplicateOf: 'https://openvibe.wiki/p/rye-grain' }, 'noindex'],
        ['thin', { text: 'too short' }, 'noindex'],
        ['unsourced', { citationCount: 0 }, 'noindex'],
        ['unsupported_claims', { unsupportedClaims: 2 }, 'noindex'],
        ['missing_canonical', { canonicalUrl: undefined }, 'noindex'],
        ['noindex_requested', { noindex: true }, 'noindex'],
    ];
    for (const [code, facts, effect] of cases) {
        const f = base({ citationCount: 1, ...facts });
        if (f.canonicalUrl === undefined) delete f.canonicalUrl;
        const d = seo.evaluate(f, { policy, now: NOW });
        assert.deepStrictEqual(d.codes, [code], `${JSON.stringify(facts)} → ${d.codes}`);
        assert.strictEqual(d.reasons[0].effect, effect);
        assert.strictEqual(d.indexable, false);
        assert.strictEqual(d.listable, effect !== 'hidden');
        assert.strictEqual(d.robots, effect === 'hidden' ? 'noindex, nofollow' : 'noindex, follow');
        assert.ok(seo.REASON_BY_CODE[code].description);
    }
});

test('the gate is deterministic: same input → same output, reasons in REASONS order', () => {
    const facts = base({ state: 'draft', visibility: 'private', text: 'short', noindex: true, citationCount: 0, authorship: { mode: 'ai', reviewed: false }, duplicateOf: 'https://x.test/o' });
    const opts = { policy: { requireSources: true }, now: NOW };
    const a = seo.evaluate(facts, opts);
    const b = seo.evaluate(JSON.parse(JSON.stringify(facts)), opts);
    assert.deepStrictEqual(a, b);
    assert.deepStrictEqual(a.codes, ['private', 'draft', 'ai_generated_unreviewed', 'duplicate_of', 'thin', 'unsourced', 'noindex_requested']);
    const order = seo.REASONS.map((r) => r.code);
    assert.deepStrictEqual([...a.codes].sort((x, y) => order.indexOf(x) - order.indexOf(y)), a.codes);
    assert.strictEqual(a.canonical, 'https://x.test/o', 'a duplicate canonicalises to its original');
    assert.strictEqual(a.reasons.find((r) => r.code === 'thin').detail, '1 of 150 words');
});

test('reviews lift the AI/stub/sensitive holds; fresh prices and future expiry pass', () => {
    const d = seo.evaluate(base({
        authorship: { mode: 'ai', reviewed: true }, stubProvider: true, sensitive: true, sensitiveReviewed: true,
        expiresAt: '2026-12-01T00:00:00Z', price: { observedAt: NOW - 3600e3 },
    }), { now: NOW });
    assert.strictEqual(d.indexable, true);
    assert.strictEqual(seo.evaluate(base({ authorship: { mode: 'hybrid', reviewed: false } })).indexable, true);
});

test('no silent pass: unknown facts, missing facts and time facts without `now` throw', () => {
    assert.throws(() => seo.evaluate(base({ visiblity: 'public' })), /unknown fact "visiblity"/);
    assert.throws(() => seo.evaluate({ visibility: 'public', text: LONG }), /state/);
    assert.throws(() => seo.evaluate({ state: 'published', text: LONG }), /visibility/);
    const { text, ...noText } = base();
    assert.throws(() => seo.evaluate(noText), /text or facts.wordCount/);
    assert.throws(() => seo.evaluate(base(), { policy: { requireSources: true } }), /citationCount/);
    assert.throws(() => seo.evaluate(base({ expiresAt: '2026-01-01' })), /needs options.now/);
    assert.throws(() => seo.evaluate(base({ price: { observedAt: NOW } })), /needs options.now/);
    assert.strictEqual(seo.evaluate(noText, { policy: { minWords: 0 } }).indexable, true);
    assert.strictEqual(seo.evaluate(base({ text: undefined, wordCount: 151 })).indexable, true);
});

// ---- canonical URLs and redirects --------------------------------------------------------------

test('canonicalUrl', () => {
    assert.strictEqual(seo.canonicalUrl('https://OpenVibe.Wiki', ['spaces', 'food', 'Crème brûlée']), 'https://openvibe.wiki/spaces/food/Cr%C3%A8me%20br%C3%BBl%C3%A9e');
    assert.strictEqual(seo.canonicalUrl('https://openvibe.blog/', '/alex/posts/bread/?utm_source=x&page=2#top', { query: ['page'] }), 'https://openvibe.blog/alex/posts/bread?page=2');
    assert.strictEqual(seo.canonicalUrl('https://openvibe.blog', '/'), 'https://openvibe.blog/');
    assert.throws(() => seo.canonicalUrl('https://openvibe.blog', 'https://evil.test/x'), /origin/);
    assert.throws(() => seo.canonicalUrl('ftp://x'), /http/);
});

test('history-aware redirects: every old slug 301s straight to the current path; gone → 410', () => {
    const redirects = seo.createRedirectStore(openDb('seo'), { prefix: 'wiki_page', now: fakeClock() });
    const current = { pg_1: '/p/rye' };
    const currentPath = (id) => current[id] || null;
    redirects.recordMove('pg_1', '/p/ryegrass', '/p/rye-grain');
    redirects.recordMove('pg_1', '/p/rye-grain', '/p/rye');
    assert.deepStrictEqual(redirects.resolve('/p/ryegrass', { currentPath }), { status: 301, location: '/p/rye', entityId: 'pg_1' });
    assert.deepStrictEqual(redirects.resolve('/p/rye-grain/?x=1', { currentPath }), { status: 301, location: '/p/rye', entityId: 'pg_1' });
    assert.strictEqual(redirects.resolve('/p/rye', { currentPath }), null);
    assert.strictEqual(redirects.resolve('/p/unknown', { currentPath }), null);
    // renamed back to an old slug: that slug is live again and must not redirect
    redirects.recordMove('pg_1', '/p/rye', '/p/ryegrass');
    current.pg_1 = '/p/ryegrass';
    assert.strictEqual(redirects.resolve('/p/ryegrass', { currentPath }), null);
    assert.deepStrictEqual(redirects.resolve('/p/rye', { currentPath }).location, '/p/ryegrass');
    assert.deepStrictEqual(redirects.history('pg_1').map((h) => h.path).sort(), ['/p/rye', '/p/rye-grain']);
    delete current.pg_1;
    assert.deepStrictEqual(redirects.resolve('/p/rye', { currentPath }), { status: 410, entityId: 'pg_1' });
    assert.strictEqual(redirects.table, 'wiki_page_redirects');
    assert.throws(() => redirects.recordMove('pg_1', 'no-slash', '/x'), /start with/);
});

// ---- meta tags ---------------------------------------------------------------------------------

test('meta tags take robots and canonical from the decision, and refuse to render without one', () => {
    const ok = seo.evaluate(base());
    const html = seo.metaTags({ title: 'Rye', description: 'A grass.', decision: ok });
    assert.match(html, /<meta name="robots" content="index, follow">/);
    assert.match(html, /<link rel="canonical" href="https:\/\/openvibe.wiki\/p\/rye">/);
    const dup = seo.evaluate(base({ duplicateOf: 'https://openvibe.wiki/p/original' }));
    assert.match(seo.metaTags({ title: 'Rye', decision: dup }), /rel="canonical" href="https:\/\/openvibe.wiki\/p\/original"/);
    assert.match(seo.metaTags({ title: 'x', decision: seo.evaluate(base({ visibility: 'private' })) }), /content="noindex, nofollow"/);
    assert.throws(() => seo.metaTags({ title: 'Rye' }), /decision/);
    assert.strictEqual(seo.robotsMeta(dup), '<meta name="robots" content="noindex, follow">');
    assert.strictEqual(seo.xRobotsTag(ok), 'index, follow');
});

// ---- sitemaps ----------------------------------------------------------------------------------

test('sitemaps contain only indexable URLs and never invent lastmod', () => {
    const entries = [
        { loc: 'https://openvibe.wiki/p/a', lastmod: '2026-09-20T08:00:00Z', decision: seo.evaluate(base({ canonicalUrl: 'https://openvibe.wiki/p/a' })) },
        { loc: 'https://openvibe.wiki/p/b', decision: seo.evaluate(base({ canonicalUrl: 'https://openvibe.wiki/p/b' })) },
        { loc: 'https://openvibe.wiki/p/draft', lastmod: '2026-09-21', decision: seo.evaluate(base({ state: 'draft' })) },
        { loc: 'https://openvibe.wiki/p/private', decision: seo.evaluate(base({ visibility: 'private' })) },
        { loc: 'https://openvibe.wiki/p/thin', decision: seo.evaluate(base({ text: 'short' })) },
    ];
    const out = seo.sitemap(entries);
    assert.strictEqual(out.count, 2);
    assert.strictEqual(out.files.length, 1);
    assert.match(out.files[0], /<loc>https:\/\/openvibe.wiki\/p\/a<\/loc><lastmod>2026-09-20<\/lastmod>/);
    assert.match(out.files[0], /<loc>https:\/\/openvibe.wiki\/p\/b<\/loc><\/url>/, 'no lastmod for b');
    assert.doesNotMatch(out.files[0], /draft|private|thin/);
    assert.deepStrictEqual(out.skipped.map((s) => s.codes), [['draft'], ['private'], ['thin']]);
    assert.throws(() => seo.sitemap([{ loc: 'https://x.test/' }]), /decision/);
    const many = Array.from({ length: 5 }, (_, i) => ({ loc: `https://x.test/${i}`, decision: seo.evaluate(base({ canonicalUrl: `https://x.test/${i}` })) }));
    assert.strictEqual(seo.sitemap(many, { maxUrls: 2 }).files.length, 3);
    assert.match(seo.sitemapIndex([{ loc: 'https://x.test/sitemap-1.xml' }]), /<sitemapindex/);
    assert.match(seo.robotsTxt({ sitemaps: ['https://x.test/sitemap.xml'] }), /Sitemap: https:\/\/x.test\/sitemap.xml/);
});

// ---- feeds -------------------------------------------------------------------------------------

function feedFixture() {
    const ok = seo.evaluate(base());
    const thin = seo.evaluate(base({ text: 'short' }));
    return [
        { id: 'tag:openvibe.blog,2026:post/1', url: 'https://openvibe.blog/a/1', title: 'Rye <bread> & co', summary: 'About rye', contentHtml: '<p>Rye</p>', published: '2026-09-20T08:00:00Z', updated: '2026-09-21T08:00:00Z', authors: [{ name: 'Alex', url: 'https://openvibe.blog/a' }], tags: ['bread'], decision: ok },
        { id: 'post-2', url: 'https://openvibe.blog/a/2', title: 'Undated and authorless', decision: thin },
        { id: 'post-3', url: 'https://openvibe.blog/a/3', title: 'Private', published: '2026-09-19T08:00:00Z', decision: seo.evaluate(base({ visibility: 'private' })) },
        { id: 'post-4', url: 'https://openvibe.blog/a/4', title: 'VIP', published: '2026-09-19T08:00:00Z', decision: seo.evaluate(base({ visibility: 'gated' })) },
    ];
}
const channel = { title: 'Alex bakes', link: 'https://openvibe.blog/a', feedUrl: 'https://openvibe.blog/a/feed.xml', description: 'Bread notes' };

test('RSS: only listable items; no invented pubDate or author; XML escaped', () => {
    const xml = seo.rssFeed(channel, feedFixture());
    assert.match(xml, /<title>Rye &lt;bread&gt; &amp; co<\/title>/);
    assert.match(xml, /<pubDate>Sun, 20 Sep 2026 08:00:00 GMT<\/pubDate>/);
    assert.match(xml, /<dc:creator>Alex<\/dc:creator>/);
    assert.strictEqual((xml.match(/<item>/g) || []).length, 2, 'the thin post is listable, private and VIP are not');
    assert.doesNotMatch(xml, /Private|VIP/);
    const item2 = xml.split('<item>')[2];
    assert.doesNotMatch(item2, /pubDate|dc:creator/);
    assert.doesNotMatch(xml, /lastBuildDate/, 'no channel date unless provided');
    assert.throws(() => seo.rssFeed({ title: 'x', link: 'https://x.test' }, []), /description/);
});

test('Atom: undated entries are left out instead of dated "now"; feed updated = newest entry', () => {
    const xml = seo.atomFeed(channel, feedFixture());
    assert.strictEqual((xml.match(/<entry>/g) || []).length, 1);
    assert.match(xml, /<updated>2026-09-21T08:00:00.000Z<\/updated>/);
    assert.match(xml, /<id>tag:openvibe.blog,2026:post\/1<\/id>/);
    assert.doesNotMatch(xml, /Undated/);
    assert.throws(() => seo.atomFeed(channel, [feedFixture()[1]]), /needs channel.updated/);
    assert.match(seo.atomFeed({ ...channel, updated: '2026-09-22T00:00:00Z' }, [feedFixture()[1]]), /<feed/);
});

test('JSON Feed 1.1: only provided fields', () => {
    const f = seo.jsonFeed(channel, feedFixture());
    assert.strictEqual(f.version, 'https://jsonfeed.org/version/1.1');
    assert.strictEqual(f.items.length, 2);
    assert.deepStrictEqual(Object.keys(f.items[1]).sort(), ['content_text', 'id', 'title', 'url']);
    assert.strictEqual(f.items[0].date_published, '2026-09-20T08:00:00.000Z');
    assert.deepStrictEqual(f.items[0].authors, [{ name: 'Alex', url: 'https://openvibe.blog/a' }]);
    assert.throws(() => seo.jsonFeed(channel, [{ id: 'x', url: 'https://x.test' }]), /decision/);
    assert.match(seo.feedLinks([{ type: 'atom', href: '/feed.atom', title: 'Atom' }]), /application\/atom\+xml/);
});

// ---- structured data ---------------------------------------------------------------------------

/** Every leaf in the output must come from the input (or be a schema.org constant). */
function leaves(obj, out = [], key = null) {
    if (obj == null) return out;
    if (Array.isArray(obj)) { for (const x of obj) leaves(x, out, key); return out; }
    if (typeof obj === 'object') { for (const [k, v] of Object.entries(obj)) leaves(v, out, k); return out; }
    out.push({ key, value: obj });
    return out;
}
function assertOnlyFrom(output, input, allowed = []) {
    const inputs = new Set(leaves(input).map((l) => String(l.value)));
    for (const l of leaves(output)) {
        if (['@context', '@type', '@id'].includes(l.key)) continue;
        if (allowed.includes(String(l.value))) continue;
        assert.ok(inputs.has(String(l.value)) || inputs.has(new Date(l.value).toISOString()) || [...inputs].some((v) => !Number.isNaN(Date.parse(v)) && Date.parse(v) === Date.parse(l.value)),
            `invented value ${l.key}=${JSON.stringify(l.value)}`);
    }
}
function hasKey(obj, name) { return JSON.stringify(obj).includes(`"${name}"`); }

test('article: a missing author or date is omitted, never defaulted', () => {
    const input = { type: 'BlogPosting', headline: 'Rye', url: 'https://openvibe.blog/a/1' };
    const ld = seo.structuredData.article(input);
    assert.deepStrictEqual(ld, { '@context': 'https://schema.org', '@type': 'BlogPosting', '@id': 'https://openvibe.blog/a/1#article', headline: 'Rye', url: 'https://openvibe.blog/a/1', mainEntityOfPage: 'https://openvibe.blog/a/1' });
    for (const k of ['author', 'datePublished', 'dateModified', 'publisher', 'image', 'citation']) assert.ok(!hasKey(ld, k), `${k} must be absent`);
    const full = { type: 'NewsArticle', headline: 'Rye', url: 'https://openvibe.news/s/1', datePublished: '2026-09-20T08:00:00Z', authors: [{ name: 'Sam' }, { name: '' }],
        publisher: { name: 'OpenVibe News' }, citations: [{ url: 'https://example.org/src', title: 'Source' }, { title: 'no url' }] };
    const ld2 = seo.structuredData.article(full);
    assert.deepStrictEqual(ld2.author, [{ '@type': 'Person', name: 'Sam' }], 'nameless author dropped');
    assert.deepStrictEqual(ld2.citation, [{ '@type': 'CreativeWork', url: 'https://example.org/src', name: 'Source' }]);
    assertOnlyFrom(ld2, full);
    assert.strictEqual(seo.structuredData.article({ url: 'https://x.test' }), null, 'no headline → no Article');
});

test('review: no rating, no reviewRating; no bestRating default', () => {
    const input = { itemReviewed: { type: 'Product', name: 'Bread knife' }, author: { name: 'Sam' }, body: 'Sharp.' };
    const ld = seo.structuredData.review(input);
    assert.ok(!hasKey(ld, 'reviewRating'));
    assert.ok(!hasKey(ld, 'ratingValue'));
    assert.ok(!hasKey(ld, 'datePublished'));
    const rated = seo.structuredData.review({ ...input, rating: { value: 4 } });
    assert.deepStrictEqual(rated.reviewRating, { '@type': 'Rating', ratingValue: 4 }, 'bestRating not assumed to be 5');
    assertOnlyFrom(rated, { ...input, rating: { value: 4 } });
    assert.strictEqual(seo.structuredData.review({ body: 'x' }), null);
});

test('aggregate ratings need a value AND a real count; otherwise nothing', () => {
    assert.strictEqual(seo.structuredData.ratedThing({ name: 'Cafe', aggregateRating: { value: 4.5 } }).aggregateRating, undefined);
    assert.strictEqual(seo.structuredData.ratedThing({ name: 'Cafe', aggregateRating: { value: 4.5, count: 0 } }).aggregateRating, undefined);
    assert.strictEqual(seo.structuredData.ratedThing({ name: 'Cafe', aggregateRating: { count: 12 } }).aggregateRating, undefined);
    const ok = seo.structuredData.ratedThing({ type: 'LocalBusiness', name: 'Cafe', aggregateRating: { value: 4.5, count: 12, best: 5 } });
    assert.deepStrictEqual(ok.aggregateRating, { '@type': 'AggregateRating', ratingValue: 4.5, ratingCount: 12, bestRating: 5 });
});

test('product: no price or currency → no Offer; no availability → none assumed', () => {
    const noPrice = seo.structuredData.product({ name: 'Rye flour', offers: [{ priceCurrency: 'EUR', availability: 'in_stock' }, { price: 3.2 }] });
    assert.ok(!hasKey(noPrice, 'offers'));
    assert.ok(!hasKey(noPrice, 'price'));
    assert.ok(!hasKey(noPrice, 'aggregateRating'));
    const input = { name: 'Rye flour', url: 'https://openvibe.deals/o/1', offers: [{ price: '3.20', priceCurrency: 'EUR', url: 'https://shop.example/rye' }] };
    const priced = seo.structuredData.product(input);
    assert.deepStrictEqual(priced.offers, [{ '@type': 'Offer', price: 3.2, priceCurrency: 'EUR', url: 'https://shop.example/rye' }]);
    assert.ok(!hasKey(priced, 'availability'), 'availability never assumed');
    assertOnlyFrom(priced, input, ['3.2']);
    const avail = seo.structuredData.product({ name: 'x', offers: [{ price: 1, priceCurrency: 'USD', availability: 'out_of_stock' }] });
    assert.strictEqual(avail.offers[0].availability, 'https://schema.org/OutOfStock');
    assert.ok(!hasKey(seo.structuredData.product({ name: 'x', offers: [{ price: 1, priceCurrency: 'USD', availability: 'probably' }] }), 'availability'));
});

test('breadcrumbs, webPage and the JSON-LD script tag', () => {
    const bc = seo.structuredData.breadcrumbs([{ name: 'Food', url: 'https://w.test/food' }, { name: 'Rye' }]);
    assert.deepStrictEqual(bc.itemListElement[1], { '@type': 'ListItem', position: 2, name: 'Rye' });
    assert.strictEqual(seo.structuredData.webPage({ url: 'https://w.test/' })['@type'], 'WebPage');
    const tag = seo.jsonLdScript(seo.structuredData.article({ headline: '</script><script>alert(1)</script>', url: 'https://w.test/' }));
    assert.doesNotMatch(tag, /<\/script><script>/);
    assert.strictEqual(seo.jsonLdScript(null), '');
    assert.deepStrictEqual(seo.compact({ a: '', b: [null, { '@type': 'X' }], c: NaN, d: 0, e: false }), { d: 0, e: false });
});

run();
