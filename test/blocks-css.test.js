'use strict';
/**
 * blocks.css is the one sheet for the blocks' look. It must keep up with the renderer: a class lib/blocks.js or
 * lib/media.js writes into a class attribute needs a rule here, or the block shows as bare browser markup on every
 * site at once (a wiki's infobox as an indented list, a stat with no space between the number and its label).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const blocks = require('../lib/blocks');
const pkg = require('../package.json');
const { suite } = require('./helpers/db');

const t = suite();
const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'blocks.css'), 'utf8');
const hasRule = (cls) => new RegExp(`\\.${cls}(?![a-z0-9-])`).test(css);

/** Every ov-… class written inside a class="…" attribute or passed as a class name in a renderer's source. */
function emitted(file) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const out = new Set();
    const add = (c) => { if (/^ov-[a-z0-9-]*[a-z0-9]$/.test(c)) out.add(c); };
    Array.from(src.matchAll(/class="([^"]*)/g)).forEach((m) => m[1].split(/\s+/).forEach(add));
    Array.from(src.matchAll(/'(ov-[a-z0-9-]*[a-z0-9])'/g)).forEach((m) => add(m[1]));
    return [...out].sort();
}

t.test('every class the renderers emit has a rule in blocks.css', () => {
    const classes = [...new Set([...emitted('lib/blocks.js'), ...emitted('lib/media.js')])];
    assert.ok(classes.length >= 30, `found ${classes.length} classes: the scan no longer reads the renderers`);
    const missing = classes.filter((c) => !hasRule(c));
    assert.deepStrictEqual(missing, [], `blocks.css has no rule for: ${missing.join(', ')}`);
});

t.test('every callout tone has its own rule', () => {
    blocks.CALLOUT_TONES.forEach((tone) => assert.ok(hasRule(`ov-callout-${tone}`), tone));
});

t.test('the sheet uses the shared theme tokens only, each with a fallback, and no site class', () => {
    const allowed = new Set(['--accent', '--border', '--border-light', '--bg-card', '--bg-tertiary', '--text-primary', '--text-secondary', '--text-muted', '--warning', '--success', '--ovnav-real-h']);
    Array.from(css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*([,)])/g)).forEach(([, name, next]) => {
        assert.ok(allowed.has(name), `${name} is not a shared theme token`);
        assert.strictEqual(next, ',', `${name} needs a fallback`);
    });
    const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/\.[a-z][a-z0-9-]*/g) || [];
    const foreign = [...new Set(selectors.filter((s) => !s.startsWith('.ov-')))];
    assert.deepStrictEqual(foreign, [], `only .ov-* classes belong here: ${foreign.join(', ')}`);
});

t.test('the package ships and exports the sheet', () => {
    assert.strictEqual(pkg.exports['./blocks.css'], './blocks.css');
    assert.ok(pkg.files.includes('blocks.css'));
    assert.strictEqual(require.resolve('openvibe-publishing/blocks.css'), path.join(ROOT, 'blocks.css'));
});

t.run();
