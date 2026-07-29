# Phase 4 Crawls REST API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `websight-data` an HTTP surface (`POST /api/crawls`, `GET /api/crawls`, `GET /api/crawls/:id`) in front of the existing BullMQ crawl pipeline, with per-owner access control, replacing the CLI as the pipeline's only caller.

**Architecture:** Three new Vercel serverless routes under `api/crawls/`, following the exact shape of the existing `api/scans/consume.ts`/`api/admin/plans.ts` routes — an exported, unit-testable logic function per HTTP verb plus a thin default `handler`. Logic lives directly in the `api/**/*.ts` files (not a separate `src/` module), matching this repo's established convention. A shared `resolveIdentity()` helper (new) removes the Clerk-vs-guest branching duplication that would otherwise repeat across all three routes.

**Tech Stack:** Vercel serverless functions (`@vercel/node`), Drizzle ORM (Postgres/Neon), BullMQ (Upstash Redis), `@aws-sdk/s3-request-presigner` (new dependency, for signed R2 URLs), Vitest against real Neon/Upstash test instances (existing convention).

## Global Constraints

- Logic lives in `api/**/*.ts` files (exported function + default `handler`), never in a separate `src/crawls.ts` — matches every existing route in this repo (`api/scans/consume.ts`, `api/me.ts`, `api/admin/plans.ts`).
- `crawls.userId`/`crawls.guestToken`: exactly one set per row, enforced at the application layer, never both — same convention as the existing `scanUsage` table.
- Raw R2 object keys (`screenshotKey`/`htmlKey`) are never returned in an API response — always converted to signed URLs (or omitted) first.
- No crawl options (depth/page limits) accepted from the client this pass — always `{}` (crawler defaults).
- Existing `insertQueuedCrawl`/`enqueueCrawl` callers (`src/cli.ts`, `test/queue/producer.test.ts`, `test/queue/worker.test.ts`, `test/db/crawls.test.ts`) must keep working unchanged — the new owner parameter is optional and defaults to no owner.
- `npm test` requires `TEST_DATABASE_URL`/`TEST_REDIS_URL` to be real, reachable values (this repo's tests never mock the database or queue). Load `.env` into the test process with `node --env-file=.env node_modules/vitest/vitest.mjs run` (or equivalent) rather than a bare `source .env` — this repo's Postgres URLs contain `&channel_binding=require`, which a shell `source` misparses as backgrounding the command, silently leaving the variable empty.

---

### Task 1: Add owner columns to `crawls` and migrate

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/crawls.ts:6-9` (`insertQueuedCrawl`)
- Create: `drizzle/0002_<name>.sql` (generated, not hand-written)
- Modify: `test/db/crawls.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `crawls.userId: number | null`, `crawls.guestToken: string | null` columns — consumed by Task 2's read functions and Task 6/7's ownership checks. `insertQueuedCrawl(db, domain, owner?: { userId?: number; guestToken?: string }): Promise<number>` — the new optional third parameter is consumed by Task 3's `enqueueCrawl`.

- [ ] **Step 1: Add the columns to the schema**

In `src/db/schema.ts`, change the `crawls` table definition to:

```ts
export const crawls = pgTable('crawls', {
  id: serial('id').primaryKey(),
  domain: text('domain').notNull(),
  status: text('status', { enum: ['queued', 'running', 'done', 'failed'] })
    .notNull()
    .default('queued'),
  userId: integer('user_id').references(() => users.id),
  guestToken: text('guest_token'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  error: text('error'),
});
```

Note `users` is defined later in the same file — Drizzle table references don't require declaration order, but if TypeScript complains, move the `crawls` table definition below `users`/`plans` in the file (keep `pages`/`clusters`/`integrations` immediately after `crawls`, since they reference it).

- [ ] **Step 2: Update `insertQueuedCrawl` to accept an optional owner**

In `src/db/crawls.ts`, replace:

```ts
export async function insertQueuedCrawl(db: Db, domain: string): Promise<number> {
  const [row] = await db.insert(crawls).values({ domain, status: 'queued' }).returning({ id: crawls.id });
  return row.id;
}
```

with:

```ts
export async function insertQueuedCrawl(
  db: Db,
  domain: string,
  owner: { userId?: number; guestToken?: string } = {}
): Promise<number> {
  const [row] = await db
    .insert(crawls)
    .values({ domain, status: 'queued', userId: owner.userId ?? null, guestToken: owner.guestToken ?? null })
    .returning({ id: crawls.id });
  return row.id;
}
```

- [ ] **Step 3: Generate and apply the migration**

Run: `npm run db:generate`
Expected: a new file appears under `drizzle/` (e.g. `0002_<name>.sql`) adding `user_id`/`guest_token` columns to `crawls`.

Apply it to both Neon branches (per this repo's existing two-branch convention):

```bash
node --env-file=.env -e "process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; require('child_process').execSync('npm run db:migrate', {stdio: 'inherit', env: process.env})"
node --env-file=.env node_modules/.bin/drizzle-kit migrate
```

The first command migrates the test branch (by pointing `DATABASE_URL` at `TEST_DATABASE_URL` for that one invocation); the second migrates the real branch using `DATABASE_URL` as-is from `.env`.

- [ ] **Step 4: Add a round-trip test for the new columns**

In `test/db/crawls.test.ts`, add to the `describe('crawl row lifecycle', ...)` block:

```ts
  it('records an owner (userId or guestToken) when provided', async () => {
    const withUser = await insertQueuedCrawl(db, 'example.com', { userId: 42 });
    const userRow = await getCrawlStatus(db, withUser);
    expect(userRow).toMatchObject({ userId: 42, guestToken: null });

    const withGuest = await insertQueuedCrawl(db, 'example.com', { guestToken: 'guest-xyz' });
    const guestRow = await getCrawlStatus(db, withGuest);
    expect(guestRow).toMatchObject({ userId: null, guestToken: 'guest-xyz' });
  });

  it('defaults to no owner when none is provided', async () => {
    const crawlId = await insertQueuedCrawl(db, 'example.com');
    const row = await getCrawlStatus(db, crawlId);
    expect(row).toMatchObject({ userId: null, guestToken: null });
  });
```

Note: `{ userId: 42 }` in the first case has no matching row in `users` — that's fine, `references()` without `.notNull()` doesn't create a foreign-key constraint that rejects a non-existent id in this schema style (matches `scanUsage.userId`, which is exercised the same way). If Postgres does reject it with a foreign-key violation, insert a real user first via `findOrCreateUser` instead of the literal `42`.

- [ ] **Step 5: Run the test file and typecheck**

Run: `node --env-file=.env node_modules/vitest/vitest.mjs run test/db/crawls.test.ts`
Expected: all tests pass, including the two new ones.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/crawls.ts drizzle/ test/db/crawls.test.ts
git commit -m "feat: add owner columns to crawls"
```

---

### Task 2: Owner-scoped and result read functions in `db/crawls.ts`

**Files:**
- Modify: `src/db/crawls.ts`
- Modify: `test/db/crawls.test.ts`

**Interfaces:**
- Consumes: `crawls`, `pages`, `clusters`, `integrations` tables from `src/db/schema.ts` (existing + Task 1's new columns).
- Produces: `getCrawlPages(db, crawlId): Promise<PageRow[]>`, `getCrawlClusters(db, crawlId): Promise<ClusterRow[]>`, `getCrawlIntegrations(db, crawlId): Promise<IntegrationRow[]>`, `listCrawlsForOwner(db, owner: { userId?: number; guestToken?: string }): Promise<CrawlRow[]>` — all consumed by Task 6 (`listCrawlsForOwner`) and Task 7 (the other three).

- [ ] **Step 1: Add the four functions**

In `src/db/crawls.ts`, add (using the existing `eq`/`and`/`desc` operators from `drizzle-orm` — extend the top import line):

```ts
import { eq, and, isNull, desc } from 'drizzle-orm';
```

```ts
export async function getCrawlPages(db: Db, crawlId: number) {
  return db.select().from(pages).where(eq(pages.crawlId, crawlId));
}

export async function getCrawlClusters(db: Db, crawlId: number) {
  return db.select().from(clusters).where(eq(clusters.crawlId, crawlId));
}

export async function getCrawlIntegrations(db: Db, crawlId: number) {
  return db.select().from(integrations).where(eq(integrations.crawlId, crawlId));
}

export async function listCrawlsForOwner(db: Db, owner: { userId?: number; guestToken?: string }) {
  const condition =
    owner.userId !== undefined
      ? and(eq(crawls.userId, owner.userId), isNull(crawls.guestToken))
      : and(eq(crawls.guestToken, owner.guestToken!), isNull(crawls.userId));
  return db.select().from(crawls).where(condition).orderBy(desc(crawls.id));
}
```

- [ ] **Step 2: Write failing tests**

Add a new `describe` block to `test/db/crawls.test.ts`:

```ts
describe('owner-scoped and result reads', () => {
  it('lists only a user\'s own crawls, newest first', async () => {
    const a = await insertQueuedCrawl(db, 'a.com', { userId: 1 });
    const b = await insertQueuedCrawl(db, 'b.com', { userId: 1 });
    await insertQueuedCrawl(db, 'other.com', { userId: 2 });

    const rows = await listCrawlsForOwner(db, { userId: 1 });
    expect(rows.map((r) => r.id)).toEqual([b, a]);
  });

  it('lists only a guest token\'s own crawls', async () => {
    const mine = await insertQueuedCrawl(db, 'mine.com', { guestToken: 'guest-1' });
    await insertQueuedCrawl(db, 'theirs.com', { guestToken: 'guest-2' });

    const rows = await listCrawlsForOwner(db, { guestToken: 'guest-1' });
    expect(rows.map((r) => r.id)).toEqual([mine]);
  });

  it('reads back pages, clusters, and integrations for a finished crawl', async () => {
    const crawlId = await insertQueuedCrawl(db, 'example.com');
    const result: CrawlResult = {
      domain: 'example.com',
      crawledAt: '2026-07-28T00:00:00.000Z',
      pages: [
        {
          url: 'https://example.com/',
          path: '/',
          depth: 0,
          status: 'ok',
          links: [],
          requestUrls: [],
          scriptSrcs: [],
          domFingerprint: {},
          html: '<html></html>',
          screenshot: Buffer.alloc(0),
        },
      ],
      clusters: [{ id: 'c1', urlPattern: '/', pageUrls: ['https://example.com/'], representativeFingerprint: {} }],
      integrations: [{ name: 'Google Maps', category: 'maps', matchedUrls: ['https://maps.googleapis.com/x'] }],
      errors: [],
    };
    const storageKeys = new Map([['https://example.com/', { screenshotKey: 'k.png', htmlKey: 'k.html' }]]);
    await persistCrawlResult(db, crawlId, result, storageKeys);

    const [pagesOut, clustersOut, integrationsOut] = await Promise.all([
      getCrawlPages(db, crawlId),
      getCrawlClusters(db, crawlId),
      getCrawlIntegrations(db, crawlId),
    ]);
    expect(pagesOut).toHaveLength(1);
    expect(pagesOut[0]).toMatchObject({ url: 'https://example.com/', screenshotKey: 'k.png', htmlKey: 'k.html' });
    expect(clustersOut).toHaveLength(1);
    expect(integrationsOut).toHaveLength(1);
  });
});
```

Add `getCrawlPages, getCrawlClusters, getCrawlIntegrations, listCrawlsForOwner` to the existing import from `'../../src/db/crawls.js'` at the top of the file.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --env-file=.env node_modules/vitest/vitest.mjs run test/db/crawls.test.ts`
Expected: FAIL — `getCrawlPages`/`getCrawlClusters`/`getCrawlIntegrations`/`listCrawlsForOwner` are not exported yet.

- [ ] **Step 4: Implement (Step 1 above), then run again**

Run: `node --env-file=.env node_modules/vitest/vitest.mjs run test/db/crawls.test.ts`
Expected: PASS, including the three new tests from this task and the two from Task 1.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` — expect no errors.

```bash
git add src/db/crawls.ts test/db/crawls.test.ts
git commit -m "feat: add owner-scoped and result read functions for crawls"
```

---

### Task 3: Thread the owner through `enqueueCrawl`

**Files:**
- Modify: `src/queue/producer.ts`
- Modify: `test/queue/producer.test.ts`

**Interfaces:**
- Consumes: `insertQueuedCrawl(db, domain, owner?)` from Task 1.
- Produces: `enqueueCrawl(db, queue, domain, options?, owner?): Promise<number>` — consumed by Task 6 (`createCrawl`).

- [ ] **Step 1: Write the failing test**

In `test/queue/producer.test.ts`, add a new test alongside the existing one (check the existing test first for the exact `db`/`queue` setup pattern used and mirror it):

```ts
  it('threads an owner through to the crawls row', async () => {
    const crawlId = await enqueueCrawl(db, queue, 'example.com', {}, { guestToken: 'guest-abc' });
    const row = await getCrawlStatus(db, crawlId);
    expect(row?.guestToken).toBe('guest-abc');
  });
```

Add `getCrawlStatus` to whatever import from `'../../src/db/crawls.js'` (or `'../../src/db/crawls.js'` re-exported via producer) the file already uses — check the existing test file's imports first, since `getCrawlStatus` may need adding to an import line rather than a new one.

- [ ] **Step 2: Run to verify it fails**

Run: `node --env-file=.env node_modules/vitest/vitest.mjs run test/queue/producer.test.ts`
Expected: FAIL — `enqueueCrawl` doesn't accept a 5th argument yet (or the extra argument is silently ignored and `guestToken` stays `null`).

- [ ] **Step 3: Update `enqueueCrawl`**

In `src/queue/producer.ts`, replace:

```ts
export async function enqueueCrawl(
  db: Db,
  queue: Queue<CrawlJobData>,
  domain: string,
  options: Partial<CrawlOptions> = {}
): Promise<number> {
  const crawlId = await insertQueuedCrawl(db, domain);
  await queue.add('crawl', { crawlId, domain, options }, { jobId: `crawl-${crawlId}` });
  return crawlId;
}
```

with:

```ts
export async function enqueueCrawl(
  db: Db,
  queue: Queue<CrawlJobData>,
  domain: string,
  options: Partial<CrawlOptions> = {},
  owner: { userId?: number; guestToken?: string } = {}
): Promise<number> {
  const crawlId = await insertQueuedCrawl(db, domain, owner);
  await queue.add('crawl', { crawlId, domain, options }, { jobId: `crawl-${crawlId}` });
  return crawlId;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --env-file=.env node_modules/vitest/vitest.mjs run test/queue/producer.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` — expect no errors (this also confirms `src/cli.ts`'s existing 3-argument call to `enqueueCrawl` still compiles).

```bash
git add src/queue/producer.ts test/queue/producer.test.ts
git commit -m "feat: thread an owner through enqueueCrawl"
```

---

### Task 4: Signed URLs on the `Storage` interface

**Files:**
- Modify: `src/storage/index.ts`
- Modify: `test/storage/index.test.ts`
- Modify: `package.json` (new dependency)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Storage.getSignedUrl(key: string, expiresInSeconds: number): Promise<string>` — consumed by Task 7 (`getCrawlDetail`).

- [ ] **Step 1: Add the dependency**

In `package.json`, add to `dependencies` (alongside the existing `@aws-sdk/client-s3`):

```json
    "@aws-sdk/s3-request-presigner": "^3.686.0",
```

Run: `npm install`
Expected: `package-lock.json` updates, install succeeds.

- [ ] **Step 2: Write the failing tests**

Read `test/storage/index.test.ts` first to match its existing style exactly, then add:

```ts
  it('returns a signed URL for the in-memory fake', async () => {
    const storage = createInMemoryStorage();
    await storage.put('k.png', Buffer.from('x'), 'image/png');
    const url = await storage.getSignedUrl('k.png', 3600);
    expect(url).toBe('memory://k.png?expires=3600');
  });
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --env-file=.env node_modules/vitest/vitest.mjs run test/storage/index.test.ts`
Expected: FAIL — `getSignedUrl` is not a function.

- [ ] **Step 4: Implement**

In `src/storage/index.ts`:

```ts
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';

export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<string>;
  get(key: string): Promise<Buffer>;
  getSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
}
```

In `createR2Storage`'s returned object, add:

```ts
    async getSignedUrl(key, expiresInSeconds) {
      return presign(client, new GetObjectCommand({ Bucket: options.bucket, Key: key }), { expiresIn: expiresInSeconds });
    },
```

In `createInMemoryStorage`'s returned object, add:

```ts
    async getSignedUrl(key, expiresInSeconds) {
      return `memory://${key}?expires=${expiresInSeconds}`;
    },
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --env-file=.env node_modules/vitest/vitest.mjs run test/storage/index.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck` — expect no errors.

```bash
git add src/storage/index.ts test/storage/index.test.ts package.json package-lock.json
git commit -m "feat: add signed URL support to Storage"
```

---

### Task 5: Shared identity resolution helper

**Files:**
- Create: `src/auth/identity.ts`
- Create: `test/auth/identity.test.ts`

**Interfaces:**
- Consumes: `ClerkVerifier` from `src/auth/clerk.js` (existing), `findOrCreateUser` from `src/db/users.js` (existing), `validateGuestToken` from `api/scans/guest-init.js` (existing — already imported cross-file by `api/scans/consume.ts`, same precedent this follows).
- Produces: `resolveIdentity(db, clerkVerifier, authHeader, guestTokenInput): Promise<{ userId: number } | { guestToken: string }>` — consumed by Task 6 and Task 7.

This factors out the "Bearer token → Clerk-verified user, else validated guest token" branch that `api/scans/consume.ts` already has inline — the new `api/crawls/*.ts` routes need the identical branch in three places, so it's worth sharing this time rather than repeating it a third and fourth time.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../helpers/testDb.js';
import { resolveIdentity } from '../../src/auth/identity.js';
import type { ClerkVerifier } from '../../src/auth/clerk.js';

let db: TestDb;

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await resetDb(db);
});

function fakeVerifier(clerkUserId: string, email: string): ClerkVerifier {
  return { verifyRequest: async () => ({ clerkUserId, email }) };
}

describe('resolveIdentity', () => {
  it('resolves a logged-in user from a Bearer header', async () => {
    const identity = await resolveIdentity(db, fakeVerifier('clerk_1', 'a@example.com'), 'Bearer whatever', undefined);
    expect(identity).toHaveProperty('userId');
  });

  it('resolves a guest from a guestToken when there is no auth header', async () => {
    const identity = await resolveIdentity(db, fakeVerifier('unused', 'unused'), undefined, 'guest-1');
    expect(identity).toEqual({ guestToken: 'guest-1' });
  });
});
```

(Add `beforeEach`/`afterAll` to the `vitest` import.) Note this test needs a seeded free plan for the Bearer case (`findOrCreateUser` requires one, per the existing pattern in `test/db/users.test.ts`) — add `import { createPlan } from '../../src/db/plans.js';` and `await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });` before the first test's call, matching how `test/api/scans/consume.test.ts` seeds a plan for its logged-in cases.

- [ ] **Step 2: Run to verify it fails**

Run: `node --env-file=.env node_modules/vitest/vitest.mjs run test/auth/identity.test.ts`
Expected: FAIL — module `src/auth/identity.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `src/auth/identity.ts`:

```ts
import type { Db } from '../db/client.js';
import { findOrCreateUser } from '../db/users.js';
import type { ClerkVerifier } from './clerk.js';
import { validateGuestToken } from '../../api/scans/guest-init.js';

export type Identity = { userId: number } | { guestToken: string };

export async function resolveIdentity(
  db: Db,
  clerkVerifier: ClerkVerifier,
  authHeader: string | undefined,
  guestTokenInput: unknown
): Promise<Identity> {
  if (authHeader) {
    const { clerkUserId, email } = await clerkVerifier.verifyRequest(authHeader);
    const user = await findOrCreateUser(db, clerkUserId, email);
    return { userId: user.id };
  }
  const guestToken = validateGuestToken(guestTokenInput);
  return { guestToken };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --env-file=.env node_modules/vitest/vitest.mjs run test/auth/identity.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` — expect no errors.

```bash
git add src/auth/identity.ts test/auth/identity.test.ts
git commit -m "feat: add shared identity resolution helper"
```

---

### Task 6: `POST /api/crawls` and `GET /api/crawls`

**Files:**
- Create: `api/crawls/index.ts`
- Create: `test/api/crawls/index.test.ts`

**Interfaces:**
- Consumes: `resolveIdentity` (Task 5), `enqueueCrawl` (Task 3), `listCrawlsForOwner` (Task 2), `createClerkVerifier` (existing `src/auth/clerk.js`), `countScansForUser`/`countScansForGuestToken`/`recordScanForUser`/`recordScanForGuestToken`/`GUEST_SCAN_LIMIT` (existing `src/db/scanUsage.js`), `getUserWithPlan` (existing `src/db/users.js`), `BadRequestError`/`QuotaExceededError`/`errorToResponse` (existing `src/http/errors.js`), `createCrawlQueue` (existing `src/queue/producer.js`).
- Produces: nothing consumed by later tasks — this is one of the two public endpoints.

- [ ] **Step 1: Write the failing tests**

Read `test/api/scans/consume.test.ts` first to match its exact style (it's the closest analog — quota branching), then create `test/api/crawls/index.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../../helpers/testDb.js';
import { createCrawl, listCrawls, normalizeDomain } from '../../../api/crawls/index.js';
import { createPlan } from '../../../src/db/plans.js';
import { findOrCreateUser } from '../../../src/db/users.js';
import type { ClerkVerifier } from '../../../src/auth/clerk.js';
import { QuotaExceededError, BadRequestError } from '../../../src/http/errors.js';
import type { CrawlJobData } from '../../../src/queue/producer.js';
import type { Queue } from 'bullmq';

let db: TestDb;

function fakeVerifier(clerkUserId: string, email: string): ClerkVerifier {
  return { verifyRequest: async () => ({ clerkUserId, email }) };
}

function fakeQueue(): Queue<CrawlJobData> {
  return { add: vi.fn().mockResolvedValue(undefined) } as unknown as Queue<CrawlJobData>;
}

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await resetDb(db);
});

describe('normalizeDomain', () => {
  it('strips protocol, path, and lowercases', () => {
    expect(normalizeDomain('https://Example.com/foo?x=1')).toBe('example.com');
  });

  it('rejects an empty domain', () => {
    expect(() => normalizeDomain('   ')).toThrow(BadRequestError);
  });
});

describe('createCrawl — guest', () => {
  it('enqueues a crawl and returns remainingScans', async () => {
    const queue = fakeQueue();
    const result = await createCrawl(db, queue, fakeVerifier('unused', 'unused'), undefined, {
      domain: 'example.com',
      guestToken: 'guest-1',
    });
    expect(result.remainingScans).toBe(0);
    expect(queue.add).toHaveBeenCalledOnce();
  });

  it('rejects a second guest crawl on the same token', async () => {
    const queue = fakeQueue();
    await createCrawl(db, queue, fakeVerifier('unused', 'unused'), undefined, { domain: 'example.com', guestToken: 'guest-1' });
    await expect(
      createCrawl(db, queue, fakeVerifier('unused', 'unused'), undefined, { domain: 'example.com', guestToken: 'guest-1' })
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });
});

describe('createCrawl — logged in', () => {
  it('enqueues a crawl for a plan with remaining quota', async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 2 });
    const queue = fakeQueue();
    const result = await createCrawl(db, queue, fakeVerifier('clerk_1', 'a@example.com'), 'Bearer whatever', {
      domain: 'example.com',
    });
    expect(result.remainingScans).toBe(1);
  });
});

describe('listCrawls', () => {
  it('returns only the caller\'s own crawls', async () => {
    const queue = fakeQueue();
    await createCrawl(db, queue, fakeVerifier('unused', 'unused'), undefined, { domain: 'mine.com', guestToken: 'guest-1' });
    await createCrawl(db, queue, fakeVerifier('unused', 'unused'), undefined, { domain: 'theirs.com', guestToken: 'guest-2' });

    const result = await listCrawls(db, fakeVerifier('unused', 'unused'), undefined, 'guest-1');
    expect(result.crawls).toHaveLength(1);
    expect(result.crawls[0]).toMatchObject({ domain: 'mine.com' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --env-file=.env node_modules/vitest/vitest.mjs run test/api/crawls/index.test.ts`
Expected: FAIL — `api/crawls/index.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `api/crawls/index.ts`:

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import { createDb, type Db } from '../../src/db/client.js';
import { createCrawlQueue, enqueueCrawl, type CrawlJobData } from '../../src/queue/producer.js';
import { listCrawlsForOwner } from '../../src/db/crawls.js';
import {
  countScansForGuestToken,
  countScansForUser,
  recordScanForGuestToken,
  recordScanForUser,
  GUEST_SCAN_LIMIT,
} from '../../src/db/scanUsage.js';
import { getUserWithPlan } from '../../src/db/users.js';
import { createClerkVerifier, type ClerkVerifier } from '../../src/auth/clerk.js';
import { resolveIdentity } from '../../src/auth/identity.js';
import { BadRequestError, QuotaExceededError, errorToResponse } from '../../src/http/errors.js';
import { requireEnv } from '../../src/env.js';

export function normalizeDomain(input: unknown): string {
  if (typeof input !== 'string') throw new BadRequestError('domain must be a string');
  const stripped = input
    .trim()
    .replace(/^https?:\/\//i, '')
    .split(/[/?#]/)[0]
    .toLowerCase();
  if (!stripped) throw new BadRequestError('domain must not be empty');
  return stripped;
}

export async function createCrawl(
  db: Db,
  queue: Queue<CrawlJobData>,
  clerkVerifier: ClerkVerifier,
  authHeader: string | undefined,
  body: { domain?: unknown; guestToken?: unknown }
): Promise<{ crawlId: number; remainingScans: number }> {
  const domain = normalizeDomain(body?.domain);
  const identity = await resolveIdentity(db, clerkVerifier, authHeader, body?.guestToken);

  if ('userId' in identity) {
    const withPlan = await getUserWithPlan(db, identity.userId);
    const used = await countScansForUser(db, identity.userId);
    if (used >= withPlan!.plan.scanLimit) {
      throw new QuotaExceededError({ plan: withPlan!.plan.name, scanLimit: withPlan!.plan.scanLimit, used });
    }
    await recordScanForUser(db, identity.userId);
    const crawlId = await enqueueCrawl(db, queue, domain, {}, { userId: identity.userId });
    return { crawlId, remainingScans: withPlan!.plan.scanLimit - used - 1 };
  }

  const used = await countScansForGuestToken(db, identity.guestToken);
  if (used >= GUEST_SCAN_LIMIT) {
    throw new QuotaExceededError({ plan: 'Guest', scanLimit: GUEST_SCAN_LIMIT, used });
  }
  await recordScanForGuestToken(db, identity.guestToken);
  const crawlId = await enqueueCrawl(db, queue, domain, {}, { guestToken: identity.guestToken });
  return { crawlId, remainingScans: GUEST_SCAN_LIMIT - used - 1 };
}

export async function listCrawls(
  db: Db,
  clerkVerifier: ClerkVerifier,
  authHeader: string | undefined,
  guestTokenInput: unknown
) {
  const identity = await resolveIdentity(db, clerkVerifier, authHeader, guestTokenInput);
  const rows = await listCrawlsForOwner(db, identity);
  return {
    crawls: rows.map((r) => ({ id: r.id, domain: r.domain, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt })),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const clerkVerifier = createClerkVerifier(requireEnv('CLERK_SECRET_KEY'));
    const db = createDb();

    if (req.method === 'POST') {
      const connection = new Redis(requireEnv('REDIS_URL'), { maxRetriesPerRequest: null });
      const queue = createCrawlQueue(connection);
      try {
        const result = await createCrawl(db, queue, clerkVerifier, req.headers.authorization, req.body ?? {});
        res.status(201).json(result);
      } finally {
        await queue.close();
        await connection.quit();
      }
      return;
    }

    if (req.method === 'GET') {
      const result = await listCrawls(db, clerkVerifier, req.headers.authorization, req.query.guestToken);
      res.status(200).json(result);
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const { status, body } = errorToResponse(err);
    res.status(status).json(body);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --env-file=.env node_modules/vitest/vitest.mjs run test/api/crawls/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` — expect no errors.

```bash
git add api/crawls/index.ts test/api/crawls/index.test.ts
git commit -m "feat: add POST/GET /api/crawls"
```

---

### Task 7: `GET /api/crawls/:id`

**Files:**
- Create: `api/crawls/[id].ts`
- Create: `test/api/crawls/id.test.ts`

**Interfaces:**
- Consumes: `resolveIdentity` (Task 5), `getCrawlStatus` (existing), `getCrawlPages`/`getCrawlClusters`/`getCrawlIntegrations` (Task 2), `Storage.getSignedUrl` (Task 4), `createR2Storage`/`createInMemoryStorage` (existing), `createClerkVerifier` (existing), `ForbiddenError`/`NotFoundError`/`errorToResponse` (existing).
- Produces: nothing consumed by later tasks — the last of the three endpoints.

- [ ] **Step 1: Write the failing tests**

Create `test/api/crawls/id.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../../helpers/testDb.js';
import { getCrawlDetail } from '../../../api/crawls/[id].js';
import { insertQueuedCrawl, persistCrawlResult } from '../../../src/db/crawls.js';
import { createInMemoryStorage } from '../../../src/storage/index.js';
import type { ClerkVerifier } from '../../../src/auth/clerk.js';
import { ForbiddenError, NotFoundError } from '../../../src/http/errors.js';
import type { CrawlResult } from 'websight-crawler';

let db: TestDb;

function fakeVerifier(clerkUserId: string, email: string): ClerkVerifier {
  return { verifyRequest: async () => ({ clerkUserId, email }) };
}

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await resetDb(db);
});

describe('getCrawlDetail', () => {
  it('throws NotFoundError for an unknown id', async () => {
    const storage = createInMemoryStorage();
    await expect(
      getCrawlDetail(db, storage, fakeVerifier('unused', 'unused'), undefined, 'guest-1', 999999)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws ForbiddenError for a different guest token', async () => {
    const storage = createInMemoryStorage();
    const crawlId = await insertQueuedCrawl(db, 'example.com', { guestToken: 'guest-owner' });
    await expect(
      getCrawlDetail(db, storage, fakeVerifier('unused', 'unused'), undefined, 'guest-other', crawlId)
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('returns just status fields while queued', async () => {
    const storage = createInMemoryStorage();
    const crawlId = await insertQueuedCrawl(db, 'example.com', { guestToken: 'guest-owner' });
    const result = await getCrawlDetail(db, storage, fakeVerifier('unused', 'unused'), undefined, 'guest-owner', crawlId);
    expect(result).toEqual({ id: crawlId, domain: 'example.com', status: 'queued', startedAt: null, finishedAt: null, error: null });
  });

  it('returns pages/clusters/integrations with signed URLs once done', async () => {
    const storage = createInMemoryStorage();
    const crawlId = await insertQueuedCrawl(db, 'example.com', { guestToken: 'guest-owner' });
    const crawlResult: CrawlResult = {
      domain: 'example.com',
      crawledAt: '2026-07-28T00:00:00.000Z',
      pages: [
        {
          url: 'https://example.com/',
          path: '/',
          depth: 0,
          status: 'ok',
          links: [],
          requestUrls: [],
          scriptSrcs: [],
          domFingerprint: {},
          html: '<html></html>',
          screenshot: Buffer.alloc(0),
        },
      ],
      clusters: [],
      integrations: [],
      errors: [],
    };
    const storageKeys = new Map([['https://example.com/', { screenshotKey: 'k.png', htmlKey: 'k.html' }]]);
    await persistCrawlResult(db, crawlId, crawlResult, storageKeys);

    const result = await getCrawlDetail(db, storage, fakeVerifier('unused', 'unused'), undefined, 'guest-owner', crawlId);
    expect(result.status).toBe('done');
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toMatchObject({
      url: 'https://example.com/',
      screenshotUrl: 'memory://k.png?expires=3600',
      htmlUrl: 'memory://k.html?expires=3600',
    });
    expect(result.pages[0]).not.toHaveProperty('screenshotKey');
    expect(result.pages[0]).not.toHaveProperty('htmlKey');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --env-file=.env node_modules/vitest/vitest.mjs run test/api/crawls/id.test.ts`
Expected: FAIL — `api/crawls/[id].ts` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `api/crawls/[id].ts`:

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createDb, type Db } from '../../src/db/client.js';
import { getCrawlStatus, getCrawlPages, getCrawlClusters, getCrawlIntegrations } from '../../src/db/crawls.js';
import { createR2Storage, type Storage } from '../../src/storage/index.js';
import { createClerkVerifier, type ClerkVerifier } from '../../src/auth/clerk.js';
import { resolveIdentity } from '../../src/auth/identity.js';
import { BadRequestError, ForbiddenError, NotFoundError, errorToResponse } from '../../src/http/errors.js';
import { requireEnv } from '../../src/env.js';

const SIGNED_URL_EXPIRY_SECONDS = 3600;

export async function getCrawlDetail(
  db: Db,
  storage: Storage,
  clerkVerifier: ClerkVerifier,
  authHeader: string | undefined,
  guestTokenInput: unknown,
  crawlId: number
) {
  const identity = await resolveIdentity(db, clerkVerifier, authHeader, guestTokenInput);
  const row = await getCrawlStatus(db, crawlId);
  if (!row) throw new NotFoundError(`No crawl with id ${crawlId}`);

  const owns =
    ('userId' in identity && row.userId === identity.userId) ||
    ('guestToken' in identity && row.guestToken === identity.guestToken);
  if (!owns) throw new ForbiddenError('You do not have access to this crawl');

  const base = {
    id: row.id,
    domain: row.domain,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    error: row.error,
  };
  if (row.status !== 'done') return base;

  const [pages, clusters, integrations] = await Promise.all([
    getCrawlPages(db, crawlId),
    getCrawlClusters(db, crawlId),
    getCrawlIntegrations(db, crawlId),
  ]);

  const pagesWithUrls = await Promise.all(
    pages.map(async (p) => {
      const { screenshotKey, htmlKey, ...rest } = p;
      return {
        ...rest,
        screenshotUrl: screenshotKey ? await storage.getSignedUrl(screenshotKey, SIGNED_URL_EXPIRY_SECONDS) : null,
        htmlUrl: htmlKey ? await storage.getSignedUrl(htmlKey, SIGNED_URL_EXPIRY_SECONDS) : null,
      };
    })
  );

  return { ...base, pages: pagesWithUrls, clusters, integrations };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const crawlId = Number(req.query.id);
    if (!Number.isFinite(crawlId)) throw new BadRequestError('invalid crawl id');

    const clerkVerifier = createClerkVerifier(requireEnv('CLERK_SECRET_KEY'));
    const storage = createR2Storage({
      accountId: requireEnv('R2_ACCOUNT_ID'),
      accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
      bucket: requireEnv('R2_BUCKET'),
    });
    const result = await getCrawlDetail(
      createDb(),
      storage,
      clerkVerifier,
      req.headers.authorization,
      req.query.guestToken,
      crawlId
    );
    res.status(200).json(result);
  } catch (err) {
    const { status, body } = errorToResponse(err);
    res.status(status).json(body);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --env-file=.env node_modules/vitest/vitest.mjs run test/api/crawls/id.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, full test suite, and commit**

Run: `npm run typecheck` — expect no errors.
Run: `node --env-file=.env node_modules/vitest/vitest.mjs run` — expect the full suite (existing + all new tests from Tasks 1–7) to pass.

```bash
git add api/crawls/[id].ts test/api/crawls/id.test.ts
git commit -m "feat: add GET /api/crawls/:id"
```

---

## Self-Review Notes

- **Spec coverage:** `POST /api/crawls` (Task 6), `GET /api/crawls` (Task 6), `GET /api/crawls/:id` (Task 7), schema/owner column (Task 1), signed URLs (Task 4), quota-combined-with-enqueue (Task 6), ownership 403 (Task 7), domain normalization (Task 6) — every endpoint and behavior from the spec has a task. Out-of-scope items (crawl options, pagination, cancel/delete, frontend changes) correctly have no task.
- **Convention correction from the spec:** the spec's Components section listed a separate `src/crawls.ts` module; mapping the actual file structure during planning showed every existing route (`consume.ts`, `me.ts`, `admin/plans.ts`) keeps its logic directly in the `api/**/*.ts` file instead. This plan follows the codebase's actual convention rather than the spec's document structure — the exported/testable-function shape the spec cared about is preserved either way.
- **Placeholder scan:** every step has literal code or literal commands; no "add appropriate handling" language.
- **Type/name consistency:** `identity: { userId } | { guestToken }` (Task 5) is destructured the same way (`'userId' in identity`) in both Task 6 (`createCrawl`) and Task 7 (`getCrawlDetail`). `owner: { userId?: number; guestToken?: string }` (Task 1/2/3) uses the same shape throughout. `getCrawlPages`/`getCrawlClusters`/`getCrawlIntegrations` (Task 2) are imported with those exact names in Task 7.
