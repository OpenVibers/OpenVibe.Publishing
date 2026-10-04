'use strict';
const assert = require('assert');
const { renderDocument } = require('../lib/layout');
const { suite } = require('./helpers/db');

const { test, run } = suite();

const decision = { indexable: false, robots: 'noindex, follow', canonical: 'https://openvibe.news/a/original', codes: ['duplicate'] };
const doc = (extra = {}) => ({
    site: 'news', siteName: 'OpenVibe.News', title: 'A story · OpenVibe.News', description: 'What happened.',
    canonical: 'https://openvibe.news/a/story', type: 'article', decision,
    published: '2026-10-01T08:00:00Z', modified: '2026-10-02T09:00:00Z', prev: '/a/older',
    jsonLd: [{ '@context': 'https://schema.org', '@type': 'NewsArticle', headline: 'A story' }, null],
    feeds: [{ type: 'rss', href: '/feed.xml', title: 'OpenVibe.News' }],
    navbar: { service: 'news', links: [{ label: 'News', href: '/' }] },
    footer: { service: 'news', variant: 'full', mount: '#ov-footer', brandName: 'OpenVibe.News' },
    navLinks: [{ label: 'News', href: '/' }, { label: 'Topics', href: '/topics' }],
    css: '/css/news.css?v=abc', styles: ['showcase.css'], release: 'r42', referrer: 'strict-origin-when-cross-origin',
    account: '<a href="/auth/login">Sign in with OpenVibe</a>', body: '<h1>A story</h1>',
    ...extra,
});
const count = (s, re) => (s.match(re) || []).length;

