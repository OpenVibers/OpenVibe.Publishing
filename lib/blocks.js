'use strict';
/**
 * openvibe-publishing/blocks — the rich block model shared by OpenVibe.Blog and OpenVibe.Wiki.
 *
 *   const blocks = require('openvibe-publishing/blocks');
 *   const tree = blocks.parse(markdown);       // → { type: 'root', children: [...] }
 *   const check = blocks.validate(tree);       // → { ok, errors: [{ path, message }] }
 *   const html = blocks.render(tree, { ... }); // → server-rendered HTML, complete without script
 *   const text = blocks.toText(tree);          // → plain text for feeds, search and AI readers
 *
 * A BODY IS MARKDOWN PLUS BLOCKS. The Markdown stays the source of truth: revisions diff it, and an
 * editor that does not know a block still shows its text (toText). A block is a fenced directive:
 *
 *   :::hero{art="med_..." kicker="Devblog" date="2026-11-09"}
 *   The teaser goes here.
 *   :::
 *
 *   :::section{id="blueprint-rework" by="usr_..." react}
 *   ## Blueprint rework
 *   The prose, and the blocks inside it.
 *   :::figure{src="med_..." alt="The channel header"}
 *   :::
 *   :::
 *
 * Rules:
 *   - A block opens with :::name{attr="value"} and closes with ::: . A block with no body may be
 *     written on one line: :::figure{src="med_..."}: the second ::: closes it.
 *   - ":::" is reserved. Write a backslash before it in prose for a literal one.
 *   - Attributes: key="value", key='value', key=bare (true), key=bare-word (the word).
 *   - A block name is [a-z][a-z0-9_]*.
 *   - Blocks nest: a section holds prose and other blocks.
 *
 * The renderer is server-side and complete without JavaScript. Every block has a plain-HTML form: a
 * section's reactions are a <form> that posts, the patch notes are a <details> a crawler reads, and
 * images are <img> with width, height, alt and loading="lazy" after the first one.
 *
 * Images are Media object ids (med_...). The renderer never guesses a URL: the caller resolves the
 * id and the credit line comes from what Media knows — an AI image says "Made with <model>", an
 * Openverse or Commons image keeps its licence and its author.
 */

const { escapeHtml: esc, renderMarkdown, markdownToText } = require('./ssr');

/** The blocks this model knows. A leaf block takes no body. */
const TYPES = Object.freeze({
    hero: { leaf: false, requires: [] },
    section: { leaf: false, requires: [] },
    figure: { leaf: true, requires: ['src'] },
    compare: { leaf: true, requires: ['before', 'after'] },
    gallery: { leaf: true, requires: ['items'] },
    clip: { leaf: true, requires: ['id'] },
    pic: { leaf: true, requires: ['id'] },
    video: { leaf: true, requires: ['id'] },
    embed: { leaf: true, requires: ['url'] },
    callout: { leaf: false, requires: ['tone'] },
    stat: { leaf: true, requires: ['value', 'label'] },
    patchnotes: { leaf: true, requires: [] },
    infobox: { leaf: false, requires: [] },
    timeline: { leaf: false, requires: [] },
    quote: { leaf: false, requires: [] },
});

const TYPE_NAMES = Object.freeze(Object.keys(TYPES));
const CALLOUT_TONES = Object.freeze(['info', 'warn', 'tip']);
const MEDIA_ID_RE = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;
const CLIP_ID_RE = /^(clp|vod)_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUBJECT_RE = /^(usr|gst)_[0-9A-HJKMNP-TV-Z]{26}$/;
const SAFE_URL_RE = /^https?:\/\//i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** { key: "value" }, { key: 'value' }, { key: bare } (true), { key=bare } (the bare word). */
function parseAttrs(source) {
    const attrs = {};
    const text = String(source == null ? '' : source);
    const re = /([a-z][a-z0-9_-]*)(?:=(?:"([^"]*)"|'([^']*)'|([^\s}]*)))?/g;
    let m;
    while ((m = re.exec(text))) {
        const value = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : true));
        attrs[m[1]] = value;
    }
    return attrs;
}

