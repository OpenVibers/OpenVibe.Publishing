# Two products, one package, two databases

The Wave 15 exit proof. `wiki/app.js` and `blog/app.js` are deliberately small products that
import `openvibe-publishing/*` exactly as a real product would, each with its **own** database (an
`openvibe-sdk/db` handle: PostgreSQL in production, PGlite here):

| | Mini wiki | Mini blog |
|---|---|---|
| Database | only `wiki_*` tables | only `blog_*` tables |
| Schema | `wiki/migrations/0001_initial.sql` | `blog/migrations/0001_initial.sql` |
| Publication state | `wiki_pages` (owned by the app) | `blog_posts` (owned by the app) |
| Revisions | `wiki_page_revisions` | `blog_post_revisions` |
| Citations | `wiki_citations` (sources required) | `blog_post_citations` (optional) |
| Gate policy | `minWords 30`, `requireSources` | `minWords 20` |
| Feeds | Atom + JSON Feed | RSS + JSON Feed |
| Also | redirects, AI authorship + review, index events in an outbox (same transaction) | taxonomy, scheduling, media attachments |

Each migration is the product's own tables plus `require('openvibe-publishing').schema({ … })` for the
stores it uses, written by `node examples/two-products/migrations.js --write` and applied with
`db.migrate()`, the way a service does it. Writes that belong together run in one `db.tx`, with the
transaction handle passed to every store call; feeds and sitemaps read in batches
(`revisions.getMany`, `citations.forRevisions`, `reviews.latestMany`, `taxonomy.termsForMany`).

```bash
node examples/two-products/wiki/app.js   # http://127.0.0.1:4801/p/rye
node examples/two-products/blog/app.js   # http://127.0.0.1:4811/posts/first-loaf
```

Both use in-memory PGlite and made-up sample text. The assertions live in
[../../test/two-products.test.js](../../test/two-products.test.js).
