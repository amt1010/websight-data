# Phase 4, Sub-project 1 — Crawls REST API: Design

Status: approved
Date: 2026-07-29
Repo: websight-data (extends the existing repo, no new repo)

## Context

Phase 3 (`docs/superpowers/specs/2026-07-28-phase-3-data-jobs-design.md`)
built the crawl pipeline (BullMQ worker, Postgres persistence, R2 storage)
but explicitly deferred any REST/GraphQL API in front of it — the only way
to trigger or read a crawl today is the CLI (`npm run cli -- enqueue
<domain>` / `status <crawlId>`), confirmed again as still-missing by the
README ("Phase 3's own crawl pipeline still has no REST/GraphQL API in
front of it") and the auth-subscriptions-api spec ("once Phase 4 resumes,
its endpoints ... will be added to the same API surface").

This is that API. It's the first of two sub-projects making up Phase 4
(`websight-base/ROADMAP.md`'s "wire the frontend to the real backend"): this
one gives `websight-data` an HTTP surface for creating and reading crawls;
the second (not yet speced) wires `websight-base`'s UI to it, replacing the
`BSW` mock. This spec covers only the API — no frontend changes.

### Why the existing quota API isn't enough as-is

The auth-subscriptions-api feature already gates *starting* a scan
(`POST /api/scans/consume`) by guest/free/paid tier, but that endpoint only
decrements a counter — it doesn't know about crawls at all (added before
Phase 3's pipeline had any caller). Wiring a real crawl in means every
"Analyze" click must both spend a scan **and** enqueue a real crawl, or a
caller could hit whichever endpoint is unguarded and get free scans or
crawl for free.

### Why `crawls` needs an owner column

`crawls.id` is a bare serial integer with no linkage to who requested it.
An unauthenticated (or any-authenticated-caller) `GET /crawls/:id` would
let anyone enumerate sequential ids and read other users'/guests' crawl
results — domain, detected third-party integrations, page screenshots.
The auth-subscriptions-api spec accepted no server-side tab-gating
enforcement specifically *because* results were mock data ("nothing
sensitive"); that reasoning no longer holds once results are real. This
spec adds ownership and enforces it.

## Components

```
websight-data/
  api/
    crawls/
      index.ts        POST  — create a crawl (quota check + consume + enqueue)
                       GET   — list the caller's own crawls
      [id].ts          GET   — read one crawl's status, and full result once done
  src/
    crawls.ts          createCrawl(), getCrawlDetail(), listCrawls() — the
                        testable logic each api/crawls/*.ts handler wraps
    db/
      schema.ts         (existing file) — crawls gains userId, guestToken
      crawls.ts          (existing file) gains getCrawlPages/getCrawlClusters/
                          getCrawlIntegrations, listCrawlsForOwner(), and
                          insertQueuedCrawl() takes an owner param
    storage/
      index.ts          (existing file) — Storage gains getSignedUrl()
```

This follows the exact shape of the existing `api/scans/consume.ts` /
`api/me.ts` routes: each `api/**/*.ts` file is a thin Vercel handler
(method check, call into `src/`, `errorToResponse` on catch); the actual
logic lives in `src/crawls.ts` as plain, unit-testable functions.

## Schema change

```ts
export const crawls = pgTable('crawls', {
  id: serial('id').primaryKey(),
  domain: text('domain').notNull(),
  status: text('status', { enum: ['queued', 'running', 'done', 'failed'] })
    .notNull().default('queued'),
  userId: integer('user_id').references(() => users.id),
  guestToken: text('guest_token'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  error: text('error'),
});
```

`userId`/`guestToken` mirror `scanUsage`'s existing convention: exactly one
is set per row, enforced at the application layer (not a DB constraint),
set once at creation from whichever identity created the crawl. A Drizzle
migration (`npm run db:generate` then `db:migrate`) is required, run
against both `TEST_DATABASE_URL` and `DATABASE_URL` per the README's
existing two-branch process.

## Storage change

```ts
export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<string>;
  get(key: string): Promise<Buffer>;
  getSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
}
```

R2 implementation uses `@aws-sdk/s3-request-presigner`'s
`getSignedUrl(client, new GetObjectCommand(...), { expiresIn })` (new
dependency). The in-memory test fake returns a deterministic fake URL
(e.g. `memory://{key}?expires={expiresInSeconds}`) — sufficient for
asserting the API wires signed URLs into its response without hitting real
R2, consistent with how `createInMemoryStorage` is already used in
`worker.test.ts`.

## Endpoints

### `POST /api/crawls`

Body: `{ domain: string, guestToken?: string }`. Identity: `Authorization:
Bearer <clerk-jwt>` if logged in, else `guestToken` in the body — same
branching `consumeScan` already does.

1. Normalize `domain` (`normalizeDomain()` in `src/crawls.ts`): trim, strip
   a leading `http://`/`https://` and any path/query, lowercase. Throws
   `BadRequestError` if empty after normalizing.
2. Resolve identity exactly as `consumeScan` does today (Clerk verify +
   `findOrCreateUser`, or `validateGuestToken`).
3. Quota check against the resolved identity's plan/guest limit — reuses
   `countScansForUser`/`countScansForGuestToken` and throws
   `QuotaExceededError` (402) exactly as today, same response body shape
   (`{error, plan, scanLimit, used}`).
4. If under quota: record scan usage (`recordScanForUser`/
   `recordScanForGuestToken`), then insert the `crawls` row with the
   resolved owner and enqueue the BullMQ job (extends
   `enqueueCrawl`/`insertQueuedCrawl` to accept `{ userId }` or
   `{ guestToken }`).
5. Response: `201 { crawlId, remainingScans }`.

No crawl options (max pages/depth) are accepted from the client in this
pass — always `{}` (crawler defaults), same as the CLI's `enqueue`
command. No UI surfaces this yet.

### `GET /api/crawls/:id`

Identity: `Authorization: Bearer` header, or `?guestToken=` query param
(GET has no body).

1. Look up identity the same way as `POST`, without the quota check (a
   read doesn't spend a scan).
2. Load the `crawls` row (`getCrawlStatus`). `NotFoundError` (404) if it
   doesn't exist.
3. Ownership check: the resolved identity's `userId`/`guestToken` must
   match the row's. `ForbiddenError` (403) otherwise.
4. Response shape depends on `status`:
   - `queued` / `running`: `{ id, domain, status, startedAt, finishedAt: null, error: null }`.
   - `failed`: same shape plus `error` populated, no result data (matches
     Phase 3: no partial `pages`/`clusters`/`integrations` rows exist).
   - `done`: adds `pages`, `clusters`, `integrations` (via new
     `getCrawlPages`/`getCrawlClusters`/`getCrawlIntegrations` reads). Each
     page's `screenshotKey`/`htmlKey` columns are replaced in the response
     by `screenshotUrl`/`htmlUrl` — a signed R2 URL (1 hour expiry) via
     `storage.getSignedUrl()`, or `null` if the key itself is `null` (a
     page whose asset upload failed per Phase 3's error handling). Raw R2
     keys are never returned to the client.

### `GET /api/crawls`

Identity: same as `GET /api/crawls/:id` (Bearer header or `?guestToken=`).
Returns `{ crawls: [{ id, domain, status, startedAt, finishedAt }, ...] }`
for the resolved identity's own crawls only, newest first — no pagination
in this pass (matches the existing admin list endpoints' lack of
pagination). Backs the frontend's future project-history sidebar
(sub-project 2), kept in this spec so that later work doesn't stall on
missing API surface.

## Error handling

No new error types — reuses `BadRequestError` (400, bad domain),
`AuthError` (401, bad/missing Clerk token), `ForbiddenError` (403, not the
owner), `NotFoundError` (404, unknown crawl id), `QuotaExceededError` (402,
same shape as today's `consume` endpoint).

## Testing

Same conventions as the existing `api/` test suite (`fileParallelism:
false`, real Neon/Upstash test instances, Clerk verification stubbed):

- `POST /api/crawls`: quota enforcement at guest/free/paid boundaries
  (mirrors `consume.test.ts`'s existing cases, now asserting a `crawls` row
  + BullMQ job are also created); domain normalization; 400 on empty
  domain.
- `GET /api/crawls/:id`: 404 unknown id; 403 cross-owner access (a
  different user's token, and a different guestToken); response shape
  differs correctly across `queued`/`running`/`done`/`failed`; signed URLs
  present (via the in-memory storage fake) only in the `done` case and
  only for pages with non-null keys.
- `GET /api/crawls`: returns only the caller's own crawls, newest first.
- `src/storage/index.ts`: in-memory fake's `getSignedUrl` returns the
  expected deterministic format; no new R2-integration test (matches the
  existing "manual-only" bar for real R2 calls).

## Out of scope (confirmed)

- Any `websight-base` frontend changes — sub-project 2.
- Crawl options (depth/page limits) from the client — always crawler
  defaults this pass.
- Pagination on `GET /api/crawls`.
- Cancelling a queued/running crawl.
- Re-running/deleting a crawl.
