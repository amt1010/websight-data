# Phase 3 — Data + Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the persistence, job-queue, and object-storage layer that turns `websight-crawler`'s in-memory `crawl()` result into an async, pollable, durably-stored crawl job.

**Architecture:** A BullMQ producer (`enqueueCrawl`) inserts a `crawls` row and a matching Redis job. A BullMQ worker picks up the job, runs `crawl()` from `websight-crawler` (imported as a package dependency), uploads each page's screenshot/HTML to R2, and persists the full result into Postgres via Drizzle, updating job status along the way. A thin CLI wraps enqueue/status for manual use — there's no consumer of this yet (Phase 4's API server is that consumer).

**Tech Stack:** TypeScript, Drizzle ORM + `@neondatabase/serverless` (Postgres), BullMQ + `ioredis` (Redis/Upstash), `@aws-sdk/client-s3` (R2, S3-compatible), Vitest.

## Global Constraints

- Node >=20, ESM (`"type": "module"`) — matches `websight-crawler`'s conventions.
- `websight-crawler` is a git dependency pinned to tag `v0.2.0`
  (`github:amt1010/websight-crawler#v0.2.0`) — **do not start this plan until
  that tag exists** (see `websight-crawler`'s
  `docs/superpowers/plans/2026-07-28-phase-3-screenshot-capture.md`, "After
  this plan is executed").
- Cloud-hosted only, no local Docker: Neon (Postgres), Upstash (Redis),
  Cloudflare R2 (object storage) — per
  `docs/superpowers/specs/2026-07-28-phase-3-data-jobs-design.md`.
- Tests that touch Postgres or Redis run against **real disposable test
  instances** (env vars `TEST_DATABASE_URL`, `TEST_REDIS_URL`), truncated/
  flushed between tests — never mocked. `storage` tests use an in-memory
  fake; real R2 is exercised manually only (same pattern `websight-crawler`
  uses for real-domain crawls).
- `npm run typecheck` and `npm test` must pass after every task (test suites
  that need `TEST_DATABASE_URL`/`TEST_REDIS_URL` will fail until those env
  vars are provisioned — see Task 1's prerequisites note).

---

### Task 1: Project scaffold + Drizzle schema

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `drizzle.config.ts`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `src/db/schema.ts`

**Interfaces:**
- Produces: Drizzle table definitions `crawls`, `pages`, `clusters`,
  `integrations` — consumed by every later task via `import * as schema from
  './schema.js'`.

**Prerequisite (not a step — do this before Step 1):** provision a Neon
project (grab its connection string as `TEST_DATABASE_URL`, and later
`DATABASE_URL` for a separate branch/db) and an Upstash Redis database
(`TEST_REDIS_URL` / `REDIS_URL`). These are manual account-setup actions
outside this plan's scope; the plan assumes they exist as env vars from here
on.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "websight-data",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "websight-data": "./dist/cli.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "worker": "tsx src/workerMain.ts",
    "cli": "tsx src/cli.ts",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.686.0",
    "@neondatabase/serverless": "^0.10.1",
    "bullmq": "^5.21.2",
    "drizzle-orm": "^0.36.1",
    "ioredis": "^5.4.1",
    "websight-crawler": "github:amt1010/websight-crawler#v0.2.0"
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "drizzle-kit": "^0.27.1",
    "typescript": "^5.6.3",
    "tsx": "^4.19.2",
    "vitest": "^2.1.4"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
```

- [ ] **Step 4: Create `drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? '',
  },
});
```

- [ ] **Step 5: Create `.env.example`**

```
# Postgres (Neon) — production/dev
DATABASE_URL=postgres://user:password@ep-example.neon.tech/websight?sslmode=require

# Redis (Upstash) — production/dev
REDIS_URL=rediss://default:password@example.upstash.io:6379

# Object storage (Cloudflare R2)
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=websight-data

# Test-only — point at disposable Neon/Upstash instances, never production
TEST_DATABASE_URL=
TEST_REDIS_URL=
```

- [ ] **Step 6: Create `.gitignore`**

```
node_modules/
dist/
.env
```

- [ ] **Step 7: Create `src/db/schema.ts`**

```ts
import { pgTable, serial, text, timestamp, integer, jsonb } from 'drizzle-orm/pg-core';

