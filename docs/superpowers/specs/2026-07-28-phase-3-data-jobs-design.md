# Phase 3 — Data + Jobs: Design

Status: approved
Date: 2026-07-28
Repo: websight-data (new, separate from both websight-base and
websight-crawler)

## Context

Phase 2 (see `websight-crawler`'s
`docs/superpowers/specs/2026-07-27-phase-2-crawler-design.md`, merged to
master) delivered a standalone crawler engine: `crawl(domain, options)`
walks a domain with Playwright and returns one in-memory `CrawlResult` —
pages, clusters, detected integrations. It explicitly deferred persistence,
async execution, and object storage to Phase 3. It also doesn't capture
screenshots at all, and discards each page's full HTML right after computing
the DOM fingerprint.

The roadmap (`websight` repo `ROADMAP.md`) describes Phase 3 as:

- Postgres for crawl results (domains, pages, templates, detected APIs).
- A job queue (BullMQ + Redis) so crawls run async and the UI can poll status.
- Object storage (S3) for page screenshots/HTML snapshots powering the X-ray
  view.

This spec covers all three, plus the screenshot/HTML capture needed to give
the storage layer something to store. It does **not** include a REST/GraphQL
API or any frontend wiring — that's Phase 4, which will read from the
Postgres tables this phase creates.

## Repo boundary and why

Phase 3 lives in a **new repo, `websight-data`**, separate from
`websight-crawler` — following the same reasoning Phase 2 used to split the
crawler out from the frontend: each repo tracks one deployable
concern and its own dependency tree. `websight-crawler` stays a pure
`crawl(domain, options)` library with Playwright as its heavy dependency;
`websight-data` owns persistence, queueing, and storage, and depends on
`websight-crawler` rather than absorbing it. This also sets the precedent
Phase 4 will likely follow for its API server (another repo, depending on
`websight-data`'s tables).

**Consequence**: capturing screenshots/HTML is a crawler-side change (it
happens during the page visit, inside `websight-crawler`), not a
`websight-data` change. That work happens first, as a small addition to
`websight-crawler` on its own branch (e.g. `phase-3-screenshot-capture`),
merged and tagged (e.g. `v0.2.0`) so `websight-data` can depend on a stable,
versioned `crawl()` that returns screenshots/HTML alongside everything it
returns today. `websight-data`'s own work only starts once that tag exists.

### Cross-repo dependency

`websight-data`'s `package.json` depends on `websight-crawler` as a **git
dependency pinned to a tag**:

```json
"dependencies": {
  "websight-crawler": "github:amt1010/websight-crawler#v0.2.0"
}
```

Real TypeScript types flow through (no publishing step to a registry needed
at this stage), and bumping the crawler version is a deliberate, visible
`package.json` change rather than an implicit floating dependency.

## Providers

Cloud-hosted from day one, no local Docker infra:

- **Postgres**: Neon (serverless, branching — a disposable branch is also
  the test database, see Testing).
- **Redis**: Upstash (serverless, works with BullMQ's standard Redis
  protocol connection).
- **Object storage**: Cloudflare R2 (S3-compatible API, no egress fees —
  relevant later when the frontend reads screenshots back).
- **DB client**: Drizzle ORM — SQL-like, strong TS inference, lightweight
  enough for a schema this size, works well with Neon's serverless driver.

Config (`DATABASE_URL`, `REDIS_URL`, `R2_*`) is read from environment
variables, documented in `.env.example`. No secrets committed.

## Architecture

```
websight-crawler (v0.2.0+)                    websight-data
┌──────────────────────────┐
│ crawl(domain, options)    │
│  → CrawlResult, now       │
│    including per-page     │
│    screenshot + full HTML │
└─────────────┬─────────────┘
              │ imported as a dependency
              ▼
      enqueueCrawl(domain, options)
        │  (src/queue/producer.ts)
        ▼
      BullMQ job on Upstash Redis
        │
        ▼
      worker (src/queue/worker.ts, long-running process)
        │
        ├─▶ crawl(domain, options)   [from websight-crawler]
        │
        ├─▶ storage.put() each page's screenshot/HTML to R2, keyed by
        │     {domain}/{crawlId}/{pageHash}.{png,html}
        │
        └─▶ db/persist.ts writes CrawlResult + storage keys into Postgres,
              updates crawls.status along the way
```

### Job lifecycle

1. `enqueueCrawl(domain, options)` inserts a `crawls` row with
   `status='queued'` and adds a matching BullMQ job (job id = crawl row id).
2. Worker picks up the job, sets `status='running'`, `started_at=now()`.
3. Worker runs `crawl()` (screenshot/HTML capture happens inside the
   existing page-visit loop in `websight-crawler`, no second pass over the
   site).
4. On success: uploads succeed-or-log-per-page (see Error handling), full
   result persisted, `status='done'`, `finished_at=now()`.
5. On failure (crawl-level, e.g. `CrawlAbortedError`): `status='failed'`,
   `error` column set, no partial page rows left dangling — persistence
   happens in one transaction after the crawl finishes, not incrementally.

Nothing in this phase polls the job status — that consumer is Phase 4. This
phase just makes status queryable by crawl id via a plain `db` read.

## Schema (Drizzle, Postgres)

- **`crawls`**: `id` (pk), `domain`, `status` (`queued`/`running`/`done`/
  `failed`), `started_at`, `finished_at`, `error`.
- **`pages`**: `id` (pk), `crawl_id` (fk), `url`, `path`, `depth`, `status`,
  `error`, `links` (jsonb), `request_urls` (jsonb), `script_srcs` (jsonb),
  `dom_fingerprint` (jsonb), `screenshot_key` (nullable), `html_key`
  (nullable).
- **`clusters`**: `id` (pk), `crawl_id` (fk), `url_pattern`, `page_urls`
  (jsonb), `representative_fingerprint` (jsonb).
- **`integrations`**: `id` (pk), `crawl_id` (fk), `name`, `category`,
  `matched_urls` (jsonb).

This mirrors the crawler's `CrawlResult` field-for-field (plus the two new
storage-key columns), so Phase 4's read path is a direct mapping, not a
translation layer.

