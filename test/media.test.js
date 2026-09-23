'use strict';
const assert = require('assert');
const { openDb, fakeClock, suite } = require('./helpers/db');
const { createAttachmentStore, mediaRef, figureHtml, isMediaId } = require('../lib/media');
const contracts = require('openvibe-contracts');

const { test, run } = suite();
const MED = 'med_01J8Z6Q3KX0000000000000000';
const MED2 = 'med_01J8Z6Q3KX0000000000000001';

test('attachments reference Media ids and validate as Contracts MediaRef', () => {
    const media = createAttachmentStore(openDb('media'), { prefix: 'blog_post', now: fakeClock() });
    const a = media.attach({ entityId: 'post_1', mediaId: MED, role: 'cover', alt: 'A loaf' });
    assert.strictEqual(a.state, 'unverified');
    assert.strictEqual(a.broken, false);
    assert.ok(contracts.validate('media.media-ref@1', mediaRef(a)).valid);
    assert.ok(isMediaId('legacy:live:vod:123'));
    assert.throws(() => media.attach({ entityId: 'post_1', mediaId: 'https://cdn.example/x.png' }), (e) => e.code === 'media.invalid_id');
    assert.strictEqual(media.table, 'blog_post_attachments');
});

test('a deleted Media object surfaces an explicit broken-asset state', () => {
    const media = createAttachmentStore(openDb('media'), { prefix: 'blog_post', now: fakeClock() });
    media.attach({ entityId: 'post_1', mediaId: MED, role: 'cover', caption: 'Crumb' });
    media.attach({ entityId: 'post_2', mediaId: MED });
    media.attach({ entityId: 'post_2', mediaId: MED2 });
    assert.deepStrictEqual(media.markBroken(MED, 'deleted'), ['post_1', 'post_2']);
    const [att] = media.list('post_1');
    assert.strictEqual(att.state, 'broken');
    assert.strictEqual(att.brokenReason, 'deleted');
    assert.ok(att.checkedAt);
    assert.strictEqual(media.broken('post_2').length, 1);
    const html = figureHtml(att, { urlFor: () => 'https://openvibe.media/o/x' });
    assert.match(html, /data-state="broken"/);
    assert.match(html, /no longer available/);
    assert.doesNotMatch(html, /<img/, 'no image and no guessed URL for a broken object');
    assert.match(html, /<figcaption>Crumb<\/figcaption>/);
});

test('verify(): 404 → broken, found → available, outage → unchanged (check_failed)', async () => {
    const media = createAttachmentStore(openDb('media'), { prefix: 'wiki_page', now: fakeClock() });
    media.attach({ entityId: 'pg', mediaId: MED });
    media.attach({ entityId: 'pg', mediaId: MED2 });
    const out = await media.verify('pg', { resolve: async (id) => (id === MED ? { exists: true } : { exists: false, reason: 'not_found' }) });
    assert.deepStrictEqual(out.map((o) => o.outcome), ['available', 'broken']);
    const outage = await media.verify('pg', { resolve: async () => { throw new Error('ECONNREFUSED'); } });
    assert.deepStrictEqual(outage.map((o) => o.outcome), ['check_failed', 'check_failed']);
    assert.deepStrictEqual(media.list('pg').map((a) => a.state), ['available', 'broken'], 'an outage changes nothing');
    media.markAvailable(MED2);
    assert.strictEqual(media.list('pg')[1].state, 'available');
});

test('figureHtml escapes alt/caption and needs a URL builder for available media', () => {
    const att = { mediaId: MED, state: 'available', alt: '"><script>x</script>', caption: '<b>c</b>' };
    const html = figureHtml(att, { urlFor: (id) => `https://openvibe.media/o/${id}` });
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;b&gt;c&lt;\/b&gt;/);
    assert.throws(() => figureHtml(att), /urlFor/);
});

run();
