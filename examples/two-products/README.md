# Two products, one package, two databases

The Wave 15 exit proof. `wiki/app.js` and `blog/app.js` are deliberately small products that
import `openvibe-publishing/*` exactly as a real product would, each opening its **own** SQLite file:

| | Mini wiki | Mini blog |
|---|---|---|
| Database | `wiki.db` — only `wiki_*` tables | `blog.db` — only `blog_*` tables |
| Publication state | `wiki_pages` (owned by the app) | `blog_posts` (owned by the app) |
| Revisions | `wiki_page_revisions` | `blog_post_revisions` |
| Citations | `wiki_citations` (sources required) | `blog_post_citations` (optional) |
| Gate policy | `minWords 30`, `requireSources` | `minWords 20` |
| Feeds | Atom + JSON Feed | RSS + JSON Feed |
| Also | redirects, AI authorship + review, index events | taxonomy, scheduling, media attachments |

```bash
node examples/two-products/wiki/app.js   # http://127.0.0.1:4801/p/rye
node examples/two-products/blog/app.js   # http://127.0.0.1:4811/posts/first-loaf
```

Both use temp databases and made-up sample text. The assertions live in
[../../test/two-products.test.js](../../test/two-products.test.js).
