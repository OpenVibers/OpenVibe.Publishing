# OpenVibe.Publishing

> Shared publishing packages for the OpenVibe publication products: Wiki, Blog, News, Reviews,
> Deals, Coupons and Trade.

**Status:** alpha, 0.2.1 (roadmap Wave 15). The modules are tested and the exit proof
(`examples/two-products`) runs in `npm test`. v0.1.0, v0.2.0 and v0.2.1 (a Markdown
ReDoS fix — see [CHANGELOG.md](CHANGELOG.md)) are tagged; CI is green on v0.2.1. Seven products pin
v0.2.1 and run it in production: Wiki and Blog (public at openvibe.wiki and openvibe.blog) and News,
Reviews, Deals, Coupons and Trade (deployed loopback-only on the host, not launched).
**Package:** `openvibe-publishing` (CommonJS, Node ≥ 20, production runs Node 22).
**License:** MIT, like OpenVibe.Shared.

## The rule: packages, not an authority

This repository is **code, never state**. It has no runtime, no port, no domain, no database and
no API of its own, and it must never get one. Each product (Wiki, Blog, News, …) owns its
publication state in its own database; these modules take the product's `better-sqlite3` handle
and a table prefix, and create `<prefix>_…` tables *inside that product's database*. Two products
share the code, not the data: `wiki.db` holds `wiki_*` tables, `blog.db` holds `blog_*` tables,
and nothing is shared between them (proved by [test/two-products.test.js](test/two-products.test.js)).

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
| `openvibe-publishing/ssr` | auto-escaping `html` tagged templates with `raw()`, a safe Markdown subset, plain-text extraction, word count, server pagination, breadcrumbs, diff markup, honest `<time>` | — |

`require('openvibe-publishing')` exposes all of them lazily (`.revisions`, `.seo`, `.indexHooks`, …).

## Install

Pin the release tarball, like every OpenVibe package (never a `file:` link or a vendored copy):

```json
"openvibe-publishing": "https://codeload.github.com/OpenVibers/OpenVibe.Publishing/tar.gz/refs/tags/v0.2.1"
```

`better-sqlite3` (≥ 11) is a peer dependency: the product brings its own handle. The only runtime
dependency is `openvibe-shared` (v1.0.0), whose `seo` module is the network's single implementation
of head tags, sitemap XML, robots.txt and JSON-LD escaping; this package adds the publication rules on top.

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
  (SQLite triggers) except by an audited purge.
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
const doc = seq.stamp(hooks.buildIndexDocument({ owner: 'wiki', type: 'page', id, revision: 0, state, visibility, … , decision }));
outbox.enqueue(hooks.indexEvent({ document: doc }));   // wiki.index_document.upserted | .deleted
```

`indexEvent()` builds the envelope Search's webhook consumes (payload = the document, or
`{ type, id, revision }` for a deletion; subject `{ type, id, revision }`; visibility internal).
`publicationEvent()` builds the product's own `<product>.<type>.<action>` event (payload: canonical
URL, publication state, indexability; public only for public, listable content). Neither sets
`event_id`: the OpenVibe.Events outbox assigns it. Enqueue both in the same transaction as the
product's state change. Tests validate every document and envelope with openvibe-contracts
v0.12.0 and mirror Search's webhook checks.

## Exit proof: two products

[examples/two-products](examples/two-products) holds a mini wiki and a mini blog, each with its own
SQLite file and its own publication tables, both using revisions, citations, the gate and feeds with
different editorial policies. `node examples/two-products/wiki/app.js` (port 4801) and
`node examples/two-products/blog/app.js` (port 4811) serve them on temp databases.
[test/two-products.test.js](test/two-products.test.js) shows they load the same modules, that each
database holds only its own product's tables, that writes never cross, and that pages are useful
without JavaScript, old slugs 301, private/VIP/deleted content leaves feeds and sitemaps, and
scheduled publication survives a worker restart.

## Development

```bash
fnm exec --using=22.22.1 npm install
fnm exec --using=22.22.1 npm test          # every test/*.test.js, temp databases, no network
```

## What it does not do

- It does not own publication state, run workers, listen on a port, or talk to a database it was not handed.
- It does not decide editorial rules: each product passes its own gate policy and its own permission checks.
- It does not store or render comment content (Community owns it), media bytes (Media owns them) or
  source items (Sources owns them); it stores references.
- It is not a notification, search or event runtime: it builds the documents and envelopes those services consume.

## Depends on

- `openvibe-shared` v1.0.0 (`seo`), at runtime.
- `better-sqlite3` ≥ 11, supplied by the consumer.
- Contracts it produces for: `common.entity-ref@1`, `media.media-ref@1`, `events.event-envelope@1`
  and `search.index-document@1` (validated in tests against `openvibe-contracts` v0.12.0, a
  devDependency: nothing in `lib/` needs it at runtime).
