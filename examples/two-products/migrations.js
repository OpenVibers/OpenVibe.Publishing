'use strict';
/**
 * The two example products' first migrations, built the way a service builds its own: the product's
 * tables, then openvibe-publishing's schema() for the stores it uses. A service writes this text into
 * migrations/0001_initial.sql once and never edits it after it runs (a later library schema change
 * arrives as the service's next migration).
 *
 *   node examples/two-products/migrations.js --write    # regenerate wiki/ and blog/ migrations
 *
 * test/two-products.test.js checks the committed files still match.
 */
const fs = require('fs');
const path = require('path');
const publishing = require('openvibe-publishing');

const HEADER = '-- phase: expand\n';

const FILES = {
    'wiki/migrations/0001_initial.sql': () => `${HEADER}-- Mini wiki: its own tables, then the openvibe-publishing stores it uses.
CREATE TABLE wiki_pages (
    id                 text PRIMARY KEY,
    slug               text NOT NULL UNIQUE,
    owner              text NOT NULL,
    visibility         text NOT NULL DEFAULT 'public',
    state              text NOT NULL DEFAULT 'draft',
    published_revision integer,
    published_at       bigint,
    updated_at         bigint NOT NULL
);
CREATE INDEX wiki_pages_published ON wiki_pages (published_at DESC, id) WHERE state = 'published';
CREATE TABLE wiki_outbox (
    id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    envelope jsonb NOT NULL
);
${publishing.schema({ revisions: 'wiki_page', citations: 'wiki', seo: 'wiki_page', authorship: 'wiki_page', indexHooks: 'wiki' })}`,

    'blog/migrations/0001_initial.sql': () => `${HEADER}-- Mini blog: its own table, then the openvibe-publishing stores it uses.
CREATE TABLE blog_posts (
    id                 text PRIMARY KEY,
    slug               text NOT NULL UNIQUE,
    author_name        text,
    visibility         text NOT NULL DEFAULT 'public',
    state              text NOT NULL DEFAULT 'draft',
    published_revision integer,
    published_at       bigint,
    updated_at         bigint NOT NULL
);
CREATE INDEX blog_posts_published ON blog_posts (published_at DESC, id) WHERE state = 'published';
${publishing.schema({ revisions: 'blog_post', citations: 'blog_post', taxonomy: 'blog', schedule: 'blog', media: 'blog_post' })}`,
};

/** [{ file, expected, actual }] */
function check() {
    return Object.entries(FILES).map(([rel, build]) => {
        const file = path.join(__dirname, rel);
        return { file, expected: build(), actual: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null };
    });
}

module.exports = { check, FILES };

if (require.main === module && process.argv.includes('--write')) {
    for (const { file, expected } of check()) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, expected);
        console.log(`wrote ${path.relative(process.cwd(), file)}`);
    }
}
