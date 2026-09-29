'use strict';
/**
 * openvibe-publishing/ingest — the shared ingest chassis: the primitives the five content products
 * (News, Reviews, Deals, Coupons, Trade) each keep a private copy of today.
 *
 *   const ingest = require('openvibe-publishing/ingest');
 *
 *   const sources = ingest.createSourcesClient({ config });                       // Sources HTTP client
 *   const cursor  = await ingest.createChangeCursor(db, { prefix: 'deals' }).ensureSchema();
 *   await ingest.pullChanges({ db, cursor, source: sources, apply: async (item, t) => 'applied' });
 *   const consumer = ingest.createEventConsumer({ db, secrets, consumer: 'deals-sources' });
 *   const r = await consumer.apply(raw, req.headers, (event) => importer.kick());
 *
 * It is primitives + thin factories, not one opinionated pipeline: the products' domains diverge
 * (News clustering, Reviews signals, Trade observations, …), so only what they share lives here —
 * the Sources client, the change-cursor pull with per-item isolation, the signed event consumer with
 * an exactly-once inbox, the shared pure normalisers, the PSL/registrable-host helpers and the
 * freshness verdict.
 *
 * Honesty: nothing here defaults a missing date to "now", invents a value or reads fields of a
 * Sources item beyond what the caller asks for. The cursor stores what Sources' change feed said and
 * moves only past pages that committed.
 *
 * Every method that touches data takes the caller's openvibe-sdk/db transaction handle as its first
 * argument (the store convention of this package), so the chassis writes commit or roll back with the
 * caller's own writes.
 */
const { isHandle, assertPrefix, clockOf, PublishingError } = require('./internal');

// ─────────────────────────────────────────────────────────────────────────────
// normalize — the pure helpers the five copies share, ported byte-for-byte.
// Each entry names the copy it came from (product path:line in the source tree).
// ─────────────────────────────────────────────────────────────────────────────

// News `server/domain/text.js`
const STOPWORDS = new Set(('a about above after again against all am an and any are as at be because been before being below between both but by '
    + 'can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its '
    + 'itself just me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the '
    + 'their theirs them then there these they this those through to too under until up very was we were what when where which while who whom '
    + 'why will with would you your yours says said say new news report reports update updates live latest via amid over after more first year '
    + 'years today yesterday week one two three four five six seven eight nine ten'
).split(/\s+/));
const NOT_ENTITIES = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'as', 'how', 'why', 'what', 'when', 'where', 'who', 'new', 'breaking', 'update', 'live', 'watch', 'exclusive', 'opinion', 'analysis', 'report']);

