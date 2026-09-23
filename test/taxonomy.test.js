'use strict';
const assert = require('assert');
const { openDb, suite } = require('./helpers/db');
const { createTaxonomy, slugify } = require('../lib/taxonomy');

const { test, run } = suite();

test('slugify', () => {
    assert.strictEqual(slugify('Crème Brûlée & Co.'), 'creme-brulee-co');
    assert.strictEqual(slugify("Baker's  Guide"), 'bakers-guide');
    assert.strictEqual(slugify('日本 料理'), '日本-料理');
    assert.throws(() => slugify('!!!'), /slug/);
    assert.ok(slugify('x'.repeat(200)).length <= 80);
});

test('terms are unique per vocabulary slug; ensureTerm is get-or-create', () => {
    const tax = createTaxonomy(openDb('tax'), { prefix: 'blog' });
    const a = tax.ensureTerm({ vocabulary: 'tag', name: 'Sourdough' });
    const b = tax.ensureTerm({ vocabulary: 'tag', name: 'sourdough' });
    const c = tax.ensureTerm({ vocabulary: 'category', name: 'Sourdough' });
    assert.strictEqual(a.id, b.id);
    assert.notStrictEqual(a.id, c.id);
    assert.strictEqual(tax.bySlug('tag', 'sourdough').name, 'Sourdough');
    assert.deepStrictEqual(tax.tables, { terms: 'blog_terms', links: 'blog_term_links' });
});

test('hierarchical categories: ancestors (breadcrumbs), descendants, tree, cycles refused', () => {
    const tax = createTaxonomy(openDb('tax'), { prefix: 'wiki' });
    const food = tax.ensureTerm({ vocabulary: 'category', name: 'Food' });
    const baking = tax.ensureTerm({ vocabulary: 'category', name: 'Baking', parentId: food.id });
    const bread = tax.ensureTerm({ vocabulary: 'category', name: 'Bread', parentId: baking.id });
    assert.deepStrictEqual(tax.ancestors(bread.id).map((t) => t.name), ['Food', 'Baking', 'Bread']);
    assert.deepStrictEqual(tax.descendants(food.id).map((t) => t.name).sort(), ['Baking', 'Bread']);
    const tree = tax.tree('category');
    assert.strictEqual(tree.length, 1);
    assert.strictEqual(tree[0].children[0].children[0].name, 'Bread');
    assert.throws(() => tax.setParent(food.id, bread.id), (e) => e.code === 'term.cycle');
    assert.throws(() => tax.setParent(food.id, food.id), (e) => e.code === 'term.cycle');
    const tag = tax.ensureTerm({ vocabulary: 'tag', name: 'x' });
    assert.throws(() => tax.setParent(tag.id, food.id), (e) => e.code === 'term.parent_vocabulary');
});

test('setTerms replaces one vocabulary; entitiesFor includes descendants on request', () => {
    const tax = createTaxonomy(openDb('tax'), { prefix: 'blog' });
    const food = tax.ensureTerm({ vocabulary: 'category', name: 'Food' });
    const bread = tax.ensureTerm({ vocabulary: 'category', name: 'Bread', parentId: food.id });
    tax.setTerms('post_1', 'tag', ['Rye', 'rye', 'Starter']);
    tax.setTerms('post_1', 'category', [bread.id]);
    tax.setTerms('post_2', 'category', [food.id]);
    assert.deepStrictEqual(tax.termsFor('post_1', 'tag').map((t) => t.slug), ['rye', 'starter']);
    tax.setTerms('post_1', 'tag', ['Starter']);
    assert.deepStrictEqual(tax.termsFor('post_1', 'tag').map((t) => t.slug), ['starter']);
    assert.strictEqual(tax.termsFor('post_1', 'category').length, 1, 'other vocabularies untouched');
    assert.deepStrictEqual(tax.entitiesFor(food.id), ['post_2']);
    assert.deepStrictEqual(tax.entitiesFor(food.id, { includeDescendants: true }), ['post_1', 'post_2']);
    assert.throws(() => tax.setTerms('post_1', 'tag', [bread.id]), (e) => e.code === 'term.vocabulary_mismatch');
});

test('remove re-parents children and drops links', () => {
    const tax = createTaxonomy(openDb('tax'), { prefix: 'blog' });
    const a = tax.ensureTerm({ vocabulary: 'category', name: 'A' });
    const b = tax.ensureTerm({ vocabulary: 'category', name: 'B', parentId: a.id });
    const c = tax.ensureTerm({ vocabulary: 'category', name: 'C', parentId: b.id });
    tax.setTerms('e', 'category', [b.id]);
    tax.remove(b.id);
    assert.strictEqual(tax.get(c.id).parentId, a.id);
    assert.deepStrictEqual(tax.termsFor('e'), []);
    assert.strictEqual(tax.rename(a.id, '  All  ').name, 'All');
});

run();
