'use strict';
/**
 * openvibe-publishing — every module is also its own entry point and can be used alone:
 *   require('openvibe-publishing/revisions'), …/schedule, …/taxonomy, …/citations, …/media,
 *   …/discussion, …/seo, …/authorship, …/index-hooks, …/ssr, …/ai, …/ingest, …/publication
 * This root export loads each one lazily, on first access.
 *
 * schema({ revisions: 'wiki_page', citations: 'wiki', … }) is the DDL of every store a product uses,
 * for its migration file (keys are module names; a value is a prefix or a list of prefixes).
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
    ai: './lib/ai',
    ingest: './lib/ingest',
    publication: './lib/publication',
};

/** Which function gives each storing module's DDL. */
const SCHEMAS = {
    revisions: (p) => require('./lib/revisions').schema(p),
    citations: (p) => require('./lib/citations').schema(p),
    media: (p) => require('./lib/media').schema(p),
    discussion: (p) => require('./lib/discussion').schema(p),
    schedule: (p) => require('./lib/schedule').schema(p),
    authorship: (p) => require('./lib/authorship').schema(p),
    taxonomy: (p) => require('./lib/taxonomy').schema(p),
    seo: (p) => require('./lib/seo').redirectsSchema(p),
    indexHooks: (p) => require('./lib/index-hooks').sequencerSchema(p),
    ingest: (p) => require('./lib/ingest').schema(p),
};

function schema(stores = {}) {
    const parts = [];
    for (const [name, prefixes] of Object.entries(stores)) {
        if (!SCHEMAS[name]) throw new TypeError(`schema: no store in module "${name}" (one of ${Object.keys(SCHEMAS).join(', ')})`);
        for (const p of [].concat(prefixes)) parts.push(`-- openvibe-publishing/${name === 'indexHooks' ? 'index-hooks' : name} (prefix ${p})\n${SCHEMAS[name](p)}`);
    }
    return parts.join('\n');
}

const api = {};
for (const [name, path] of Object.entries(MODULES)) {
    Object.defineProperty(api, name, { enumerable: true, get: () => require(path) });
}
Object.defineProperty(api, 'PublishingError', { enumerable: true, get: () => require('./lib/internal').PublishingError });
Object.defineProperty(api, 'schema', { enumerable: true, value: schema });
Object.defineProperty(api, 'version', { enumerable: true, value: require('./package.json').version });

module.exports = api;
