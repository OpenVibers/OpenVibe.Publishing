# OpenVibe.Publishing

> Shared publishing packages for the OpenVibe publication products: Wiki, Blog, News, Reviews,
> Deals, Coupons and Trade.

**Status:** alpha, **1.3.0**: the stores run on PostgreSQL through the `openvibe-sdk/db` async data
layer (ADR-035: PostgreSQL 18 behind PgBouncer in production, PGlite in tests). Every store method is
async, takes the product's `openvibe-sdk/db` handle, and accepts the caller's transaction handle; each
store gives its DDL as `schema(prefix)` for the product's migrations. v1.1.0 adds the shared ingest
chassis (`openvibe-publishing/ingest`) and publication glue (`openvibe-publishing/publication`) —
additive, no existing export changed. v1.2.0 adds `openvibe-publishing/layout`, the page document the
seven sites render through `openvibe-shared/shell` (additive). v1.3.0 forwards the AI summary, facts,
`updated` and `url` through `layout.renderDocument` to the shell (additive). The exit proof (`examples/two-products`) runs in `npm test`.
Releases v0.1.0 to v1.0.0 are tagged (see [CHANGELOG.md](CHANGELOG.md)). All seven products (Wiki and
Blog, public at openvibe.wiki and openvibe.blog; News, Reviews, Deals, Coupons and Trade, deployed
loopback-only, not launched) pin v1.3.0 on PostgreSQL today; each adopts a release by pinning its tag,
and no product is released until its conversion lands.
**Package:** `openvibe-publishing` (CommonJS, Node ≥ 20, production runs Node 22).
**License:** MIT, like OpenVibe.Shared.

## Purpose

One implementation of how the publication products publish: revisions, scheduling, taxonomy,
citations, media references, discussion references, the indexability gate, feeds and sitemaps,
authorship and AI disclosure, Search documents and server-rendered HTML. Each product keeps its own
state and rules; this repository keeps the code they share.

## Owns

- the modules below and their table layouts (the DDL each gives as `schema(prefix)`), with the
  product's prefix, inside the product's own database
- the indexability gate's rules and its stable reason codes (`seo.REASONS`)
- the shape of the documents and envelopes the products send to OpenVibe.Search and OpenVibe.Events

It owns no state: no runtime, port, domain or database of its own (next section).

## The rule: packages, not an authority

This repository is **code, never state**. It has no runtime, no port, no domain, no database and
no API of its own, and it must never get one. Each product (Wiki, Blog, News, …) owns its
publication state in its own database; these modules take the product's `openvibe-sdk/db` handle
and a table prefix, and use `<prefix>_…` tables *inside that product's database* (the product's
migrations create them from `schema(prefix)`). Two products share the code, not the data: the wiki's
database holds `wiki_*` tables, the blog's holds `blog_*` tables, and nothing is shared between them
(proved by [test/two-products.test.js](test/two-products.test.js)).

Following the plan (§12.4, §31.1, §31.5): share *how* something is done (revisions, the gate,
feeds, indexing); never share *what is true* (which revision is live, who may read it, editorial
rules). A generic `OpenVibe.Content` authority is explicitly not what this is.

## Module map

Every module is its own entry point and can be used alone.