/** The attribute text of a directive: the inside of its braces. */
function attrsOf(directive) {
    const i = directive.indexOf('{');
    const j = directive.lastIndexOf('}');
    return (i === -1 || j <= i) ? '' : directive.slice(i + 1, j);
}

/**
 * The lines of a body, with the ::: inside a fenced code block hidden from the directive scanner.
 * The hidden marker is put back when the text is read, so a code sample still reads as written.
 */
const HIDDEN = '\u0000';
function maskedLines(source) {
    const lines = String(source == null ? '' : source).split('\n');
    const fence = /^( {0,3})(\x60{3,}|~{3,})/;
    let open = null;
    return lines.map((line) => {
        const m = line.match(fence);
        if (open) {
            if (m && m[2][0] === open[0] && m[2].length >= open.length) { open = null; return line.replace(/:::/g, HIDDEN); }
            return line.replace(/:::/g, HIDDEN);    // inside a code block: never a directive
        }
        if (m) { open = m[2]; return line.replace(/:::/g, HIDDEN); }
        return line;
    });
}

/** The hidden markers back in the text. */
function unhide(value) {
    return String(value == null ? '' : value).split(HIDDEN).join(':::');
}

const DIRECTIVE_RE = /:::+\s*([a-z][a-z0-9_]*)?\s*(\{[^{}]*\})?/g;

/**
 * Markdown plus blocks → a tree. The tree is plain JSON, so the API hands it out as it is:
 *   { type: 'root', children: [ { type: 'section', attrs: {}, children: [ ... ] } ] }
 * A run of prose between blocks is { type: 'text', value: 'markdown' }.
 */
function parse(source) {
    const lines = maskedLines(source);
    const root = { type: 'root', children: [] };
    const stack = [root];
    let text = [];

    const flush = () => {
        if (!text.length) return;
        const value = text.join('\n');
        text = [];
        if (value.trim()) stack[stack.length - 1].children.push({ type: 'text', value: unhide(value) });
    };

    for (const line of lines) {
        if (line === null) { text.push(''); continue; }
        let cursor = 0;
        let matched = false;
        DIRECTIVE_RE.lastIndex = 0;
        let m;
        while ((m = DIRECTIVE_RE.exec(line))) {
            matched = true;
            const before = line.slice(cursor, m.index);
            if (before.trim()) { flush(); text.push(before); flush(); }
            cursor = m.index + m[0].length;
            const name = m[1];
            if (!name) {
                flush();
                if (stack.length > 1) stack.pop();      // a closing ::: ends the open block
                continue;
            }
            flush();
            const node = { type: name, attrs: parseAttrs(attrsOf(m[2] || '')), children: [] };
            stack[stack.length - 1].children.push(node);
            stack.push(node);
        }
        const tail = line.slice(cursor);
        if (!matched || tail.trim() || tail.length) text.push(tail);
    }
    flush();
    return root;
}

/** Every node of the tree, depth first. */
function walk(node, visit) {
    visit(node);
    for (const child of node.children || []) walk(child, visit);
}

/** A comma or space separated list of ids. */
function listOf(value) {
    if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
    if (value == null || value === true) return [];
    return String(value).split(/[\s,]+/).map((v) => v.trim()).filter(Boolean);
}