export const crawls = pgTable('crawls', {
  id: serial('id').primaryKey(),
  domain: text('domain').notNull(),
  status: text('status', { enum: ['queued', 'running', 'done', 'failed'] })
    .notNull()
    .default('queued'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  error: text('error'),
});

export const pages = pgTable('pages', {
  id: serial('id').primaryKey(),
  crawlId: integer('crawl_id')
    .notNull()
    .references(() => crawls.id),
  url: text('url').notNull(),
  path: text('path').notNull(),
  depth: integer('depth').notNull(),
  status: text('status', { enum: ['ok', 'error'] }).notNull(),
  error: text('error'),
  links: jsonb('links').notNull().$type<string[]>(),
  requestUrls: jsonb('request_urls').notNull().$type<string[]>(),
  scriptSrcs: jsonb('script_srcs').notNull().$type<string[]>(),
  domFingerprint: jsonb('dom_fingerprint').notNull().$type<Record<string, number>>(),
  screenshotKey: text('screenshot_key'),
  htmlKey: text('html_key'),
});

export const clusters = pgTable('clusters', {
  id: serial('id').primaryKey(),
  crawlId: integer('crawl_id')
    .notNull()
    .references(() => crawls.id),
  urlPattern: text('url_pattern').notNull(),
  pageUrls: jsonb('page_urls').notNull().$type<string[]>(),
  representativeFingerprint: jsonb('representative_fingerprint').notNull().$type<Record<string, number>>(),
});

export const integrations = pgTable('integrations', {
  id: serial('id').primaryKey(),
  crawlId: integer('crawl_id')
    .notNull()
    .references(() => crawls.id),
  name: text('name').notNull(),
  category: text('category').notNull(),
  matchedUrls: jsonb('matched_urls').notNull().$type<string[]>(),
});
```

- [ ] **Step 8: Install dependencies**

Run: `npm install`
Expected: installs cleanly, including `websight-crawler` from GitHub at tag `v0.2.0`.

- [ ] **Step 9: Verify the schema typechecks**

Run: `npm run typecheck`
Expected: PASS (no `.ts` files exist yet besides `schema.ts`, which has no
errors).

- [ ] **Step 10: Generate the initial migration**

Run: `npx drizzle-kit generate`
Expected: creates a new SQL file under `drizzle/` containing `CREATE TABLE`
statements for all four tables. This is the migration you'd run against
`DATABASE_URL`/`TEST_DATABASE_URL` with `npm run db:migrate` before running
Task 2's tests.

- [ ] **Step 11: Apply the migration to the test database**

Run: `npm run db:migrate` with `DATABASE_URL` temporarily set to
`TEST_DATABASE_URL`'s value (or export `DATABASE_URL=$TEST_DATABASE_URL`
first) — `drizzle.config.ts` falls back to `TEST_DATABASE_URL` automatically
if `DATABASE_URL` is unset.
Expected: migration applies without error; the four tables now exist in the
test database.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts drizzle.config.ts .env.example .gitignore src/db/schema.ts drizzle/
git commit -m "chore: scaffold websight-data project and Drizzle schema"
```

---

### Task 2: DB client + crawl row CRUD (`db/client.ts`, `db/crawls.ts`)

**Files:**
- Create: `src/db/client.ts`
- Create: `src/db/crawls.ts`
- Create: `test/helpers/testDb.ts`
- Test: `test/db/crawls.test.ts`

**Interfaces:**
- Consumes: `schema.ts` tables from Task 1.
- Produces: `createDb(databaseUrl?) → Db`; `insertQueuedCrawl(db, domain) →
  Promise<number>`; `markCrawlRunning(db, crawlId) → Promise<void>`;
  `markCrawlFailed(db, crawlId, error) → Promise<void>`; `getCrawlStatus(db,
  crawlId) → Promise<CrawlRow | null>`; `persistCrawlResult(db, crawlId,
  result: CrawlResult, storageKeys: Map<string, { screenshotKey: string |
  null; htmlKey: string | null }>) → Promise<void>`. These are consumed by
  Task 4 (producer) and Task 5 (worker).

- [ ] **Step 1: Create the test DB helper**

`test/helpers/testDb.ts`:

```ts
import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import * as schema from '../../src/db/schema.js';
import { crawls, pages, clusters, integrations } from '../../src/db/schema.js';

export function createTestDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL must be set to run db tests against a real Neon test branch');
  }
  const pool = new Pool({ connectionString: url });
  return drizzle(pool, { schema });
}

export type TestDb = ReturnType<typeof createTestDb>;

export async function resetDb(db: TestDb): Promise<void> {
  await db.delete(pages);
  await db.delete(clusters);
  await db.delete(integrations);
  await db.delete(crawls);
}
```

- [ ] **Step 2: Write the failing tests**

`test/db/crawls.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../helpers/testDb.js';
import {
  insertQueuedCrawl,
  markCrawlRunning,
  markCrawlFailed,
  getCrawlStatus,
  persistCrawlResult,
} from '../../src/db/crawls.js';
import type { CrawlResult } from 'websight-crawler';

let db: TestDb;

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await resetDb(db);
});

describe('crawl row lifecycle', () => {
  it('inserts a queued crawl and reads it back', async () => {
    const crawlId = await insertQueuedCrawl(db, 'example.com');
    const row = await getCrawlStatus(db, crawlId);
    expect(row?.domain).toBe('example.com');
    expect(row?.status).toBe('queued');
  });

  it('marks a crawl running with a started_at timestamp', async () => {
    const crawlId = await insertQueuedCrawl(db, 'example.com');
    await markCrawlRunning(db, crawlId);
    const row = await getCrawlStatus(db, crawlId);
    expect(row?.status).toBe('running');
    expect(row?.startedAt).not.toBeNull();
  });

  it('marks a crawl failed with an error message', async () => {
    const crawlId = await insertQueuedCrawl(db, 'example.com');
    await markCrawlFailed(db, crawlId, 'boom');
    const row = await getCrawlStatus(db, crawlId);
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('boom');
  });

  it('returns null for an unknown crawl id', async () => {
    const row = await getCrawlStatus(db, 999999);
    expect(row).toBeNull();
  });

  it('persists a full CrawlResult and marks the crawl done', async () => {
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
          links: ['https://example.com/a'],
          requestUrls: [],
          scriptSrcs: [],
          domFingerprint: { div: 3 },
          html: '<html></html>',
          screenshot: Buffer.alloc(0),
        },
      ],
      clusters: [
        {
          id: 'c1',
          urlPattern: '/',
          pageUrls: ['https://example.com/'],
          representativeFingerprint: { div: 3 },
        },
      ],
      integrations: [{ name: 'Google Maps', category: 'maps', matchedUrls: ['https://maps.googleapis.com/x'] }],
      errors: [],
    };
    const storageKeys = new Map([['https://example.com/', { screenshotKey: 'example.com/1/abc.png', htmlKey: 'example.com/1/abc.html' }]]);

    await persistCrawlResult(db, crawlId, result, storageKeys);

    const row = await getCrawlStatus(db, crawlId);
    expect(row?.status).toBe('done');
    expect(row?.finishedAt).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- db/crawls`
Expected: FAIL — `src/db/client.ts` and `src/db/crawls.ts` don't exist yet
(import errors).

- [ ] **Step 4: Implement `src/db/client.ts`**

```ts
import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import * as schema from './schema.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export function createDb(databaseUrl: string = requireEnv('DATABASE_URL')) {
  const pool = new Pool({ connectionString: databaseUrl });
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;
```

- [ ] **Step 5: Implement `src/db/crawls.ts`**

```ts
import { eq } from 'drizzle-orm';
import type { CrawlResult } from 'websight-crawler';
import type { Db } from './client.js';
import { crawls, pages, clusters, integrations } from './schema.js';

export async function insertQueuedCrawl(db: Db, domain: string): Promise<number> {
  const [row] = await db.insert(crawls).values({ domain, status: 'queued' }).returning({ id: crawls.id });
  return row.id;
}

export async function markCrawlRunning(db: Db, crawlId: number): Promise<void> {
  await db.update(crawls).set({ status: 'running', startedAt: new Date() }).where(eq(crawls.id, crawlId));
}

export async function markCrawlFailed(db: Db, crawlId: number, error: string): Promise<void> {
  await db.update(crawls).set({ status: 'failed', error, finishedAt: new Date() }).where(eq(crawls.id, crawlId));
}

export async function getCrawlStatus(db: Db, crawlId: number) {
  const [row] = await db.select().from(crawls).where(eq(crawls.id, crawlId));
  return row ?? null;
}

export async function persistCrawlResult(
  db: Db,
  crawlId: number,
  result: CrawlResult,
  storageKeys: Map<string, { screenshotKey: string | null; htmlKey: string | null }>
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(crawls).set({ status: 'done', finishedAt: new Date() }).where(eq(crawls.id, crawlId));

    if (result.pages.length > 0) {
      await tx.insert(pages).values(
        result.pages.map((p) => ({
          crawlId,
          url: p.url,
          path: p.path,
          depth: p.depth,
          status: p.status,
          error: p.error ?? null,
          links: p.links,
          requestUrls: p.requestUrls,
          scriptSrcs: p.scriptSrcs,
          domFingerprint: p.domFingerprint,
          screenshotKey: storageKeys.get(p.url)?.screenshotKey ?? null,
          htmlKey: storageKeys.get(p.url)?.htmlKey ?? null,
        }))
      );
    }

    if (result.clusters.length > 0) {
      await tx.insert(clusters).values(
        result.clusters.map((c) => ({
          crawlId,
          urlPattern: c.urlPattern,
          pageUrls: c.pageUrls,
          representativeFingerprint: c.representativeFingerprint,
        }))
      );
    }

    if (result.integrations.length > 0) {
      await tx.insert(integrations).values(
        result.integrations.map((i) => ({
          crawlId,
          name: i.name,
          category: i.category,
          matchedUrls: i.matchedUrls,
        }))
      );
    }
  });
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- db/crawls`
Expected: PASS (all five tests). Requires `TEST_DATABASE_URL` to point at a
real, migrated (Task 1 Step 11) Neon database.

- [ ] **Step 7: Commit**

```bash
git add src/db/client.ts src/db/crawls.ts test/helpers/testDb.ts test/db/crawls.test.ts
git commit -m "feat: add db client and crawl row persistence"
```

---

### Task 3: Object storage (`storage/index.ts`)

**Files:**
- Create: `src/storage/index.ts`
- Test: `test/storage/index.test.ts`

**Interfaces:**
- Produces: `Storage` interface (`put(key, body, contentType) →
  Promise<string>`, `get(key) → Promise<Buffer>`); `createInMemoryStorage()
  → Storage`; `createR2Storage(options) → Storage`. Consumed by Task 5's
  worker (via whichever `Storage` implementation is passed in — tests use
  the in-memory one).

- [ ] **Step 1: Write the failing tests**

`test/storage/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createInMemoryStorage } from '../../src/storage/index.js';

describe('createInMemoryStorage', () => {
  it('round-trips a put object through get', async () => {
    const storage = createInMemoryStorage();
    const body = Buffer.from('hello world');
    const key = await storage.put('a/b/c.txt', body, 'text/plain');
    expect(key).toBe('a/b/c.txt');
    const read = await storage.get('a/b/c.txt');
    expect(read).toEqual(body);
  });

  it('throws when getting a key that was never put', async () => {
    const storage = createInMemoryStorage();
    await expect(storage.get('missing')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- storage`
Expected: FAIL — `src/storage/index.ts` doesn't exist.

- [ ] **Step 3: Implement `src/storage/index.ts`**

```ts
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<string>;
  get(key: string): Promise<Buffer>;
}

export interface R2StorageOptions {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function createR2Storage(options: R2StorageOptions): Storage {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${options.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  });

  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: body, ContentType: contentType })
      );
      return key;
    },
    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }));
      const bytes = await res.Body!.transformToByteArray();
      return Buffer.from(bytes);
    },
  };
}

export function createInMemoryStorage(): Storage {
  const store = new Map<string, Buffer>();
  return {
    async put(key, body) {
      store.set(key, body);
      return key;
    },
    async get(key) {
      const value = store.get(key);
      if (!value) throw new Error(`No object stored for key ${key}`);
      return value;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- storage`
Expected: PASS (both tests). No network/credentials required — this suite
only exercises `createInMemoryStorage`.

- [ ] **Step 5: Commit**

```bash
git add src/storage/index.ts test/storage/index.test.ts
git commit -m "feat: add R2 and in-memory storage implementations"
```

---

### Task 4: Queue producer (`queue/producer.ts`)

**Files:**
- Create: `src/queue/producer.ts`
- Create: `test/helpers/testRedis.ts`
- Test: `test/queue/producer.test.ts`

**Interfaces:**
- Consumes: `insertQueuedCrawl` from Task 2's `db/crawls.ts`.
- Produces: `CrawlJobData` type (`{ crawlId: number; domain: string;
  options: Partial<CrawlOptions> }`); `createCrawlQueue(connection) →
  Queue<CrawlJobData>`; `enqueueCrawl(db, queue, domain, options?) →
  Promise<number>`. `CrawlJobData` is consumed by Task 5's worker.

- [ ] **Step 1: Create the test Redis helper**

`test/helpers/testRedis.ts`:

```ts
import IORedis from 'ioredis';

export function createTestConnection(): IORedis {
  const url = process.env.TEST_REDIS_URL;
  if (!url) {
    throw new Error('TEST_REDIS_URL must be set to run queue tests against a real Upstash test database');
  }
  return new IORedis(url, { maxRetriesPerRequest: null });
}
```

- [ ] **Step 2: Write the failing test**

`test/queue/producer.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestConnection } from '../helpers/testRedis.js';
import { createTestDb, resetDb, type TestDb } from '../helpers/testDb.js';
import { createCrawlQueue, enqueueCrawl } from '../../src/queue/producer.js';
import { getCrawlStatus } from '../../src/db/crawls.js';
import type IORedis from 'ioredis';
import type { Queue } from 'bullmq';
import type { CrawlJobData } from '../../src/queue/producer.js';

let connection: IORedis;
let queue: Queue<CrawlJobData>;
let db: TestDb;

beforeEach(async () => {
  connection = createTestConnection();
  await connection.flushdb();
  queue = createCrawlQueue(connection);
  db = createTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await queue.close();
  await connection.quit();
});

describe('enqueueCrawl', () => {
  it('inserts a queued crawl row and adds a matching BullMQ job', async () => {
    const crawlId = await enqueueCrawl(db, queue, 'example.com');

    const row = await getCrawlStatus(db, crawlId);
    expect(row?.status).toBe('queued');

    const job = await queue.getJob(String(crawlId));
    expect(job?.data).toEqual({ crawlId, domain: 'example.com', options: {} });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- queue/producer`
Expected: FAIL — `src/queue/producer.ts` doesn't exist.

- [ ] **Step 4: Implement `src/queue/producer.ts`**

```ts
import { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import type { CrawlOptions } from 'websight-crawler';
import type { Db } from '../db/client.js';
import { insertQueuedCrawl } from '../db/crawls.js';

export interface CrawlJobData {
  crawlId: number;
  domain: string;
  options: Partial<CrawlOptions>;
}

export function createCrawlQueue(connection: IORedis): Queue<CrawlJobData> {
  return new Queue<CrawlJobData>('crawl', { connection });
}

export async function enqueueCrawl(
  db: Db,
  queue: Queue<CrawlJobData>,
  domain: string,
  options: Partial<CrawlOptions> = {}
): Promise<number> {
  const crawlId = await insertQueuedCrawl(db, domain);
  await queue.add('crawl', { crawlId, domain, options }, { jobId: String(crawlId) });
  return crawlId;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- queue/producer`
Expected: PASS. Requires `TEST_REDIS_URL` (real Upstash test database) and
`TEST_DATABASE_URL`.

- [ ] **Step 6: Commit**

```bash
git add src/queue/producer.ts test/helpers/testRedis.ts test/queue/producer.test.ts
git commit -m "feat: add BullMQ crawl queue producer"
```

---

### Task 5: Queue worker pipeline (`queue/worker.ts`)

**Files:**
- Create: `src/queue/worker.ts`
- Test: `test/queue/worker.test.ts`

**Interfaces:**
- Consumes: `markCrawlRunning`, `markCrawlFailed`, `persistCrawlResult` from
  Task 2; `Storage` from Task 3; `CrawlJobData` from Task 4; `crawl` and
  `CrawlResult` types from `websight-crawler`.
- Produces: `handleCrawlJob(db, storage, data, runCrawl?) → Promise<void>`
  (the testable pipeline logic — takes an injectable `runCrawl` so tests
  don't launch a real browser); `createCrawlWorker(connection, db, storage)
  → Worker<CrawlJobData>` (wires `handleCrawlJob` into a real BullMQ
  `Worker`, used by Task 6's `workerMain.ts`).

- [ ] **Step 1: Write the failing tests**

`test/queue/worker.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../helpers/testDb.js';
import { handleCrawlJob } from '../../src/queue/worker.js';
import { insertQueuedCrawl, getCrawlStatus } from '../../src/db/crawls.js';
import { createInMemoryStorage } from '../../src/storage/index.js';
import type { CrawlResult } from 'websight-crawler';

let db: TestDb;

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await resetDb(db);
});