/** Lowercase, strip accents and punctuation, collapse spaces. */
function fold(s) {
    return String(s == null ? '' : s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** A headline normalised for comparison. */
function titleKey(title) { return fold(title); }

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|cmpid|ocid|igshid|smid)$/i;

/**
 * The URL key dedupe compares: https, lowercase host without "www.", no fragment, no tracking
 * parameters, remaining parameters sorted, no trailing slash. null for anything that is not http(s).
 */
function urlKey(url) {
    if (!url) return null;
    let u;
    try { u = new URL(String(url)); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
    const q = params.length ? `?${new URLSearchParams(params).toString()}` : '';
    let p = u.pathname.replace(/\/{2,}/g, '/');
    if (p.length > 1) p = p.replace(/\/+$/, '');
    return `https://${host}${u.port && u.port !== '443' && u.port !== '80' ? `:${u.port}` : ''}${p}${q}`;
}

/** The outlet shown when the registry has no name: the URL's host without "www.". */
function hostOf(url) {
    try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

// Second-level labels under a two-letter country code that are not a publisher's own name
// (bbc.co.uk, abc.net.au): the publisher is the label before them.
const COUNTRY_SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'ne', 'or', 'go', 'gob', 'nic', 'mil']);

/**
 * The publisher's domain of a URL: its host without subdomains (news.example.com and
 * www.example.com → example.com; news.bbc.co.uk → bbc.co.uk). Deliberately coarse.
 */
function publisherDomain(url) {
    const host = hostOf(url);
    if (!host) return null;
    if (/^[\d.]+$/.test(host) || host.startsWith('[')) return host;
    const labels = host.split('.').filter(Boolean);
    if (labels.length <= 2) return labels.join('.');
    const n = labels.length;
    const take = labels[n - 1].length === 2 && COUNTRY_SECOND_LEVEL.has(labels[n - 2]) ? 3 : 2;
    return labels.slice(-take).join('.');
}

/**
 * Independent sources among source items: items are one source when they share the Sources source,
 * the publisher's domain, the outlet name, or the original they duplicate; transitive. → groups of ids.
 */
function independentSources(items) {
    const parent = new Map();
    const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
    const union = (a, b) => { const x = find(a); const y = find(b); if (x !== y) parent.set(y, x); };
    for (const it of items) {
        const node = `item:${it.id}`;
        if (!parent.has(node)) parent.set(node, node);
        const domain = publisherDomain(it.canonical_url);
        const outlet = fold(it.outlet);
        const keys = [`source:${it.source_key}`, `original:${it.duplicate_of || it.id}`, domain ? `domain:${domain}` : null, outlet ? `outlet:${outlet}` : null].filter(Boolean);
        for (const k of keys) {
            if (!parent.has(k)) parent.set(k, k);
            union(node, k);
        }
    }
    const groups = new Map();
    for (const it of items) {
        const root = find(`item:${it.id}`);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(it.id);
    }
    return [...groups.values()];
}

/** Very light stemming: plural and possessive endings, so "rockets" and "rocket" meet. */
function stem(w) {
    if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
    return w;
}

/** Content terms of a text: folded words of 3+ letters (or any number), minus stopwords, stemmed, unique, sorted. */
function terms(text) {
    const out = new Set();
    for (const w of fold(text).split(' ')) {
        if (!w || STOPWORDS.has(w)) continue;
        if (w.length < 3 && !/^\d+$/.test(w)) continue;
        out.add(stem(w));
    }
    return [...out].sort();
}

/**
 * Named entities, deterministically: runs of Capitalised words (and ALL-CAPS acronyms of 2+ letters),
 * folded. Sorted, unique.
 */
function entities(text) {
    const src = String(text || '');
    const tokens = src.split(/\s+/).filter(Boolean);
    const out = new Set();
    let run = [];
    const laterCapitalised = (w, idx) => tokens.slice(idx + 1).some((t) => t.replace(/[^\p{L}\p{N}]/gu, '') === w);
    const flush = () => {
        if (run.length) {
            const words = run.map((r) => r.word);
            const startsText = run[0].index === 0;
            const acronym = words.some((w) => /^[A-Z0-9]{2,}$/.test(w));
            if (!(startsText && words.length === 1 && !acronym && !laterCapitalised(words[0], run[0].index))) {
                const f = fold(words.join(' '));
                if (f && !NOT_ENTITIES.has(f) && !STOPWORDS.has(f)) out.add(f);
            }
        }
        run = [];
    };
    tokens.forEach((raw, index) => {
        const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        const cap = /^\p{Lu}/u.test(word) && !NOT_ENTITIES.has(word.toLowerCase());
        if (word && cap) run.push({ word, index }); else flush();
        if (/[.!?:;,]$/.test(raw)) flush();
    });
    flush();
    return [...out].sort();
}

/** Word 2-shingles of a folded headline (single-word headlines give the word itself). */
function shingles(title) {
    const w = titleKey(title).split(' ').filter(Boolean);
    if (w.length < 2) return new Set(w);
    const s = new Set();
    for (let i = 0; i < w.length - 1; i++) s.add(`${w[i]} ${w[i + 1]}`);
    return s;
}

function jaccard(a, b) {
    if (!a.size && !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
}

const ALLOWS_SUMMARY = /\b(short|brief)\s+summar(y|ies)\b|\bsummar(y|ies)\s+(are|is)\s+(allowed|permitted)\b/i;
const FORBIDS_SUMMARY = /\b(no|not|never|without)\s+(short\s+|brief\s+)?summar(y|ies)\b|\bsummar(y|ies)\s+(are|is)\s+not\b|\bheadlines?\s+(and\s+links\s+)?only\b|\btitles?\s+and\s+links\s+only\b/i;

/**
 * What of a source's summary may be kept: a short summary, only when the item's terms or licence
 * note explicitly allows it (and nothing forbids it), cut to maxChars at a word boundary.
 * → { summary, basis }
 */
function licensedSummary(summary, { termsNote, licenseNote, maxChars = 280 } = {}) {
    const notes = `${termsNote || ''}\n${licenseNote || ''}`;
    const text = String(summary || '').replace(/\s+/g, ' ').trim();
    if (!text) return { summary: null, basis: 'none_provided' };
    if (!maxChars) return { summary: null, basis: 'summaries_disabled' };
    if (FORBIDS_SUMMARY.test(notes)) return { summary: null, basis: 'terms_forbid_summaries' };
    if (!ALLOWS_SUMMARY.test(notes)) return { summary: null, basis: 'terms_do_not_allow_summaries' };
    if (text.length <= maxChars) return { summary: text, basis: 'terms_allow_short_summaries' };
    const cut = text.slice(0, maxChars - 1);
    const at = cut.lastIndexOf(' ');
    return { summary: `${(at > maxChars * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, '')}…`, basis: 'terms_allow_short_summaries' };
}

// Deals `server/domain/util.js`
/** http(s) URL with the fragment and tracking parameters removed, host lower-cased, params sorted. */
function normalizeUrl(input) {
    if (input == null || input === '') return null;
    let u;
    try { u = new URL(String(input).trim()); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    u.search = '';
    for (const [k, v] of keep) u.searchParams.append(k, v);
    let s = u.toString();
    if (u.pathname.length > 1 && s.endsWith('/') && !u.search) s = s.slice(0, -1);
    return s.length <= 2048 ? s : null;
}

/** The identity used to find duplicates: normalised URL without scheme and without "www.". */
function hostPathKey(normalized) {
    if (!normalized) return null;
    return normalized.replace(/^https?:\/\//, '').replace(/^www\./, '');
}

function domainOf(normalized) {
    try { return new URL(normalized).hostname.replace(/^www\./, ''); } catch { return null; }
}

function slugify(text, suffixFrom) {
    const base = String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '') || 'deal';
    const suffix = String(suffixFrom || '').replace(/^[a-z]+_/, '').slice(-6).toLowerCase();
    return suffix ? `${base}-${suffix}` : base;
}

/**
 * A decimal amount as stated: '12', '12.5', '1,299.99'. The digits stay as given; only thousands
 * commas and surrounding space go. → { text, num } | null ; throws 422 on anything else.
 */
function parseAmount(v, field) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') {
        if (!Number.isFinite(v) || v < 0) throw new PublishingError(422, 'request.invalid', `${field} must be a non-negative number`);
        return { text: String(v), num: v };
    }
    const s = String(v).trim().replace(/,(?=\d{3}(\D|$))/g, '');
    if (s === '') return null;
    if (!/^\d{1,9}(\.\d{1,4})?$/.test(s)) throw new PublishingError(422, 'request.invalid', `${field} must be a plain amount like 19.99 (no currency symbols)`);
    return { text: s.replace(/^0+(?=\d)/, ''), num: Number(s) };
}

function parseCurrency(v, field = 'currency') {
    if (v == null || v === '') return null;
    const s = String(v).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(s)) throw new PublishingError(422, 'request.invalid', `${field} must be an ISO 4217 code such as USD or EUR`);
    return s;
}

