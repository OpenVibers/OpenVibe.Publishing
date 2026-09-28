'use strict';
const assert = require('assert');
const { openDb, fakeClock, suite } = require('./helpers/db');
const { createAttachmentStore, mediaRef, figureHtml, isMediaId } = require('../lib/media');
const contracts = require('openvibe-contracts');

const { test, run } = suite();
const MED = 'med_01J8Z6Q3KX0000000000000000';
const MED2 = 'med_01J8Z6Q3KX0000000000000001';

const store = async (prefix) => createAttachmentStore(await openDb(), { prefix, now: fakeClock() }).ensureSchema();

test('attachments reference Media ids and validate as Contracts MediaRef', async () => {
    const media = await store('blog_post');
    const a = await media.attach({ entityId: 'post_1', mediaId: MED, role: 'cover', alt: 'A loaf' });
    assert.strictEqual(a.state, 'unverified');
    assert.strictEqual(a.broken, false);
    assert.ok(contracts.validate('media.media-ref@1', mediaRef(a)).valid);
    assert.ok(isMediaId('legacy:live:vod:123'));
    await assert.rejects(media.attach({ entityId: 'post_1', mediaId: 'https://cdn.example/x.png' }), (e) => e.code === 'media.invalid_id');
    assert.strictEqual(media.table, 'blog_post_attachments');
    assert.deepStrictEqual(await media.get(a.id), a);
    assert.strictEqual(await media.detach('post_2', a.id), false, 'detach names the entity');
    assert.strictEqual(await media.detach('post_1', a.id), true);
    assert.deepStrictEqual(await media.list('post_1'), []);
});

test('a deleted Media object surfaces an explicit broken-asset state', async () => {
    const media = await store('blog_post');
    await media.attach({ entityId: 'post_1', mediaId: MED, role: 'cover', caption: 'Crumb' });
    await media.attach({ entityId: 'post_2', mediaId: MED });
    await media.attach({ entityId: 'post_2', mediaId: MED2 });
    await media.attach({ entityId: 'post_2', mediaId: MED, revision: 3 });
    assert.deepStrictEqual(await media.entitiesUsing(MED), ['post_1', 'post_2']);
    assert.deepStrictEqual(await media.entitiesUsing(MED, { after: 'post_1' }), ['post_2'], 'keyset page');
    assert.deepStrictEqual(await media.markBroken(MED, 'deleted'), ['post_1', 'post_2']);
    const [att] = await media.list('post_1');
    assert.strictEqual(att.state, 'broken');
    assert.strictEqual(att.brokenReason, 'deleted');
    assert.ok(att.checkedAt);
    assert.strictEqual((await media.broken('post_2')).length, 2);
    assert.strictEqual((await media.list('post_2', { revision: 2 })).length, 2, 'entity-wide attachments, not revision 3\'s');
    assert.strictEqual((await media.list('post_2', { revision: 3 })).length, 3);
    await assert.rejects(media.markBroken(MED, 'gone'), /reason/);
    const html = figureHtml(att, { urlFor: () => 'https://openvibe.media/o/x' });
    assert.match(html, /data-state="broken"/);
    assert.match(html, /no longer available/);
    assert.doesNotMatch(html, /<img/, 'no image and no guessed URL for a broken object');
    assert.match(html, /<figcaption>Crumb<\/figcaption>/);
});

test('verify(): 404 → broken, found → available, outage → unchanged (check_failed)', async () => {
    const media = await store('wiki_page');
    await media.attach({ entityId: 'pg', mediaId: MED });
    await media.attach({ entityId: 'pg', mediaId: MED2 });
    const out = await media.verify('pg', { resolve: async (id) => (id === MED ? { exists: true } : { exists: false, reason: 'not_found' }) });
    assert.deepStrictEqual(out.map((o) => o.outcome), ['available', 'broken']);
    const outage = await media.verify('pg', { resolve: async () => { throw new Error('ECONNREFUSED'); } });
    assert.deepStrictEqual(outage.map((o) => o.outcome), ['check_failed', 'check_failed']);
    assert.deepStrictEqual((await media.list('pg')).map((a) => a.state), ['available', 'broken'], 'an outage changes nothing');
    assert.strictEqual((await media.list('pg'))[1].brokenReason, 'not_found');
    await media.markAvailable(MED2);
    assert.strictEqual((await media.list('pg'))[1].state, 'available');
    assert.strictEqual((await media.list('pg'))[1].brokenReason, null);
});

test('figureHtml escapes alt/caption and needs a URL builder for available media', () => {
    const att = { mediaId: MED, state: 'available', alt: '"><script>x</script>', caption: '<b>c</b>' };
    const html = figureHtml(att, { urlFor: (id) => `https://openvibe.media/o/${id}` });
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;b&gt;c&lt;\/b&gt;/);
    assert.throws(() => figureHtml(att), /urlFor/);
});

run();