function fakeResult(domain: string): CrawlResult {
  return {
    domain,
    crawledAt: '2026-07-28T00:00:00.000Z',
    pages: [
      {
        url: `https://${domain}/`,
        path: '/',
        depth: 0,
        status: 'ok',
        links: [],
        requestUrls: [],
        scriptSrcs: [],
        domFingerprint: {},
        html: '<html>hi</html>',
        screenshot: Buffer.from('fake-png'),
      },
    ],
    clusters: [],
    integrations: [],
    errors: [],
  };
}

describe('handleCrawlJob', () => {
  it('runs the crawl, uploads assets, and marks the crawl done', async () => {
    const crawlId = await insertQueuedCrawl(db, 'example.com');
    const storage = createInMemoryStorage();
    const runCrawl = async () => fakeResult('example.com');

    await handleCrawlJob(db, storage, { crawlId, domain: 'example.com', options: {} }, runCrawl);

    const row = await getCrawlStatus(db, crawlId);
    expect(row?.status).toBe('done');

    const uploaded = await storage.get(`example.com/${crawlId}/${Buffer.from(`https://example.com/`).toString('base64url')}.png`);
    expect(uploaded).toEqual(Buffer.from('fake-png'));
  });

  it('marks the crawl failed and rethrows when crawl() throws', async () => {
    const crawlId = await insertQueuedCrawl(db, 'example.com');
    const storage = createInMemoryStorage();
    const runCrawl = async () => {
      throw new Error('seed unreachable');
    };

    await expect(
      handleCrawlJob(db, storage, { crawlId, domain: 'example.com', options: {} }, runCrawl)
    ).rejects.toThrow('seed unreachable');

    const row = await getCrawlStatus(db, crawlId);
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('seed unreachable');
  });

  it('does not fail the crawl when an individual page upload fails', async () => {
    const crawlId = await insertQueuedCrawl(db, 'example.com');
    const storage = createInMemoryStorage();
    const failingStorage = {
      ...storage,
      put: async () => {
        throw new Error('upload failed');
      },
    };
    const runCrawl = async () => fakeResult('example.com');

    await handleCrawlJob(db, failingStorage, { crawlId, domain: 'example.com', options: {} }, runCrawl);

    const row = await getCrawlStatus(db, crawlId);
    expect(row?.status).toBe('done');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- queue/worker`
Expected: FAIL — `src/queue/worker.ts` doesn't exist.

- [ ] **Step 3: Implement `src/queue/worker.ts`**

```ts
import { Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { crawl } from 'websight-crawler';
import type { Db } from '../db/client.js';
import { markCrawlRunning, markCrawlFailed, persistCrawlResult } from '../db/crawls.js';
import type { Storage } from '../storage/index.js';
import type { CrawlJobData } from './producer.js';

function pageKey(domain: string, crawlId: number, url: string, ext: 'png' | 'html'): string {
  const hash = Buffer.from(url).toString('base64url');
  return `${domain}/${crawlId}/${hash}.${ext}`;
}

export async function handleCrawlJob(
  db: Db,
  storage: Storage,
  data: CrawlJobData,
  runCrawl: typeof crawl = crawl
): Promise<void> {
  await markCrawlRunning(db, data.crawlId);

  try {
    const result = await runCrawl(data.domain, data.options);
    const storageKeys = new Map<string, { screenshotKey: string | null; htmlKey: string | null }>();

    for (const page of result.pages) {
      let screenshotKey: string | null = null;
      let htmlKey: string | null = null;

      if (page.status === 'ok') {
        try {
          screenshotKey = await storage.put(pageKey(result.domain, data.crawlId, page.url, 'png'), page.screenshot, 'image/png');
          htmlKey = await storage.put(
            pageKey(result.domain, data.crawlId, page.url, 'html'),
            Buffer.from(page.html, 'utf-8'),
            'text/html'
          );
        } catch (err) {
          console.error(`Failed to upload assets for ${page.url}:`, err);
        }
      }

      storageKeys.set(page.url, { screenshotKey, htmlKey });
    }

    await persistCrawlResult(db, data.crawlId, result, storageKeys);
  } catch (err) {
    await markCrawlFailed(db, data.crawlId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export function createCrawlWorker(connection: IORedis, db: Db, storage: Storage): Worker<CrawlJobData> {
  return new Worker<CrawlJobData>(
    'crawl',
    async (job) => {
      await handleCrawlJob(db, storage, job.data);
    },
    { connection }
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- queue/worker`
Expected: PASS (all three tests). Requires `TEST_DATABASE_URL`.

- [ ] **Step 5: Commit**

```bash
git add src/queue/worker.ts test/queue/worker.test.ts
git commit -m "feat: add crawl job worker pipeline"
```

---

### Task 6: CLI and worker entrypoint

**Files:**
- Create: `src/cli.ts`
- Create: `src/workerMain.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `createDb` (Task 2), `getCrawlStatus` (Task 2), `createCrawlQueue`
  / `enqueueCrawl` (Task 4), `createCrawlWorker` (Task 5), `createR2Storage`
  (Task 3).
- Produces: `parseCliCommand(argv) → { command: 'enqueue'; domain: string }
  | { command: 'status'; crawlId: number }` — the pure/testable parsing
  logic `cli.ts`'s `main()` uses. No new interface consumed by later tasks
  (this is the last task).

- [ ] **Step 1: Write the failing tests**

`test/cli.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseCliCommand } from '../src/cli.js';

describe('parseCliCommand', () => {
  it('parses an enqueue command', () => {
    expect(parseCliCommand(['enqueue', 'example.com'])).toEqual({ command: 'enqueue', domain: 'example.com' });
  });

  it('parses a status command', () => {
    expect(parseCliCommand(['status', '42'])).toEqual({ command: 'status', crawlId: 42 });
  });

  it('throws on an unknown command', () => {
    expect(() => parseCliCommand(['bogus'])).toThrow();
  });

  it('throws when enqueue is missing a domain', () => {
    expect(() => parseCliCommand(['enqueue'])).toThrow();
  });

  it('throws when status is given a non-numeric id', () => {
    expect(() => parseCliCommand(['status', 'abc'])).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- cli`
Expected: FAIL — `src/cli.ts` doesn't exist.

- [ ] **Step 3: Implement `src/cli.ts`**

```ts
#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import IORedis from 'ioredis';
import { createDb } from './db/client.js';
import { getCrawlStatus } from './db/crawls.js';
import { createCrawlQueue, enqueueCrawl } from './queue/producer.js';

export type CliCommand = { command: 'enqueue'; domain: string } | { command: 'status'; crawlId: number };

export function parseCliCommand(argv: string[]): CliCommand {
  const [command, arg] = argv;

  if (command === 'enqueue') {
    if (!arg) throw new Error('Usage: websight-data enqueue <domain>');
    return { command: 'enqueue', domain: arg };
  }

  if (command === 'status') {
    const crawlId = Number(arg);
    if (!Number.isFinite(crawlId)) throw new Error('Usage: websight-data status <crawlId>');
    return { command: 'status', crawlId };
  }

  throw new Error('Usage: websight-data <enqueue <domain> | status <crawlId>>');
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

async function main() {
  const parsed = parseCliCommand(process.argv.slice(2));
  const db = createDb();

  if (parsed.command === 'enqueue') {
    const connection = new IORedis(requireEnv('REDIS_URL'), { maxRetriesPerRequest: null });
    const queue = createCrawlQueue(connection);
    const crawlId = await enqueueCrawl(db, queue, parsed.domain);
    console.log(`Enqueued crawl ${crawlId} for ${parsed.domain}`);
    await queue.close();
    await connection.quit();
    return;
  }

  const status = await getCrawlStatus(db, parsed.crawlId);
  console.log(JSON.stringify(status, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- cli`
Expected: PASS (all five tests).

- [ ] **Step 5: Implement `src/workerMain.ts`**

```ts
import IORedis from 'ioredis';
import { createDb } from './db/client.js';
import { createCrawlWorker } from './queue/worker.js';
import { createR2Storage } from './storage/index.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

const db = createDb();
const storage = createR2Storage({
  accountId: requireEnv('R2_ACCOUNT_ID'),
  accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
  secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
  bucket: requireEnv('R2_BUCKET'),
});
const connection = new IORedis(requireEnv('REDIS_URL'), { maxRetriesPerRequest: null });

const worker = createCrawlWorker(connection, db, storage);
console.log('Crawl worker started, listening for jobs on the "crawl" queue...');

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed:`, err);
});

process.on('SIGINT', async () => {
  await worker.close();
  await connection.quit();
  process.exit(0);
});
```

This file has no automated test — it's a thin composition root wiring real
env-backed dependencies together, exercised manually via `npm run worker`
(same "manual, not part of CI" treatment `websight-crawler` gives its real-
domain CLI crawl).

- [ ] **Step 6: Run full verification**

Run: `npm run typecheck && npm test && npm run build`
Expected: all three PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts src/workerMain.ts test/cli.test.ts
git commit -m "feat: add enqueue/status CLI and worker entrypoint"
```

---

### Task 7: README and CI

**Files:**
- Create: `README.md`
- Create: `.github/workflows/ci.yml`

**Interfaces:** None — docs and CI config only.

- [ ] **Step 1: Create `README.md`**

```markdown
# websight-data

Persistence, job queue, and object storage for WebSight (Phase 3 of the
WebSight roadmap). Wraps `websight-crawler`'s `crawl()` in a BullMQ job:
results are uploaded to Cloudflare R2 (screenshots/HTML) and persisted to
Postgres (Neon) via Drizzle. No REST/GraphQL API yet — see the design spec
in `docs/superpowers/specs/2026-07-28-phase-3-data-jobs-design.md`.

## Setup

    npm install
    cp .env.example .env   # fill in DATABASE_URL, REDIS_URL, R2_*
    npm run db:migrate

## Commands

    npm run typecheck
    npm test                          # requires TEST_DATABASE_URL, TEST_REDIS_URL
    npm run build
    npm run cli -- enqueue <domain>   # enqueue a crawl, prints its id
    npm run cli -- status <crawlId>   # print a crawl's row as JSON
    npm run worker                    # start the long-running job worker

## Status

Automated: `npm test` covers crawl-row persistence (against a real Neon test
branch), the in-memory storage fake, the BullMQ producer/worker pipeline
(against real Upstash test Redis + fake `crawl()`), and CLI argument
parsing. Real R2 uploads and the worker's `crawl()` integration are manual-
only, same as `websight-crawler`'s real-domain crawl.
```

- [ ] **Step 2: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    env:
      TEST_DATABASE_URL: ${{ secrets.TEST_DATABASE_URL }}
      TEST_REDIS_URL: ${{ secrets.TEST_REDIS_URL }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

Note: `npm ci` needs read access to `websight-crawler` for the git
dependency — if that repo is public (it is, per the design spec's repo
check), no extra token is required.

- [ ] **Step 3: Add the three required repo secrets**

In the `websight-data` GitHub repo settings, add `TEST_DATABASE_URL` and
`TEST_REDIS_URL` (both pointing at the same disposable test instances used
locally).

- [ ] **Step 4: Run full verification locally**

Run: `npm run typecheck && npm test && npm run build`
Expected: all three PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md .github/workflows/ci.yml
git commit -m "docs: add README and CI workflow"
```