test('renderDocument composes one whole document through openvibe-shared/shell', () => {
    const out = renderDocument(doc());
    assert.match(out, /^<!doctype html>\n<html lang="en">/);
    assert.strictEqual(count(out, /<title>/g), 1);
    assert.match(out, /<title>A story · OpenVibe\.News<\/title>/);
    assert.strictEqual(count(out, /<script type="application\/ld\+json">/g), 1);
    assert.match(out, /<link rel="alternate" type="application\/rss\+xml" href="\/feed\.xml" title="OpenVibe\.News">/);
    assert.match(out, /<meta property="article:published_time" content="2026-10-01T08:00:00Z">/);
    assert.match(out, /<meta property="article:modified_time" content="2026-10-02T09:00:00Z">/);
    assert.match(out, /<link rel="prev" href="https:\/\/openvibe\.news\/a\/older">/);
    assert.ok(out.includes(require('openvibe-shared/app-icon').headTags({ site: 'news' })), 'app-icon head tags');
    assert.match(out, /<link rel="stylesheet" href="\/css\/news\.css\?v=abc">/);
    assert.match(out, /<link rel="stylesheet" href="\/shared\/showcase\.css\?v=/);
    for (const f of ['theme-loader.js', 'web-runtime.js', 'navbar.js', 'footer.js', 'boost.js']) {
        assert.match(out, new RegExp(`<script src="/shared/${f.replace('.', '\\.')}\\?v=`), f);
    }
    assert.match(out, /<meta name="ov-boost" content="news@r42">/);
    assert.match(out, /<meta name="referrer" content="strict-origin-when-cross-origin">/);
    assert.match(out, /OpenVibeNavbar\.init\(/);
    assert.match(out, /OpenVibeFooter\.init\(window\.__OV_PAGE\.footer\)/);
    assert.match(out, /window\.__OV_PAGE = \{"navbar":\{"service":"news"/);
    assert.match(out, /<a class="skip" href="#main">Skip to content<\/a>\n<div id="navbar-mount"><\/div>/);
    assert.match(out, /<noscript><div class="account-bar"[^>]*><a href="\/auth\/login">Sign in with OpenVibe<\/a><\/div><\/noscript>/);
    assert.match(out, /<main id="main" class="page">\n<h1>A story<\/h1>\n<\/main>/);
    assert.match(out, /<noscript><nav aria-label="Site"[^>]*><a href="\/"[^>]*>OpenVibe\.News<\/a><a href="\/">News<\/a><a href="\/topics">Topics<\/a>/);
});

test('robots always comes from the decision, and a decision canonical wins over o.canonical', () => {
    const out = renderDocument(doc());
    assert.match(out, /<meta name="robots" content="noindex, follow">/);
    assert.match(out, /<link rel="canonical" href="https:\/\/openvibe\.news\/a\/original">/);
    assert.doesNotMatch(out, /a\/story"/);
    const own = renderDocument(doc({ decision: { robots: 'index, follow' } }));
    assert.match(own, /<link rel="canonical" href="https:\/\/openvibe\.news\/a\/story">/);
    assert.match(own, /<meta name="robots" content="index, follow">/);
    const explicit = renderDocument(doc({ decision: undefined, robots: 'noindex, nofollow' }));
    assert.match(explicit, /<meta name="robots" content="noindex, nofollow">/);
    assert.match(explicit, /<link rel="canonical" href="https:\/\/openvibe\.news\/a\/story">/);
});

test('renderDocument needs the gate decision (or explicit robots)', () => {
    assert.throws(() => renderDocument({}), (e) => e instanceof TypeError && /gate decision/.test(e.message));
    assert.throws(() => renderDocument(), TypeError);
});

test('values reaching markup are escaped, and the JSON boot cannot close its <script>', () => {
    const out = renderDocument(doc({
        published: '"><script>x</script>', css: '/x.css"onload="y', release: '<r>',
        navbar: { service: 'news', history: { title: '</script><script>alert(1)</script>' } },
    }));
    assert.doesNotMatch(out, /<script>x<\/script>/);
    assert.match(out, /href="\/x\.css&quot;onload=&quot;y"/);
    assert.match(out, /content="news@&lt;r&gt;"/);
    assert.doesNotMatch(out, /<\/script><script>alert/);
    assert.match(out, /\\u003c\/script>\\u003cscript>alert/);
});

test('no release, referrer, css or account: those extras are left out', () => {
    const out = renderDocument({ site: 'blog', siteName: 'OpenVibe.Blog', robots: 'index, follow', canonical: 'https://openvibe.blog/', body: '<p>hi</p>' });
    assert.doesNotMatch(out, /ov-boost|boost\.js|name="referrer"|account-bar|article:published_time|rel="prev"/);
    assert.match(out, /<title>OpenVibe\.Blog<\/title>/);
    assert.match(out, /window\.__OV_PAGE = \{"navbar":\{"service":"blog"\},"footer":\{"service":"blog","variant":"compact"\}\}/);
});

test('summary reaches the shell, so the page carries the ai-summary meta, the facts block and the url', () => {
    const out = renderDocument(doc({
        summary: 'A story, in one line.', facts: [['Rating', '4/5'], ['Published', '2026-10-01']],
        updated: '2026-10-02T09:00:00Z',
    }));
    assert.match(out, /<meta name="ai-summary" content="A story, in one line\.">/);
    assert.match(out, /<noscript><section data-ai-summary><h2>A story · OpenVibe\.News<\/h2><p>A story, in one line\.<\/p><ul><li>Rating: 4\/5<\/li><li>Published: 2026-10-01<\/li><\/ul><\/section><\/noscript>/);
    assert.match(out, /"dateModified":"2026-10-02T09:00:00\.000Z"/);
    assert.match(out, /"url":"https:\/\/openvibe\.news\/a\/original"/);
});

test('without a summary no ai-summary meta, facts block or WebPage tag is invented', () => {
    const out = renderDocument(doc());
    assert.doesNotMatch(out, /ai-summary|data-ai-summary|"@type":"WebPage"/);
});

test('url defaults to the canonical, so an explicit url wins', () => {
    const own = renderDocument(doc({ summary: 'S', url: 'https://openvibe.news/a/explicit' }));
    assert.match(own, /"url":"https:\/\/openvibe\.news\/a\/explicit"/);
    assert.doesNotMatch(own, /"url":"https:\/\/openvibe\.news\/a\/original"/);
});

run();
