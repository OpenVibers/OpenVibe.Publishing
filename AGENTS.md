# AGENTS.md — OpenVibe.Publishing

## Project Overview

OpenVibe.Publishing is the shared **library** of publishing behaviour for the OpenVibe publication products (Wiki, Blog,
News, Reviews, Deals, Coupons, Trade) and for the record products that use its Search feed/relay: revisions,
scheduling, taxonomy, citations, media/discussion references, the indexability gate, feeds/sitemaps, authorship and AI
disclosure, Search documents and envelopes, server-rendered page layout, the block model, the Sources ingest chassis
and the publication glue.

- **Package:** `openvibe-publishing` · **Version:** 1.7.1 · **Runtime:** CommonJS, Node ≥20 (production Node 22) ·
  **License:** MIT
- **It is code, never state.** It has no runtime, port, domain, database, API, migration directory or deploy of its own.
  It must never get one. Products pin the release tarball; the state lives in each product's database with that
  product's table prefix.
- **Read first:** [README.md](README.md), [docs/MIGRATION.md](docs/MIGRATION.md), [CHANGELOG.md](CHANGELOG.md),
  [examples/two-products/](examples/two-products/).

**Network context:** the package implements **no capability and holds no grant**. Modules call services with the
**product's** token client: `discussion` → OpenVibe.Community `community.comment.write`; `ai` → OpenVibe.AI
`ai.run.create`/`ai.run.read`; `media.verify()` → OpenVibe.Media `media.object.read`; `ingest` → OpenVibe.Sources
`sources.item.read`/`sources.source.read`. It stores references, never comment content, media bytes or source items.

## Commands

```bash
npm ci                         # install (devDependencies include contracts; peers come from the consumer)
npm test                       # every test/*.test.js on a fresh in-process PGlite schema, no network
eval "$(node_modules/openvibe-sdk/scripts/test-services.sh up)" && npm test   # PostgreSQL 18 + PgBouncer, as CI
node --check <file.js>         # syntax check (no linter configured)
```

There is no start/dev/build/deploy script. A release is a git tag `vX.Y.Z` recorded in
[CHANGELOG.md](CHANGELOG.md); products pin the tag's tarball and ship it with their own
`sudo ovhost deploy <product>`. A bad release is undone by the products pinning the previous tag.

## Module Map

Each entry point loads alone (`require('openvibe-publishing/<module>')`; the root export also exposes them lazily).

