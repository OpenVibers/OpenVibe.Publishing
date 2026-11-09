'use strict';
const assert = require('assert');
const blocks = require('../lib/blocks');
const { suite } = require('./helpers/db');

const { test, run } = suite();

const MED = 'med_01J8ZQ4X3M000000000000000A';
const MED2 = 'med_01J8ZQ4X3M000000000000000B';
const clip = 'clp_01J8ZQ4X3M000000000000000C';

test('a block directive parses into a tree; prose around it stays prose', () => {
    const tree = blocks.parse([
        'Some intro.',
        '',
        ':::hero{art="' + MED + '" kicker="Devblog" date="2026-11-09"}',
        'The teaser.',
        ':::',
        '',
        ':::section{id="blueprint-rework" by="usr_01J8ZQ4X3M000000000000000D" react}',
        '## Blueprint rework',
        'The prose.',
        ':::figure{src="' + MED + '" alt="The header"}',
        ':::',
        ':::',
    ].join('\n'));
    assert.strictEqual(tree.type, 'root');
    const kinds = tree.children.map((c) => c.type);
    assert.deepStrictEqual(kinds, ['text', 'hero', 'section']);
    const hero = tree.children[1];
    assert.strictEqual(hero.attrs.art, MED);
    assert.strictEqual(hero.attrs.kicker, 'Devblog');
    assert.strictEqual(hero.attrs.date, '2026-11-09');
    assert.deepStrictEqual(hero.children.map((c) => c.type), ['text']);
    const section = tree.children[2];
    assert.strictEqual(section.attrs.id, 'blueprint-rework');
    assert.strictEqual(section.attrs.react, true);
    assert.deepStrictEqual(section.children.map((c) => c.type), ['text', 'figure']);
    assert.strictEqual(section.children[1].attrs.src, MED);
});

test('a one-line block closes itself; attributes parse in every quoting', () => {
    const tree = blocks.parse([
        ':::figure{src="' + MED + '" alt="A"}',
        ':::',
        ':::stat{value=43 label="sites updated"}',
        ':::',
    ].join('\n'));
    assert.deepStrictEqual(tree.children.map((c) => c.type), ['figure', 'stat']);
    assert.strictEqual(tree.children[0].children.length, 0);
    assert.strictEqual(tree.children[1].attrs.value, '43');
    assert.strictEqual(tree.children[1].attrs.label, 'sites updated');
});

test('a ::: inside a code fence is prose, not a directive', () => {
    const tree = blocks.parse(['```', ':::figure{src="x"}', ':::', '```', '', 'after.'].join('\n'));
    assert.deepStrictEqual(tree.children.map((c) => c.type), ['text']);
    assert.match(tree.children[0].value, /:::figure/);
});

test('validate names what is missing and what is malformed', () => {
    const good = blocks.parse(':::figure{src="' + MED + '" alt="A"}\n:::');
    assert.deepStrictEqual(blocks.validate(good), { ok: true, errors: [] });

    const bad = blocks.parse([
        ':::figure{src="not-a-media-id"}\n:::',
        ':::stat{value="1"}\n:::',
        ':::section{id="A B"}\n:::',
        ':::callout{tone="loud"}\n:::',
        ':::nope{}\n:::',
    ].join('\n'));
    const out = blocks.validate(bad);
    assert.strictEqual(out.ok, false);
    const messages = out.errors.map((e) => e.message);
    assert.ok(messages.some((m) => /figure src must be a Media object id/.test(m)), messages.join(' | '));
    assert.ok(messages.some((m) => /"stat" needs label/.test(m)), messages.join(' | '));
    assert.ok(messages.some((m) => /section id must be a lowercase slug/.test(m)), messages.join(' | '));
    assert.ok(messages.some((m) => /callout tone must be one of/.test(m)), messages.join(' | '));
    assert.ok(messages.some((m) => /unknown block type/.test(m)), messages.join(' | '));
});

test('two sections may not share an id', () => {
    const tree = blocks.parse(':::section{id="a"}\nx\n:::\n:::section{id="a"}\ny\n:::');
    const out = blocks.validate(tree);
    assert.strictEqual(out.ok, false);
    assert.ok(out.errors.some((e) => /share the id/.test(e.message)));
});