/** The problems in a tree: { ok, errors: [{ path, message }] }. */
function validate(tree) {
    const errors = [];
    const seenIds = new Set();
    const at = (path, message) => errors.push({ path, message });

    walk(tree, (node) => {
        if (node.type === 'root' || node.type === 'text') return;
        const def = TYPES[node.type];
        const path = node.type;
        if (!def) { at(path, 'unknown block type "' + node.type + '"'); return; }
        const a = node.attrs || {};
        for (const key of def.requires) {
            const v = a[key];
            if (v === undefined || v === null || v === '' || v === true) at(path, '"' + node.type + '" needs ' + key);
        }
        if (node.type === 'figure' && typeof a.src === 'string' && !MEDIA_ID_RE.test(a.src)) at(path, 'figure src must be a Media object id (med_...)');
        if (node.type === 'pic' && typeof a.id === 'string' && !MEDIA_ID_RE.test(a.id)) at(path, 'pic id must be a Media object id (med_...)');
        if ((node.type === 'clip' || node.type === 'video') && typeof a.id === 'string' && !CLIP_ID_RE.test(a.id)) at(path, node.type + ' id must be a clip or video id');
        if (node.type === 'embed' && typeof a.url === 'string' && !SAFE_URL_RE.test(a.url)) at(path, 'embed url must be http(s)');
        if (node.type === 'callout' && typeof a.tone === 'string' && !CALLOUT_TONES.includes(a.tone)) at(path, 'callout tone must be one of ' + CALLOUT_TONES.join(', '));
        if (node.type === 'hero' && typeof a.art === 'string' && !MEDIA_ID_RE.test(a.art)) at(path, 'hero art must be a Media object id (med_...)');
        if (node.type === 'section') {
            if (a.id !== undefined) {
                if (typeof a.id !== 'string' || !SLUG_RE.test(a.id)) at(path, 'section id must be a lowercase slug');
                else if (seenIds.has(a.id)) at(path, 'two sections share the id "' + a.id + '"');
                else seenIds.add(a.id);
            }
            if (a.by !== undefined && typeof a.by === 'string' && !SUBJECT_RE.test(a.by)) at(path, 'section by must be a subject id (usr_...)');
        }
        if (node.type === 'compare') {
            for (const key of ['before', 'after']) {
                if (typeof a[key] === 'string' && !MEDIA_ID_RE.test(a[key])) at(path, 'compare ' + key + ' must be a Media object id (med_...)');
            }
        }
        if (node.type === 'gallery') {
            const items = listOf(a.items);
            if (!items.length) at(path, 'gallery needs at least one Media object id');
            for (const id of items) if (!MEDIA_ID_RE.test(id)) at(path, 'gallery item "' + id + '" is not a Media object id (med_...)');
        }
        if (node.type === 'stat' && typeof a.value === 'string' && a.value.length > 40) at(path, 'stat value is too long');
        if (node.type === 'patchnotes') {
            for (const key of ['from', 'to']) {
                if (a[key] !== undefined && !DATE_RE.test(String(a[key]))) at(path, 'patchnotes ' + key + ' must be a date (YYYY-MM-DD)');
            }
        }
    });
    return { ok: errors.length === 0, errors };
}

/** The plain text of a tree: what a feed, a search document and an AI reader get. */
function toText(tree) {
    const parts = [];
    walk(tree, (node) => {
        if (node.type === 'text') { parts.push(markdownToText(unhide(node.value))); return; }
        const a = node.attrs || {};
        if (node.type === 'hero' && a.kicker) parts.push(String(a.kicker));
        else if (node.type === 'figure' && a.alt) parts.push(String(a.alt));
        else if ((node.type === 'compare' || node.type === 'gallery') && a.caption) parts.push(String(a.caption));
        else if (node.type === 'stat') parts.push(String(a.value) + ' ' + String(a.label));
        else if (node.type === 'callout' && a.title) parts.push(String(a.title));
        else if (node.type === 'patchnotes') parts.push('Patch notes');
    });
    return parts.filter((p) => p && p.trim()).join('\n');
}

module.exports = {
    TYPES, TYPE_NAMES, CALLOUT_TONES, MEDIA_ID_RE,
    parse, parseAttrs, validate, toText, walk, listOf,
};


// ---- render -----------------------------------------------------------------------------------

/**
 * The credit line of an image.
 *   { kind: 'ai', model: 'FLUX.1' }                       → "Made with FLUX.1"
 *   { kind: 'source', author: 'Jane', licence: 'CC BY 4.0' } → "Jane · CC BY 4.0" (the author links)
 *   { kind: 'text', text: 'Screenshot, openvibe.live' }    → the text as it is
 * Nothing known → no credit line: an empty credit is not a fake one.
 */