function parseEnum(v, allowed, field) {
    if (v == null || v === '') return null;
    const s = String(v).trim().toLowerCase();
    if (!allowed.includes(s)) throw new PublishingError(422, 'request.invalid', `${field} must be one of ${allowed.join(', ')}`);
    return s;
}

/** An instant stated by a person or source (ISO string or epoch ms) → ms; blank → null. */
function parseInstant(v, field) {
    if (v == null || v === '') return null;
    const t = typeof v === 'number' ? v : Date.parse(String(v));
    if (!Number.isFinite(t)) throw new PublishingError(422, 'request.invalid', `${field} must be a date`);
    return t;
}

function text(v, { field, min = 0, max = 1000, required = false } = {}) {
    const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
    if (!s) {
        if (required) throw new PublishingError(422, 'request.invalid', `${field} is required`);
        return null;
    }
    if (s.length < min) throw new PublishingError(422, 'request.invalid', `${field} must be at least ${min} characters`);
    return s.slice(0, max);
}

/** Multi-line text (descriptions): keeps line breaks, trims, caps. */
function longText(v, max = 4000) {
    if (v == null) return null;
    const s = String(v).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
    return s ? s.slice(0, max) : null;
}

/** Lower-case word tokens (letters and digits of any script). */
function tokens(s) {
    return String(s || '').toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
}

// Trade `server/domain/util.js`
/**
 * A date the caller STATES: an ISO 8601 date-time with a zone (…Z or ±hh:mm), or epoch ms as a
 * number. Anything else (including a missing value) is null — never "now".
 */
function parseTime(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
    const s = String(v).trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
}

const DECIMAL_RE = /^-?(\d{1,20})(\.\d{1,12})?([eE][-+]?\d{1,3})?$/;

/** A decimal as stated: → { text, num } or null. Numbers are kept as their shortest string form. */
function parseDecimal(v) {
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return null;
        return { text: String(v), num: v };
    }
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!DECIMAL_RE.test(s)) return null;
    const num = Number(s);
    return Number.isFinite(num) ? { text: s, num } : null;
}

const invalid = (detail, code = 'request.invalid') => new PublishingError(422, code, detail);

function str(v, max, name, { required = false } = {}) {
    if (v == null || v === '') {
        if (required) throw invalid(`${name} is required`);
        return null;
    }
    if (typeof v !== 'string') throw invalid(`${name} must be a string`);
    const s = v.trim();
    if (!s && required) throw invalid(`${name} is required`);
    if (s.length > max) throw invalid(`${name} is longer than ${max} characters`);
    return s || null;
}