| Module | What it does | Tables (in the product's DB, `<prefix>_…`) |
|---|---|---|
| `revisions` | drafts, immutable revisions with parent pointers, optimistic concurrency (412 `revision.conflict`), diff, revert-as-new-revision, audited purge | `_revisions`, `_drafts`, `_revision_purges` |
| `schedule` | idempotent scheduled publish/unpublish, lease-based claim, retries/backoff | `_schedule_jobs` |
| `taxonomy` | tags/terms, hierarchical categories, cycle checks | `_terms`, `_term_links` |
| `citations` | append-only Sources item/URL references, retrieved_at, quote span, licence note, carry-forward | `_citations`, `_citation_purges` |
| `media` | attachments by `med_…`/`legacy:…`, explicit `broken` state, `verify()` never flips on an outage, `<figure>` with an honest placeholder | `_attachments` |
| `discussion` | Community thread references (thread id only) | `_discussion_refs` |
| `seo` | deterministic indexability gate, canonical URLs, slug redirects (301/410), meta/robots, sitemaps, RSS/Atom/JSON Feed, JSON-LD from given fields | `_redirects` |
| `authorship` | human/ai/hybrid/imported records, workflow + run id, disclosure labels, AI held as draft + noindex until review | `_reviews` |
| `index-hooks` | `search.index-document@1` docs/tombstones, `<owner>.index_document.*` events, monotonic sequencer, product publish events | `_index_revisions` |
| `ai` | run a registered OpenVibe.AI workflow, poll a slow run, read citations, coded `AiRunError`s | — |
| `ssr` | auto-escaping `html` templates + `raw`, safe Markdown subset, text extraction, pagination, breadcrumbs, diff, `<time>` | — |
| `blocks` | Markdown + `:::name{attrs}` blocks, parse/validate/render/toText, plus `blocks.css` | — |
| `ingest` | Sources client, named change cursor, `pullChanges` with per-item savepoints, signed exactly-once event consumer, normalisers, PSL host helpers | `_ingest_cursor` |
| `publication` | gate → document → `sequencer.stamp` → events → `outbox.enqueue` on the caller's transaction; tombstones; IndexNow | — |
| `search-feed` | record pages in Search from the write's transaction, `sweep()` re-sends only what changed | — |
| `search-relay` | deliver a product's `<product>_outbox` rows to Search (oldest first, supersede, conflicts, 429/5xx backoff, ≤100 a tick) | — |
| `layout` | `renderDocument(o)` through `openvibe-shared/shell page()` with gate robots/canonical, article times, prev/next, feeds, icon, stylesheets, footer init | — |

`schema({ revisions, citations, seo, … })` returns the DDL for several stores at once; each store also has
`schema()` and `ensureSchema()` (tests/PGlite only).

## The Rule: Packages, Not an Authority

Share **how** something is done (revisions, the gate, feeds, indexing); never share **what is true** (which revision
is live, who may read it, editorial rules). Two products share the code, not the data: Wiki's database holds `wiki_*`
tables, Blog's holds `blog_*`; [test/two-products.test.js](test/two-products.test.js) proves it. A generic
`OpenVibe.Content` authority is explicitly not what this is. It does not decide editorial policy — each product
passes its own gate policy and permission checks.

## Using the Stores on PostgreSQL

- Every store takes the **product's** `openvibe-sdk/db` handle and a prefix; creating it runs no query; data methods
  are `async` and take an optional transaction handle as their **first** argument. With one, the product's write and
  the store's writes commit together or not at all.
- The DDL goes into the product's migrations (the runtime PgBouncer role cannot create tables); the stores never
  create their own tables. `schema()` text is idempotent, PostgreSQL-typed (`bigint` identity, `jsonb`, epoch ms,
  `timestamptz` for citations, `COLLATE "C"` identifiers) and has an index under every query a store sends
  ([test/schema.test.js](test/schema.test.js) checks with EXPLAIN).
- Pin the release tarball (never a `file:` link or a vendored copy). `openvibe-sdk` and `openvibe-shared` are peers
  resolved from the product's install, so there is one database handle/pool and one Shared copy per service.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons. Every value reaches PostgreSQL as a bind parameter; the only
  identifiers in SQL are the validated prefix's table names.
- **Escaping:** `ssr.html` auto-escapes every value; never interpolate raw HTML without `raw()`. The Markdown subset
  stays linear-time (the ReDoS fix is a guarantee). JSON-LD is escaped by `openvibe-shared`.
- **Indexability:** the gate is deterministic with stable reasons (`seo.REASONS`). A product supplies the fields;
  the package never invents one. AI content is a draft + noindex until a person's review. Sitemaps/feeds list only
  what the gate says indexable.
- **Events/Search:** the document and envelope shapes are `search.index-document@1` / `events.event-envelope@1`;
  `stamp` and `enqueue` must be on the same transaction as the change, and a monotonic revision means an older
  document never overwrites a newer one.
- **Slug/redirects:** a request path with several leading slashes stays on the site's canonical URL
  (`//feed/` used to 500 on News, Deals and Blog — v1.4.1). Old slug → 301, gone → 410.
- **Schema changes:** a later release that changes DDL gives the migration in its CHANGELOG; an applied product
  migration is never edited.
- No Font Awesome and no site classes in `blocks.css`; use the shared theme tokens. The library renders no page shell
  of its own beyond `layout`.

## Key Pitfalls

- **Never add state, a server, a port, a database or an API here.** A change that needs one belongs in the product.
- **Never share data between products.** Prefixes isolate the tables; do not add a cross-product query, a shared
  service database, or a default prefix.
- **Transactions:** pass the caller's handle through; a store opening its own transaction inside the caller's would
  break atomicity. A purge racing writes, racing workers and `get-or-create` are tested on real PostgreSQL
  ([test/postgres.test.js](test/postgres.test.js)).
- **AI:** no partial draft on a failed run; an `AiRunError` is coded; AI output stays noindex until review; the
  authorship record keeps the workflow/run/model.
- **Media:** `verify()` never flips a state on an outage; a missing object renders the honest placeholder, not a
  broken image.
- **Ingest:** per-item savepoint isolation means one bad item does not roll back the page; a removed item is handled
  as removal, never silently ignored; the cursor advances only when the work commits.
- **Search relay:** a stale revision is done, a conflict is sent again one revision up, a 429 pauses until
  `Retry-After`, a 5xx/network error backs off; other refusals are logged and set aside, never dropped silently.
- **Peers:** do not add a runtime dependency on a driver; `lib/` never loads `pg`/PGlite. Products bring their handle.

## Testing

`npm test` runs every [test/](test/) file on a fresh in-process PGlite schema with no network: immutable revisions/
diff/revert, scheduling across worker restarts, citations, honest media states, discussion refs, the gate/redirects/
structured data/feeds, AI held until review, contracts-valid Search documents/envelopes and transactional stamping,
`ssr` escaping/ReDoS, the ingest normalisers (119 captured cases), the publication glue/tombstones/IndexNow, every
subpath loading alone without a driver, DDL idempotency/63-byte names/checks/guards/indexes, cross-store transactions/
rollbacks/savepoints, and the two-product exit proof. `test/postgres.test.js` runs the race tests on PostgreSQL 18 +
PgBouncer when `OV_TEST_PG_URL` is set (CI always does); otherwise it reports skipped with the reason.

## Documentation

- [README.md](README.md) — purpose, owns, the rule, module map, install, using the stores on PostgreSQL, moving
  between releases, the gate, honesty guarantees, events/Search, ingest, publication glue, exit proof, capabilities,
  acceptance, security, deploy, development, does-not-own, depends-on.
- [docs/MIGRATION.md](docs/MIGRATION.md) — moving a product between releases.
- [CHANGELOG.md](CHANGELOG.md) — every release, its additive/breaking changes and any DDL a product must add.
- [examples/two-products/](examples/two-products/) — the exit proof (two products, one library, no shared data).
- [SECURITY.md](SECURITY.md).
