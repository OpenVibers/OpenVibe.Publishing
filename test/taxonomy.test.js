'use strict';
const assert = require('assert');
const { openDb, countQueries, suite } = require('./helpers/db');
const { createTaxonomy, slugify } = require('../lib/taxonomy');

const { test, run } = suite();

const taxonomy = async (prefix) => createTaxonomy(await openDb(), { prefix }).ensureSchema();

test('slugify', () => {
    assert.strictEqual(slugify('Crème Brûlée & Co.'), 'creme-brulee-co');
    assert.strictEqual(slugify("Baker's  Guide"), 'bakers-guide');
    assert.strictEqual(slugify('日本 料理'), '日本-料理');
    assert.throws(() => slugify('!!!'), /slug/);
    assert.ok(slugify('x'.repeat(200)).length <= 80);
});

test('terms are unique per vocabulary slug; ensureTerm is get-or-create', async () => {
    const tax = await taxonomy('blog');
    const a = await tax.ensureTerm({ vocabulary: 'tag', name: 'Sourdough' });
    const b = await tax.ensureTerm({ vocabulary: 'tag', name: 'sourdough' });
    const c = await tax.ensureTerm({ vocabulary: 'category', name: 'Sourdough' });
    assert.strictEqual(a.id, b.id);
    assert.notStrictEqual(a.id, c.id);
    assert.strictEqual(typeof a.id, 'number');
    assert.strictEqual((await tax.bySlug('tag', 'sourdough')).name, 'Sourdough');
    assert.deepStrictEqual(tax.tables, { terms: 'blog_terms', links: 'blog_term_links' });
    // concurrent get-or-create of one new slug gives one term
    const racing = await Promise.all([1, 2, 3].map(() => tax.ensureTerm({ vocabulary: 'tag', name: 'Rye' })));
    assert.strictEqual(new Set(racing.map((t) => t.id)).size, 1);
});

test('hierarchical categories: ancestors (breadcrumbs), descendants, tree, cycles refused', async () => {
    const tax = await taxonomy('wiki');
    const food = await tax.ensureTerm({ vocabulary: 'category', name: 'Food' });
    const baking = await tax.ensureTerm({ vocabulary: 'category', name: 'Baking', parentId: food.id });
    const bread = await tax.ensureTerm({ vocabulary: 'category', name: 'Bread', parentId: baking.id });
    assert.deepStrictEqual((await tax.ancestors(bread.id)).map((t) => t.name), ['Food', 'Baking', 'Bread']);
    assert.deepStrictEqual((await tax.descendants(food.id)).map((t) => t.name).sort(), ['Baking', 'Bread']);
    assert.deepStrictEqual((await tax.children(food.id)).map((t) => t.name), ['Baking']);
    const tree = await tax.tree('category');
    assert.strictEqual(tree.length, 1);
    assert.strictEqual(tree[0].children[0].children[0].name, 'Bread');
    await assert.rejects(tax.setParent(food.id, bread.id), (e) => e.code === 'term.cycle');
    await assert.rejects(tax.setParent(food.id, food.id), (e) => e.code === 'term.cycle');
    const tag = await tax.ensureTerm({ vocabulary: 'tag', name: 'x' });
    await assert.rejects(tax.setParent(tag.id, food.id), (e) => e.code === 'term.parent_vocabulary');
    await assert.rejects(tax.setParent(999999, food.id), (e) => e.code === 'term.not_found');
    assert.strictEqual((await tax.setParent(bread.id, food.id)).parentId, food.id);
    assert.strictEqual((await tax.setParent(bread.id, null)).parentId, null);
});

