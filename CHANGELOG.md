# Changelog

All notable changes to `openvibe-publishing`. Versions follow [semver](https://semver.org/): a
breaking change to any exported function, table layout, reason code or document shape is a new
major (a minor while 0.x). A release is the git tag `vX.Y.Z`; consumers pin the tag's tarball.

## 0.4.0 — 2026-09-24

openvibe-shared is now a **peer dependency** (`>=1.5.0`), resolved from the product's own install, the way `better-sqlite3` already was. Until now every Shared release forced a Publishing release; without one, each product installed a second, nested copy of openvibe-shared. Products must keep openvibe-shared in their own dependencies (every OpenVibe product does). No API change.

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
