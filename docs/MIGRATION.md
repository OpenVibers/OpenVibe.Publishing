# Adopting a Publishing release

How a content product (Blog, Coupons, Deals, News, Reviews, Trade, Wiki) moves to each
`openvibe-publishing` release. [CHANGELOG.md](../CHANGELOG.md) lists every change; this page is the
order of work. One section per step; do them in order.

Rules that hold for every step:

- **Pin the release tarball**, never a `file:` link or a vendored copy:
  `"openvibe-publishing": "https://codeload.github.com/OpenVibers/OpenVibe.Publishing/tar.gz/refs/tags/vX.Y.Z"`.
- **Lockfile:** copy the `node_modules/openvibe-publishing` entry (`version`, `resolved`, `integrity`)
  from a product already on that tag. Never leave `integrity` empty and never write one by hand; if no
  product is on the tag yet, run the install in the product's own pipeline so npm computes it.
- Every release is additive; a product only changes what its section lists.

## v0.4 → v1.0.0

Mostly mechanical:

1. Pin `openvibe-publishing` v1.0.0, `openvibe-sdk` v0.15.0 and `pg`; `@electric-sql/pglite` for tests.
2. Put `publishing.schema({ … })` for the stores and prefixes the product uses into its
   `migrations/0001_initial.sql` (with its own tables), so the SDK's `importSqlite` finds every table
   when it moves the SQLite data.
3. Pass the `openvibe-sdk/db` handle instead of the better-sqlite3 one, and `await` every store call.
4. Replace `db.transaction(() => { … })()` around store calls with `await db.tx(async (t) => { … })`
   and pass `t` as the first argument of every store call inside it.
5. Beyond `await`: `stamp(t, doc)` takes the handle first; `redirects.resolve()`'s `currentPath`
   may be async (and should be); rows come back with parsed JSON (`fields`, `meta`, `ref`, `result`)
   exactly as the store shapes already returned them; list methods cap at their `limit`; loops of
   per-item reads in list routes become the batch reads in the README ("Lists are bounded").

## v1.0.0 → v1.1.0

Adds `openvibe-publishing/ingest` and `openvibe-publishing/publication`; nothing existing changes.
The five content products (News, Reviews, Deals, Coupons, Trade) each delete their own copy of this code.

- **package.json:** `"openvibe-publishing": "https://codeload.github.com/OpenVibers/OpenVibe.Publishing/tar.gz/refs/tags/v1.1.0"`.
- **Lockfile:** copy the entry from a product already on v1.1.0 (or later, then take that product's
  v1.1.0 history); `version` `1.1.0`, the matching `resolved` URL, the real `integrity`.
- **Require lines:**
  ```js
  const ingest = require('openvibe-publishing/ingest');           // Sources client, change cursor, pullChanges, event consumer, normalisers, PSL
  const { createPublication } = require('openvibe-publishing/publication');  // gate → document → stamp → events → outbox, IndexNow ping
  ```
  The ingest cursor's table comes from the product's migrations: `publishing.schema({ ingest: … })`
  (`<prefix>_ingest_cursor`); the runtime role cannot create tables.
- **Files to delete** (the product-local copies named in `lib/publication.js`'s header):
  News `domain/publication.js`, Reviews `service.js` (the publication part), Deals `domain/indexing.js`,
  Coupons `domain/publication.js`, Trade `domain/indexing.js`; plus the product's private Sources
  client, change-cursor loop, signed-event inbox and normalisers that `openvibe-publishing/ingest` now
  provides. What stays per product: the gate facts, facets, the document body and the domain tables.
  Delete a file only once its callers use the shared module.
- **Test:** the product's own suite (`ov test`), including its ingest and publication tests; the
  Publishing side is `test/ingest.test.js` and `test/publication.test.js`.

## v1.1.0 → v1.2.0

Adds `openvibe-publishing/layout`; nothing existing changes. The seven publication sites each hand-wrote
the page document; `renderDocument` replaces that, composed over `openvibe-shared/shell` `page()`.

- **package.json:** pin `openvibe-publishing` at `…/refs/tags/v1.2.0` **and** `openvibe-shared` at
  `https://codeload.github.com/OpenVibers/OpenVibe.Shared/tar.gz/refs/tags/v2.6.0`. `layout` requires
  `openvibe-shared/shell`, which exists only from Shared v2.6.0; the other entry points keep the
  `>=1.5.0` peer range, so an older Shared fails only on `require('openvibe-publishing/layout')`.
- **Lockfile:** copy both the `node_modules/openvibe-publishing` (1.2.0) and
  `node_modules/openvibe-shared` (2.6.0) entries from a product already on those tags
  (OpenVibe.News main). Never an empty or invented `integrity`.
- **Require line:** `const layout = require('openvibe-publishing/layout');`
- **What views call:** `layout.renderDocument({ site, siteName, title, description, canonical, decision,
  jsonLd, feeds, navbar, footer, navLinks, css, release, account, body, … })` and send the string.
  - `decision` is the gate's decision and is the robots source (`decision.robots`; canonical is
    `decision.canonical || canonical`). Without a decision (or an explicit `robots` string) it throws
    `TypeError`: no page is indexable by default.
  - `title` is composed by the caller; `body` is the `<main>` HTML; `css`, `scripts`, `head`, `header`,
    `account`, `body`, `shipped` are trusted markup the caller built; everything else is escaped.
  - It adds the head extras, the body frame (skip link, `#navbar-mount`, `<main>`) and the footer init
    the shell never emits. Styling is unchanged.
- **Files to delete:** the product's hand-written document/layout function body (its `<html>…</html>`
  template, head tags, skip link, footer init); keep a thin wrapper that builds the navbar/footer config
  and calls `renderDocument`.
- **Worked example:** OpenVibe.News main, `server/render/layout.js` (`renderPage` builds `nav`,
  `footer`, `account` and returns `layout.renderDocument({ site: 'news', … })`), landed in News PR #6.
- **Test:** the product's page/render tests (`ov test`); Publishing's side is `test/layout.test.js`.

## v1.2.0 → v1.3.0

Additive: `layout.renderDocument` forwards the AI summary to the shell. Everything else is unchanged,
and a product that passes none of the four options renders exactly as on v1.2.0.

- **package.json:** `"openvibe-publishing": "https://codeload.github.com/OpenVibers/OpenVibe.Publishing/tar.gz/refs/tags/v1.3.0"`.
  `openvibe-shared` stays at v2.6.0 or later (that is where `seo.pageSummary` and the shell's `summary`
  support already live).
- **Lockfile:** copy the `node_modules/openvibe-publishing` entry (`1.3.0`, the matching `resolved`,
  the real `integrity`) from a product already on the tag.
- **What changes in the product:** pass `summary` on the home render (and on any other page that has
  a real one-line summary, e.g. an article or a review), so the `ai-summary` meta lands on the page.
  - `layout.renderDocument({ …, summary, facts, updated, url })` — `summary` is the one-line AI
    summary, `facts` the `[[key, value], string]` (or `[string]`) rows, `updated` the ISO date, `url`
    absolute and defaulting to the canonical.
  - `summary` alone gives `<meta name="ai-summary">` plus a `WebPage` JSON-LD tag; with `summary`,
    `facts` adds the `<noscript><section data-ai-summary>` block and `updated` becomes `dateModified`.
    Without a `summary`, `facts`, `updated` and `url` emit nothing.
  - **Only pass what the facts support.** A missing rating, price, date or author is left out of the
    facts block, never defaulted — the same rule as every other structured output here.
- **Test:** the product's page/render tests (`ov test`); Publishing's side is `test/layout.test.js`.