test('setTerms replaces one vocabulary; entitiesFor includes descendants on request', async () => {
    const tax = await taxonomy('blog');
    const food = await tax.ensureTerm({ vocabulary: 'category', name: 'Food' });
    const bread = await tax.ensureTerm({ vocabulary: 'category', name: 'Bread', parentId: food.id });
    await tax.setTerms('post_1', 'tag', ['Rye', 'rye', 'Starter']);
    await tax.setTerms('post_1', 'category', [bread.id]);
    await tax.setTerms('post_2', 'category', [food.id]);
    assert.deepStrictEqual((await tax.termsFor('post_1', 'tag')).map((t) => t.slug), ['rye', 'starter']);
    await tax.setTerms('post_1', 'tag', ['Starter']);
    assert.deepStrictEqual((await tax.termsFor('post_1', 'tag')).map((t) => t.slug), ['starter']);
    assert.strictEqual((await tax.termsFor('post_1', 'category')).length, 1, 'other vocabularies untouched');
    assert.deepStrictEqual(await tax.entitiesFor(food.id), ['post_2']);
    assert.deepStrictEqual(await tax.entitiesFor(food.id, { includeDescendants: true }), ['post_1', 'post_2']);
    assert.deepStrictEqual(await tax.entitiesFor(food.id, { includeDescendants: true, after: 'post_1' }), ['post_2'], 'keyset page');
    await assert.rejects(tax.setTerms('post_1', 'tag', [bread.id]), (e) => e.code === 'term.vocabulary_mismatch');
    await assert.rejects(tax.setTerms('post_1', 'tag', [424242]), (e) => e.code === 'term.not_found');
    assert.deepStrictEqual((await tax.termsFor('post_1', 'tag')).map((t) => t.slug), ['starter'], 'a refused setTerms changes nothing');
});

test('setTerms runs a fixed number of statements, however many terms (no N+1)', async () => {
    const db = await openDb();
    const t2 = await createTaxonomy(db, { prefix: 'blog' }).ensureSchema();
    const three = await countQueries(db, () => t2.setTerms('post_a', 'tag', ['a', 'b', 'c']));
    const forty = await countQueries(db, () => t2.setTerms('post_b', 'tag', Array.from({ length: 40 }, (_, i) => `tag ${i}`)));
    assert.strictEqual(forty.out.length, 40);
    assert.strictEqual(forty.count, three.count, `${three.count} statements for 3 terms, ${forty.count} for 40`);
    const listed = await countQueries(db, () => t2.entitiesFor(forty.out[0].id, { includeDescendants: true }));
    assert.strictEqual(listed.count, 1);
});

test('remove re-parents children and drops links', async () => {
    const tax = await taxonomy('blog');
    const a = await tax.ensureTerm({ vocabulary: 'category', name: 'A' });
    const b = await tax.ensureTerm({ vocabulary: 'category', name: 'B', parentId: a.id });
    const c = await tax.ensureTerm({ vocabulary: 'category', name: 'C', parentId: b.id });
    await tax.setTerms('e', 'category', [b.id]);
    assert.strictEqual(await tax.remove(b.id), true);
    assert.strictEqual((await tax.get(c.id)).parentId, a.id);
    assert.deepStrictEqual(await tax.termsFor('e'), []);
    assert.strictEqual((await tax.rename(a.id, '  All  ')).name, 'All');
    await assert.rejects(tax.rename(a.id, '   '), /name is required/);
    await assert.rejects(tax.remove(b.id), (e) => e.code === 'term.not_found');
});

test('terms() pages by name with a keyset cursor', async () => {
    const tax = await taxonomy('blog');
    for (const n of ['delta', 'alpha', 'echo', 'bravo', 'charlie']) await tax.ensureTerm({ vocabulary: 'tag', name: n });
    const p1 = await tax.terms('tag', { limit: 2 });
    const p2 = await tax.terms('tag', { limit: 2, after: p1[1] });
    const p3 = await tax.terms('tag', { limit: 2, after: p2[1] });
    assert.deepStrictEqual([...p1, ...p2, ...p3].map((t) => t.name), ['alpha', 'bravo', 'charlie', 'delta', 'echo']);
});

run();