| Entry point | What it does | Tables (in the consumer's DB) |
|---|---|---|
| `openvibe-publishing/revisions` | Drafts, immutable revisions with parent pointers, optimistic concurrency (`expectedRevision` → 412 `revision.conflict`), line/word diff, revert as a new revision, audited purge | `<prefix>_revisions`, `<prefix>_drafts`, `<prefix>_revision_purges` |
| `openvibe-publishing/schedule` | Scheduled publish/unpublish jobs: idempotent `schedule()`, lease-based `claim()`, re-run safe across worker restarts, retries with backoff, injectable clock | `<prefix>_schedule_jobs` |
| `openvibe-publishing/taxonomy` | Tags and terms with slugs, hierarchical categories (ancestors for breadcrumbs, descendants, trees, cycle checks) | `<prefix>_terms`, `<prefix>_term_links` |
| `openvibe-publishing/citations` | Source references on one revision: Sources item id and/or URL, `retrieved_at`, quote span, license note; append-only, never dropped by later revisions; `carryForward` to reuse | `<prefix>_citations`, `<prefix>_citation_purges` |
| `openvibe-publishing/media` | Attachments by Media object id (`med_…` / `legacy:…`), explicit `broken` state when the object is gone, `verify()` that never flips state on an outage, `<figure>` rendering with an honest placeholder | `<prefix>_attachments` |
| `openvibe-publishing/discussion` | Community comment-thread references: resolves via `POST /api/v1/comments/threads/resolve`, stores the thread id only (no comment content) | `<prefix>_discussion_refs` |
| `openvibe-publishing/seo` | The deterministic **indexability gate**; canonical URLs; history-aware redirects (old slug → 301, gone → 410); meta/robots tags; sitemaps; RSS, Atom and JSON Feed; JSON-LD built only from provided fields | `<prefix>_redirects` |
| `openvibe-publishing/authorship` | human / ai / hybrid / imported records with the OpenVibe.AI workflow + run id, disclosure labels, AI content held as draft + noindex until a person's review | `<prefix>_reviews` |
| `openvibe-publishing/index-hooks` | `search.index-document@1` documents and tombstones, the `<owner>.index_document.upserted\|deleted` events OpenVibe.Search consumes, a monotonic index-revision sequencer, and the product's own `<product>.<type>.published\|updated\|unpublished\|deleted` events | `<prefix>_index_revisions` |
| `openvibe-publishing/ai` | Ask OpenVibe.AI for a draft: run a registered workflow with the product's service token (polls a slow run), read its citations, get the `{ id, version, runId, model }` an AI authorship record needs; coded `AiRunError`s, never a partial draft | — |
| `openvibe-publishing/ssr` | auto-escaping `html` tagged templates with `raw()`, a safe Markdown subset, plain-text extraction, word count, server pagination, breadcrumbs, diff markup, honest `<time>` | — |
| `openvibe-publishing/ingest` | The shared ingest chassis: the OpenVibe.Sources client, a named change cursor and the `pullChanges` loop (per-item savepoint isolation, `{applied\|hold\|removed}`), the signed event consumer with an exactly-once inbox, the shared normalisers, and the generic PSL/registrable-host and freshness helpers | `<prefix>_ingest_cursor` |
| `openvibe-publishing/publication` | The shared publication glue: gate → document → `sequencer.stamp` → events → `outbox.enqueue` on the caller's transaction handle, tombstones on unpublish/merge, and the IndexNow ping; it emits exactly `search.index-document@1` and the product's events | — |
| `openvibe-publishing/layout` | `renderDocument(o)`: the whole page through `openvibe-shared/shell` `page()` (≥ 2.6.0), with robots and canonical from the gate's decision (throws without one), article times, prev/next, feeds, the app icon, stylesheets, the boost marker, the body frame and the footer init | — |

`require('openvibe-publishing')` exposes all of them lazily (`.revisions`, `.seo`, `.indexHooks`,
`.ingest`, `.publication`, `.layout`, …), plus `schema({ … })`, the DDL of several stores at once (below).

## Install

Pin the release tarball, like every OpenVibe package (never a `file:` link or a vendored copy):

```json
"openvibe-publishing": "https://codeload.github.com/OpenVibers/OpenVibe.Publishing/tar.gz/refs/tags/v1.3.0",
"openvibe-sdk": "https://codeload.github.com/OpenVibers/OpenVibe.SDK/tar.gz/refs/tags/v0.15.0",
"pg": "^8.23.0"
```

and `@electric-sql/pglite` (`^0.5.8`) as a devDependency for tests. `openvibe-sdk` (≥ 0.15.0) and
`openvibe-shared` (≥ 1.5.0) are peer dependencies, resolved from the product's own install: the
product brings its own database handle, so there is one copy of the data layer (and of its pool) per
service, and one copy of openvibe-shared. openvibe-shared's `seo` module is the network's single
implementation of head tags, sitemap XML, robots.txt and JSON-LD escaping; this package adds the
publication rules on top. There are no other runtime dependencies; `lib/` never loads a driver.

## Using the stores on PostgreSQL

**The handle.** Every store takes the product's `openvibe-sdk/db` handle and a prefix. Creating a
store runs no query; every method that touches data is `async`.

```js
const { createDb, sql } = require('openvibe-sdk/db');
const { createRevisionStore } = require('openvibe-publishing/revisions');
const { createCitationStore } = require('openvibe-publishing/citations');

const db = createDb({ service: 'wiki' });                          // DATABASE_URL, through PgBouncer
const revisions = createRevisionStore(db, { prefix: 'wiki_page' });
const citations = createCitationStore(db, { prefix: 'wiki', revisions });
const { revision } = await revisions.create({ entityId: 'pg_1', expectedRevision: 0, content: '# Rye', fields: { title: 'Rye' } });
```

**The schema goes in the product's migrations.** The runtime role behind PgBouncer cannot create
tables, so the stores never do it on their own. Each storing module exports its DDL for a prefix, and
the root export joins several; write the text into the product's first migration once:

```js
const publishing = require('openvibe-publishing');
const ddl = publishing.schema({ revisions: 'wiki_page', citations: 'wiki', seo: 'wiki_page', authorship: 'wiki_page', indexHooks: 'wiki' });
// migrations/0001_initial.sql = '-- phase: expand
' + the product's own tables + ddl
// then at boot, as the owner: await createDb({ url: process.env.DATABASE_DIRECT_URL }).migrate({ dir })
```

| Module | DDL function | Tables |
|---|---|---|
| revisions | `schema(prefix)` | `<prefix>_revisions`, `<prefix>_drafts`, `<prefix>_revision_purges` + guard trigger |
| citations | `schema(prefix)` | `<prefix>_citations`, `<prefix>_citation_purges` + guard trigger |
| media | `schema(prefix)` | `<prefix>_attachments` |
| discussion | `schema(prefix)` | `<prefix>_discussion_refs` |
| schedule | `schema(prefix)` | `<prefix>_schedule_jobs` |
| authorship | `schema(prefix)` (the review log) | `<prefix>_reviews` + guard trigger |
| taxonomy | `schema(prefix)` | `<prefix>_terms`, `<prefix>_term_links` |
| seo | `redirectsSchema(prefix)` | `<prefix>_redirects` |
| index-hooks | `sequencerSchema(prefix)` | `<prefix>_index_revisions` |
| ingest | `schema(prefix)` | `<prefix>_ingest_cursor` |

Every store also has `store.schema()` (the same text) and `await store.ensureSchema()`, which runs it
on the handle: for tests and PGlite, where the handle may create tables. The text is idempotent
(`IF NOT EXISTS`, `CREATE OR REPLACE`), uses PostgreSQL types (`bigint` identity keys, `jsonb` for
JSON, `bigint` epoch milliseconds where 0.4 stored milliseconds, `timestamptz` for citations'
`retrieved_at`, `COLLATE "C"` on identifier columns so they sort in byte order as SQLite did), keeps
0.4's CHECK constraints, and has an index for every query a store sends (`test/schema.test.js`
checks each one with EXPLAIN). When a later release changes a store's DDL, its CHANGELOG entry gives
the migration a product adds; an applied migration is never edited.

