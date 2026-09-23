'use strict';
/**
 * openvibe-publishing — every module is also its own entry point and can be used alone:
 *   require('openvibe-publishing/revisions'), …/schedule, …/taxonomy, …/citations, …/media,
 *   …/discussion, …/seo, …/authorship, …/index-hooks, …/ssr
 * This root export loads each one lazily, on first access.
 */
const MODULES = {
    revisions: './lib/revisions',
    schedule: './lib/schedule',
    taxonomy: './lib/taxonomy',
    citations: './lib/citations',
    media: './lib/media',
    discussion: './lib/discussion',
    seo: './lib/seo',
    authorship: './lib/authorship',
    indexHooks: './lib/index-hooks',
    ssr: './lib/ssr',
};

const api = {};
for (const [name, path] of Object.entries(MODULES)) {
    Object.defineProperty(api, name, { enumerable: true, get: () => require(path) });
}
Object.defineProperty(api, 'PublishingError', { enumerable: true, get: () => require('./lib/internal').PublishingError });
Object.defineProperty(api, 'version', { enumerable: true, value: require('./package.json').version });

module.exports = api;
