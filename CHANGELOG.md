# Changelog

All notable changes to `openvibe-publishing`. Versions follow [semver](https://semver.org/): a
breaking change to any exported function, table layout, reason code or document shape is a new
major (a minor while 0.x). A release is the git tag `vX.Y.Z`; consumers pin the tag's tarball.

## 1.0.0 — 2026-09-28

**Breaking: the stores run on PostgreSQL through `openvibe-sdk/db`, and every store API is async**
(ADR-035 and its amendment: PostgreSQL 18 is every service's system of record, one SQL dialect;
production connects through PgBouncer in transaction mode, tests run PGlite). The pure modules
(`ssr`, `diff`, the gate and feeds in `seo`, the builders in `index-hooks`, the `authorship` record
functions, `ai`, `discussion`'s client) are unchanged. The seven products keep pinning v0.4.x until
each moves to PostgreSQL in its own change. A database written by 0.4 imports into the 1.0 schema
with the SDK's `importSqlite` (checked before release on every store: `report.ok`, identities kept,
sequences moved past them, purge records still refusing reuse).

### Dependencies
- **`openvibe-sdk` ≥ 0.15.0 is a peer dependency** (tests pin the v0.15.0 tag). A peer, not a
  dependency, because a store runs its queries on the product's handle: the `sql` fragments it builds
  must come from the same copy of the SDK as that handle (the handle recognises its own fragments),
  and a service should have one data layer and one pool, not a nested second copy per library.
  Stores take the `sql` tag from the handle itself (`db.sql`), and `lib/` never loads a driver.
- `better-sqlite3` is gone (it was a peer dependency and a devDependency). `@electric-sql/pglite`
  (`^0.5.8`) and `pg` (`^8.23.0`) are devDependencies; products bring `pg` themselves.

### Changed (every store)
- **The handle** is an `openvibe-sdk/db` handle (`createDb`): `query`, `many`, `maybe`, `one`, `value`,
  `exec`, `tx` and `sql`. A better-sqlite3 handle throws a TypeError that names 0.4.x.
- **Every method that touches data is `async`** and returns a promise; argument errors that were
  synchronous throws are now rejections (the prefix and handle checks of `create…()` still throw).
  Method names and result shapes are those of 0.4: ids of identity columns are still JS numbers,
  JSON fields still come back as objects, times are still ISO strings built from epoch milliseconds.
- **Transaction handles.** Every data method takes an optional transaction handle as its first
  argument: `store.m(args…)` runs on the store's db, `store.m(t, args…)` inside the caller's
  `db.tx(async (t) => …)`, so a product's own writes and the stores' commit together or not at all.
  Writes that need several statements run in their own `db.tx`, or in a savepoint (`t.tx`) of the
  caller's transaction; a store's refusal (412, 404, 410, 400) leaves the caller's transaction usable.
- **No DDL at construction.** Creating a store runs no query. Each storing module exports its DDL,
  `schema(prefix)` → SQL text, for the product's migration files (the runtime role behind PgBouncer
  cannot create tables); `store.schema()` gives the same text and `await store.ensureSchema()` runs it
  (tests, PGlite) and resolves to the store. The root export adds `schema({ module: prefix | [prefixes] })`
  joining several. `seo` exports it as `redirectsSchema(prefix)` and `index-hooks` as
  `sequencerSchema(prefix)` (their `schema` names were taken by schema.org and the Search contract).
