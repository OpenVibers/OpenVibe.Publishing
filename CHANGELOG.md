# Changelog

All notable changes to `openvibe-publishing`. Versions follow [semver](https://semver.org/): a
breaking change to any exported function, table layout, reason code or document shape is a new
major (a minor while 0.x). A release is the git tag `vX.Y.Z`; consumers pin the tag's tarball.

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