function httpUrl(v, name) {
    if (v == null || v === '') return null;
    let u;
    try { u = new URL(String(v)); } catch { throw invalid(`${name} must be an absolute URL`); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw invalid(`${name} must be http(s)`);
    return u.toString();
}

/** Parse JSON stored by a service; a broken value is an empty default, never a crash. */
function json(text, def) {
    if (text == null) return def;
    try { return JSON.parse(text); } catch { return def; }
}

/** epoch ms → ISO string, or null. */
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

// Reviews `server/reviews/normalize.js`
class NormalizeError extends Error {
    constructor(message) { super(message); this.name = 'NormalizeError'; this.status = 422; this.code = 'alias.invalid'; }
}

function name(value) {
    const s = String(value == null ? '' : value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
    if (!s) throw new NormalizeError('A name needs at least one letter or digit');
    return s.slice(0, 200);
}

/** host (without www.) + path (+ query minus tracking parameters); http and https are the same thing. */
function url(value) {
    let u;
    try { u = new URL(String(value || '').trim()); } catch { throw new NormalizeError('A URL alias must be an absolute http(s) URL'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new NormalizeError('A URL alias must be http(s)');
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const keep = [...u.searchParams.entries()].filter(([k]) => !/^(utm_|fbclid$|gclid$|ref$|mc_)/i.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    let pathname = u.pathname.replace(/\/{2,}/g, '/');
    if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '');
    const query = keep.length ? `?${new URLSearchParams(keep).toString()}` : '';
    return `${host}${pathname === '/' ? '' : pathname}${query}`.slice(0, 1000);
}

function code(value, what) {
    const s = String(value == null ? '' : value).trim().toUpperCase().replace(/\s+/g, '');
    if (!s || s.length > 100) throw new NormalizeError(`A ${what} is 1–100 characters`);
    return s;
}

/** GTIN-8/12/13/14 → 14 digits, so the same product under two lengths is one key. */
function gtin(value) {
    const d = String(value == null ? '' : value).replace(/[\s-]/g, '');
    if (!/^\d+$/.test(d) || ![8, 12, 13, 14].includes(d.length)) throw new NormalizeError('A GTIN has 8, 12, 13 or 14 digits');
    return d.padStart(14, '0');
}

function sourceKey(value) {
    const s = String(value == null ? '' : value).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(s)) throw new NormalizeError('A source binding is an OpenVibe.Sources source key');
    return s;
}

/** namespace:id, e.g. steam_app:620 */
function external(value) {
    const m = String(value == null ? '' : value).trim().match(/^([A-Za-z][A-Za-z0-9_.-]{0,39}):(.{1,200})$/);
    if (!m) throw new NormalizeError('An external id is namespace:id (e.g. steam_app:620)');
    return `${m[1].toLowerCase()}:${m[2].trim()}`;
}

const BY_TYPE = { name, url, sku: (v) => code(v, 'SKU'), mpn: (v) => code(v, 'MPN'), gtin, source: sourceKey, external };

function alias(type, value) {
    const fn = BY_TYPE[type];
    if (!fn) throw new NormalizeError(`alias type must be one of ${Object.keys(BY_TYPE).join(', ')}`);
    return fn(value);
}

/** Try to normalise; null when the value is not a valid identifier of that type. */
function tryAlias(type, value) {
    if (value == null || value === '') return null;
    try { return alias(type, value); } catch { return null; }
}

function slug(value) {
    const s = String(value == null ? '' : value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/&/g, '-and-').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
    return s || null;
}

const normalize = Object.freeze({
    // News
    fold, titleKey, urlKey, hostOf, publisherDomain, independentSources, terms, entities, shingles, jaccard, stem, licensedSummary,
    // Deals
    normalizeUrl, hostPathKey, domainOf, slugify, parseAmount, parseCurrency, parseEnum, parseInstant, text, longText, tokens,
    // Trade
    parseTime, parseDecimal, str, httpUrl, json,
    // Reviews
    name, url, code, gtin, sourceKey, external, alias, tryAlias, slug, NormalizeError, ALIAS_TYPES: Object.keys(BY_TYPE),
    // shared
    iso,
});

// ─────────────────────────────────────────────────────────────────────────────
// hosts — the PSL and registrable-host helpers (Coupons `server/domain/psl.js` and `hosts.js`).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A small, bundled subset of the Public Suffix List (https://publicsuffix.org/list/, MPL-2.0),
 * enough to find the registrable domain (eTLD+1) of a host. Longest matching rule wins, `*.x`
 * matches one label, `!a.x` is an exception, else `*`. Private-section entries are included so
 * foo.myshopify.com and bar.myshopify.com never resolve to the same site. A subset on purpose:
 * no network fetch, no runtime dependency.
 */
const PSL_RULES = [
    'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk', 'sch.uk',
    'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
    'co.nz', 'net.nz', 'org.nz', 'ac.nz', 'govt.nz',
    'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'ad.jp', 'ed.jp', 'gr.jp', 'lg.jp',
    'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr',
    'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
    'com.mx', 'org.mx', 'net.mx', 'gob.mx', 'edu.mx',
    'com.ar', 'net.ar', 'org.ar', 'gob.ar',
    'com.co', 'net.co', 'org.co', 'gov.co',
    'com.pe', 'org.pe', 'net.pe',
    'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
    'com.hk', 'net.hk', 'org.hk', 'edu.hk', 'gov.hk',
    'com.tw', 'net.tw', 'org.tw', 'edu.tw', 'gov.tw',
    'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'gov.sg',
    'com.my', 'net.my', 'org.my', 'edu.my', 'gov.my',
    'co.id', 'or.id', 'web.id', 'ac.id', 'go.id',
    'com.ph', 'net.ph', 'org.ph', 'gov.ph',
    'com.vn', 'net.vn', 'org.vn', 'gov.vn',
    'co.th', 'in.th', 'or.th', 'ac.th', 'go.th',
    'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'ac.in', 'gov.in', 'edu.in',
    'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr',
    'com.ua', 'net.ua', 'org.ua', 'gov.ua',
    'com.pl', 'net.pl', 'org.pl',
    'co.za', 'org.za', 'net.za', 'gov.za', 'ac.za',
    'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il',
    'com.sa', 'net.sa', 'org.sa', 'gov.sa',
    'com.eg', 'net.eg', 'org.eg', 'gov.eg',
    'co.ke', 'or.ke', 'ne.ke', 'go.ke',
    'com.ng', 'org.ng', 'net.ng', 'gov.ng',
    '*.ck', '!www.ck',
    '*.bd', '*.er', '*.fk', '*.jm', '*.kh', '*.mm', '*.np', '*.pg',
    'myshopify.com', 'bigcartel.com', 'wixsite.com',
    'github.io', 'gitlab.io', 'blogspot.com', 'herokuapp.com', 'netlify.app', 'vercel.app',
    'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'appspot.com', 'azurewebsites.net',
    'cloudfront.net',
];

const PSL_EXACT = new Set();
const PSL_WILDCARD = new Set();
const PSL_EXCEPTION = new Set();
for (const r of PSL_RULES) {
    if (r.startsWith('!')) PSL_EXCEPTION.add(r.slice(1));
    else if (r.startsWith('*.')) PSL_WILDCARD.add(r.slice(2));
    else PSL_EXACT.add(r);
}

/** Number of labels of the public suffix of `host` (already normalized). */
function suffixLabels(host) {
    const labels = host.split('.');
    let best = 1;
    for (let i = 0; i < labels.length; i++) {
        const candidate = labels.slice(i).join('.');
        const n = labels.length - i;
        if (PSL_EXCEPTION.has(candidate)) return n - 1;
        if (PSL_EXACT.has(candidate) && n > best) best = n;
        if (i > 0 && PSL_WILDCARD.has(candidate) && n + 1 > best) best = n + 1;
    }
    return best;
}

/** The public suffix of a normalized host (e.g. 'co.uk'). */
function publicSuffix(host) {
    const labels = host.split('.');
    return labels.slice(labels.length - Math.min(suffixLabels(host), labels.length)).join('.');
}

/** eTLD+1, or null when the host IS a public suffix (e.g. 'co.uk', 'myshopify.com'). */
function registrableDomain(host) {
    const labels = host.split('.');
    const n = suffixLabels(host);
    if (labels.length <= n) return null;
    return labels.slice(labels.length - n - 1).join('.');
}

const { domainToASCII } = require('url');

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const SPECIAL = ['localhost', 'local', 'internal', 'invalid', 'arpa', 'test', 'example', 'onion', 'lan', 'home', 'corp'];

class HostError extends Error {
    constructor(detail) { super(detail); this.name = 'HostError'; this.status = 400; this.code = 'host.invalid'; }
}

/** → normalized host, or throws HostError. */
function normalizeHost(input) {
    if (typeof input !== 'string') throw new HostError('host must be a string');
    let h = input.trim().toLowerCase();
    if (!h || h.length > 300) throw new HostError('host is empty or too long');
    if (/[\s/\\?#@]/.test(h)) throw new HostError('host must be a hostname only (no scheme, path, query or credentials)');
    if (h.startsWith('[')) throw new HostError('IP addresses are not merchants');
    const colon = h.indexOf(':');
    if (colon !== -1) {
        if (!/^\d{1,5}$/.test(h.slice(colon + 1))) throw new HostError('malformed port');
        h = h.slice(0, colon);
    }
    h = h.replace(/\.$/, '');
    const ascii = domainToASCII(h);
    if (!ascii) throw new HostError('not a valid domain name');
    h = ascii.toLowerCase();
    if (h.length > 253) throw new HostError('host is too long');
    const labels = h.split('.');
    if (labels.length < 2) throw new HostError('host needs at least two labels');
    if (!labels.every((l) => LABEL_RE.test(l))) throw new HostError('host has a malformed label');
    if (labels.every((l) => /^\d+$/.test(l)) || /^\d+$/.test(labels[labels.length - 1])) throw new HostError('IP addresses are not merchants');
    if (SPECIAL.includes(labels[labels.length - 1])) throw new HostError('special-use names are not merchants');
    return h;
}

/** Normalize, or null. */
function tryHost(input) {
    try { return normalizeHost(input); } catch { return null; }
}

/** The registrable domain (eTLD+1) of a normalized host, or null when it is a public suffix. */
function registrable(host) { return registrableDomain(host); }

/** Host and path of an http(s) URL (for evidence and Sources items), or null. */
function hostOfUrl(url) {
    let u;
    try { u = new URL(String(url)); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = tryHost(u.hostname);
    return host ? { host, path: u.pathname || '/' } : null;
}

/** '/Shop/x/' → '/Shop/x' ; '' | '/' → '' ; throws on anything that is not a plain path. */
function normalizePathPrefix(p) {
    if (p == null || p === '' || p === '/') return '';
    const s = String(p).trim();
    if (!s.startsWith('/') || s.length > 200 || /[\s?#\\]/.test(s) || s.includes('//') || /(^|\/)\.\.?(\/|$)/.test(s)) {
        throw new HostError('path_prefix must be a plain path like /shop/name');
    }
    return s.replace(/\/+$/, '');
}

/** Does `path` start with `prefix` at a segment boundary? */
function pathMatches(prefix, path) {
    if (!prefix) return true;
    if (path == null) return false;
    return path === prefix || path.startsWith(`${prefix}/`);
}

/** Validate a new domain rule. → { host, registrable, path_prefix, include_subdomains }. */
function checkRule({ host, include_subdomains = true, path_prefix = '' } = {}) {
    const h = normalizeHost(host);
    const reg = registrable(h);
    if (!reg) throw new HostError(`${h} is a public suffix (${publicSuffix(h)}), not a site`);
    return { host: h, registrable: reg, path_prefix: normalizePathPrefix(path_prefix), include_subdomains: include_subdomains === false || include_subdomains === 0 || include_subdomains === '0' ? 0 : 1 };
}

/** The best rule for (host, path) among candidate rule rows, or null. */
function bestRule(rules, host, path = null) {
    const reg = registrable(host);
    if (!reg) return null;
    let best = null;
    for (const r of rules) {
        const exact = r.host === host;
        const parent = !exact && r.include_subdomains && host.endsWith(`.${r.host}`);
        if (!exact && !parent) continue;
        if (r.host.length < reg.length || !(r.host === reg || r.host.endsWith(`.${reg}`))) continue;
        if (!pathMatches(r.path_prefix, path)) continue;
        if (!best || r.host.length > best.host.length || (r.host.length === best.host.length && r.path_prefix.length > best.path_prefix.length)) best = r;
    }
    return best;
}

/** Every host a lookup could match a rule on: the host and its parents down to the registrable domain. */
function candidateHosts(host) {
    const reg = registrable(host);
    if (!reg) return [];
    const out = [];
    let h = host;
    for (;;) {
        out.push(h);
        if (h === reg) break;
        h = h.slice(h.indexOf('.') + 1);
    }
    return out;
}

const hosts = Object.freeze({
    PSL_RULES, suffixLabels, publicSuffix, registrableDomain,
    HostError, normalizeHost, tryHost, registrable, hostOfUrl, normalizePathPrefix, pathMatches, checkRule, bestRule, candidateHosts,
});

// ─────────────────────────────────────────────────────────────────────────────
// freshness — the generic staleness verdict (Trade `server/domain/freshness.js`, pure half).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The verdict for one source-status row at `now` (epoch ms). A row:
 * { stale_after_sec, last_success_at, stale_since, name, upstream_status, reported_at, terms_note, license_note }.
 * A source is fresh only when its last successful fetch is known and younger than its window
 * (row.stale_after_sec || defaultStaleAfterSec). Everything else is stale; nothing is invented.
 */
function freshnessVerdict(row, now, defaultStaleAfterSec) {
    if (!row) return { known: false, stale: true, staleSince: null, window: defaultStaleAfterSec, lastSuccessAt: null };
    const window = row.stale_after_sec || defaultStaleAfterSec;
    if (row.last_success_at == null) return { known: true, stale: true, staleSince: row.stale_since, window, lastSuccessAt: null };
    const until = row.last_success_at + window * 1000;
    return { known: true, stale: now > until, staleSince: now > until ? until : null, window, lastSuccessAt: row.last_success_at };
}

/** The serialisable view of one status row (Trade's freshness.view shape). */
function freshnessView(row, key, now, defaultStaleAfterSec) {
    const v = freshnessVerdict(row, now, defaultStaleAfterSec);
    return {
        key,
        name: row ? row.name : null,
        known: v.known,
        status: !v.known ? 'unknown' : v.stale ? 'stale' : 'fresh',
        stale: v.stale,
        stale_since: iso(v.staleSince),
        last_success_at: iso(v.lastSuccessAt),
        stale_after_sec: v.window,
        upstream_status: row ? row.upstream_status : null,
        reported_at: row ? iso(row.reported_at) : null,
        terms_note: row ? row.terms_note : null,
        license_note: row ? row.license_note : null,
    };
}

const freshness = Object.freeze({ verdict: freshnessVerdict, view: freshnessView });

// ─────────────────────────────────────────────────────────────────────────────
// Sources client
// ─────────────────────────────────────────────────────────────────────────────

class SourcesError extends Error {
    constructor(code, message, status = null) { super(message); this.name = 'SourcesError'; this.code = code; this.status = status; }
}

/**
 * OpenVibe.Sources client (host-local API, client-credentials token for audience openvibe.sources).
 *
 *   sources.item.read     GET /api/v1/items?category=<cat>&after=&limit=&include_removed=1   (change order)
 *                         GET /api/v1/items/:id
 *   sources.source.read   GET /api/v1/sources          (health and staleness of every source)
 *                         GET /api/v1/sources/:key     (a registry record)
 *
 * config: { networkInternalUrl, oauth: { clientId, clientSecret }, sources: { internalUrl, category, timeoutMs } }.
 * Failures throw a SourcesError with a stable code (sources.not_configured, sources.token_unavailable,
 * sources.unavailable, sources.http_<status>, sources.bad_response); the caller records them. Nothing
 * here invents an item.
 */
function createSourcesClient({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = null } = {}) {
    const src = (config && config.sources) || {};
    const base = src.internalUrl;
    const enabled = Boolean(config && config.oauth && config.oauth.clientSecret && base);
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    const tokens = enabled ? createServiceTokenClient({
        network: config.networkInternalUrl, tokenUrl: config.networkInternalUrl ? `${String(config.networkInternalUrl).replace(/\/+$/, '')}/oauth/token` : undefined,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl, now,
    }) : null;
    const wallMs = timeoutMs || src.timeoutMs || 10000;
    const ITEM = { audience: 'openvibe.sources', scope: 'sources.item.read' };
    const SOURCE = { audience: 'openvibe.sources', scope: 'sources.source.read' };

    async function call(ctx, path) {
        if (!tokens) throw new SourcesError('sources.not_configured', 'OV_OAUTH_CLIENT_SECRET or OV_SOURCES_INTERNAL_URL is not set');
        let auth;
        try { auth = await tokens.authHeaders(ctx); } catch (err) {
            throw new SourcesError('sources.token_unavailable', `No service token for OpenVibe.Sources: ${err.message}`);
        }
        let res;
        try {
            res = await fetchImpl(`${base}${path}`, { headers: { Accept: 'application/json', ...auth }, signal: AbortSignal.timeout(wallMs) });
        } catch (err) {
            throw new SourcesError('sources.unavailable', `OpenVibe.Sources is unreachable: ${err.message}`);
        }
        if (res.status === 401) tokens.invalidate(ctx);
        const body = await res.json().catch(() => null);
        if (!res.ok) {
            throw new SourcesError(`sources.http_${res.status}`, `OpenVibe.Sources answered ${res.status}${body && (body.code || body.detail) ? `: ${body.code || ''} ${body.detail || ''}`.trimEnd() : ''}`, res.status);
        }
        if (!body || typeof body !== 'object') throw new SourcesError('sources.bad_response', 'OpenVibe.Sources sent no JSON');
        return body;
    }

    function category() {
        if (!src.category) throw new SourcesError('sources.bad_response', 'config.sources.category is required');
        return src.category;
    }

    return {
        enabled,
        SourcesError,
        /** One page of items in change order. → { items, next_after, more, sources } */
        async listItems({ after = 0, limit = 100 } = {}) {
            const qs = new URLSearchParams({ category: category(), after: String(after), limit: String(limit), include_removed: '1' });
            const body = await call(ITEM, `/api/v1/items?${qs}`);
            if (!Array.isArray(body.items) || !Number.isInteger(body.next_after)) throw new SourcesError('sources.bad_response', 'items page without items/next_after');
            return body;
        },
        /** One item (with its source's health). → { item, source } */
        async getItem(id) {
            const body = await call(ITEM, `/api/v1/items/${encodeURIComponent(id)}`);
            if (!body.item || typeof body.item.id !== 'string') throw new SourcesError('sources.bad_response', 'item response without item');
            return body;
        },
        /** Every source known to Sources. → { sources: [...] } */
        async listSources() {
            const body = await call(SOURCE, '/api/v1/sources');
            if (!Array.isArray(body.sources)) throw new SourcesError('sources.bad_response', 'sources response without sources');
            return body;
        },
        /** A registry record (name, homepage, health). Failure is the caller's "unknown". */
        async getSource(key) {
            const body = await call(SOURCE, `/api/v1/sources/${encodeURIComponent(key)}`);
            return body.source || body;
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Change cursor + pull
// ─────────────────────────────────────────────────────────────────────────────

/** The ingest cursor's DDL for one prefix (idempotent), for the service's migration file. */
function ingestSchema(prefix) {
    assertPrefix(prefix);
    const T = `${prefix}_ingest_cursor`;
    return `CREATE TABLE IF NOT EXISTS ${T} (
    name       text COLLATE "C" NOT NULL,
    cursor     bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (name)
);
`;
}

/**
 * A named change cursor in <prefix>_ingest_cursor of the product's database. One row per feed
 * (e.g. 'sources'), advanced by pullChanges only past pages that committed. get() reads on the
 * store's handle; set(t, name, value) takes the caller's transaction handle first.
 */
function createChangeCursor(db, { prefix, now } = {}) {
    const { assertDb, sqlOf } = require('./internal');
    assertDb(db);
    assertPrefix(prefix);
    const sql = sqlOf(db);
    const clock = clockOf(now);
    const T = `${prefix}_ingest_cursor`;
    const t$ = sql.ident(T);
    const api = {
        table: T,
        schema: () => ingestSchema(prefix),
        /** Create the table where the handle may (tests, PGlite); services put schema() in a migration. */
        async ensureSchema() { await db.query(ingestSchema(prefix)); return api; },
        /** The stored cursor for `name` (0 when the row is absent). */
        async get(name = 'default') {
            return (await db.value(sql`SELECT cursor FROM ${t$} WHERE name = ${String(name)}`)) || 0;
        },
        /** Advance the cursor for `name`. set(t, name, value) writes on the caller's handle. */
        async set(...args) {
            const t = isHandle(args[0]) ? args[0] : db;
            const [name = 'default', value] = args.slice(isHandle(args[0]) ? 1 : 0);
            const n = Math.floor(Number(value));
            if (!Number.isFinite(n) || n < 0) throw new TypeError('cursor value must be a non-negative integer');
            await t.exec(sql`INSERT INTO ${t$} (name, cursor, updated_at) VALUES (${String(name)}, ${n}, ${clock()})
                ON CONFLICT (name) DO UPDATE SET cursor = GREATEST(${t$}.cursor, excluded.cursor), updated_at = excluded.updated_at`);
            return n;
        },
    };
    return api;
}

/** The apply() result, one of these three strings (or { outcome }). Anything else is a bug. */
const APPLY_OUTCOMES = new Set(['applied', 'hold', 'removed']);
function applyOutcome(value) {
    const o = value && typeof value === 'object' ? value.outcome : value;
    if (!APPLY_OUTCOMES.has(o)) throw new TypeError(`apply(item, t) must return one of ${[...APPLY_OUTCOMES].join(', ')}`);
    return o;
}

/**
 * Pull the change feed from the cursor, applying each item:
 *
 *   - one transaction per page: the page's writes AND the cursor advance commit together, so a crash
 *     replays the page (product writes must be idempotent on (item id, revision));
 *   - one savepoint per item: an item whose apply() throws is rolled back alone and counted as
 *     `failed`, so a bad item never stalls its page or the cursor;
 *   - `hold` is not an error and does not block: the item is counted and the cursor moves past it
 *     (the product records the hold itself, e.g. "no merchant yet").
 *
 * apply(item, t) → 'applied' | 'hold' | 'removed'. A fetch/list failure throws (the caller records it
 * and tries again). → { pages, applied, hold, removed, failed, after }.
 */
async function pullChanges({ db, cursor, source, apply, name = 'default', maxPages = 25, pageSize = 200, onItem = null } = {}) {
    if (typeof apply !== 'function') throw new TypeError('pullChanges needs apply(item, t)');
    if (!source || typeof source.listItems !== 'function') throw new TypeError('pullChanges needs a source with listItems({ after, limit })');
    const counts = { pages: 0, applied: 0, hold: 0, removed: 0, failed: 0 };
    let after = await cursor.get(name);
    const limit = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 200;
    for (let p = 0; p < maxPages; p++) {
        const body = await source.listItems({ after, limit });
        const items = Array.isArray(body.items) ? body.items : [];
        await db.tx(async (t) => {
            for (const item of items) {
                let outcome;
                try {
                    outcome = await t.tx(async (st) => applyOutcome(await apply(item, st)));
                } catch (err) {
                    outcome = 'failed';
                    if (onItem) onItem(item, err, 'failed');
                }
                if (outcome !== 'failed' && onItem) onItem(item, null, outcome);
                counts[outcome] = (counts[outcome] || 0) + 1;
            }
            const next = Number.isInteger(body.next_after) ? Math.max(body.next_after, after) : after;
            await cursor.set(t, name, next);
            after = next;
        });
        counts.pages++;
        if (!body.more) break;
    }
    return { ...counts, after };
}

// ─────────────────────────────────────────────────────────────────────────────
// Signed event consumer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A signed OpenVibe.Events delivery consumer: the shared half of POST /internal/events.
 *
 *   const consumer = createEventConsumer({ db, secrets: config.events.webhookSecrets, consumer: 'deals-sources' });
 *   const r = await consumer.apply(req.body, req.headers, async (event) => { ... });
 *   // r: { status, code? , event_id?, duplicate?, outcome? } — map status onto your HTTP response.
 *
 * The signature is X-OpenVibe-Signature v2 (HMAC-SHA256 of "<t>.<raw body>"), accepted only within
 * ±300 s; a v1-only or stale delivery is refused (openvibe-sdk/events parseDelivery requireV2).
 * Exactly once: the inbox receipt (consumer, event_id) claims in the same transaction as the handler,
 * so a redelivery changes nothing and a failed handler rolls back its receipt and is retried.
 */
function createEventConsumer({ db, secrets, consumer, now = () => Date.now(), table } = {}) {
    const { assertDb } = require('./internal');
    assertDb(db);
    if (!consumer || typeof consumer !== 'string') throw new TypeError('consumer is required (e.g. "deals-sources")');
    const list = [].concat(secrets || []).filter(Boolean);
    const { createPgInbox, parseDelivery } = require('openvibe-sdk/events');
    const inbox = createPgInbox(db, table ? { table, now } : { now });

    function verify(raw, headers) {
        if (!list.length) return null;
        for (const secret of list) {
            const delivery = parseDelivery(raw, headers, secret, { requireV2: true });
            if (delivery) return delivery;
        }
        return null;
    }

    return {
        inbox,
        verify,
        /** One delivery: verify the signature, then run handler(event) once per event_id. */
        async apply(raw, headers, handler) {
            if (!list.length) return { status: 503, code: 'ingest.webhook_disabled' };
            const delivery = verify(raw, headers);
            if (!delivery) return { status: 401, code: 'ingest.bad_signature' };
            const event = delivery.event;
            if (!event || typeof event.event_id !== 'string' || !/^evt_[0-9A-HJKMNP-TV-Z]{26}$/.test(event.event_id)) {
                return { status: 400, code: 'ingest.bad_delivery' };
            }
            const r = await inbox.once(consumer, event.event_id, () => handler(event));
            return { status: 200, event_id: event.event_id, duplicate: r.duplicate, outcome: r.duplicate ? null : (r.result === undefined ? null : r.result) };
        },
    };
}

module.exports = {
    createSourcesClient, SourcesError,
    createChangeCursor, pullChanges, schema: ingestSchema,
    createEventConsumer,
    normalize, hosts, freshness,
};
