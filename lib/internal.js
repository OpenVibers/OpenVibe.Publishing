'use strict';
/**
 * Helpers shared by the modules in this package. Not a public entry point.
 *
 * Every storage module works on an openvibe-sdk/db handle the consumer owns (PostgreSQL through
 * PgBouncer in production, PGlite in tests; ADR-035) and names its tables with the consumer's
 * prefix, so a product's publication state stays in the product's database.
 *
 * Handles: every data method of a store takes an optional transaction handle as its first argument.
 *   await revisions.create({ … })                         // runs on the store's db
 *   await db.tx(async (t) => {                            // one transaction with the caller's own writes
 *       await t.exec(sql`UPDATE pages SET … WHERE id = ${id}`);
 *       await revisions.create(t, { … });
 *   });
 * A store write that needs several statements runs them in db.tx() on its own, or in a savepoint of the
 * caller's transaction (t.tx), so a store call is all or nothing either way and a caller can catch its
 * error (a 412 conflict, say) and still commit the rest.
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

/** An openvibe-sdk/db handle: the pool (createDb) or a transaction/savepoint handle (db.tx gives it). */
function isHandle(x) {
    return x != null && typeof x === 'object' && typeof x.query === 'function' && typeof x.tx === 'function';
}

function assertDb(db) {
    if (db && typeof db.prepare === 'function' && typeof db.query !== 'function') {
        throw new TypeError('openvibe-publishing 1.x takes an openvibe-sdk/db handle (createDb); better-sqlite3 handles are 0.4.x');
    }
    if (!isHandle(db) || typeof db.many !== 'function' || typeof db.maybe !== 'function' || typeof db.exec !== 'function') {
        throw new TypeError('an openvibe-sdk/db handle is required (createDb from openvibe-sdk/db)');
    }
}

/**
 * The sql tag of the handle's own openvibe-sdk copy: fragments are recognised by the handle that built
 * them, so a store never mixes two copies of the SDK.
 */
function sqlOf(db) {
    if (typeof db.sql === 'function' && typeof db.sql.ident === 'function') return db.sql;
    return require('openvibe-sdk/db').sql;
}

/**
 * Public methods from implementations whose first parameter is the handle to run on:
 * api.m(...args) runs on `db`; api.m(t, ...args) runs inside the caller's transaction `t`.
 */
function bindHandles(db, impl) {
    const api = {};
    for (const [name, fn] of Object.entries(impl)) {
        api[name] = (...args) => (isHandle(args[0]) ? fn(...args) : fn(db, ...args));
    }
    return api;
}

/** Serialises writers of one key until the transaction ends (pg_advisory_xact_lock: fine behind PgBouncer). */
function lockKey(t, sql, key) {
    return t.query(sql`SELECT pg_advisory_xact_lock(hashtextextended(${String(key)}, 0))`);
}

/** A bounded list size: an integer in [1, max], `fallback` when missing or not a number. */
function boundedLimit(limit, fallback = 1000, max = 10000) {
    const n = Math.floor(Number(limit));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(max, n));
}

/** A positive safe integer id, or null (a lookup by a malformed id finds nothing instead of erroring). */
function toId(v) {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** An integer that fits a PostgreSQL integer column, or null. */
function toInt4(v) {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isInteger(n) && n >= -2147483648 && n <= 2147483647 ? n : null;
}

/**
 * Validated (entityId, number) references for the batch reads (getMany, forRevisions, latestMany):
 * at most `max`, each with a string entity id; a number that cannot exist maps to null.
 */
function revisionRefs(refs, max = 1000) {
    if (!Array.isArray(refs)) throw new TypeError('refs must be an array of { entityId, revision }');
    if (refs.length > max) throw new TypeError(`at most ${max} refs per call`);
    return refs.map((r) => {
        if (!r || typeof r.entityId !== 'string' || !r.entityId) throw new TypeError('each ref needs an entityId');
        const n = toInt4(r.revision != null ? r.revision : r.number);
        return { entityId: r.entityId, number: n != null && n >= 0 ? n : null };
    });
}

const refKey = (entityId, number) => `${entityId}\u0000${number}`;

/** jsonb comes back parsed; tolerate text (a column read through another path) and null. */
function jsonValue(v, fallback = null) {
    if (v == null) return fallback;
    if (typeof v === 'string') return parseJson(v, fallback);
    return v;
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
 * Append-only protection for a table, in PL/pgSQL: UPDATE always aborts; DELETE aborts unless the
 * entity was first registered in `purgeTable` (an audited, explicit erasure path). Without a purge
 * table, only UPDATE is refused. SQLSTATE 23001 (restrict_violation). TRUNCATE is not a row operation:
 * the runtime role behind PgBouncer has no TRUNCATE privilege (ADR-035), and the owner's one-time
 * import (importSqlite truncate) needs it.
 */
function immutableTriggers(table, purgeTable = null, keyColumn = 'entity_id') {
    const deleteRule = purgeTable
        ? `IF NOT EXISTS (SELECT 1 FROM ${purgeTable} WHERE entity_id = OLD.${keyColumn}) THEN
        RAISE EXCEPTION '${table} rows are never deleted outside a recorded purge' USING ERRCODE = 'restrict_violation';
    END IF;
    `
        : '';
    return `CREATE OR REPLACE FUNCTION ${table}_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION '${table} rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    ${deleteRule}RETURN OLD;
END
$$;
CREATE OR REPLACE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${table}_guard();
${purgeTable ? `CREATE OR REPLACE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${table}_guard();\n` : ''}`;
}

module.exports = {
    PublishingError, assertDb, isHandle, sqlOf, bindHandles, lockKey, boundedLimit, toId, toInt4, jsonValue, revisionRefs, refKey,
    assertPrefix, clockOf, newId, sha256, stableStringify, parseJson,
    assertEntityId, assertRevisionNumber, isoOrNull, immutableTriggers, PREFIX_RE,
};
