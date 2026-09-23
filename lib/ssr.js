'use strict';
/**
 * openvibe-publishing/ssr — small helpers for server-rendered pages that are useful without JS.
 *
 *   const ssr = require('openvibe-publishing/ssr');
 *   ssr.html`<h1>${title}</h1>${ssr.raw(ssr.renderMarkdown(body))}`   // values escaped unless raw()
 *   ssr.paginate({ page: 2, perPage: 20, total: 95, href: (p) => `/tags/bread?page=${p}` })
 *   ssr.paginationHtml(pager)      ssr.breadcrumbsHtml([{ name, url }, …])
 *   ssr.diffHtml(revs.diff(id, 1, 2, { mode: 'word' }).content)
 *   ssr.timeTag('2026-09-20T10:00:00Z')   // '' when the date is unknown — never a guessed date
 *
 * Markdown safety model: the source is never trusted as HTML. Text is escaped before any tag is
 * written, and the only tags produced are this file's own (p, br, h2–h6, blockquote, ul/ol/li, hr,
 * pre/code, strong, em, del, a). Links keep http(s), mailto, same-site paths and #fragments only.
 * No images (media goes through openvibe-publishing/media by object id), tables or raw HTML.
 * The Markdown renderer follows the approach of OpenVibe.Community's server/render/markdown.js (MIT),
 * without the syntax highlighter, with configurable link rel and heading level.
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESC[c]);
}
const escapeAttr = escapeHtml;

class Raw {
    constructor(s) { this.html = String(s == null ? '' : s); }
    toString() { return this.html; }
}
/** Mark trusted HTML (output of this module, or your own template) so html`` does not escape it. */
function raw(s) { return s instanceof Raw ? s : new Raw(s); }

function interp(v) {
    if (v == null || v === false) return '';
    if (v instanceof Raw) return v.html;
    if (Array.isArray(v)) return v.map(interp).join('');
    return escapeHtml(v);
}

/** Tagged template: every interpolated value is escaped unless wrapped in raw(). Returns a Raw. */
function html(strings, ...values) {
    let out = strings[0];
    for (let i = 0; i < values.length; i++) out += interp(values[i]) + strings[i + 1];
    return new Raw(out);
}

// ---- Markdown ----------------------------------------------------------------------------------

