'use strict';
/**
 * openvibe-publishing/layout — the page document every publication site (Wiki, Blog, News, Reviews,
 * Deals, Coupons, Trade) renders, composed by openvibe-shared/shell page().
 *
 *   const layout = require('openvibe-publishing/layout');
 *   res.type('html').send(layout.renderDocument({
 *       site: 'news', siteName: 'OpenVibe.News', title: `${o.title} · OpenVibe.News`,
 *       decision, canonical, jsonLd, feeds, navbar, footer, navLinks, css, release, body,
 *   }));
 *
 * The gate's decision is the robots source: there is no default that makes a page indexable, so a
 * document needs a decision (or, for a page the gate never sees, an explicit robots string). The
 * canonical is the decision's (the original, for a duplicate) when it has one.
 *
 * The shell writes the SEO head, the theme-loader, the deferred web runtime, navbar and footer
 * scripts, the noscript navigation and the server-rendered footer, and boots the navbar. This adds
 * the publication extras (article times, prev/next, feeds, the app icon, stylesheets, the boost
 * marker) and the body frame, and initialises the footer, which the shell never does.
 *
 * Every value that reaches markup is escaped; css, scripts, head, header, account, body and shipped
 * are trusted markup the caller already built.
 */
const shell = require('openvibe-shared/shell');
const serve = require('openvibe-shared/serve');
const appIcon = require('openvibe-shared/app-icon');
const sharedSeo = require('openvibe-shared/seo');
const { feedLinks } = require('./seo');
const { escapeHtml: esc } = require('./ssr');

/** JSON that is safe inside a <script>: `<` is escaped so nothing can close the element. */
function json(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * o: site (service id, e.g. 'news'), service (defaults to site), siteName ('OpenVibe.News'), lang,
 *    title (composed by the caller), description, canonical (absolute), type, image, imageAlt,
 *    author, keywords, locale, twitterSite, jsonLd [], prev, next, published, modified,
 *    decision (or robots), feeds [{ type, href, title }], navbar, footer, navLinks, home,
 *    css (stylesheet href), styles [openvibe-shared/serve names], scripts [<script> HTML],
 *    referrer, release, head (extra head HTML), iconSite, skipLabel, account (noscript account-bar
 *    HTML), header (HTML after #navbar-mount), body (main HTML), mainId ('main'), mainClass ('page'),
 *    bodyClass, shipped (frame.shipped HTML)
 */
function renderDocument(o = {}) {
    if (!o.decision && !o.robots) throw new TypeError('renderDocument needs the gate decision (or explicit robots)');
    const robots = o.decision ? o.decision.robots : o.robots;
    const canonical = o.decision ? (o.decision.canonical || o.canonical) : o.canonical;
    const site = o.site;
    const service = o.service || site;
    const navbar = { service, ...(o.navbar || {}) };
    const footer = o.footer || { service, variant: 'compact' };
    const mainId = o.mainId || 'main';
    const mainClass = o.mainClass == null ? 'page' : o.mainClass;

    const head = [
        o.published ? `<meta property="article:published_time" content="${esc(o.published)}">` : '',
        o.modified ? `<meta property="article:modified_time" content="${esc(o.modified)}">` : '',
        o.prev ? `<link rel="prev" href="${esc(sharedSeo.absolute(o.prev, canonical))}">` : '',
        o.next ? `<link rel="next" href="${esc(sharedSeo.absolute(o.next, canonical))}">` : '',
        feedLinks(o.feeds || []),
        appIcon.headTags({ site: o.iconSite || site }),
        o.css ? `<link rel="stylesheet" href="${esc(o.css)}">` : '',
        ...(o.styles || []).map((name) => `<link rel="stylesheet" href="${esc(serve.url(name))}">`),
        ...(o.scripts || []),
        o.release ? `<meta name="ov-boost" content="${esc(`${site}@${o.release}`)}">` : '',
        o.release ? `<script src="${esc(serve.url('boost.js'))}" data-main="#${esc(mainId)}" defer></script>` : '',
        o.referrer ? `<meta name="referrer" content="${esc(o.referrer)}">` : '',
        o.head || '',
    ].filter(Boolean).join('\n');

    const body = [
        `<a class="skip" href="#${esc(mainId)}">${esc(o.skipLabel || 'Skip to content')}</a>`,
        '<div id="navbar-mount"></div>',
        o.header || '',
        o.account ? `<noscript><div class="account-bar" role="navigation" aria-label="Account">${o.account}</div></noscript>` : '',
        `<main id="${esc(mainId)}"${mainClass ? ` class="${esc(mainClass)}"` : ''}>`,
        o.body || '',
        o.shipped || '',
        '</main>',
        `<script>
window.__OV_PAGE = ${json({ navbar, footer })};
document.addEventListener('DOMContentLoaded', function () {
  try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* the Frame is optional */ }
});
</script>`,
    ].filter(Boolean).join('\n');

    return shell.page({
        // shell's `name` is the noscript-nav brand (and drops this site from the network links), so it
        // gets the display name; the service id reaches the navbar and the footer through their configs.
        name: o.siteName || site,
        service,
        lang: o.lang || 'en',
        title: o.title || o.siteName || site,
        siteName: o.siteName || site,
        description: o.description,
        canonical,
        robots,
        type: o.type || 'website',
        image: o.image || undefined,
        imageAlt: o.imageAlt || undefined,
        author: o.author || undefined,
        keywords: o.keywords || undefined,
        locale: o.locale || undefined,
        twitterSite: o.twitterSite || undefined,
        jsonLd: (o.jsonLd || []).filter(Boolean),
        navLinks: o.navLinks || [],
        home: o.home || '/',
        navbar,
        footer,
        body,
        bodyClass: o.bodyClass || undefined,
        head,
    });
}

module.exports = { renderDocument };