function creditLine(credit, { rel = 'noopener' } = {}) {
    if (!credit || typeof credit !== 'object') return '';
    if (credit.kind === 'ai') return credit.model ? 'Made with ' + String(credit.model) : 'Made with AI';
    if (credit.kind === 'source') {
        const parts = [];
        if (credit.author) {
            parts.push(credit.authorUrl
                ? '<a href="' + esc(credit.authorUrl) + '" rel="' + esc(rel) + '">' + esc(credit.author) + '</a>'
                : esc(credit.author));
        }
        if (credit.licence) {
            parts.push(credit.licenceUrl
                ? '<a href="' + esc(credit.licenceUrl) + '" rel="' + esc(rel) + '">' + esc(credit.licence) + '</a>'
                : esc(credit.licence));
        }
        return parts.join(' · ');
    }
    if (credit.kind === 'text' && credit.text) return esc(credit.text);
    return '';
}

/** The credit of one image: the block's own credit attribute wins, else what Media knows. */
function creditOf(node, media, opts) {
    const a = node.attrs || {};
    if (typeof a.credit === 'string' && a.credit) return { kind: 'text', text: a.credit };
    if (media && media.credit) return media.credit;
    return null;
}

/** The dimensions of an image: the block's own width/height, else what Media knows. */
function dimsOf(node, media) {
    const a = node.attrs || {};
    const w = Number.isInteger(a.width) ? a.width : (media && Number.isInteger(media.width) ? media.width : null);
    const h = Number.isInteger(a.height) ? a.height : (media && Number.isInteger(media.height) ? media.height : null);
    return { width: w, height: h };
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * The HTML of a tree.
 *
 *   render(tree, {
 *     media(mediaId)        → { width, height, alt, credit } | null   (what Media knows)
 *     urlFor(mediaId)       → the delivery URL (required for any image)
 *     person(subject)       → { name, url } | null                    (a section's byline)
 *     patchNotes(from, to)  → [{ site, commits: [{ sha, url, title }] }]  (the folded list)
 *     reactions             → { sectionId: { up, down } }             (the counts)
 *     reactionAction        → where the form posts (a section's reactions)
 *     csrf                  → the form's CSRF token
 *     signedIn              → a person may react
 *     loginUrl              → where a signed-out reader signs in
 *     rel                   → the link rel of editorial text
 *     headingShift          → how far the Markdown headings move (default 1)
 *   })
 */
function render(tree, opts = {}) {
    const options = opts || {};
    const rel = options.rel || 'nofollow ugc noopener';
    const shift = Number.isInteger(options.headingShift) ? options.headingShift : 1;
    let images = 0;

    const img = (node, mediaId, extraClass) => {
        const media = typeof options.media === 'function' ? options.media(mediaId) : null;
        if (!media || media.broken) {
            return '<figure class="ov-media ov-media-broken" data-media-id="' + esc(mediaId) + '" data-state="broken">'
                + '<div class="ov-media-missing" role="img" aria-label="This media is no longer available.">This media is no longer available.</div></figure>';
        }
        const url = typeof options.urlFor === 'function' ? options.urlFor(mediaId, media) : null;
        if (!url) {
            return '<figure class="ov-media ov-media-broken" data-media-id="' + esc(mediaId) + '" data-state="unresolved">'
                + '<div class="ov-media-missing" role="img" aria-label="This media is no longer available.">This media is no longer available.</div></figure>';
        }
        const a = node.attrs || {};
        const dims = dimsOf(node, media);
        const alt = typeof a.alt === 'string' && a.alt ? a.alt : (media.alt || '');
        const lazy = images > 0 ? ' loading="lazy"' : '';
        images++;
        const width = num(a.width) || dims.width;
        const height = num(a.height) || dims.height;
        return '<figure class="ov-media ' + esc(extraClass || '') + '" data-media-id="' + esc(mediaId) + '" data-state="available">'
            + '<img src="' + esc(url) + '" alt="' + esc(alt) + '"'
            + (width ? ' width="' + width + '"' : '') + (height ? ' height="' + height + '"' : '')
            + lazy + ' decoding="async">'
            + '</figure>';
    };

    const captionOf = (node, mediaId) => {
        const a = node.attrs || {};
        const media = typeof options.media === 'function' ? options.media(mediaId) : null;
        const caption = typeof a.caption === 'string' ? a.caption : (media && media.caption ? media.caption : null);
        const credit = creditOf(node, media, options);
        const creditHtml = creditLine(credit, { rel });
        if (!caption && !creditHtml) return '';
        return '<figcaption>' + (caption ? esc(caption) : '')
            + (caption && creditHtml ? ' ' : '')
            + (creditHtml ? '<span class="ov-media-credit">' + creditHtml + '</span>' : '')
            + '</figcaption>';
    };

    const figureOf = (node, mediaId, extraClass) => {
        const body = img(node, mediaId, extraClass);
        const caption = captionOf(node, mediaId);
        if (!caption) return body;
        return body.replace('</figure>', caption + '</figure>');
    };

    const reactionsForm = (sectionId) => {
        if (!sectionId) return '';
        const counts = (options.reactions && options.reactions[sectionId]) || { up: 0, down: 0 };
        const up = Number.isInteger(counts.up) ? counts.up : 0;
        const down = Number.isInteger(counts.down) ? counts.down : 0;
        const action = options.reactionAction || '';
        const signedIn = Boolean(options.signedIn);
        const csrf = options.csrf ? '<input type="hidden" name="_csrf" value="' + esc(options.csrf) + '">' : '';
        const buttons = '<button type="submit" name="reaction" value="up" class="ov-react ov-react-up"'
            + ' aria-label="This section is good">👍 <span class="ov-react-count">' + up + '</span></button>'
            + '<button type="submit" name="reaction" value="down" class="ov-react ov-react-down"'
            + ' aria-label="This section is not good">👎 <span class="ov-react-count">' + down + '</span></button>';
        if (!signedIn) {
            const login = options.loginUrl ? '/auth/login?next=' + encodeURIComponent(options.path || '') : '#';
            return '<div class="ov-reactions" data-section="' + esc(sectionId) + '">'
                + '<span class="ov-react-count">👍 ' + up + '</span>'
                + '<span class="ov-react-count">👎 ' + down + '</span>'
                + '<a class="ov-react-signin" href="' + esc(login) + '">Sign in to react</a></div>';
        }
        return '<form class="ov-reactions" method="post" action="' + esc(action) + '" data-section="' + esc(sectionId) + '">'
            + csrf
            + '<input type="hidden" name="section" value="' + esc(sectionId) + '">'
            + buttons
            + '</form>';
    };

    const bylineOf = (node) => {
        const a = node.attrs || {};
        if (!a.by) return '';
        const person = typeof options.person === 'function' ? options.person(a.by) : null;
        const name = person && person.name ? person.name : 'The OpenVibe team';
        if (person && person.url) return '<p class="ov-section-by">by <a href="' + esc(person.url) + '" rel="author">' + esc(name) + '</a></p>';
        return '<p class="ov-section-by">by ' + esc(name) + '</p>';
    };

    const patchNotesHtml = (node) => {
        const a = node.attrs || {};
        let groups = [];
        if (typeof options.patchNotes === 'function') {
            const got = options.patchNotes(a.from || null, a.to || null);
            if (Array.isArray(got)) groups = got;
        }
        const total = groups.reduce((n, g) => n + ((g.commits && g.commits.length) || 0), 0);
        const sites = groups.length;
        const label = total
            ? total + ' change' + (total === 1 ? '' : 's') + ' across ' + sites + ' site' + (sites === 1 ? '' : 's')
            : 'No changes in this window';
        const body = groups.map((g) => {
            const commits = (g.commits || []).map((c) => '<li><a href="' + esc(c.url || '#') + '" rel="noopener"><code>' + esc(c.sha || '') + '</code></a> '
                + esc(c.title || '') + '</li>').join('');
            return '<section class="ov-patchnotes-site"><h3>' + esc(g.site || '') + '</h3><ul>' + commits + '</ul></section>';
        }).join('');
        return '<details class="ov-patchnotes"><summary>' + esc(label) + '</summary>' + body + '</details>';
    };

    // Inside a hero or a section the Markdown headings are the page's own: the post page owns the
    // h1 (the post's name), so a section's "## Heading" is its h2 and its body headings move with it.
    const inner = (node, headingShift) => (node.children || []).map((c) => one(c, headingShift)).join('');

    const one = (node, headingShift = shift) => {
        const a = node.attrs || {};
        switch (node.type) {
            case 'text':
                return renderMarkdown(unhide(node.value), { rel, headingShift });
            case 'hero': {
                const art = typeof a.art === 'string' ? a.art : null;
                const body = inner(node, Math.max(0, headingShift - 1));
                return '<header class="ov-hero"'
                    + (a.kicker ? ' data-kicker="' + esc(a.kicker) + '"' : '') + '>'
                    + (art ? figureOf(node, art, 'ov-hero-art') : '')
                    + (a.kicker ? '<p class="ov-kicker">' + esc(a.kicker) + '</p>' : '')
                    + (a.date ? '<p class="ov-hero-date"><time datetime="' + esc(a.date) + '">' + esc(a.date) + '</time></p>' : '')
                    + '<div class="ov-hero-body">' + body + '</div>'
                    + '</header>';
            }
            case 'section': {
                const id = typeof a.id === 'string' ? a.id : null;
                const body = inner(node, Math.max(0, headingShift - 1));
                const react = a.react !== undefined && a.react !== false;
                return '<section class="ov-section' + (id ? '' : ' ov-section-noid') + '"'
                    + (id ? ' id="' + esc(id) + '" data-section-id="' + esc(id) + '"' : '') + '>'
                    + bylineOf(node)
                    + body
                    + (react && id ? reactionsForm(id) : '')
                    + '</section>';
            }
            case 'figure':
                return figureOf(node, a.src, 'ov-figure');
            case 'compare': {
                const before = img(node, a.before, 'ov-compare-before');
                const after = img(node, a.after, 'ov-compare-after');
                const caption = typeof a.caption === 'string' && a.caption
                    ? '<figcaption>' + esc(a.caption) + '</figcaption>' : '';
                return '<figure class="ov-compare">'
                    + '<div class="ov-compare-pair">' + before + after + '</div>'
                    + caption + '</figure>';
            }
            case 'gallery': {
                const items = listOf(a.items);
                const figures = items.map((id) => figureOf({ type: 'figure', attrs: {}, children: [] }, id, 'ov-gallery-item')).join('');
                const caption = typeof a.caption === 'string' && a.caption
                    ? '<figcaption>' + esc(a.caption) + '</figcaption>' : '';
                return '<figure class="ov-gallery"><div class="ov-gallery-grid">' + figures + '</div>' + caption + '</figure>';
            }
            case 'clip':
                return '<figure class="ov-clip" data-clip-id="' + esc(a.id || '') + '"><a href="/clips/' + esc(a.id || '') + '" rel="noopener">Clip</a></figure>';
            case 'pic':
                return figureOf(node, a.id, 'ov-pic');
            case 'video':
                return '<figure class="ov-video" data-video-id="' + esc(a.id || '') + '"><a href="/videos/' + esc(a.id || '') + '" rel="noopener">Video</a></figure>';
            case 'embed': {
                const url = typeof a.url === 'string' ? a.url : '';
                return '<figure class="ov-embed"><a href="' + esc(url) + '" rel="noopener nofollow">' + esc(url) + '</a></figure>';
            }
            case 'callout': {
                const tone = CALLOUT_TONES.includes(a.tone) ? a.tone : 'info';
                const title = typeof a.title === 'string' ? '<p class="ov-callout-title">' + esc(a.title) + '</p>' : '';
                return '<aside class="ov-callout ov-callout-' + esc(tone) + '">' + title + inner(node, headingShift) + '</aside>';
            }
            case 'stat':
                return '<div class="ov-stat"><span class="ov-stat-value">' + esc(a.value) + '</span>'
                    + '<span class="ov-stat-label">' + esc(a.label) + '</span></div>';
            case 'patchnotes':
                return patchNotesHtml(node);
            case 'infobox': {
                const rows = (node.children || []).filter((c) => c.type === 'text').map((c) => unhide(c.value).trim()).filter(Boolean);
                const items = rows.map((row) => {
                    const at = row.indexOf(':');
                    if (at === -1) return '<div class="ov-infobox-row"><span class="ov-infobox-value">' + esc(row) + '</span></div>';
                    return '<div class="ov-infobox-row"><dt class="ov-infobox-key">' + esc(row.slice(0, at).trim()) + '</dt>'
                        + '<dd class="ov-infobox-value">' + esc(row.slice(at + 1).trim()) + '</dd></div>';
                }).join('');
                const title = typeof a.title === 'string' ? '<h2 class="ov-infobox-title">' + esc(a.title) + '</h2>' : '';
                return '<aside class="ov-infobox">' + title + '<dl>' + items + '</dl></aside>';
            }
            case 'timeline': {
                const rows = (node.children || []).filter((c) => c.type === 'text').map((c) => unhide(c.value).trim()).filter(Boolean);
                const items = rows.map((row) => {
                    const at = row.indexOf(':');
                    if (at === -1) return '<li class="ov-timeline-item"><span class="ov-timeline-text">' + esc(row) + '</span></li>';
                    return '<li class="ov-timeline-item"><time class="ov-timeline-when" datetime="' + esc(row.slice(0, at).trim()) + '">' + esc(row.slice(0, at).trim()) + '</time>'
                        + '<span class="ov-timeline-text">' + esc(row.slice(at + 1).trim()) + '</span></li>';
                }).join('');
                const title = typeof a.title === 'string' ? '<h2 class="ov-timeline-title">' + esc(a.title) + '</h2>' : '';
                return '<div class="ov-timeline">' + title + '<ol>' + items + '</ol></div>';
            }
            case 'quote': {
                const body = inner(node, headingShift);
                const by = typeof a.by === 'string' && a.by ? '<footer class="ov-quote-by">— ' + esc(a.by) + '</footer>' : '';
                return '<blockquote class="ov-quote">' + body + by + '</blockquote>';
            }
            default:
                return '';
        }
    };

    const root = tree && tree.type === 'root' ? tree : { type: 'root', children: [tree].filter(Boolean) };
    return (root.children || []).map((c) => one(c, shift)).join('');
}

module.exports.render = render;
module.exports.creditLine = creditLine;


// ---- serialize ---------------------------------------------------------------------------------

/** An attribute value as a directive writes it: a bare word, a quoted string, or a bare flag. */
function attrValue(value) {
    if (value === true) return null;                       // a bare flag: { react }
    const s = String(value);
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** The directive of a block: :::name{attr="value"}. */
function directive(node) {
    const parts = [];
    for (const [key, value] of Object.entries(node.attrs || {})) {
        const v = attrValue(value);
        parts.push(v === null ? key : key + '=' + v);
    }
    return ':::' + node.type + (parts.length ? '{' + parts.join(' ') + '}' : '');
}

/**
 * A tree → the Markdown that parses back into it. The Markdown stays the source of truth, so a
 * caller who has blocks (an editor, an agent) can hand Blog the Markdown it will keep.
 *   serialize(parse(markdown)) === markdown, for the Markdown the parser writes.
 */
function serialize(tree) {
    const root = tree && tree.type === 'root' ? tree : { type: 'root', children: [tree].filter(Boolean) };
    const out = [];
    for (const node of root.children || []) {
        if (node.type === 'text') { out.push(node.value); continue; }
        const body = serialize({ type: 'root', children: node.children || [] });
        out.push(body.trim() ? directive(node) + '\n' + body.replace(/\n+$/, '') + '\n:::' : directive(node) + ':::');
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

module.exports.serialize = serialize;
module.exports.directive = directive;

