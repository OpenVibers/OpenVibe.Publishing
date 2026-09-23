'use strict';
const assert = require('assert');
const ssr = require('../lib/ssr');
const { diffText } = require('../lib/diff');
const { suite } = require('./helpers/db');

const { test, run } = suite();

test('html`` escapes interpolations unless raw()', () => {
    const name = '<img src=x onerror=alert(1)>';
    const out = String(ssr.html`<h1>${name}</h1>${ssr.raw('<em>ok</em>')}${null}${['a', '<b>']}`);
    assert.strictEqual(out, '<h1>&lt;img src=x onerror=alert(1)&gt;</h1><em>ok</em>a&lt;b&gt;');
    assert.strictEqual(ssr.escapeHtml(`"'&`), '&quot;&#39;&amp;');
});

test('markdown: the supported subset renders; raw HTML and unsafe links do not', () => {
    const src = [
        '# Title', '', 'Some **bold**, *em*, ~~gone~~ and `code <x>`.', '',
        '- one', '- two', '', '1. first', '2. second', '', '> quoted', '', '---', '',
        '```js', 'const a = "<b>";', '```', '',
        '[site](https://openvibe.wiki/p) [bad](javascript:alert(1)) <script>alert(1)</script>',
        'Bare https://example.org/x?a=1&b=2.',
    ].join('\n');
    const html = ssr.renderMarkdown(src);
    assert.match(html, /<h2>Title<\/h2>/, '# is demoted: the page owns <h1>');
    assert.match(html, /<strong>bold<\/strong>, <em>em<\/em>, <del>gone<\/del> and <code>code &lt;x&gt;<\/code>/);
    assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
    assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
    assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
    assert.match(html, /<pre><code class="language-js">const a = &quot;&lt;b&gt;&quot;;<\/code><\/pre>/);
    assert.match(html, /<a href="https:\/\/openvibe.wiki\/p" rel="nofollow ugc noopener">site<\/a>/);
    assert.doesNotMatch(html, /href="javascript/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /<a href="https:\/\/example.org\/x\?a=1&amp;b=2" rel="nofollow ugc noopener">https:\/\/example.org\/x\?a=1&amp;b=2<\/a>\./);
    assert.match(ssr.renderMarkdown('[a](/local)', { rel: 'noopener' }), /<a href="\/local" rel="noopener">a<\/a>/);
    assert.doesNotMatch(ssr.renderMarkdown('[a](//evil.test)'), /<a /);
    assert.doesNotMatch(ssr.renderMarkdown('[x](https://a.test/"onmouseover="alert(1))'), /" onmouseover|"onmouseover="alert/);
});

test('markdown: pathological input renders in linear time (no ReDoS)', () => {
    let codeRuns = '';
    for (let k = 1; codeRuns.length < 60000; k++) codeRuns += `a${'`'.repeat(k)}`;
    const cases = {
        heading: `# a${' '.repeat(6000)}x`,
        fence: `\`\`\`${' '.repeat(60000)}!`,
        strong: '**x '.repeat(40000),
        underscore: ' __x'.repeat(40000),
        strike: '~~x '.repeat(40000),
        codeRuns,
    };
    for (const [name, src] of Object.entries(cases)) {
        const started = Date.now();
        ssr.renderMarkdown(src);
        const ms = Date.now() - started;
        assert.ok(ms < 1000, `renderMarkdown ${name} took ${ms}ms`);
    }
    const started = Date.now();
    ssr.markdownToText('['.repeat(100000));
    assert.ok(Date.now() - started < 1000, `markdownToText took ${Date.now() - started}ms`);
});

test('markdown: code spans, emphasis and headings keep their meaning', () => {
    assert.strictEqual(ssr.renderMarkdown('# Title ##  '), '<h2>Title</h2>');
    assert.strictEqual(ssr.renderMarkdown('## a # b #'), '<h3>a # b</h3>');
    assert.strictEqual(ssr.renderMarkdown('```  js  \nx\n```'), '<pre><code class="language-js">x</code></pre>');
    assert.strictEqual(ssr.renderMarkdown('``a`b`` and `c` ``d`'), '<p><code>a`b</code> and <code>c</code> `<code>d</code></p>');
    assert.strictEqual(ssr.renderMarkdown('**a** **b **c** ~~d~~ x__y__ __z__'), '<p><strong>a</strong> <strong>b **c</strong> <del>d</del> x__y__ <strong>z</strong></p>');
    assert.strictEqual(ssr.markdownToText('[a [b](https://x.test) c'), '[a b c');
});

test('markdownToText and wordCount', () => {
    assert.strictEqual(ssr.markdownToText('# Hi\n\nSome **bold** [link](https://x.test).\n\n```\ncode\n```'), 'Hi Some bold link. code');
    assert.strictEqual(ssr.markdownToText('one two three four', 10), 'one two…');
    assert.strictEqual(ssr.wordCount("It's a rye-bread loaf, 2 kg."), 6);
    assert.strictEqual(ssr.wordCount(''), 0);
});

test('pagination is plain links and clamps out-of-range pages', () => {
    const p = ssr.paginate({ page: 3, perPage: 10, total: 95, href: (n) => `/tags/rye?page=${n}` });
    assert.strictEqual(p.pages, 10);
    assert.strictEqual(p.offset, 20);
    assert.strictEqual(p.prev.href, '/tags/rye?page=2');
    const html = ssr.paginationHtml(p);
    assert.match(html, /<a href="\/tags\/rye\?page=2" rel="prev">/);
    assert.match(html, /<span aria-current="page">3<\/span>/);
    assert.match(html, /<a href="\/tags\/rye\?page=10">10<\/a>/);
    const far = ssr.paginate({ page: 99, perPage: 10, total: 95, href: (n) => `?p=${n}` });
    assert.strictEqual(far.page, 10);
    assert.strictEqual(far.outOfRange, true);
    assert.strictEqual(ssr.paginationHtml(ssr.paginate({ total: 3, href: String })), '');
});

test('breadcrumbs, diff markup and honest <time>', () => {
    const bc = ssr.breadcrumbsHtml([{ name: 'Food', url: '/food' }, { name: '<Rye>', url: '/food/rye' }]);
    assert.strictEqual(bc, '<nav class="ov-breadcrumbs" aria-label="Breadcrumb"><ol><li><a href="/food">Food</a></li><li aria-current="page">&lt;Rye&gt;</li></ol></nav>');
    const d = ssr.diffHtml(diffText('a <b>', 'a <i>', { mode: 'word' }));
    assert.match(d, /<del>b<\/del><ins>i<\/ins>/);
    assert.doesNotMatch(d, /<b>/);
    assert.strictEqual(ssr.timeTag(null), '');
    assert.strictEqual(ssr.timeTag('not a date'), '');
    assert.strictEqual(ssr.timeTag('2026-09-20T10:00:00Z'), '<time datetime="2026-09-20T10:00:00.000Z">2026-09-20</time>');
});

run();