## Components

### In `websight-crawler` (small addition, own branch + tag, precedes
`websight-data` work)

- `src/pageVisitor.ts` (modified) — capture `page.screenshot({ fullPage:
  true })` and retain the already-fetched `html` string in `VisitResult`
  instead of discarding it after fingerprinting.
- `src/types.ts` (modified) — `PageRecord` gains `screenshot: Buffer`,
  `html: string` (raw capture; `websight-data` decides what to do with
  them — the crawler itself still doesn't know about object storage).
- Tag a new version (e.g. `v0.2.0`) once merged.

### In `websight-data` (new repo, this phase's main deliverable)

- `src/db/schema.ts` — Drizzle table definitions above.
- `src/db/client.ts` — Neon connection via Drizzle's serverless driver, reads
  `DATABASE_URL`.
- `src/db/persist.ts` — `persistCrawlResult(crawlId, result)`, one function
  that writes a finished `CrawlResult` into all four tables.
- `src/storage/index.ts` — `put(key, buffer, contentType) → key`,
  `get(key) → buffer`; thin wrapper over the S3-compatible SDK pointed at R2.
  Interface only touches these two methods so it's mockable in tests and
  swappable later.
- `src/queue/producer.ts` — `enqueueCrawl(domain, options) → crawlId`.
- `src/queue/worker.ts` — BullMQ worker entrypoint; the
  enqueue→crawl→upload→persist pipeline described above. Run via
  `npm run worker`; long-running, local/manual for now (no deploy target
  until Phase 5).
- `src/cli.ts` — thin CLI: `enqueue <domain>` (prints a crawl id),
  `status <crawlId>` (reads the `crawls` row). This replaces the
  `--async` CLI flag idea from the earlier draft of this spec — that
  doesn't make sense once enqueue/worker live in a different repo from the
  synchronous `websight-crawler` CLI, which is untouched and keeps writing
  JSON files exactly as it does today.

## Error handling

- Per-page crawl failures: unchanged from Phase 2 (recorded on the page,
  crawl continues) — this behavior lives in `websight-crawler` and isn't
  touched by this phase.
- Per-page screenshot/HTML upload failure: logged, that page's
  `screenshot_key`/`html_key` stay `null` in the persisted row — doesn't fail
  the crawl or the job.
- Crawl-level failure (`CrawlAbortedError` or unexpected throw from
  `crawl()`): caught in the worker, `crawls.status='failed'` with the error
  message persisted, job marked failed in BullMQ (so it shows up in
  Upstash/BullMQ tooling as failed, not silently dropped). No partial
  `pages`/`clusters`/`integrations` rows are written for a failed crawl.
- Worker process crash mid-job (not a caught error — e.g. OOM, process
  killed): BullMQ's stalled-job detection requeues it per default retry
  config; `crawls.status` stays `running` until the retry either finishes or
  exhausts retries and marks it `failed`. No custom recovery logic beyond
  BullMQ's built-in retry — real dead-letter handling/alerting is a Phase 5
  observability concern.

## Testing

- **`websight-crawler`'s screenshot/HTML capture**: extends the existing
  Phase 2 fixture-server test suite there — assert a screenshot buffer and
  full HTML string come back for a fixture page, same pattern as existing
  link/script-src assertions. Lives and runs in that repo's CI, ships with
  the `v0.2.0` tag.
- **`db/persist.ts`**: unit tests against a real disposable Neon branch
  created for the test run (mirrors Phase 2's "no mocking the real thing"
  spirit for infra that's cheap to spin up). If branch-per-test-run proves
  too slow/flaky in practice, fall back to a single shared test branch reset
  between tests — a decision left to implementation, not blocking this spec.
- **`storage`**: interface is two methods (`put`/`get`) — tests use an
  in-memory fake implementing the same interface rather than hitting real
  R2. One small manual/integration check against real R2 credentials,
  gated the same way Phase 2 gates real-domain crawls (not part of CI).
- **`queue`**: `enqueueCrawl` tested against a real Upstash Redis test
  database (cheap, serverless, no local Redis needed). Worker pipeline logic
  (capture → upload → persist → status transitions) tested by calling the
  worker's internal handler function directly with a fake `crawl()` (from
  `websight-crawler`) and fake `storage`, rather than running BullMQ's
  polling loop in tests.
- CI needs three new secrets (test Neon branch URL, test Upstash URL, and
  either skips the R2 integration test or needs R2 test credentials) —
  added to `websight-data`'s GitHub Actions secrets as part of
  implementation. A GitHub token with read access to `websight-crawler` may
  also be needed for the git-dependency install in CI, depending on whether
  the crawler repo is public.

## Out of scope for Phase 3 (confirmed)

- REST/GraphQL API, frontend wiring, loading/error states in the UI —
  Phase 4.
- Auth — Phase 4.
- Worker deployment/hosting, autoscaling — Phase 5.
- Dead-letter queues, retry alerting, crawl-rate/observability dashboards —
  Phase 5.
- Full rate-limiting/robots.txt compliance — Phase 5 (unchanged from Phase
  2's deferral).