const MAX_SOURCE = 200000;
// Every pattern here runs on untrusted text on each page view, so none may backtrack
// super-linearly: trailing whitespace/#s are trimmed in code, not by competing \s* groups.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]{0,32})$/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+([\s\S]*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const UL = /^ {0,3}[-*+]\s+(.*)$/;
const OL = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/;
const SAFE_URL = /^(https?:\/\/|mailto:|\/(?![/\\])|#)/i;

function decodeBasic(s) {
    return s.replace(/&(amp|lt|gt|quot|#39);/g, (_m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]));
}

const FENCE = { test: (line) => FENCE_RE.test(line.trimEnd()) };
function fenceMatch(line) { return line.trimEnd().match(FENCE_RE); }

/** [, hashes, text] for an ATX heading (text without the optional closing #s), or null. */
function headingMatch(line) {
    const m = line.match(HEADING_RE);
    if (!m) return null;
    const text = m[2].trimEnd().replace(/#+$/, '').trimEnd();
    return /[\u2028\u2029]/.test(text) ? null : [m[0], m[1], text];
}
const HEADING = { test: (line) => headingMatch(line) !== null };

/**
 * Same result as s.replace(/<open>([\s\S]*?\S)<close>/g, …) for a delimiter pair, in linear time:
 * the lazy regex rescans to the end of the text for every opener that has no closer (quadratic).
 * Content runs from the end of an opener to the first closer after it; once one opener finds no
 * closer, no later opener can either, so the scan stops.
 */
function pairUp(s, open, close, wrap) {
    const o = new RegExp(open.source, 'g');
    const c = new RegExp(close.source, 'g');
    let out = '';
    let pos = 0;
    for (;;) {
        o.lastIndex = pos;
        const m = o.exec(s);
        if (!m) break;
        const start = m.index + m[0].length;
        c.lastIndex = start;
        const k = c.exec(s);
        if (!k) break;
        const end = k.index + 1; // the closer pattern starts with the content's last (non-space) character
        out += s.slice(pos, m.index) + wrap(m, s.slice(start, end));
        pos = k.index + k[0].length;
    }
    return out + s.slice(pos);
}

function emphasis(s) {
    s = pairUp(s, /\*\*(?=\S)/, /\S\*\*/, (_m, t) => `<strong>${t}</strong>`);
    s = pairUp(s, /(^|[^\w])__(?=\S)/, /\S__(?!\w)/, (m, t) => `${m[1]}<strong>${t}</strong>`);
    s = s
        .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
        .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
    return pairUp(s, /~~(?=\S)/, /\S~~/, (_m, t) => `<del>${t}</del>`);
}

/**
 * Same result as s.replace(/(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1(?!`)/g, …) in O(n log n): an opener
 * is the tail of a backtick run (longest first, as the regex tries it), its closer the next whole
 * run of exactly that length not preceded by a newline, with non-empty content not starting with one.
 */
function codeSpans(s, onCode) {
    const runs = [];
    const byLen = new Map();
    const re = /`+/g;
    let m;
    while ((m = re.exec(s))) {
        runs.push([m.index, m[0].length]);
        if (s[m.index - 1] !== '\n') {
            if (!byLen.has(m[0].length)) byLen.set(m[0].length, []);
            byLen.get(m[0].length).push(m.index);
        }
    }
    const nextAt = (list, from) => {
        let lo = 0;
        let hi = list.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] < from) lo = mid + 1; else hi = mid; }
        return lo < list.length ? list[lo] : -1;
    };
    let out = '';
    let pos = 0;
    for (const [at, len] of runs) {
        if (at < pos) continue;
        const contentStart = at + len;
        if (contentStart >= s.length || s[contentStart] === '\n') continue;
        for (let n = len; n >= 1; n--) {
            const list = byLen.get(n);
            const close = list ? nextAt(list, contentStart + 1) : -1;
            if (close < 0) continue;
            out += s.slice(pos, at + len - n) + onCode(s.slice(contentStart, close));
            pos = close + n;
            break;
        }
    }
    return out + s.slice(pos);
}

function inline(src, opts) {
    const held = [];
    const hold = (h) => `\u0000${held.push(h) - 1}\u0000`;
    const relAttr = opts.rel ? ` rel="${escapeHtml(opts.rel)}"` : '';
    let s = codeSpans(String(src), (code) => hold(`<code>${escapeHtml(code)}</code>`));
    s = escapeHtml(s);
    s = s.replace(/\[([^\]\n]{1,300})\]\(([^\s()]{1,2000})\)/g, (m, text, url) => {
        const href = decodeBasic(url);
        if (!SAFE_URL.test(href)) return m;
        return hold(`<a href="${escapeHtml(href)}"${relAttr}>${emphasis(text)}</a>`);
    });
    s = s.replace(/\bhttps?:\/\/[^\s<>\u0000]+/gi, (m) => {
        let url = m;
        let tail = '';
        for (;;) {
            const ent = url.match(/&(quot|#39|gt|lt);$/);
            if (ent) { tail = ent[0] + tail; url = url.slice(0, -ent[0].length); continue; }
            if (/[.,;:!?)\]'"]$/.test(url)) { tail = url.slice(-1) + tail; url = url.slice(0, -1); continue; }
            break;
        }
        if (url.length <= 8) return m;
        const href = decodeBasic(url);
        return hold(`<a href="${escapeHtml(href)}"${relAttr}>${escapeHtml(href)}</a>`) + tail;
    });
    s = emphasis(s).replace(/\n/g, '<br>\n');
    for (let i = 0; i < 3 && s.includes('\u0000'); i++) s = s.replace(/\u0000(\d+)\u0000/g, (_m, n) => held[Number(n)] || '');
    return s;
}

function startsBlock(line) {
    return FENCE.test(line) || HEADING.test(line) || QUOTE.test(line) || HR.test(line) || UL.test(line) || OL.test(line);
}

function blocks(lines, depth, opts) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) { i++; continue; }
        let m = fenceMatch(line);
        if (m) {
            const close = new RegExp(`^ {0,3}\\${m[1][0]}{${m[1].length},}\\s*$`);
            const body = [];
            i++;
            while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
            i++;
            const lang = m[2] ? ` class="language-${escapeHtml(m[2].toLowerCase())}"` : '';
            out.push(`<pre><code${lang}>${escapeHtml(body.join('\n'))}</code></pre>`);
            continue;
        }
        if (HR.test(line)) { out.push('<hr>'); i++; continue; }
        m = headingMatch(line);
        if (m) {
            const level = Math.min(Math.max(m[1].length + opts.headingShift, 2), 6);
            out.push(`<h${level}>${inline(m[2], opts)}</h${level}>`);
            i++;
            continue;
        }
        if (QUOTE.test(line)) {
            const inner = [];
            while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) inner.push(lines[i++].match(QUOTE)[1]);
            out.push(depth < 3 ? `<blockquote>${blocks(inner, depth + 1, opts)}</blockquote>` : `<blockquote><p>${inline(inner.join('\n'), opts)}</p></blockquote>`);
            continue;
        }
        if (UL.test(line) || OL.test(line)) {
            const ordered = !UL.test(line);
            const re = ordered ? OL : UL;
            const start = ordered ? parseInt(line.match(OL)[1], 10) : 1;
            const items = [];
            while (i < lines.length && lines[i].trim()) {
                const mm = lines[i].match(re);
                if (mm) items.push(ordered ? mm[2] : mm[1]);
                else if (/^\s+\S/.test(lines[i]) && items.length) items[items.length - 1] += `\n${lines[i].trim()}`;
                else break;
                i++;
            }
            const tag = ordered ? 'ol' : 'ul';
            out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${items.map((it) => `<li>${inline(it, opts)}</li>`).join('')}</${tag}>`);
            continue;
        }
        const para = [];
        while (i < lines.length && lines[i].trim() && (!para.length || !startsBlock(lines[i]))) para.push(lines[i++]);
        out.push(`<p>${inline(para.join('\n'), opts)}</p>`);
    }
    return out.join('\n');
}

/**
 * Markdown → safe HTML. Options: rel (link rel, default 'nofollow ugc noopener' — pass 'noopener'
 * for editorial text you vouch for), headingShift (default 1: '#' becomes <h2>, the page owns <h1>).
 */
function renderMarkdown(source, { rel = 'nofollow ugc noopener', headingShift = 1 } = {}) {
    const text = String(source == null ? '' : source).slice(0, MAX_SOURCE).replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
    return blocks(text.split('\n'), 0, { rel, headingShift });
}

/** Markdown → plain text for descriptions, feeds and index documents (the caller escapes it). */
function markdownToText(source, max = Infinity) {
    const t = String(source == null ? '' : source).replace(/\u0000/g, '')
        .replace(/^ {0,3}(`{3,}|~{3,}).*$/gm, '')
        .replace(/\[([^[\]\n]*)\]\([^)\s]*\)/g, '$1')
        .replace(/^ {0,3}(#{1,6}|>|[-*+]|\d{1,9}[.)])\s+/gm, '')
        .replace(/^ {0,3}([-*_])(\s*\1){2,}\s*$/gm, '')
        .replace(/(\*\*|__|~~|`)/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : t;
}

/** Words in a text (Unicode letters/numbers runs) — the SEO gate's thin-content measure. */
function wordCount(text) {
    const m = String(text == null ? '' : text).match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
    return m ? m.length : 0;
}

// ---- Pagination, breadcrumbs, diff, time -------------------------------------------------------

/**
 * Server pagination. href(page) builds each page's URL. Out-of-range pages are clamped and
 * reported (`outOfRange: true`) so the caller can answer 404 instead of an empty page.
 */
function paginate({ page = 1, perPage = 20, total = 0, href } = {}) {
    if (typeof href !== 'function') throw new TypeError('href(page) is required');
    const per = Math.max(1, Math.min(500, Math.floor(Number(perPage)) || 20));
    const count = Math.max(0, Math.floor(Number(total)) || 0);
    const pages = Math.max(1, Math.ceil(count / per));
    const asked = Math.floor(Number(page)) || 1;
    const current = Math.min(Math.max(1, asked), pages);
    const window = [];
    for (let p = Math.max(1, current - 2); p <= Math.min(pages, current + 2); p++) window.push({ page: p, href: href(p), current: p === current });
    return {
        page: current, perPage: per, total: count, pages, offset: (current - 1) * per, limit: per,
        outOfRange: asked !== current,
        prev: current > 1 ? { page: current - 1, href: href(current - 1) } : null,
        next: current < pages ? { page: current + 1, href: href(current + 1) } : null,
        first: { page: 1, href: href(1) }, last: { page: pages, href: href(pages) },
        window,
    };
}

/** Plain links (rel=prev/next) that work without JavaScript. */
function paginationHtml(p, { label = 'Pagination' } = {}) {
    if (!p || p.pages <= 1) return '';
    const parts = [];
    if (p.prev) parts.push(`<a href="${escapeHtml(p.prev.href)}" rel="prev">&larr; Newer</a>`);
    if (p.window[0] && p.window[0].page > 1) parts.push(`<a href="${escapeHtml(p.first.href)}">1</a>`, p.window[0].page > 2 ? '<span aria-hidden="true">…</span>' : '');
    for (const w of p.window) parts.push(w.current ? `<span aria-current="page">${w.page}</span>` : `<a href="${escapeHtml(w.href)}">${w.page}</a>`);
    const lastShown = p.window[p.window.length - 1];
    if (lastShown && lastShown.page < p.pages) parts.push(lastShown.page < p.pages - 1 ? '<span aria-hidden="true">…</span>' : '', `<a href="${escapeHtml(p.last.href)}">${p.pages}</a>`);
    if (p.next) parts.push(`<a href="${escapeHtml(p.next.href)}" rel="next">Older &rarr;</a>`);
    return `<nav class="ov-pagination" aria-label="${escapeHtml(label)}">${parts.filter(Boolean).join(' ')}</nav>`;
}

/** Breadcrumb trail: items [{ name, url }], the last one is the current page. */
function breadcrumbsHtml(items = [], { label = 'Breadcrumb' } = {}) {
    const list = items.filter((it) => it && it.name);
    if (!list.length) return '';
    const li = list.map((it, i) => (i === list.length - 1 || !it.url
        ? `<li${i === list.length - 1 ? ' aria-current="page"' : ''}>${escapeHtml(it.name)}</li>`
        : `<li><a href="${escapeHtml(it.url)}">${escapeHtml(it.name)}</a></li>`));
    return `<nav class="ov-breadcrumbs" aria-label="${escapeHtml(label)}"><ol>${li.join('')}</ol></nav>`;
}

/** A diff (from revisions.diff(...).content or diffText) as <ins>/<del> markup inside <pre>. */
function diffHtml(result) {
    const ops = result && result.ops ? result.ops : [];
    const body = ops.map((o) => (o.op === 'insert' ? `<ins>${escapeHtml(o.text)}</ins>` : o.op === 'delete' ? `<del>${escapeHtml(o.text)}</del>` : escapeHtml(o.text))).join('');
    return `<pre class="ov-diff ov-diff-${result && result.mode === 'word' ? 'word' : 'line'}">${body}</pre>`;
}

/** <time> for a known instant; '' for an unknown one (the page must not guess a date). */
function timeTag(value, { label } = {}) {
    if (value == null || value === '') return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const iso = d.toISOString();
    return `<time datetime="${iso}">${escapeHtml(label || iso.slice(0, 10))}</time>`;
}

module.exports = {
    escapeHtml, escapeAttr, html, raw, renderMarkdown, markdownToText, wordCount,
    paginate, paginationHtml, breadcrumbsHtml, diffHtml, timeTag,
};