**Transaction handles.** Every data method takes an optional transaction handle as its **first**
argument. Without one it runs on the store's `db`; with one it runs inside the caller's
transaction, so a product's own write and the stores' writes commit together or not at all:

```js
await db.tx(async (t) => {
    await t.exec(sql`INSERT INTO wiki_pages (id, slug, owner, updated_at) VALUES (${id}, ${slug}, ${owner}, ${Date.now()})`);
    const { revision } = await revisions.create(t, { entityId: id, expectedRevision: 0, content, fields: { title } });
    await citations.attachMany(t, id, revision.number, sources);
});
```

Inside `db.tx`, pass `t` to every store call, reads included: a read on `db` would not see the
transaction's writes (and on PGlite, one connection, it waits for the transaction). A store write
that needs several statements runs them in its own transaction, or in a savepoint of the caller's
(`t.tx`); a store refusal (a 412 conflict, a 404, a 410) is raised before or after a clean savepoint,
so the caller can catch it and still commit the rest. `indexSequencer.stamp(t, document)` takes the
handle **always**, like the SDK outbox's `enqueue(t, …)`: the stamped revision must commit if and
only if the event carrying it does.

**Concurrency.** Writers of one entity take a transaction-scoped advisory lock
(`pg_advisory_xact_lock`, allowed behind PgBouncer), so revisions' and citations' check-then-write,
purges and `setTerms` behave as they did under SQLite's single writer: racing writers of one base
revision get exactly one success and 412s, and nothing written during a purge survives it. The
scheduler claims with `FOR UPDATE SKIP LOCKED` in one statement, so any number of workers on any
number of hosts share one jobs table without taking a job twice. Get-or-create paths use
`ON CONFLICT`. `test/postgres.test.js` races all of these through PgBouncer.