test('toText gives a feed and an AI reader the words, without the markup', () => {
    const tree = blocks.parse([
        'The intro.',
        ':::figure{src="' + MED + '" alt="A lit stage"}\n:::',
        ':::stat{value="43" label="sites updated"}\n:::',
        ':::section{id="s"}\nSome **bold** words.\n:::',
    ].join('\n'));
    const text = blocks.toText(tree);
    assert.match(text, /The intro\./);
    assert.match(text, /A lit stage/);
    assert.match(text, /43 sites updated/);
    assert.match(text, /Some bold words\./);
    assert.doesNotMatch(text, /\*\*/);
});

test('the renderer writes plain HTML: an image, a credit, a details, a form', () => {
    const tree = blocks.parse([
        ':::figure{src="' + MED + '" alt="The stage" credit="Screenshot, openvibe.live"}',
        ':::',
        ':::patchnotes{from="2026-11-02" to="2026-11-09"}',
        ':::',
        ':::section{id="blueprint-rework" react}',
        '## Blueprint rework',
        'Prose.',
        ':::',
    ].join('\n'));
    const html = blocks.render(tree, {
        media: (id) => (id === MED ? { width: 1200, height: 630, alt: 'The stage' } : null),
        urlFor: (id) => 'https://media.openvibe.live/o/' + id,
        patchNotes: () => [{ site: 'openvibe.blog', commits: [{ sha: 'abc1234', url: 'https://git/commit/abc1234', title: 'Blueprint rework' }] }],
        reactions: { 'blueprint-rework': { up: 12, down: 1 } },
        reactionAction: '/p/post-1/react',
        csrf: 'tok',
        signedIn: true,
    });
    assert.match(html, /<img src="https:\/\/media\.openvibe\.live\/o\//);
    assert.match(html, /alt="The stage"/);
    assert.match(html, /width="1200"/);
    assert.match(html, /height="630"/);
    assert.match(html, /Screenshot, openvibe\.live/);
    assert.match(html, /<details class="ov-patchnotes"><summary>1 change across 1 site<\/summary>/);
    assert.match(html, /<code>abc1234<\/code>/);
    assert.match(html, /<form class="ov-reactions" method="post" action="\/p\/post-1\/react"/);
    assert.match(html, /name="section" value="blueprint-rework"/);
    assert.match(html, /👍 <span class="ov-react-count">12<\/span>/);
    assert.match(html, /👎 <span class="ov-react-count">1<\/span>/);
    assert.match(html, /<h2>Blueprint rework<\/h2>/);
    assert.doesNotMatch(html, /<script/);
});

test('only the first image is eager; the rest are lazy', () => {
    const tree = blocks.parse([
        ':::figure{src="' + MED + '" alt="one"}\n:::',
        ':::figure{src="' + MED2 + '" alt="two"}\n:::',
    ].join('\n'));
    const html = blocks.render(tree, {
        media: () => ({ width: 800, height: 600 }),
        urlFor: (id) => 'https://media.openvibe.live/o/' + id,
    });
    assert.strictEqual((html.match(/loading="lazy"/g) || []).length, 1);
    assert.ok(html.indexOf('loading="lazy"') > html.indexOf('data-media-id="' + MED + '"'));
});

test('a signed-out reader is asked to sign in; a broken media says so', () => {
    const tree = blocks.parse(':::figure{src="' + MED + '" alt="x"}\n:::\n:::section{id="s" react}\nx\n:::');
    const html = blocks.render(tree, {
        media: () => null,
        urlFor: () => 'https://media.openvibe.live/o/x',
        signedIn: false,
        loginUrl: '/auth/login?next=%2Fpost',
    });
    assert.match(html, /This media is no longer available\./);
    assert.match(html, /Sign in to react/);
    assert.doesNotMatch(html, /<form class="ov-reactions"/);
});

test('an AI image says "Made with <model>"; a source image keeps its licence and author', () => {
    const ai = blocks.creditLine({ kind: 'ai', model: 'FLUX.1' });
    assert.strictEqual(ai, 'Made with FLUX.1');
    const src = blocks.creditLine({ kind: 'source', author: 'Jane Roe', licence: 'CC BY 4.0', authorUrl: 'https://commons.example/jane', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/' });
    assert.match(src, /Jane Roe/);
    assert.match(src, /CC BY 4\.0/);
    assert.match(src, /<a href="https:\/\/commons\.example\/jane"/);
    assert.strictEqual(blocks.creditLine(null), '');
    assert.strictEqual(blocks.creditLine({ kind: 'text', text: 'Screenshot' }), 'Screenshot');
});

test('an unknown block renders as nothing, and never as raw HTML', () => {
    const tree = blocks.parse(':::mystery{}\n:::');
    assert.strictEqual(blocks.render(tree, {}), '');
    const xss = blocks.parse(':::callout{tone="info"}\n<script>alert(1)</script>\n:::');
    const html = blocks.render(xss, {});
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
});

test('the compare, gallery, callout, stat, quote, infobox and timeline blocks render', () => {
    const tree = blocks.parse([
        ':::compare{before="' + MED + '" after="' + MED2 + '" caption="Before and after"}\n:::',
        ':::gallery{items="' + MED + ',' + MED2 + '"}\n:::',
        ':::callout{tone="warn" title="Careful"}\nWatch out.\n:::',
        ':::stat{value="43" label="sites updated"}\n:::',
        ':::quote{by="Ada"}\nIt works.\n:::',
        ':::infobox{title="The facts"}\nReleased: 2026-11-09\n:::',
        ':::timeline{title="When"}\n2026-11-02: We started.\n:::',
    ].join('\n'));
    const html = blocks.render(tree, { media: () => ({ width: 100, height: 100 }), urlFor: (id) => '/o/' + id });
    assert.match(html, /ov-compare/);
    assert.match(html, /Before and after/);
    assert.match(html, /ov-gallery-grid/);
    assert.match(html, /ov-callout-warn/);
    assert.match(html, /Watch out\./);
    assert.match(html, /<span class="ov-stat-value">43<\/span>/);
    assert.match(html, /<blockquote class="ov-quote"/);
    assert.match(html, /— Ada/);
    assert.match(html, /ov-infobox-key">Released/);
    assert.match(html, /ov-timeline-when/);
});

test('serialize writes the Markdown that parses back into the same tree', () => {
    const md = [
        'Some intro.',
        '',
        ':::hero{art="' + MED + '" kicker="Devblog" date="2026-11-09"}',
        'The teaser.',
        ':::',
        '',
        ':::section{id="blueprint-rework" by="usr_01J8ZQ4X3M000000000000000D" react}',
        '## Blueprint rework',
        ':::figure{src="' + MED + '" alt="A"}',
        ':::',
        ':::',
    ].join('\n');
    const tree = blocks.parse(md);
    const back = blocks.parse(blocks.serialize(tree));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(back)), JSON.parse(JSON.stringify(tree)));
    assert.match(blocks.serialize(tree), /:::hero\{art="med_/);
    assert.match(blocks.serialize(tree), /:::section\{id="blueprint-rework"/);
    assert.match(blocks.serialize(tree), /react/);
});

test('serialize quotes what needs quoting and writes a bare flag', () => {
    const tree = blocks.parse(':::section{id="a-b" by="usr_01J8ZQ4X3M000000000000000D" react}\nText with "quotes"\n:::');
    const md = blocks.serialize(tree);
    assert.match(md, /:::section\{id="a-b" by="usr_01J8ZQ4X3M000000000000000D" react\}/);
    assert.match(md, /Text with "quotes"/);
});

run();

// render() is safe on its own: an embed that is not http(s) is never a link (a caller may skip validate()).
{
    const b = require('../lib/blocks');
    const html = b.render(b.parse(':::embed{url="javascript:alert(1)"}\n:::\n'));
    require('assert').ok(!/href="javascript:/i.test(html), html);
    const ok = b.render(b.parse(':::embed{url="https://example.com/x"}\n:::\n'));
    require('assert').ok(/href="https:\/\/example.com\/x"/.test(ok), ok);
}

// 1.6.1: a timeline and an infobox have one row per line; "10:45: text" keeps the time whole; list markers go.
{
    const b = require('../lib/blocks');
    const assert = require('assert');
    const tl = b.render(b.parse(':::timeline\n- 10:45: Stage two is live\n- 2026-11-09: Shared 4.168\nA note without a time\n:::\n'));
    assert.strictEqual((tl.match(/<li class="ov-timeline-item">/g) || []).length, 3, tl);
    assert.ok(tl.includes('<time class="ov-timeline-when" datetime="10:45">10:45</time><span class="ov-timeline-text">Stage two is live</span>'), tl);
    assert.ok(tl.includes('datetime="2026-11-09"'), tl);
    const ib = b.render(b.parse(':::infobox{title="Release"}\nVersion: 4.168.0\nShipped — 9 November\n:::\n'));
    assert.strictEqual((ib.match(/<div class="ov-infobox-row">/g) || []).length, 2, ib);
    assert.ok(ib.includes('<dt class="ov-infobox-key">Shipped</dt><dd class="ov-infobox-value">9 November</dd>'), ib);
}

