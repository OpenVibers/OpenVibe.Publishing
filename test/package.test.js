'use strict';
/** Package shape: every subpath export loads alone, the root is lazy, no server code needs a browser. */
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const pkg = require('../package.json');
const { suite } = require('./helpers/db');

const { test, run } = suite();
const ROOT = path.join(__dirname, '..');
const SUBPATHS = Object.keys(pkg.exports).filter((k) => k !== '.' && k !== './package.json');

test('every subpath export resolves to an existing module', () => {
    assert.deepStrictEqual(SUBPATHS.map((s) => s.slice(2)).sort(),
        ['ai', 'authorship', 'citations', 'discussion', 'index-hooks', 'media', 'revisions', 'schedule', 'seo', 'ssr', 'taxonomy']);
    for (const s of SUBPATHS) assert.ok(require(`openvibe-publishing/${s.slice(2)}`), s);
});

test('each module loads alone in a fresh process, without loading a database driver or the SDK', () => {
    for (const s of SUBPATHS) {
        const code = `const Module = require('module'); const orig = Module._load;
            const banned = ['better-sqlite3', 'pg', '@electric-sql/pglite', 'openvibe-sdk/db'];
            Module._load = function (req, ...rest) { if (banned.includes(req)) throw new Error('loaded ' + req); return orig.call(this, req, ...rest); };
            require('openvibe-publishing/${s.slice(2)}'); console.log('ok');`;
        const r = spawnSync(process.execPath, ['-e', code], { cwd: ROOT, encoding: 'utf8' });
        assert.strictEqual(r.status, 0, `${s}: ${r.stderr}`);
    }
});

test('the root export is lazy and exposes every module', () => {
    const r = spawnSync(process.execPath, ['-e', `const p = require('openvibe-publishing');
        const before = Object.keys(require.cache).filter((f) => f.includes('/lib/')).length;
        const names = Object.keys(p); p.seo.evaluate; const after = Object.keys(require.cache).filter((f) => f.includes('/lib/')).length;
        console.log(JSON.stringify({ names, before, after, v: p.version }));`], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.before, 0);
    assert.ok(out.after > 0);
    assert.strictEqual(out.v, pkg.version);
    assert.deepStrictEqual(out.names.sort(), ['PublishingError', 'ai', 'authorship', 'citations', 'discussion', 'indexHooks', 'media', 'revisions', 'schedule', 'schema', 'seo', 'ssr', 'taxonomy', 'version']);
});

test('the package owns no runtime: no listen(), no database of its own, no env config in lib/', () => {
    const fs = require('fs');
    for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) {
        const src = fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8');
        assert.doesNotMatch(src, /\.listen\(|new Database\(|createDb\(|process\.env|require\('(better-sqlite3|pg|@electric-sql\/pglite)'\)/, `${f} must take the consumer's handle, not open its own`);
    }
});

test('better-sqlite3 is gone from the package; openvibe-sdk is a peer (one copy of the data layer per service)', () => {
    for (const k of ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies']) assert.ok(!(pkg[k] || {})['better-sqlite3'], k);
    assert.strictEqual(pkg.peerDependencies['openvibe-sdk'], '>=0.15.0');
    assert.match(pkg.devDependencies['openvibe-sdk'], /refs\/tags\/v0\.15\.0$/);
    assert.ok(!(pkg.dependencies || {})['openvibe-sdk']);
});

run();
