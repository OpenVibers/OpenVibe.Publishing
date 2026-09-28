'use strict';
/**
 * Test databases: real PostgreSQL in-process (PGlite, through openvibe-sdk/db), as ADR-035 asks.
 *
 *   const db = await openDb();          // this file's database, emptied (a fresh public schema)
 *   const other = await newDb();        // a second, separate database (two products)
 *
 * Starting PGlite takes a second or two, so a test file shares one instance and each openDb()
 * starts it over from an empty schema. suite().run() closes every database it opened.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDb, sql } = require('openvibe-sdk/db');

const dirs = [];
const opened = [];
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function tempDir(tag = 'pub') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ovpub-${tag}-`));
    dirs.push(dir);
    return dir;
}

/** A separate PGlite database (in memory, or persisted in `dir`). */
async function newDb({ dir } = {}) {
    const db = createDb({ pglite: dir || true, service: 'publishing-test' });
    opened.push(db);
    await db.value(sql`SELECT 1 AS ok`);
    return db;
}

/** Empty a database: drop and recreate the public schema (tables, indexes, trigger functions). */
async function resetDb(db) {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    return db;
}

let shared = null;
/** This file's database, emptied. */
async function openDb() {
    if (!shared) shared = newDb();
    return resetDb(await shared);
}

/** Queries `fn` sends through `db` (the handle's own counter). */
async function countQueries(db, fn) {
    const before = db.stats().queries;
    const out = await fn();
    return { count: db.stats().queries - before, out };
}

/** A controllable clock. */
function fakeClock(start = Date.parse('2026-09-22T12:00:00Z')) {
    let t = start;
    const now = () => t;
    now.advance = (ms) => { t += ms; return t; };
    now.set = (ms) => { t = ms; return t; };
    return now;
}

async function closeAll() {
    for (const db of opened.splice(0)) await db.close().catch(() => {});
}

/** Tiny async-aware test runner: test(name, fn) then run(). */
function suite() {
    const tests = [];
    return {
        test(name, fn) { tests.push({ name, fn }); },
        async run() {
            let failed = 0;
            for (const t of tests) {
                try { await t.fn(); console.log(`  ok   ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n${err && err.stack || err}`); }
            }
            await closeAll();
            console.log(`${tests.length - failed}/${tests.length} passed`);
            if (failed) process.exit(1);
        },
    };
}

module.exports = { openDb, newDb, resetDb, tempDir, countQueries, fakeClock, suite, sql };
