'use strict';
/**
 * Helpers shared by the modules in this package. Not a public entry point.
 *
 * Every storage module works on a better-sqlite3 handle the consumer owns and names its tables
 * with the consumer's prefix, so a product's publication state stays in the product's database.
 */
const crypto = require('crypto');

const PREFIX_RE = /^[a-z][a-z0-9_]{0,39}$/;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** An error with an HTTP status and a stable code, ready for contracts.http.sendProblem(res, status, code, …). */
class PublishingError extends Error {
    constructor(status, code, message, extra = {}) {
        super(message);
        this.name = 'PublishingError';
        this.status = status;
        this.code = code;
        Object.assign(this, extra);
    }
}

function assertDb(db) {
    if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
        throw new TypeError('a better-sqlite3 database handle is required');
    }
}

function assertPrefix(prefix) {
    if (typeof prefix !== 'string' || !PREFIX_RE.test(prefix)) {
        throw new TypeError(`prefix must match ${PREFIX_RE} (got ${JSON.stringify(prefix)})`);
    }
    return prefix;
}

function clockOf(now) {
    if (now == null) return () => Date.now();
    if (typeof now !== 'function') throw new TypeError('now must be a function returning epoch milliseconds');
    return () => {
        const t = Number(now());
        if (!Number.isFinite(t)) throw new TypeError('now() must return epoch milliseconds');
        return t;
    };
}

/** Time-sortable id with a type prefix: rev_01J…, job_01J…. */
function newId(prefix, nowMs = Date.now()) {
    let time = '';
    for (let t = Math.floor(nowMs), i = 0; i < 10; i++, t = Math.floor(t / 32)) time = ALPHABET[t % 32] + time;
    const bytes = crypto.randomBytes(16);
    let rand = '';
    for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i] % 32];
    return `${prefix}_${time}${rand}`;
}

function sha256(text) {
    return crypto.createHash('sha256').update(String(text)).digest('hex');
}

/** Stable JSON: object keys sorted, so the same fields always hash the same. */
function stableStringify(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function parseJson(text, fallback = null) {
    if (text == null) return fallback;
    try { return JSON.parse(text); } catch { return fallback; }
}

function assertEntityId(id, name = 'entityId') {
    if (typeof id !== 'string' || !id || id.length > 200) throw new TypeError(`${name} must be a non-empty string of at most 200 characters`);
    return id;
}

function assertRevisionNumber(n, name = 'revision') {
    if (!Number.isInteger(n) || n < 0) throw new TypeError(`${name} must be a non-negative integer`);
    return n;
}

/** ISO-8601 instant or null. Never invents a time: missing stays null. */
function isoOrNull(value, name) {
    if (value == null || value === '') return null;
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) throw new TypeError(`${name} must be a valid date`);
    return d.toISOString();
}

/**
 * Append-only protection for a table: UPDATE always aborts, DELETE aborts unless the entity was
 * first registered in `<purgeTable>` (an audited, explicit erasure path).
 */
function immutableTriggers(table, purgeTable, keyColumn = 'entity_id') {
    return `
        CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
        BEGIN SELECT RAISE(ABORT, '${table} rows are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
        WHEN NOT EXISTS (SELECT 1 FROM ${purgeTable} WHERE entity_id = OLD.${keyColumn})
        BEGIN SELECT RAISE(ABORT, '${table} rows are never deleted outside a recorded purge'); END;
    `;
}

module.exports = {
    PublishingError, assertDb, assertPrefix, clockOf, newId, sha256, stableStringify, parseJson,
    assertEntityId, assertRevisionNumber, isoOrNull, immutableTriggers, PREFIX_RE,
};
