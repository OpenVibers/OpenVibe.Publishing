'use strict';
/** A fresh on-disk SQLite database in a temp directory, removed at exit. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const dirs = [];
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function tempDir(tag = 'pub') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ovpub-${tag}-`));
    dirs.push(dir);
    return dir;
}

function openDb(tag) {
    const db = new Database(path.join(tempDir(tag), 'test.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return db;
}

/** A controllable clock. */
function fakeClock(start = Date.parse('2026-09-22T12:00:00Z')) {
    let t = start;
    const now = () => t;
    now.advance = (ms) => { t += ms; return t; };
    now.set = (ms) => { t = ms; return t; };
    return now;
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
            console.log(`${tests.length - failed}/${tests.length} passed`);
            if (failed) process.exit(1);
        },
    };
}

module.exports = { openDb, tempDir, fakeClock, suite };