**Lists are bounded; several reads are one query.** Every list method has a `limit` (defaults keep
0.4's answers for normal sizes), and lists that grow across entities page by keyset (`after`):
`citations.bySourceItem`, `media.entitiesUsing`, `taxonomy.entitiesFor` and `taxonomy.terms`
(revisions' `list` keeps its `before` cursor). For a feed or sitemap, read in batches instead of per
item: `revisions.getMany(refs)`, `citations.forRevisions(refs)`, `reviews.latestMany(refs)` and
`taxonomy.termsForMany(entityIds)` (refs are `{ entityId, revision }`; answers come back in the same
order).

**Tests.** `createDb({ pglite: true })`, then `await store.ensureSchema()` (or `db.migrate({ dir })`
with the product's migrations): real PostgreSQL in-process.

## Moving a product between releases

See [docs/MIGRATION.md](docs/MIGRATION.md): 0.4 → 1.0, 1.0 → 1.1 and 1.1 → 1.2, step by step.

## The indexability gate

```js
const seo = require('openvibe-publishing/seo');
const decision = seo.evaluate(
    { state: 'published', visibility: 'public', canonicalUrl, text, citationCount: 2, authorship: { mode: 'ai', reviewed: false } },
    { policy: { minWords: 150, requireSources: true }, now: Date.now() },
);
// → { indexable: false, listable: false, robots: 'noindex, nofollow', codes: ['ai_generated_unreviewed'], reasons: [...], canonical, gate }
```

A pure function of (facts, policy, now): the same input always gives the same decision. Every "no"
carries stable reason codes, in a fixed order (`seo.REASONS`):

| Effect | Codes |
|---|---|
| **hidden** — never indexed, never in sitemaps, feeds or public search | `deleted`, `takedown`, `private`, `gated`, `unlisted`, `draft` (draft or scheduled), `unpublished`, `ai_generated_unreviewed`, `stub_provider`, `unreviewed_sensitive` |
| **noindex** — may be served and listed in feeds, never indexed or put in a sitemap | `retracted`, `expired`, `stale_price`, `duplicate_of` (canonical points at the original), `thin`, `unsourced`, `unsupported_claims`, `missing_canonical`, `noindex_requested` |

There is no default that makes content indexable: unknown fact names throw, a rule that needs a fact
the caller did not give throws, and time rules need an explicit `now` (no hidden clock). Each product
sets its own policy (`minWords`, `requireSources`, `minSources`, `priceMaxAgeMs`, `sensitiveCategories`).
`metaTags`, `robotsMeta`, `sitemap`, the three feed builders and `buildIndexDocument` (for a
published document) all require the decision, so an object without one cannot reach a crawler by omission.

## Honesty guarantees (tested)

- **Structured data** is generated only from provided fields. A missing rating, price, currency,
  date or author is omitted, never defaulted (no `bestRating: 5`, no assumed `InStock`, no
  "now" as a date, no placeholder author). An `AggregateRating` needs a real count; an `Offer` needs a
  price and a currency. [test/seo.test.js](test/seo.test.js) checks every output leaf against the input.
- **Feeds and sitemaps** never invent `pubDate`, `lastmod` or authors; an Atom entry without any date
  is left out rather than dated "now".
- **Citations** never get a retrieval time they did not have, and cannot be edited or deleted
  (a PL/pgSQL trigger, SQLSTATE 23001) except by an audited purge. Revisions are guarded the same way;
  review-log rows cannot be updated.
- **Media** outages are `check_failed`, not "gone" and not "fine".
- **Discussion** failures are errors, never a fabricated thread.
- **AI content** starts as draft + noindex: `authorship.canPublish()` refuses it and the gate hides it
  (`ai_generated_unreviewed`) until a person (a `usr_` subject, never a service) records an approving
  review. Products must call these; the package cannot stop a product that bypasses its own checks.

## Events and Search

`index-hooks.buildIndexDocument()` produces exactly the released `search.index-document@1`
(openvibe-contracts v0.12.0, owned by OpenVibe.Search): visibility `public | unlisted | members |
private`, ACL `subjects | groups | entitlements`, authorship `human | ai_assisted | ai_generated |
imported`, provenance as typed references (Sources items, the product's citation records, the AI
run with `stub: true` for stub output), and `indexability { decision: index|noindex, reasons }` with
the gate's codes mapped onto Search's known reasons (`hooks.SEARCH_REASONS`). Anything not
published, and unlisted content unless `includeUnlisted`, becomes the tombstone
`{ owner, type, id, revision, deleted: true }`.

Search orders documents by `revision`, refuses a different document at an equal revision and lets a
tombstone win ties, so the revision must rise with every indexed change, not only content edits.
`createIndexSequencer(db, { prefix })` keeps that counter in the product's database.

```js
const seq = hooks.createIndexSequencer(db, { prefix: 'wiki' });
await db.tx(async (t) => {
    const doc = await seq.stamp(t, hooks.buildIndexDocument({ owner: 'wiki', type: 'page', id, revision: 0, state, visibility, … , decision }));
    await outbox.enqueue(t, hooks.indexEvent({ document: doc }));   // wiki.index_document.upserted | .deleted
});
```

`indexEvent()` builds the envelope Search's webhook consumes (payload = the document, or
`{ type, id, revision }` for a deletion; subject `{ type, id, revision }`; visibility internal).
`publicationEvent()` builds the product's own `<product>.<type>.<action>` event (payload: canonical
URL, publication state, indexability; public only for public, listable content). Neither sets
`event_id`: the OpenVibe.Events outbox assigns it. Enqueue both in the same transaction as the
product's state change. Tests validate every document and envelope with openvibe-contracts
v0.76.0 and mirror Search's webhook checks.

## Ingesting from Sources (the ingest chassis)

The five content products (News, Reviews, Deals, Coupons, Trade) each pull OpenVibe.Sources items, track a
change cursor, consume signed OpenVibe.Events deliveries and normalise item fields. They share that code
here; each keeps its own domain tables, gate facts, facets and item mapping.

```js
const { createSourcesClient, createChangeCursor, pullChanges, createEventConsumer }
    = require('openvibe-publishing/ingest');

const sources = createSourcesClient({ config });                // { sources, oauth }, from the product
const cursor = createChangeCursor(db, { prefix: 'deals' });     // <prefix>_ingest_cursor in a migration
const summary = await pullChanges({
    db, cursor, source: sources, name: 'sources.deals.after',
    apply: async (item, t) => {                                 // one savepoint per item
        const row = await offers.upsertFromItem(t, item);
        return row.held ? 'hold' : 'applied';                   // 'removed' for a deleted item
    },
});
// → { pages, applied, hold, removed, failed, after }
```

`pullChanges` commits one transaction per page — the page's writes **and** the cursor advance — and runs
`apply(item, t)` in a savepoint, so one unreadable item is rolled back alone (`failed`) and never stalls
the page or the cursor. `apply` returns `'applied' | 'hold' | 'removed'`; `hold` is counted and the cursor
moves past it (the product records the hold itself).

`createEventConsumer({ db, secrets, consumer }).apply(raw, headers, handler)` verifies the
`X-OpenVibe-Signature` v2 HMAC (±300 s; a v1-only or stale delivery is refused) and runs the handler
exactly once per `event_id` through the SDK's pg inbox, so a redelivery changes nothing and a failed
handler rolls back its receipt.

`ingest.normalize` holds the normalisers the products share (folding, title/URL keys, hosts, amounts,
currencies, instants, enum/text parsing, the Reviews key/alias normalisers), `ingest.hosts` the PSL and
registrable-host helpers, and `ingest.freshness` the generic staleness rule. Nothing defaults a date to
"now", and no policy threshold is a constant: a product passes its own.

## The publication glue (createPublication)

`createPublication` is the half the five content products each re-implement: it takes the product's gate
(`decide`), document builder (`document`), canonical path (`page`), the index sequencer and the outbox, and
runs gate → document → `sequencer.stamp(t, doc)` → event → `outbox.enqueue(t, …)` on the **caller's**
transaction handle, so the index document, its event and the product's own change commit or roll back
together.

```js
const { createPublication } = require('openvibe-publishing/publication');
const publication = createPublication({
    owner: 'deals', sequencer, outbox, baseUrl: config.baseUrl, indexnow,
    decide: (offer, now) => publication.decideOffer(offer),      // the product's gate facts
    document: (offer, decision) => offerDocument(offer),         // hooks.buildIndexDocument/tombstone
    page: (offer) => `/d/${offer.slug}`,
});
await db.tx(async (t) => {
    await t.exec(sql`UPDATE deal_offers SET … WHERE id = ${id}`);
    await publication.sync(t, offer);                            // stamps + enqueues in the SAME tx
});
```

It emits exactly `search.index-document@1` (carried by `<owner>.index_document.upserted|deleted`) and the
product's own `<owner>.<type>.<action>` events; an unchanged document is a no-op, a resource that was
never indexed gets no tombstone, and unpublish/merge call `tombstone(t, …)`. It owns the IndexNow ping
(config stays per product): an indexable page that appeared or changed, or a page Search already had that
went away, is announced; a draft, private or noindex page never is.

## Exit proof: two products

[examples/two-products](examples/two-products) holds a mini wiki and a mini blog, each with its own
database (an `openvibe-sdk/db` handle) and its own publication tables, both using revisions,
citations, the gate and feeds with different editorial policies. Each applies its
`migrations/0001_initial.sql` (its own tables plus `publishing.schema({ … })`, generated by
`examples/two-products/migrations.js`) with `db.migrate()`, as a service does.
`node examples/two-products/wiki/app.js` (port 4801) and `node examples/two-products/blog/app.js`
(port 4811) serve them on in-memory PGlite. [test/two-products.test.js](test/two-products.test.js)
shows they load the same modules, that each database holds only its own product's tables, that
writes never cross, that a product's write and the stores' writes share one transaction, that a feed
of many pages costs the same queries as a feed of one, and that pages are useful without JavaScript,
old slugs 301, private/VIP/deleted content leaves feeds and sitemaps, and scheduled publication
survives a worker restart.

## Capabilities

The package implements no capability and holds no grant. Four modules call a service with the
**product's** token client, so the product needs the grant: `discussion` calls OpenVibe.Community
(`community.comment.write` to resolve a thread), `ai` calls OpenVibe.AI (`ai.run.create`,
`ai.run.read`), `media`'s `verify()` reads OpenVibe.Media objects (`media.object.read`), and `ingest`'s
Sources client reads OpenVibe.Sources items and registry records (`sources.item.read`,
`sources.source.read`).

## Acceptance

`npm test` runs every `test/*.test.js` on real PostgreSQL in-process (PGlite, one fresh schema per
test) with no network. What it proves: immutable revisions, diff and revert, keyset lists, drafts in
one query (`revisions.test.js`); idempotent scheduling across worker restarts, concurrent claims
(`schedule.test.js`); append-only citations, batched inserts (`citations.test.js`); honest media
states (`media.test.js`); discussion references without content (`discussion.test.js`); the gate,
redirects, structured data and feeds built only from given fields (`seo.test.js`); AI content held
until a person's review (`authorship.test.js`, `ai.test.js`); Search documents and envelopes valid
against openvibe-contracts, and `stamp(t, …)` committing with its event (`index-hooks.test.js`);
escaping and the Markdown subset, including the ReDoS fix (`ssr.test.js`); the ingest chassis — the
normalisers and host helpers byte-for-byte against 119 cases captured from the five current product files,
the Sources client against a stub server, cursor advancement with per-item savepoint isolation and hold,
and the signed event consumer's window and exactly-once inbox (`ingest.test.js`); the publication glue —
contracts-valid documents and events, `stamp` + `enqueue` in one transaction, tombstones and the IndexNow
ping (`publication.test.js`); every subpath export loading
alone without a driver (`package.test.js`); the DDL: idempotent, 63-byte names, PostgreSQL types,
CHECKs, PL/pgSQL guards, applied by `db.migrate()`, and an index under every query the stores send
(`schema.test.js`); callers' transactions spanning store writes, rollbacks leaving nothing, savepoints
(`transactions.test.js`); and the two-product exit proof (`two-products.test.js`).
`test/postgres.test.js` runs the stores on PostgreSQL 18 through PgBouncer (transaction mode) when
`OV_TEST_PG_URL` is set: racing writers, a purge racing writes, racing workers, racing get-or-create and
`setTerms`, and callers' transactions behind the pooler; otherwise it prints
`postgresql+pgbouncer: skipped (…)`. CI starts the containers, so it always runs there.

## Security

Reporting a vulnerability: [SECURITY.md](SECURITY.md). The `ssr` module auto-escapes every value in
its `html` templates and renders only a safe Markdown subset (linear-time since v0.2.1's ReDoS fix);
JSON-LD is escaped by openvibe-shared. The package holds no secrets, opens no database it was not
handed, and makes network calls only through the token client and base URL a product passes in. Every
value reaches PostgreSQL as a bind parameter (the `sql` tag); the only identifiers in statements are
the validated prefix's table names. A product that bypasses its own checks is not stopped by the
package (see Honesty guarantees).

## Deploy

Nothing is deployed from this repository. A release is a git tag (`vX.Y.Z`, recorded in
[CHANGELOG.md](CHANGELOG.md)); products pin the tag's tarball and ship it with their own deploys
(`sudo ovhost deploy <product>`). A bad release is undone by the products pinning the previous tag.

## Development

```bash
fnm exec --using=22.22.1 npm install
fnm exec --using=22.22.1 npm test          # every test/*.test.js on PGlite, no network
# with PostgreSQL 18 + PgBouncer containers (what CI runs):
eval "$(node_modules/openvibe-sdk/scripts/test-services.sh up)" && fnm exec --using=22.22.1 npm test
```

## Does not own

- It does not own publication state, run workers, listen on a port, or talk to a database it was not handed.
- It does not decide editorial rules: each product passes its own gate policy and its own permission checks.
- It does not store or render comment content (Community owns it), media bytes (Media owns them) or
  source items (Sources owns them); it stores references.
- It is not a notification, search or event runtime: it builds the documents and envelopes those services consume.

## Depends on

- `openvibe-sdk` ≥ 0.15.0 (`openvibe-sdk/db`), a peer dependency supplied by the consumer: its
  `createDb` handle (and `pg` in production, `@electric-sql/pglite` in tests) reach the stores through
  the product. Tests pin v0.15.0.
- PostgreSQL 18 (through PgBouncer in transaction mode), the product's own database (ADR-035).
- `openvibe-shared` ≥ 1.5.0 (`seo`), a peer dependency supplied by the consumer (tests use v1.25.0).
- Contracts it produces for: `common.entity-ref@1`, `media.media-ref@1`, `events.event-envelope@1`
  and `search.index-document@1` (validated in tests against `openvibe-contracts` v0.112.0, a
  devDependency: nothing in `lib/` needs it at runtime).

<!-- versions:start -->
- openvibe-contracts: v0.112.0
- openvibe-sdk: v0.15.0
- openvibe-shared: v2.6.0
<!-- versions:end -->