- **Types:** `INTEGER PRIMARY KEY AUTOINCREMENT` → `bigint GENERATED ALWAYS AS IDENTITY`; JSON text →
  `jsonb`; integer epoch milliseconds → `bigint` (still milliseconds); citations' `retrieved_at` (ISO
  text) → `timestamptz`; counts and revision numbers → `integer`. Identifier columns (`entity_id`,
  drafts' `owner`, `media_id`, `source_item_id`, `from_path`, jobs' `id`, the sequencer's key) are
  `COLLATE "C"`, so they sort and compare in byte order as SQLite did. Every CHECK constraint is kept.
- **Immutability triggers** are PL/pgSQL (`<table>_guard()` with `BEFORE UPDATE` / `BEFORE DELETE`
  row triggers): revisions and citations refuse UPDATE always and DELETE unless the entity is in the
  purge table; review-log rows refuse UPDATE. Same messages; the SQLSTATE is 23001
  (restrict_violation). TRUNCATE is not a row operation and is not guarded: the runtime role has no
  TRUNCATE privilege, and the owner's one-time import (`importSqlite({ truncate: true })`) needs it.
- **Indexes for every query** (`test/schema.test.js` EXPLAINs each statement the stores send). Some
  index names changed because PostgreSQL names must fit 63 bytes at a 40-character prefix (for example
  `<prefix>_revisions_entity_number` is now `<prefix>_revisions_entity_num`); new ones: drafts
  `(entity_id, updated_at DESC, owner)`, citations `(source_item_id, entity_id, revision, id)` (partial)
  and `(carried_from)` (partial, for the self-reference), attachments `(entity_id, position, id)` and
  `(media_id, entity_id)`, reviews `(entity_id, id)`, terms `(parent_id, name)` and `(vocabulary, name)`,
  term links `(term_id, entity_id)`, jobs `(run_at, id) WHERE status = 'pending'`,
  `(lease_until) WHERE status = 'running'` and `(entity_id, run_at, id)`, redirects
  `(entity_id, created_at, from_path)`.
- **Concurrency.** SQLite had one writer; PostgreSQL has many. Writers of one entity take a
  transaction-scoped advisory lock (`pg_advisory_xact_lock`, allowed behind PgBouncer) where 0.4
  relied on the single writer for a check-then-write: revisions (`create`, `revert`, `commitDraft`,
  `purgeEntity`), citations (`attach`, `attachMany`, `carryForward`, `purgeEntity`), `setTerms` (per
  entity and vocabulary) and taxonomy tree changes (`setParent`, `remove`). Get-or-create paths use
  `ON CONFLICT`.
- **Bounded lists.** Every list method takes a `limit`; lists that were unbounded now have a default
  (1000 unless noted) and a maximum (10000). Lists that grow across entities page by keyset (`after`).
  **Batch reads** for list routes (no N+1): `revisions.getMany`, `citations.forRevisions`,
  `reviews.latestMany`, `taxonomy.termsForMany` (refs are `{ entityId, revision }` and answers come in
  the same order).

### Changed, per store (beyond `await` and the optional leading `t`)
- **revisions** (`createRevisionStore`): new `exists(entityId, number)` (no content read) and
  `getMany(refs)`. `lineage(entityId, number, { limit = 1000 })` is one recursive query and bounded.
  `drafts(entityId, { limit = 500 })` is one query (0.4 ran two per draft), ordered by `updated_at`
  then owner. `diff()` reads both revisions in one query. `list()`'s `before` must be a number.
  `saveDraft()` is one statement. A malformed revision number finds nothing (null) instead of erroring.
- **citations** (`createCitationStore`): new `forRevisions(refs)` and `tables` (`{ citations, purges }`).
  `attachMany()` validates every row before the first write and inserts them in one statement;
  `carryForward()` is one `INSERT … SELECT` (carried rows are not re-validated: they were valid when
  written). `attach()` checks the source, URL and quote before it looks up the revision (0.4 looked up
  the revision first). `forRevision(entityId, revision, { limit = 1000 })`, `history(entityId, { limit = 1000 })`,
  `bySourceItem(sourceItemId, { limit = 500, after })` (keyset: pass the last citation of a page; 0.4
  returned every row). `retrievedAt` is read from `timestamptz` (same ISO string).
- **media** (`createAttachmentStore`): `list(entityId, { revision, limit = 1000 })`,
  `broken(entityId, { limit = 1000 })`, `entitiesUsing(mediaId, { limit = 1000, after })` (keyset on
  entity id). `markBroken()` / `markAvailable()` are one `UPDATE … RETURNING` each. `verify()` writes
  all verdicts in one statement after every check has answered (0.4 wrote each as it came) and never
  holds a transaction across the calls to Media. `detach()` with a malformed id is `false`.
- **discussion** (`createDiscussionRefs`): `get`, `set`, `forget`, `threadFor` are async; `ref` is
  `jsonb`; `schema(prefix)` is exported. `threadFor()` calls Community between two statements, never
  inside a transaction it opens. `createDiscussionClient` is unchanged.
- **schedule** (`createScheduler`): `claim()` / `runDue()` lease due jobs in one
  `UPDATE … FOR UPDATE SKIP LOCKED`, so any number of workers on any number of hosts share one table
  without taking a job twice (0.4 serialised claimers with SQLite's `BEGIN IMMEDIATE`); abandoned jobs
  are marked in the same statement. `fail()` is one statement (backoff computed in SQL). `runDue()`
  reads each finished job from its `RETURNING` row. `jobs(entityId, { limit = 1000 })`. `backoffMs` must
  be a list of non-negative integers.
- **authorship** (`createReviewLog`): `record`, `latest`, `history(entityId, { limit = 1000 })` are
  async; new `latestMany(refs)`; `schema(prefix)` is exported. The record functions (`record`,
  `initialState`, `canPublish`, `gateFacts`, `disclosure`) are unchanged.
- **taxonomy** (`createTaxonomy`): `setTerms()` runs a fixed number of statements whatever the number
  of items (one lookup of the ids, one insert of the new names with `ON CONFLICT`, one lookup of the
  slugs, one insert of the links), where 0.4 ran several per item; the result and its errors are the
  same, and a refused call changes nothing. `ensureTerm()` is safe against a concurrent creator (both
  get the one term). `entitiesFor(termId, { includeDescendants, limit = 1000, after })` is one query
  and pages by entity id. `terms(vocabulary, { limit = 1000, after })` pages by (name, id);
  `children(id, { limit })`, `descendants(id, { limit })` (ordered by name, then id),
  `tree(vocabulary, { limit = 10000 })`. New `termsForMany(entityIds, vocabulary)`.
- **seo** (`createRedirectStore`): `recordMove`, `release`, `resolve`, `history(entityId, { limit = 1000 })`
  are async; `recordMove()` is one statement; `resolve()` awaits `currentPath(entityId)`, which may
  return a promise (a product's own lookup is async now). `redirectsSchema(prefix)` is exported.
- **index-hooks** (`createIndexSequencer`): **`stamp(t, document)` takes the transaction handle
  first, always** (like the SDK outbox's `enqueue(t, …)`): the stamped revision must commit if and only
  if the event carrying it does, or a replay would believe Search has a document it never received.
  Pass `db` only when nothing else is written. `stamp` is one upsert (a second read only when nothing
  changed) and safe against concurrent stamps. `current([t,] owner, type, id)` is async.
  `sequencerSchema(prefix)` is exported.
- **root** (`require('openvibe-publishing')`): new `schema(stores)`.

### Examples and tests
- `examples/two-products`: both apps take an `openvibe-sdk/db` handle, apply
  `migrations/0001_initial.sql` (their own tables plus `schema()`, generated by `migrations.js`) with
  `db.migrate()`, run related writes in one `db.tx` with `t` passed to every store call, keep the Search
  events in an outbox table in that transaction, and build feeds and sitemaps from batch reads. The
  servers run on in-memory PGlite.
- Every test runs on PGlite (one instance per file, a fresh schema per test) with the same
  assertions as 0.4, adjusted only for types and `await`. New: `schema.test.js` (DDL text,
  identifiers within 63 bytes, types, CHECKs, triggers, `db.migrate()`, an index under every
  statement), `transactions.test.js` (a caller's `t` spanning its own write and every store's, a
  rollback leaving none, a refusal undoing only its savepoint), query-count checks (`drafts()` is one
  query, `setTerms()` and `attachMany()` do not grow with their input, a feed of 12 pages costs the same
  queries as a feed of 1), and `postgres.test.js`: the stores on PostgreSQL 18 through PgBouncer
  (transaction mode) with real concurrency (racing writers of one revision, a purge racing writes,
  racing workers, racing get-or-create and `setTerms`, callers' transactions), which runs when
  `OV_TEST_PG_URL` is set and otherwise prints `postgresql+pgbouncer: skipped (…)`. CI starts the
  containers (`eval "$(node_modules/openvibe-sdk/scripts/test-services.sh up)" && npm test`).
- `npm test` (Node 22.22.1): 16/16 test files with the containers, 121 cases (113 on PGlite or
  pure, 8 through PgBouncer; 0.4 had 92 in 13 files); without the containers 15/16 files pass and
  `postgres.test.js` is listed as skipped.

## 0.4.0 — 2026-09-24

openvibe-shared is now an optional **peer dependency** (`>=1.5.0`), resolved from the product's own install and never fetched from the npm registry (where it is not published), the way `better-sqlite3` already was. Until now every Shared release forced a Publishing release; without one, each product installed a second, nested copy of openvibe-shared. Products must keep openvibe-shared in their own dependencies (every OpenVibe product does). No API change.

## 0.3.2 — 2026-09-24

Depends on openvibe-shared v1.11.0 (the OpenVibe Frame rename). No API change.

## 0.3.1 — 2026-09-24

Depends on openvibe-shared v1.10.0 (was v1.5.1). Every product pinning the same Shared release now installs one copy instead of a nested one. No API change.

## 0.3.0 — 2026-09-24

- `openvibe-publishing/ai`: how a content product asks OpenVibe.AI for a draft. `createAiClient({
  baseUrl, tokenClient })` runs a registered workflow (`POST /api/v1/runs?wait=`, polling a run still
  going), reads its citations, and returns the output with the `{ id, version, runId, model }` an
  AI authorship record needs. Failures throw `AiRunError` with a code (`ai.not_configured`,
  `ai.refused`, `ai.run_failed`, `ai.timeout`, `ai.unreachable`), never a partial draft; a refused
  token is invalidated and retried once; a traceparent passed in goes along. Additive.

## 0.2.2 — 2026-09-24

- `openvibe-shared` v1.0.0 -> v1.5.1 (the runtime dependency; `seo` is unchanged, so consumers that
  pin a newer openvibe-shared share one copy once this is tagged). Tests use `openvibe-contracts`
  v0.33.0 (devDependency).

## 0.2.1 — 2026-09-23

Security fix (no API change).

### Fixed
- **ReDoS in `ssr.renderMarkdown` and `ssr.markdownToText`.** Several patterns backtracked
  super-linearly on untrusted Markdown, blocking the event loop on every render of the page:
  a heading line with a long run of trailing spaces (`# a` + 4,000 spaces + `x` took 28 s, cubic),
  unclosed `**`/`__`/`~~` openers (200 KB took 8 s each), backtick runs of rising length (26 s),
  a fence line with trailing spaces before a non-word character (quadratic), and `[` runs in
  `markdownToText` (quadratic). Headings, fences, emphasis and code spans are now matched in
  linear (code spans O(n log n)) time with the same output (checked by differential fuzzing
  against 0.2.0). One visible change: `markdownToText` no longer treats a `[` inside link text as
  part of it (`[a [b](u) c` → `[a b c`, was `a [b c`). Products that render user Markdown with
  this module should move to 0.2.1.

## 0.2.0 — 2026-09-22

**Breaking: `index-hooks` now emits the released `search.index-document@1`** (openvibe-contracts
v0.12.0, owned by OpenVibe.Search) instead of the 0.1.0 proposal, and builds the events Search
actually consumes. Products on 0.1.0 must update their calls; nothing else changed.

### Changed (breaking)
- `buildIndexDocument()` takes `owner` (was `service`) and returns exactly the contract shape:
  `owner`, `type`, `id`, `revision`, `deleted`, `visibility`, `acl`, `canonical_url`, `title`,
  `summary`, `body`, `facets`, `language` (was `locale`), `authorship`, `provenance`,
  `publication_state`, `published_at`, `updated_at`, `indexability { decision, reasons }`.
  Gone: `schema`, `owner_service`, `resource_type`, `resource_id`, `acl.public`, `body_truncated`,
  the `indexability.indexable/listable/gate` fields and the provenance object.
- Mappings onto the contract enums: visibility `gated` → `members`; authorship `hybrid` →
  `ai_assisted`, `ai` → `ai_generated`; gate reason codes → Search's known reasons where one exists
  (`thin` → `thin_content`, `ai_generated_unreviewed` → `ai_unreviewed`, `unreviewed_sensitive` →
  `sensitive_unreviewed`, `gated` → `members_only`, `unpublished` → `not_published`,
  `missing_canonical` → `missing_canonical_url`, `noindex_requested` → `owner_decision`; the rest
  keep the gate's code). `provenance` is now an array of typed references built from citations
  (Sources items, or the owner's own citation records), the AI run (with `stub: true` for stub
  output) and extra `provenance` refs.
- `tombstone()` returns exactly `{ owner, type, id, revision, deleted: true }`. Anything not
  published (draft, scheduled, unpublished, retracted, archived, deleted) is still a tombstone, and
  so is unlisted content unless `includeUnlisted: true` (then `visibility: 'unlisted'`).
- ACL follows the contract: `subjects` are `usr_`/`gst_` only, plus `groups` and `entitlements`;
  private needs subjects, members needs at least one of the three. Text is clipped to the contract's
  limits (title 500, summary 4000, body 48000); facets are checked against its rules.
- `publicationEvent()` (the product's own `<product>.<type>.<action>` event) no longer embeds the
  document; its payload is `{ canonical_url, publication_state, indexability }`.

### Added
- `indexEvent({ document })`: `<owner>.index_document.upserted` (payload = document) or
  `<owner>.index_document.deleted` (payload = `{ type, id, revision }`), subject
  `{ type, id, revision }`, visibility internal — the envelopes OpenVibe.Search's webhook consumes.
- `createIndexSequencer(db, { prefix })`: a monotonic index revision per resource in
  `<prefix>_index_revisions`. Search refuses a different document at an equal revision and lets a
  tombstone win ties, so every indexed change (content, visibility, state, canonical URL,
  decision) needs a higher revision; an unchanged document keeps its revision (a safe replay).
- `searchIndexability(decision)`, `SEARCH_REASONS`, `AUTHORSHIP`, `LIMITS`.
- Tests validate every emitted document with `validate('search.index-document@1')` and every
  envelope with `validate('events.event-envelope@1')` from openvibe-contracts v0.12.0, and mirror
  Search's webhook checks (owner = source, subject matches the payload).

### Removed
- `docs/contracts-proposal/search.index-document.v1.json` (superseded by the released contract).

## 0.1.0 — 2026-09-22

First version (roadmap Wave 15). Packages only: no runtime, no domain, no database.

### Added
- `revisions`: drafts, immutable revisions with parent pointers (UPDATE/DELETE blocked by SQLite
  triggers), optimistic concurrency with a 412 `revision.conflict`, line and word diffs (Myers, with
  a bounded fallback), revert as a new revision, audited `purgeEntity`.
- `schedule`: idempotent publish/unpublish jobs with leases; re-run safe after a worker crash;
  retry with backoff; abandoned after `maxAttempts`; injectable clock.
- `taxonomy`: slugs, get-or-create terms per vocabulary, hierarchical categories, entity links.
- `citations`: append-only source references per revision (Sources item id / URL, retrieved_at,
  quote span, license note), `carryForward`, lookups by source item.
- `media`: attachments by Media object id with `unverified | available | broken` states and an
  explicit broken placeholder in `figureHtml`.
- `discussion`: Community thread resolution (`POST /api/v1/comments/threads/resolve`) with a
  service token; stores thread ids only.
- `seo`: the deterministic indexability gate (19 stable reason codes, `hidden`/`noindex` effects),
  canonical URL builder, history-aware redirects, meta/robots tags, sitemaps, RSS 2.0, Atom 1.0,
  JSON Feed 1.1, JSON-LD builders (Article/BlogPosting/NewsArticle, Review, Product/Offer,
  AggregateRating, BreadcrumbList, WebPage) that omit anything not provided.
- `authorship`: human / ai / hybrid / imported records with AI workflow + run references,
  disclosure labels, append-only human review log; AI content starts as draft + noindex.
- `index-hooks`: Search index documents and tombstones, `actionFor` transitions, and
  `<product>.<type>.<action>` event envelopes valid against `events.event-envelope@1`.
- `ssr`: escaping templates, safe Markdown subset, pagination, breadcrumbs, diff markup, `<time>`.
- `examples/two-products`: a mini wiki and a mini blog with separate databases (the exit proof).
- Proposed contract `docs/contracts-proposal/search.index-document.v1.json`.
