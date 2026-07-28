# Auth / Guest / Paid Gating — Backend (Sub-project 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `websight-data` with a Clerk-verified API (deployed as Vercel serverless functions) that gates scans by guest/free/paid tier against an admin-configurable rate card, without touching real crawl data.

**Architecture:** Three new Drizzle tables (`plans`, `users`, `scan_usage`) plus data-access modules under `src/db/`; a small injectable Clerk-verification wrapper under `src/auth/`; five Vercel serverless functions under `api/` that each export both a thin HTTP `handler` (default export) and a pure, directly-testable logic function (named export), following the same "thin CLI, logic lives in `src/`" split already used by `src/cli.ts`.

**Tech Stack:** TypeScript, Drizzle ORM (Neon Postgres), `@clerk/backend`, Vercel serverless functions (`@vercel/node` types), Vitest against a real Neon test branch (`fileParallelism: false`).

## Global Constraints

- Node >=20 (matches existing `engines` field).
- `"type": "module"` — all imports use `.js` extensions on relative paths (existing convention, e.g. `./schema.js`), even though source files are `.ts`.
- Vitest tests live under `test/`, run with `fileParallelism: false` against `TEST_DATABASE_URL` (a real, disposable Neon branch) — never mock the database itself, per the existing `test/db/crawls.test.ts` pattern.
- Clerk verification itself IS mocked/stubbed in tests via dependency injection (no real Clerk account needed for CI) — this is the one exception, matching the spec's explicit call-out and the existing pattern of faking `crawl()` in worker tests.
- No new repo — everything below lives in `websight-data`, on its own branch (already checked out: `auth-subscriptions-api`).
- `plans.tier` has exactly one row with `tier:'free'` at any time (enforced in `createPlan`/`updatePlan`) — this is what `findOrCreateUser` relies on to assign a default plan to brand-new users. Not stated explicitly in the spec, but required for the "seeded Free plan" behavior it describes to be unambiguous.
- Every new module that can fail in a way an API caller needs to see (validation, not-found, quota, auth) throws one of the typed errors from `src/http/errors.ts`, never a bare `Error`, so the API adapters can map it to the right HTTP status without inspecting message strings.

---

### Task 1: Schema — `plans`, `users`, `scan_usage` tables

**Files:**
- Modify: `src/db/schema.ts` (add three table definitions after the existing `integrations` export)
- Modify: `test/helpers/testDb.ts` (extend `resetDb` to clear the new tables, in FK-safe order)
- Test: `test/db/schema.test.ts`

**Interfaces:**
- Produces: `plans`, `users`, `scanUsage` Drizzle table objects, importable from `../../src/db/schema.js`. Columns: `plans.{id,name,tier,scanLimit,createdAt}`, `users.{id,clerkUserId,email,role,planId,createdAt}`, `scanUsage.{id,userId,guestToken,scannedAt}`.

- [ ] **Step 1: Write the failing test**

```ts
// test/db/schema.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../helpers/testDb.js';
import { plans, users, scanUsage } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';

let db: TestDb;

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await resetDb(db);
});

describe('plans/users/scan_usage schema', () => {
  it('round-trips a plan row', async () => {
    const [plan] = await db.insert(plans).values({ name: 'Free', tier: 'free', scanLimit: 3 }).returning();
    const [row] = await db.select().from(plans).where(eq(plans.id, plan.id));
    expect(row).toMatchObject({ name: 'Free', tier: 'free', scanLimit: 3 });
  });

  it('round-trips a user row referencing a plan', async () => {
    const [plan] = await db.insert(plans).values({ name: 'Free', tier: 'free', scanLimit: 3 }).returning();
    const [user] = await db
      .insert(users)
      .values({ clerkUserId: 'clerk_1', email: 'a@example.com', planId: plan.id })
      .returning();
    expect(user).toMatchObject({ clerkUserId: 'clerk_1', email: 'a@example.com', role: 'user', planId: plan.id });
  });

  it('round-trips a scan_usage row for a guest token', async () => {
    const [row] = await db.insert(scanUsage).values({ guestToken: 'guest-abc' }).returning();
    expect(row).toMatchObject({ guestToken: 'guest-abc', userId: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/db/schema.test.ts`
Expected: FAIL — `plans`/`users`/`scanUsage` don't exist yet (import error or undefined table).

- [ ] **Step 3: Add the table definitions**

Append to `src/db/schema.ts` (imports `pgTable, serial, text, timestamp, integer, jsonb` are already present at the top of the file — no import changes needed):

```ts
export const plans = pgTable('plans', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  tier: text('tier', { enum: ['free', 'paid'] }).notNull(),
  scanLimit: integer('scan_limit').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  clerkUserId: text('clerk_user_id').notNull().unique(),
  email: text('email').notNull(),
  role: text('role', { enum: ['user', 'admin'] }).notNull().default('user'),
  planId: integer('plan_id')
    .notNull()
    .references(() => plans.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const scanUsage = pgTable('scan_usage', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
  guestToken: text('guest_token'),
  scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 4: Generate and apply the migration**

Run: `npm run db:generate`
Then apply it to the test branch (per this repo's existing two-branch migration convention):
Run: `DATABASE_URL=$TEST_DATABASE_URL npm run db:migrate`

- [ ] **Step 5: Update `resetDb` for the new tables**

Modify `test/helpers/testDb.ts`:

```ts
import * as schema from '../../src/db/schema.js';
import { crawls, pages, clusters, integrations, plans, users, scanUsage } from '../../src/db/schema.js';

// ... createTestDb unchanged ...

export async function resetDb(db: TestDb): Promise<void> {
  await db.delete(pages);
  await db.delete(clusters);
  await db.delete(integrations);
  await db.delete(crawls);
  await db.delete(scanUsage);
  await db.delete(users);
  await db.delete(plans);
}
```

(Children before parents: `scanUsage` references `users`, `users` references `plans`.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- test/db/schema.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts test/helpers/testDb.ts test/db/schema.test.ts drizzle/
git commit -m "feat: add plans/users/scan_usage schema"
```

---

### Task 2: Shared HTTP error types + env helper

**Files:**
- Create: `src/http/errors.ts`
- Create: `src/env.ts`
- Test: `test/http/errors.test.ts`

**Interfaces:**
- Produces: `AppError`, `BadRequestError`, `AuthError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `QuotaExceededError` (all extend `AppError`, each carries `.status: number`); `errorToResponse(err: unknown): { status: number; body: Record<string, unknown> }`; `requireEnv(name: string): string`. All later tasks import these from `../http/errors.js` / `../env.js` (relative depth varies by file location).

- [ ] **Step 1: Write the failing test**

```ts
// test/http/errors.test.ts
import { describe, it, expect } from 'vitest';
import {
  BadRequestError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  QuotaExceededError,
  errorToResponse,
} from '../../src/http/errors.js';

describe('errorToResponse', () => {
  it('maps BadRequestError to 400', () => {
    expect(errorToResponse(new BadRequestError('bad'))).toEqual({ status: 400, body: { error: 'bad' } });
  });

  it('maps AuthError to 401', () => {
    expect(errorToResponse(new AuthError('nope'))).toEqual({ status: 401, body: { error: 'nope' } });
  });

  it('maps ForbiddenError to 403', () => {
    expect(errorToResponse(new ForbiddenError('nope'))).toEqual({ status: 403, body: { error: 'nope' } });
  });

  it('maps NotFoundError to 404', () => {
    expect(errorToResponse(new NotFoundError('missing'))).toEqual({ status: 404, body: { error: 'missing' } });
  });

  it('maps ConflictError to 409', () => {
    expect(errorToResponse(new ConflictError('conflict'))).toEqual({ status: 409, body: { error: 'conflict' } });
  });

  it('maps QuotaExceededError to 402 with details', () => {
    const err = new QuotaExceededError({ plan: 'Guest', scanLimit: 1, used: 1 });
    expect(errorToResponse(err)).toEqual({
      status: 402,
      body: { error: 'Scan quota exceeded', plan: 'Guest', scanLimit: 1, used: 1 },
    });
  });

  it('maps an unknown error to 500 without leaking its message', () => {
    expect(errorToResponse(new Error('secret internals'))).toEqual({
      status: 500,
      body: { error: 'Internal server error' },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/http/errors.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
// src/http/errors.ts
export class AppError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class AuthError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409);
  }
}

export interface QuotaDetails {
  plan: string;
  scanLimit: number;
  used: number;
}

export class QuotaExceededError extends AppError {
  readonly details: QuotaDetails;
  constructor(details: QuotaDetails) {
    super('Scan quota exceeded', 402);
    this.details = details;
  }
}

export function errorToResponse(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof QuotaExceededError) {
    return { status: 402, body: { error: err.message, ...err.details } };
  }
  if (err instanceof AppError) {
    return { status: err.status, body: { error: err.message } };
  }
  return { status: 500, body: { error: 'Internal server error' } };
}
```

```ts
// src/env.ts
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/http/errors.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/http/errors.ts src/env.ts test/http/errors.test.ts
git commit -m "feat: add typed HTTP errors and env helper"
```

---

### Task 3: Plans data-access module

**Files:**
- Create: `src/db/plans.ts`
- Test: `test/db/plans.test.ts`

**Interfaces:**
- Consumes: `Db` from `./client.js`; `plans`, `users` tables from `./schema.js`; `BadRequestError`, `ConflictError`, `NotFoundError` from `../http/errors.js`.
- Produces: `PlanTier = 'free' | 'paid'`; `PlanInput = { name: string; tier: PlanTier; scanLimit: number }`; `listPlans(db): Promise<Plan[]>`; `getPlanById(db, planId: number): Promise<Plan | null>`; `createPlan(db, input: PlanInput): Promise<Plan>`; `updatePlan(db, planId: number, input: PlanInput): Promise<Plan>`; `deletePlan(db, planId: number): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/db/plans.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../helpers/testDb.js';
import { listPlans, getPlanById, createPlan, updatePlan, deletePlan } from '../../src/db/plans.js';
import { users } from '../../src/db/schema.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../src/http/errors.js';

let db: TestDb;

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await resetDb(db);
});

describe('plans data access', () => {
  it('creates and lists a plan', async () => {
    const plan = await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    expect(await listPlans(db)).toEqual([plan]);
    expect(await getPlanById(db, plan.id)).toEqual(plan);
  });

  it('rejects a second free-tier plan', async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    await expect(createPlan(db, { name: 'Free 2', tier: 'free', scanLimit: 5 })).rejects.toBeInstanceOf(ConflictError);
  });

  it('rejects an invalid plan payload', async () => {
    await expect(createPlan(db, { name: '', tier: 'free', scanLimit: 3 })).rejects.toBeInstanceOf(BadRequestError);
    await expect(createPlan(db, { name: 'X', tier: 'paid', scanLimit: 0 })).rejects.toBeInstanceOf(BadRequestError);
    // @ts-expect-error deliberately invalid tier for the runtime check
    await expect(createPlan(db, { name: 'X', tier: 'gold', scanLimit: 3 })).rejects.toBeInstanceOf(BadRequestError);
  });

  it('updates a plan', async () => {
    const plan = await createPlan(db, { name: 'Pro', tier: 'paid', scanLimit: 10 });
    const updated = await updatePlan(db, plan.id, { name: 'Pro', tier: 'paid', scanLimit: 20 });
    expect(updated.scanLimit).toBe(20);
  });

  it('throws NotFoundError updating an unknown plan', async () => {
    await expect(updatePlan(db, 999999, { name: 'X', tier: 'paid', scanLimit: 1 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deletes an unused plan', async () => {
    const plan = await createPlan(db, { name: 'Pro', tier: 'paid', scanLimit: 10 });
    await deletePlan(db, plan.id);
    expect(await getPlanById(db, plan.id)).toBeNull();
  });

  it('refuses to delete a plan with users assigned', async () => {
    const plan = await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    await db.insert(users).values({ clerkUserId: 'clerk_1', email: 'a@example.com', planId: plan.id });
    await expect(deletePlan(db, plan.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it('throws NotFoundError deleting an unknown plan', async () => {
    await expect(deletePlan(db, 999999)).rejects.toBeInstanceOf(NotFoundError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/db/plans.test.ts`
Expected: FAIL — `src/db/plans.ts` doesn't exist.

- [ ] **Step 3: Implement**

```ts
// src/db/plans.ts
import { eq, count } from 'drizzle-orm';
import type { Db } from './client.js';
import { plans, users } from './schema.js';
import { BadRequestError, ConflictError, NotFoundError } from '../http/errors.js';

export type PlanTier = 'free' | 'paid';

export interface PlanInput {
  name: string;
  tier: PlanTier;
  scanLimit: number;
}

function validatePlanInput(input: PlanInput): void {
  if (!input.name || !input.name.trim()) throw new BadRequestError('name is required');
  if (input.tier !== 'free' && input.tier !== 'paid') throw new BadRequestError('tier must be "free" or "paid"');
  if (!Number.isInteger(input.scanLimit) || input.scanLimit <= 0) {
    throw new BadRequestError('scanLimit must be a positive integer');
  }
}

async function assertNoOtherFreePlan(db: Db, excludePlanId?: number): Promise<void> {
  const existingFree = await db.select().from(plans).where(eq(plans.tier, 'free'));
  const conflicting = existingFree.filter((p) => p.id !== excludePlanId);
  if (conflicting.length > 0) throw new ConflictError('a free-tier plan already exists');
}

export async function listPlans(db: Db) {
  return db.select().from(plans);
}

export async function getPlanById(db: Db, planId: number) {
  const [row] = await db.select().from(plans).where(eq(plans.id, planId));
  return row ?? null;
}

export async function createPlan(db: Db, input: PlanInput) {
  validatePlanInput(input);
  if (input.tier === 'free') await assertNoOtherFreePlan(db);
  const [row] = await db.insert(plans).values(input).returning();
  return row;
}

export async function updatePlan(db: Db, planId: number, input: PlanInput) {
  validatePlanInput(input);
  const existing = await getPlanById(db, planId);
  if (!existing) throw new NotFoundError(`plan ${planId} not found`);
  if (input.tier === 'free') await assertNoOtherFreePlan(db, planId);
  const [row] = await db.update(plans).set(input).where(eq(plans.id, planId)).returning();
  return row;
}

export async function deletePlan(db: Db, planId: number) {
  const existing = await getPlanById(db, planId);
  if (!existing) throw new NotFoundError(`plan ${planId} not found`);
  const [{ value }] = await db.select({ value: count() }).from(users).where(eq(users.planId, planId));
  if (value > 0) throw new ConflictError('plan has users assigned to it');
  await db.delete(plans).where(eq(plans.id, planId));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/db/plans.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/db/plans.ts test/db/plans.test.ts
git commit -m "feat: add plans data-access module with rate-card CRUD"
```

---

### Task 4: Users data-access module

**Files:**
- Create: `src/db/users.ts`
- Test: `test/db/users.test.ts`

**Interfaces:**
- Consumes: `createPlan` from `./plans.js` (test setup only); `NotFoundError` from `../http/errors.js`.
- Produces: `getDefaultFreePlan(db): Promise<Plan>`; `getUserByClerkId(db, clerkUserId: string): Promise<User | null>`; `findOrCreateUser(db, clerkUserId: string, email: string): Promise<User>`; `getUserWithPlan(db, userId: number): Promise<{ user: User; plan: Plan } | null>`; `listUsersWithPlans(db): Promise<{ user: User; plan: Plan }[]>`; `updateUserPlan(db, userId: number, planId: number): Promise<User>`; `promoteToAdmin(db, email: string): Promise<User>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/db/users.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../helpers/testDb.js';
import { createPlan } from '../../src/db/plans.js';
import {
  getDefaultFreePlan,
  findOrCreateUser,
  getUserByClerkId,
  getUserWithPlan,
  listUsersWithPlans,
  updateUserPlan,
  promoteToAdmin,
} from '../../src/db/users.js';
import { NotFoundError } from '../../src/http/errors.js';

let db: TestDb;

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await resetDb(db);
});

describe('users data access', () => {
  it('finds the seeded free plan', async () => {
    const free = await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    expect(await getDefaultFreePlan(db)).toEqual(free);
  });

  it('errors clearly when no free plan is seeded', async () => {
    await expect(getDefaultFreePlan(db)).rejects.toThrow(/seed:plans/);
  });

  it('creates a user on first login and reuses it on the next', async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    const first = await findOrCreateUser(db, 'clerk_1', 'a@example.com');
    const second = await findOrCreateUser(db, 'clerk_1', 'a@example.com');
    expect(second.id).toBe(first.id);
    expect(await getUserByClerkId(db, 'clerk_1')).toEqual(first);
  });

  it('joins a user with their plan', async () => {
    const free = await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    const user = await findOrCreateUser(db, 'clerk_1', 'a@example.com');
    const withPlan = await getUserWithPlan(db, user.id);
    expect(withPlan?.plan).toEqual(free);
  });

  it('lists all users with their plans', async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    await findOrCreateUser(db, 'clerk_1', 'a@example.com');
    await findOrCreateUser(db, 'clerk_2', 'b@example.com');
    expect(await listUsersWithPlans(db)).toHaveLength(2);
  });

  it('reassigns a user to a different plan', async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    const paid = await createPlan(db, { name: 'Pro', tier: 'paid', scanLimit: 50 });
    const user = await findOrCreateUser(db, 'clerk_1', 'a@example.com');
    const updated = await updateUserPlan(db, user.id, paid.id);
    expect(updated.planId).toBe(paid.id);
  });

  it('throws NotFoundError reassigning an unknown user or plan', async () => {
    const free = await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    const user = await findOrCreateUser(db, 'clerk_1', 'a@example.com');
    await expect(updateUserPlan(db, 999999, free.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateUserPlan(db, user.id, 999999)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('promotes an existing user to admin by email', async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    await findOrCreateUser(db, 'clerk_1', 'a@example.com');
    const promoted = await promoteToAdmin(db, 'a@example.com');
    expect(promoted.role).toBe('admin');
  });

  it('throws NotFoundError promoting an email with no user yet', async () => {
    await expect(promoteToAdmin(db, 'nobody@example.com')).rejects.toBeInstanceOf(NotFoundError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/db/users.test.ts`
Expected: FAIL — `src/db/users.ts` doesn't exist.

- [ ] **Step 3: Implement**

```ts
// src/db/users.ts
import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { users, plans } from './schema.js';
import { NotFoundError } from '../http/errors.js';

export async function getDefaultFreePlan(db: Db) {
  const [row] = await db.select().from(plans).where(eq(plans.tier, 'free'));
  if (!row) throw new Error('No free-tier plan is seeded — run `npm run seed:plans` first');
  return row;
}

export async function getUserByClerkId(db: Db, clerkUserId: string) {
  const [row] = await db.select().from(users).where(eq(users.clerkUserId, clerkUserId));
  return row ?? null;
}

export async function findOrCreateUser(db: Db, clerkUserId: string, email: string) {
  const existing = await getUserByClerkId(db, clerkUserId);
  if (existing) return existing;
  const freePlan = await getDefaultFreePlan(db);
  const [row] = await db.insert(users).values({ clerkUserId, email, planId: freePlan.id }).returning();
  return row;
}

export async function getUserWithPlan(db: Db, userId: number) {
  const [row] = await db
    .select({ user: users, plan: plans })
    .from(users)
    .innerJoin(plans, eq(users.planId, plans.id))
    .where(eq(users.id, userId));
  return row ?? null;
}

export async function listUsersWithPlans(db: Db) {
  return db
    .select({ user: users, plan: plans })
    .from(users)
    .innerJoin(plans, eq(users.planId, plans.id));
}

export async function updateUserPlan(db: Db, userId: number, planId: number) {
  const [existingUser] = await db.select().from(users).where(eq(users.id, userId));
  if (!existingUser) throw new NotFoundError(`user ${userId} not found`);
  const [existingPlan] = await db.select().from(plans).where(eq(plans.id, planId));
  if (!existingPlan) throw new NotFoundError(`plan ${planId} not found`);
  const [row] = await db.update(users).set({ planId }).where(eq(users.id, userId)).returning();
  return row;
}

export async function promoteToAdmin(db: Db, email: string) {
  const [row] = await db.select().from(users).where(eq(users.email, email));
  if (!row) {
    throw new NotFoundError(`no user found with email ${email} — they must log in at least once before being promoted`);
  }
  const [updated] = await db.update(users).set({ role: 'admin' }).where(eq(users.id, row.id)).returning();
  return updated;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/db/users.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/db/users.ts test/db/users.test.ts
git commit -m "feat: add users data-access module with find-or-create and admin promotion"
```

---

### Task 5: Scan usage data-access module

**Files:**
- Create: `src/db/scanUsage.ts`
- Test: `test/db/scanUsage.test.ts`

**Interfaces:**
- Produces: `GUEST_SCAN_LIMIT = 1`; `countScansForUser(db, userId: number): Promise<number>`; `countScansForGuestToken(db, guestToken: string): Promise<number>`; `recordScanForUser(db, userId: number): Promise<void>`; `recordScanForGuestToken(db, guestToken: string): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/db/scanUsage.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../helpers/testDb.js';
import { createPlan } from '../../src/db/plans.js';
import { findOrCreateUser } from '../../src/db/users.js';
import {
  GUEST_SCAN_LIMIT,
  countScansForUser,
  countScansForGuestToken,
  recordScanForUser,
  recordScanForGuestToken,
} from '../../src/db/scanUsage.js';

let db: TestDb;

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await resetDb(db);
});

describe('scan usage tracking', () => {
  it('starts at zero for a fresh guest token', async () => {
    expect(await countScansForGuestToken(db, 'guest-1')).toBe(0);
  });

  it('increments guest usage on record', async () => {
    await recordScanForGuestToken(db, 'guest-1');
    expect(await countScansForGuestToken(db, 'guest-1')).toBe(1);
    expect(GUEST_SCAN_LIMIT).toBe(1);
  });

  it('keeps separate counts per guest token', async () => {
    await recordScanForGuestToken(db, 'guest-1');
    expect(await countScansForGuestToken(db, 'guest-2')).toBe(0);
  });

  it('increments a logged-in user\'s usage on record', async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    const user = await findOrCreateUser(db, 'clerk_1', 'a@example.com');
    await recordScanForUser(db, user.id);
    await recordScanForUser(db, user.id);
    expect(await countScansForUser(db, user.id)).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/db/scanUsage.test.ts`
Expected: FAIL — `src/db/scanUsage.ts` doesn't exist.

- [ ] **Step 3: Implement**

```ts
// src/db/scanUsage.ts
import { eq, count } from 'drizzle-orm';
import type { Db } from './client.js';
import { scanUsage } from './schema.js';

export const GUEST_SCAN_LIMIT = 1;

export async function countScansForUser(db: Db, userId: number): Promise<number> {
  const [{ value }] = await db.select({ value: count() }).from(scanUsage).where(eq(scanUsage.userId, userId));
  return value;
}

export async function countScansForGuestToken(db: Db, guestToken: string): Promise<number> {
  const [{ value }] = await db
    .select({ value: count() })
    .from(scanUsage)
    .where(eq(scanUsage.guestToken, guestToken));
  return value;
}

export async function recordScanForUser(db: Db, userId: number): Promise<void> {
  await db.insert(scanUsage).values({ userId, guestToken: null });
}

export async function recordScanForGuestToken(db: Db, guestToken: string): Promise<void> {
  await db.insert(scanUsage).values({ guestToken, userId: null });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/db/scanUsage.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/db/scanUsage.ts test/db/scanUsage.test.ts
git commit -m "feat: add scan usage tracking for guests and logged-in users"
```

---

### Task 6: Seed scripts (`seed:plans`, `seed:admin`)

**Files:**
- Create: `src/seedPlans.ts`
- Create: `src/seedAdmin.ts`
- Modify: `package.json` (add `"seed:plans"` and `"seed:admin"` scripts)
- Test: `test/seedPlans.test.ts`
- Test: `test/seedAdmin.test.ts`

**Interfaces:**
- Consumes: `createPlan`, `listPlans` from `./db/plans.js`; `promoteToAdmin` from `./db/users.js`.
- Produces: `seedFreePlan(db, scanLimit?: number): Promise<Plan>` (idempotent — returns the existing free plan if one already exists instead of throwing); `parseSeedAdminArgs(argv: string[]): { email: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/seedPlans.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from './helpers/testDb.js';
import { seedFreePlan } from '../src/seedPlans.js';
import { listPlans } from '../src/db/plans.js';

let db: TestDb;

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await resetDb(db);
});

describe('seedFreePlan', () => {
  it('creates the free plan once', async () => {
    const plan = await seedFreePlan(db, 3);
    expect(plan).toMatchObject({ name: 'Free', tier: 'free', scanLimit: 3 });
    expect(await listPlans(db)).toHaveLength(1);
  });

  it('is idempotent — running it again returns the existing plan without duplicating', async () => {
    const first = await seedFreePlan(db, 3);
    const second = await seedFreePlan(db, 3);
    expect(second.id).toBe(first.id);
    expect(await listPlans(db)).toHaveLength(1);
  });
});
```

```ts
// test/seedAdmin.test.ts
import { describe, it, expect } from 'vitest';
import { parseSeedAdminArgs } from '../src/seedAdmin.js';

describe('parseSeedAdminArgs', () => {
  it('parses an email argument', () => {
    expect(parseSeedAdminArgs(['a@example.com'])).toEqual({ email: 'a@example.com' });
  });

  it('throws a usage error with no argument', () => {
    expect(() => parseSeedAdminArgs([])).toThrow(/Usage: seed:admin <email>/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/seedPlans.test.ts test/seedAdmin.test.ts`
Expected: FAIL — neither module exists.

- [ ] **Step 3: Implement**

```ts
// src/seedPlans.ts
import { pathToFileURL } from 'node:url';
import { createDb } from './db/client.js';
import { listPlans, createPlan, type PlanTier } from './db/plans.js';

export async function seedFreePlan(db: ReturnType<typeof createDb>, scanLimit: number) {
  const existingFree = (await listPlans(db)).find((p) => p.tier === ('free' as PlanTier));
  if (existingFree) return existingFree;
  return createPlan(db, { name: 'Free', tier: 'free', scanLimit });
}

async function main() {
  const db = createDb();
  const plan = await seedFreePlan(db, 3);
  console.log(`Free plan ready: id=${plan.id} scanLimit=${plan.scanLimit}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
```

```ts
// src/seedAdmin.ts
import { pathToFileURL } from 'node:url';
import { createDb } from './db/client.js';
import { promoteToAdmin } from './db/users.js';

export function parseSeedAdminArgs(argv: string[]): { email: string } {
  const [email] = argv;
  if (!email) throw new Error('Usage: seed:admin <email>');
  return { email };
}

async function main() {
  const { email } = parseSeedAdminArgs(process.argv.slice(2));
  const db = createDb();
  const user = await promoteToAdmin(db, email);
  console.log(`Promoted ${user.email} to admin`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
```

Add to `package.json` `"scripts"` (alongside the existing `"cli"`/`"worker"` entries):

```json
"seed:plans": "tsx src/seedPlans.ts",
"seed:admin": "tsx src/seedAdmin.ts --",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/seedPlans.test.ts test/seedAdmin.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/seedPlans.ts src/seedAdmin.ts package.json test/seedPlans.test.ts test/seedAdmin.test.ts
git commit -m "feat: add seed:plans and seed:admin scripts"
```

---

### Task 7: Clerk verifier (injectable)

**Files:**
- Create: `src/auth/clerk.ts`
- Modify: `package.json` (add `@clerk/backend` dependency)
- Test: `test/auth/clerk.test.ts`

**Interfaces:**
- Produces: `AuthenticatedUser = { clerkUserId: string; email: string }`; `ClerkVerifier = { verifyRequest(authHeader: string | undefined): Promise<AuthenticatedUser> }`; `createClerkVerifier(secretKey: string, deps?: { verifyTokenFn?, getUserFn? }): ClerkVerifier`. Later tasks (8–12) import `createClerkVerifier` and `type ClerkVerifier`, and construct fakes matching `ClerkVerifier`'s shape directly in their own tests (no need to reach into this file's injection params).

- [ ] **Step 1: Write the failing test**

```ts
// test/auth/clerk.test.ts
import { describe, it, expect } from 'vitest';
import { createClerkVerifier } from '../../src/auth/clerk.js';
import { AuthError } from '../../src/http/errors.js';

describe('createClerkVerifier', () => {
  const verifier = createClerkVerifier('test-secret', {
    verifyTokenFn: async (token: string) => {
      if (token !== 'good-token') throw new Error('invalid');
      return { sub: 'clerk_123' } as never;
    },
    getUserFn: async (userId: string) => ({
      emailAddresses: [{ emailAddress: `${userId}@example.com` }],
    }),
  });

  it('rejects a missing Authorization header', async () => {
    await expect(verifier.verifyRequest(undefined)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a header without a Bearer prefix', async () => {
    await expect(verifier.verifyRequest('Basic xyz')).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects an invalid token', async () => {
    await expect(verifier.verifyRequest('Bearer bad-token')).rejects.toBeInstanceOf(AuthError);
  });

  it('resolves clerkUserId and email for a valid token', async () => {
    const result = await verifier.verifyRequest('Bearer good-token');
    expect(result).toEqual({ clerkUserId: 'clerk_123', email: 'clerk_123@example.com' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/auth/clerk.test.ts`
Expected: FAIL — `src/auth/clerk.ts` doesn't exist.

- [ ] **Step 3: Add the dependency and implement**

Add to `package.json` `"dependencies"`:

```json
"@clerk/backend": "^1.24.0",
```

Run: `npm install`

```ts
// src/auth/clerk.ts
import { verifyToken, createClerkClient } from '@clerk/backend';
import { AuthError } from '../http/errors.js';

export interface AuthenticatedUser {
  clerkUserId: string;
  email: string;
}

type VerifyTokenFn = (token: string, options: { secretKey: string }) => Promise<{ sub: string }>;
type GetUserFn = (userId: string) => Promise<{ emailAddresses: { emailAddress: string }[] }>;

export interface ClerkVerifier {
  verifyRequest(authHeader: string | undefined): Promise<AuthenticatedUser>;
}

export function createClerkVerifier(
  secretKey: string,
  deps: { verifyTokenFn?: VerifyTokenFn; getUserFn?: GetUserFn } = {}
): ClerkVerifier {
  const verifyTokenFn = deps.verifyTokenFn ?? (verifyToken as unknown as VerifyTokenFn);
  const getUserFn =
    deps.getUserFn ??
    (async (userId: string) => {
      const client = createClerkClient({ secretKey });
      return client.users.getUser(userId);
    });

  return {
    async verifyRequest(authHeader) {
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new AuthError('Missing bearer token');
      }
      const token = authHeader.slice('Bearer '.length);
      let payload: { sub: string };
      try {
        payload = await verifyTokenFn(token, { secretKey });
      } catch {
        throw new AuthError('Invalid or expired token');
      }
      const user = await getUserFn(payload.sub);
      const email = user.emailAddresses[0]?.emailAddress;
      if (!email) throw new AuthError('Clerk user has no email address');
      return { clerkUserId: payload.sub, email };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/auth/clerk.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/auth/clerk.ts package.json package-lock.json
git commit -m "feat: add injectable Clerk JWT verifier"
```

---

### Task 8: `POST /api/scans/guest-init`

**Files:**
- Create: `api/scans/guest-init.ts`
- Modify: `package.json` (add `@vercel/node` devDependency)
- Test: `test/api/scans/guest-init.test.ts`

**Interfaces:**
- Consumes: `Db` from `../../src/db/client.js`; `countScansForGuestToken`, `GUEST_SCAN_LIMIT` from `../../src/db/scanUsage.js`; `BadRequestError` from `../../src/http/errors.js`.
- Produces: `validateGuestToken(guestToken: unknown): string` (re-exported and reused by Task 9's `consume.ts`); `guestInit(db: Db, guestTokenInput: unknown): Promise<{ guestToken: string; remainingScans: number }>`; default-exported Vercel `handler`.

- [ ] **Step 1: Write the failing test**

```ts
// test/api/scans/guest-init.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../../helpers/testDb.js';
import { guestInit } from '../../../api/scans/guest-init.js';
import { recordScanForGuestToken } from '../../../src/db/scanUsage.js';
import { BadRequestError } from '../../../src/http/errors.js';

let db: TestDb;

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await resetDb(db);
});

describe('guestInit', () => {
  it('returns a fresh token with 1 remaining scan', async () => {
    expect(await guestInit(db, 'guest-1')).toEqual({ guestToken: 'guest-1', remainingScans: 1 });
  });

  it('returns 0 remaining after a scan is recorded', async () => {
    await recordScanForGuestToken(db, 'guest-1');
    expect(await guestInit(db, 'guest-1')).toEqual({ guestToken: 'guest-1', remainingScans: 0 });
  });

  it('rejects a missing guestToken', async () => {
    await expect(guestInit(db, undefined)).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects an empty guestToken', async () => {
    await expect(guestInit(db, '   ')).rejects.toBeInstanceOf(BadRequestError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/api/scans/guest-init.test.ts`
Expected: FAIL — `api/scans/guest-init.ts` doesn't exist.

- [ ] **Step 3: Add dev dependency and implement**

Add to `package.json` `"devDependencies"`:

```json
"@vercel/node": "^3.2.0",
```

Run: `npm install`

```ts
// api/scans/guest-init.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createDb, type Db } from '../../src/db/client.js';
import { countScansForGuestToken, GUEST_SCAN_LIMIT } from '../../src/db/scanUsage.js';
import { BadRequestError, errorToResponse } from '../../src/http/errors.js';

export function validateGuestToken(guestToken: unknown): string {
  if (typeof guestToken !== 'string' || guestToken.trim().length === 0 || guestToken.length > 100) {
    throw new BadRequestError('guestToken must be a non-empty string');
  }
  return guestToken;
}

export async function guestInit(db: Db, guestTokenInput: unknown) {
  const guestToken = validateGuestToken(guestTokenInput);
  const used = await countScansForGuestToken(db, guestToken);
  return { guestToken, remainingScans: Math.max(0, GUEST_SCAN_LIMIT - used) };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const result = await guestInit(createDb(), req.body?.guestToken);
    res.status(200).json(result);
  } catch (err) {
    const { status, body } = errorToResponse(err);
    res.status(status).json(body);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/api/scans/guest-init.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add api/scans/guest-init.ts package.json package-lock.json test/api/scans/guest-init.test.ts
git commit -m "feat: add POST /api/scans/guest-init"
```

---

### Task 9: `POST /api/scans/consume`

**Files:**
- Create: `api/scans/consume.ts`
- Test: `test/api/scans/consume.test.ts`

**Interfaces:**
- Consumes: `validateGuestToken` from `./guest-init.js`; `countScansForGuestToken`, `countScansForUser`, `recordScanForGuestToken`, `recordScanForUser`, `GUEST_SCAN_LIMIT` from `../../src/db/scanUsage.js`; `findOrCreateUser`, `getUserWithPlan` from `../../src/db/users.js`; `createClerkVerifier`, `type ClerkVerifier` from `../../src/auth/clerk.js`; `QuotaExceededError` from `../../src/http/errors.js`; `requireEnv` from `../../src/env.js`.
- Produces: `consumeScan(db: Db, clerkVerifier: ClerkVerifier, authHeader: string | undefined, guestTokenInput: unknown): Promise<{ remainingScans: number }>`; default-exported Vercel `handler`.

- [ ] **Step 1: Write the failing test**

```ts
// test/api/scans/consume.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../../helpers/testDb.js';
import { consumeScan } from '../../../api/scans/consume.js';
import { createPlan } from '../../../src/db/plans.js';
import { findOrCreateUser } from '../../../src/db/users.js';
import type { ClerkVerifier } from '../../../src/auth/clerk.js';
import { QuotaExceededError } from '../../../src/http/errors.js';

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

describe('consumeScan — guest', () => {
  it('allows the first guest scan', async () => {
    const result = await consumeScan(db, fakeVerifier('unused', 'unused'), undefined, 'guest-1');
    expect(result).toEqual({ remainingScans: 0 });
  });

  it('rejects a second guest scan on the same token', async () => {
    await consumeScan(db, fakeVerifier('unused', 'unused'), undefined, 'guest-1');
    await expect(consumeScan(db, fakeVerifier('unused', 'unused'), undefined, 'guest-1')).rejects.toBeInstanceOf(
      QuotaExceededError
    );
  });
});

describe('consumeScan — logged in', () => {
  it('allows scans up to the plan limit, then rejects', async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 2 });
    const verifier = fakeVerifier('clerk_1', 'a@example.com');

    const first = await consumeScan(db, verifier, 'Bearer whatever', undefined);
    expect(first).toEqual({ remainingScans: 1 });

    const second = await consumeScan(db, verifier, 'Bearer whatever', undefined);
    expect(second).toEqual({ remainingScans: 0 });

    await expect(consumeScan(db, verifier, 'Bearer whatever', undefined)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('finds-or-creates the user on first call', async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 5 });
    const verifier = fakeVerifier('clerk_2', 'b@example.com');
    await consumeScan(db, verifier, 'Bearer whatever', undefined);
    const found = await findOrCreateUser(db, 'clerk_2', 'b@example.com');
    expect(found.email).toBe('b@example.com');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/api/scans/consume.test.ts`
Expected: FAIL — `api/scans/consume.ts` doesn't exist.

- [ ] **Step 3: Implement**

```ts
// api/scans/consume.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createDb, type Db } from '../../src/db/client.js';
import {
  countScansForGuestToken,
  countScansForUser,
  recordScanForGuestToken,
  recordScanForUser,
  GUEST_SCAN_LIMIT,
} from '../../src/db/scanUsage.js';
import { findOrCreateUser, getUserWithPlan } from '../../src/db/users.js';
import { createClerkVerifier, type ClerkVerifier } from '../../src/auth/clerk.js';
import { QuotaExceededError, errorToResponse } from '../../src/http/errors.js';
import { requireEnv } from '../../src/env.js';
import { validateGuestToken } from './guest-init.js';

export async function consumeScan(
  db: Db,
  clerkVerifier: ClerkVerifier,
  authHeader: string | undefined,
  guestTokenInput: unknown
): Promise<{ remainingScans: number }> {
  if (authHeader) {
    const { clerkUserId, email } = await clerkVerifier.verifyRequest(authHeader);
    const user = await findOrCreateUser(db, clerkUserId, email);
    const withPlan = await getUserWithPlan(db, user.id);
    const used = await countScansForUser(db, user.id);
    if (used >= withPlan!.plan.scanLimit) {
      throw new QuotaExceededError({ plan: withPlan!.plan.name, scanLimit: withPlan!.plan.scanLimit, used });
    }
    await recordScanForUser(db, user.id);
    return { remainingScans: withPlan!.plan.scanLimit - used - 1 };
  }

  const guestToken = validateGuestToken(guestTokenInput);
  const used = await countScansForGuestToken(db, guestToken);
  if (used >= GUEST_SCAN_LIMIT) {
    throw new QuotaExceededError({ plan: 'Guest', scanLimit: GUEST_SCAN_LIMIT, used });
  }
  await recordScanForGuestToken(db, guestToken);
  return { remainingScans: GUEST_SCAN_LIMIT - used - 1 };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const clerkVerifier = createClerkVerifier(requireEnv('CLERK_SECRET_KEY'));
    const result = await consumeScan(createDb(), clerkVerifier, req.headers.authorization, req.body?.guestToken);
    res.status(200).json(result);
  } catch (err) {
    const { status, body } = errorToResponse(err);
    res.status(status).json(body);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/api/scans/consume.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add api/scans/consume.ts test/api/scans/consume.test.ts
git commit -m "feat: add POST /api/scans/consume for guest and logged-in quota enforcement"
```

---

### Task 10: `GET /api/me`

**Files:**
- Create: `api/me.ts`
- Test: `test/api/me.test.ts`

**Interfaces:**
- Consumes: `findOrCreateUser`, `getUserWithPlan` from `../src/db/users.js`; `countScansForUser` from `../src/db/scanUsage.js`; `createClerkVerifier`, `type ClerkVerifier` from `../src/auth/clerk.js`; `requireEnv` from `../src/env.js`.
- Produces: `getMe(db: Db, clerkVerifier: ClerkVerifier, authHeader: string | undefined): Promise<{ email: string; role: 'user' | 'admin'; plan: { name: string; tier: 'free' | 'paid'; scanLimit: number }; remainingScans: number }>`; default-exported Vercel `handler`.

- [ ] **Step 1: Write the failing test**

```ts
// test/api/me.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../helpers/testDb.js';
import { getMe } from '../../api/me.js';
import { createPlan } from '../../src/db/plans.js';
import type { ClerkVerifier } from '../../src/auth/clerk.js';

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

describe('getMe', () => {
  it('returns the caller\'s email, role, plan, and remaining scans', async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    const result = await getMe(db, fakeVerifier('clerk_1', 'a@example.com'), 'Bearer whatever');
    expect(result).toEqual({
      email: 'a@example.com',
      role: 'user',
      plan: { name: 'Free', tier: 'free', scanLimit: 3 },
      remainingScans: 3,
    });
  });

  it('reflects consumed scans in remainingScans', async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    const verifier = fakeVerifier('clerk_1', 'a@example.com');
    await getMe(db, verifier, 'Bearer whatever'); // creates the user
    const { recordScanForUser } = await import('../../src/db/scanUsage.js');
    const { findOrCreateUser } = await import('../../src/db/users.js');
    const user = await findOrCreateUser(db, 'clerk_1', 'a@example.com');
    await recordScanForUser(db, user.id);
    const result = await getMe(db, verifier, 'Bearer whatever');
    expect(result.remainingScans).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/api/me.test.ts`
Expected: FAIL — `api/me.ts` doesn't exist.

- [ ] **Step 3: Implement**

```ts
// api/me.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createDb, type Db } from '../src/db/client.js';
import { findOrCreateUser, getUserWithPlan } from '../src/db/users.js';
import { countScansForUser } from '../src/db/scanUsage.js';
import { createClerkVerifier, type ClerkVerifier } from '../src/auth/clerk.js';
import { errorToResponse } from '../src/http/errors.js';
import { requireEnv } from '../src/env.js';

export async function getMe(db: Db, clerkVerifier: ClerkVerifier, authHeader: string | undefined) {
  const { clerkUserId, email } = await clerkVerifier.verifyRequest(authHeader);
  const user = await findOrCreateUser(db, clerkUserId, email);
  const withPlan = await getUserWithPlan(db, user.id);
  const used = await countScansForUser(db, user.id);
  return {
    email: withPlan!.user.email,
    role: withPlan!.user.role,
    plan: { name: withPlan!.plan.name, tier: withPlan!.plan.tier, scanLimit: withPlan!.plan.scanLimit },
    remainingScans: Math.max(0, withPlan!.plan.scanLimit - used),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const clerkVerifier = createClerkVerifier(requireEnv('CLERK_SECRET_KEY'));
    const result = await getMe(createDb(), clerkVerifier, req.headers.authorization);
    res.status(200).json(result);
  } catch (err) {
    const { status, body } = errorToResponse(err);
    res.status(status).json(body);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/api/me.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add api/me.ts test/api/me.test.ts
git commit -m "feat: add GET /api/me"
```

---

### Task 11: `/api/admin/plans` (rate-card CRUD)

**Files:**
- Create: `api/admin/plans.ts`
- Test: `test/api/admin/plans.test.ts`

**Interfaces:**
- Consumes: `findOrCreateUser` from `../../src/db/users.js`; `listPlans`, `createPlan`, `updatePlan`, `deletePlan`, `type PlanInput` from `../../src/db/plans.js`; `createClerkVerifier`, `type ClerkVerifier` from `../../src/auth/clerk.js`; `ForbiddenError` from `../../src/http/errors.js`; `requireEnv` from `../../src/env.js`.
- Produces: `handlePlansRequest(db: Db, clerkVerifier: ClerkVerifier, method: string, authHeader: string | undefined, body: unknown, query: { id?: string }): Promise<unknown>`; default-exported Vercel `handler`.

- [ ] **Step 1: Write the failing test**

```ts
// test/api/admin/plans.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../../helpers/testDb.js';
import { handlePlansRequest } from '../../../api/admin/plans.js';
import { createPlan } from '../../../src/db/plans.js';
import { findOrCreateUser } from '../../../src/db/users.js';
import { promoteToAdmin } from '../../../src/db/users.js';
import type { ClerkVerifier } from '../../../src/auth/clerk.js';
import { ForbiddenError, ConflictError, NotFoundError } from '../../../src/http/errors.js';

let db: TestDb;

function fakeVerifier(clerkUserId: string, email: string): ClerkVerifier {
  return { verifyRequest: async () => ({ clerkUserId, email }) };
}

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
  await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
});

afterAll(async () => {
  await resetDb(db);
});

describe('handlePlansRequest', () => {
  it('rejects a non-admin user', async () => {
    await findOrCreateUser(db, 'clerk_user', 'user@example.com');
    await expect(
      handlePlansRequest(db, fakeVerifier('clerk_user', 'user@example.com'), 'GET', 'Bearer x', undefined, {})
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lists, creates, updates, and deletes a plan for an admin', async () => {
    await findOrCreateUser(db, 'clerk_admin', 'admin@example.com');
    await promoteToAdmin(db, 'admin@example.com');
    const verifier = fakeVerifier('clerk_admin', 'admin@example.com');

    const listed = (await handlePlansRequest(db, verifier, 'GET', 'Bearer x', undefined, {})) as unknown[];
    expect(listed).toHaveLength(1);

    const created = (await handlePlansRequest(
      db,
      verifier,
      'POST',
      'Bearer x',
      { name: 'Pro', tier: 'paid', scanLimit: 50 },
      {}
    )) as { id: number };

    const updated = (await handlePlansRequest(
      db,
      verifier,
      'PATCH',
      'Bearer x',
      { name: 'Pro', tier: 'paid', scanLimit: 100 },
      { id: String(created.id) }
    )) as { scanLimit: number };
    expect(updated.scanLimit).toBe(100);

    const deleted = await handlePlansRequest(db, verifier, 'DELETE', 'Bearer x', undefined, { id: String(created.id) });
    expect(deleted).toEqual({ deleted: true });
  });

  it('propagates NotFoundError for an unknown plan id', async () => {
    await findOrCreateUser(db, 'clerk_admin', 'admin@example.com');
    await promoteToAdmin(db, 'admin@example.com');
    const verifier = fakeVerifier('clerk_admin', 'admin@example.com');
    await expect(
      handlePlansRequest(db, verifier, 'PATCH', 'Bearer x', { name: 'X', tier: 'paid', scanLimit: 1 }, { id: '999999' })
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/api/admin/plans.test.ts`
Expected: FAIL — `api/admin/plans.ts` doesn't exist.

- [ ] **Step 3: Implement**

```ts
// api/admin/plans.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createDb, type Db } from '../../src/db/client.js';
import { findOrCreateUser } from '../../src/db/users.js';
import { listPlans, createPlan, updatePlan, deletePlan, type PlanInput } from '../../src/db/plans.js';
import { createClerkVerifier, type ClerkVerifier } from '../../src/auth/clerk.js';
import { ForbiddenError, errorToResponse } from '../../src/http/errors.js';
import { requireEnv } from '../../src/env.js';

async function requireAdmin(db: Db, clerkVerifier: ClerkVerifier, authHeader: string | undefined) {
  const { clerkUserId, email } = await clerkVerifier.verifyRequest(authHeader);
  const user = await findOrCreateUser(db, clerkUserId, email);
  if (user.role !== 'admin') throw new ForbiddenError('admin role required');
  return user;
}

export async function handlePlansRequest(
  db: Db,
  clerkVerifier: ClerkVerifier,
  method: string,
  authHeader: string | undefined,
  body: unknown,
  query: { id?: string }
) {
  await requireAdmin(db, clerkVerifier, authHeader);

  if (method === 'GET') return listPlans(db);
  if (method === 'POST') return createPlan(db, body as PlanInput);
  if (method === 'PATCH') return updatePlan(db, Number(query.id), body as PlanInput);
  if (method === 'DELETE') {
    await deletePlan(db, Number(query.id));
    return { deleted: true };
  }
  throw new Error(`Unsupported method ${method}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const clerkVerifier = createClerkVerifier(requireEnv('CLERK_SECRET_KEY'));
    const result = await handlePlansRequest(
      createDb(),
      clerkVerifier,
      req.method ?? 'GET',
      req.headers.authorization,
      req.body,
      req.query as { id?: string }
    );
    res.status(200).json(result);
  } catch (err) {
    const { status, body } = errorToResponse(err);
    res.status(status).json(body);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/api/admin/plans.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add api/admin/plans.ts test/api/admin/plans.test.ts
git commit -m "feat: add /api/admin/plans rate-card CRUD"
```

---

### Task 12: `/api/admin/users` (list + reassign plan)

**Files:**
- Create: `api/admin/users.ts`
- Test: `test/api/admin/users.test.ts`

**Interfaces:**
- Consumes: `findOrCreateUser`, `listUsersWithPlans`, `updateUserPlan` from `../../src/db/users.js`; `createClerkVerifier`, `type ClerkVerifier` from `../../src/auth/clerk.js`; `ForbiddenError`, `BadRequestError` from `../../src/http/errors.js`; `requireEnv` from `../../src/env.js`.
- Produces: `handleUsersRequest(db: Db, clerkVerifier: ClerkVerifier, method: string, authHeader: string | undefined, body: unknown, query: { id?: string }): Promise<unknown>`; default-exported Vercel `handler`.

- [ ] **Step 1: Write the failing test**

```ts
// test/api/admin/users.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../../helpers/testDb.js';
import { handleUsersRequest } from '../../../api/admin/users.js';
import { createPlan } from '../../../src/db/plans.js';
import { findOrCreateUser, promoteToAdmin } from '../../../src/db/users.js';
import type { ClerkVerifier } from '../../../src/auth/clerk.js';
import { ForbiddenError, BadRequestError } from '../../../src/http/errors.js';

let db: TestDb;

function fakeVerifier(clerkUserId: string, email: string): ClerkVerifier {
  return { verifyRequest: async () => ({ clerkUserId, email }) };
}

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
  await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
});

afterAll(async () => {
  await resetDb(db);
});

describe('handleUsersRequest', () => {
  it('rejects a non-admin user', async () => {
    await findOrCreateUser(db, 'clerk_user', 'user@example.com');
    await expect(
      handleUsersRequest(db, fakeVerifier('clerk_user', 'user@example.com'), 'GET', 'Bearer x', undefined, {})
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lists users and reassigns a plan for an admin', async () => {
    await findOrCreateUser(db, 'clerk_admin', 'admin@example.com');
    await promoteToAdmin(db, 'admin@example.com');
    const target = await findOrCreateUser(db, 'clerk_target', 'target@example.com');
    const paid = await createPlan(db, { name: 'Pro', tier: 'paid', scanLimit: 50 });
    const verifier = fakeVerifier('clerk_admin', 'admin@example.com');

    const listed = (await handleUsersRequest(db, verifier, 'GET', 'Bearer x', undefined, {})) as unknown[];
    expect(listed).toHaveLength(2);

    const updated = (await handleUsersRequest(
      db,
      verifier,
      'PATCH',
      'Bearer x',
      { planId: paid.id },
      { id: String(target.id) }
    )) as { planId: number };
    expect(updated.planId).toBe(paid.id);
  });

  it('rejects a PATCH with no planId in the body', async () => {
    await findOrCreateUser(db, 'clerk_admin', 'admin@example.com');
    await promoteToAdmin(db, 'admin@example.com');
    const target = await findOrCreateUser(db, 'clerk_target', 'target@example.com');
    const verifier = fakeVerifier('clerk_admin', 'admin@example.com');
    await expect(
      handleUsersRequest(db, verifier, 'PATCH', 'Bearer x', {}, { id: String(target.id) })
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/api/admin/users.test.ts`
Expected: FAIL — `api/admin/users.ts` doesn't exist.

- [ ] **Step 3: Implement**

```ts
// api/admin/users.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createDb, type Db } from '../../src/db/client.js';
import { findOrCreateUser, listUsersWithPlans, updateUserPlan } from '../../src/db/users.js';
import { createClerkVerifier, type ClerkVerifier } from '../../src/auth/clerk.js';
import { ForbiddenError, BadRequestError, errorToResponse } from '../../src/http/errors.js';
import { requireEnv } from '../../src/env.js';

async function requireAdmin(db: Db, clerkVerifier: ClerkVerifier, authHeader: string | undefined) {
  const { clerkUserId, email } = await clerkVerifier.verifyRequest(authHeader);
  const user = await findOrCreateUser(db, clerkUserId, email);
  if (user.role !== 'admin') throw new ForbiddenError('admin role required');
  return user;
}

export async function handleUsersRequest(
  db: Db,
  clerkVerifier: ClerkVerifier,
  method: string,
  authHeader: string | undefined,
  body: unknown,
  query: { id?: string }
) {
  await requireAdmin(db, clerkVerifier, authHeader);

  if (method === 'GET') return listUsersWithPlans(db);
  if (method === 'PATCH') {
    const planId = (body as { planId?: unknown })?.planId;
    if (typeof planId !== 'number') throw new BadRequestError('planId is required');
    return updateUserPlan(db, Number(query.id), planId);
  }
  throw new Error(`Unsupported method ${method}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const clerkVerifier = createClerkVerifier(requireEnv('CLERK_SECRET_KEY'));
    const result = await handleUsersRequest(
      createDb(),
      clerkVerifier,
      req.method ?? 'GET',
      req.headers.authorization,
      req.body,
      req.query as { id?: string }
    );
    res.status(200).json(result);
  } catch (err) {
    const { status, body } = errorToResponse(err);
    res.status(status).json(body);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/api/admin/users.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add api/admin/users.ts test/api/admin/users.test.ts
git commit -m "feat: add /api/admin/users listing and plan reassignment"
```

---

### Task 13: Deployment config, env docs, README

**Files:**
- Create: `vercel.json`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:** None — documentation and deploy config only, no new exports.

- [ ] **Step 1: Add Vercel config**

```json
// vercel.json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": null,
  "framework": null
}
```

(No custom build step — Vercel auto-detects the `api/` directory of TypeScript functions with the "Other" framework preset; `buildCommand: null` avoids running this repo's `tsc` build, which targets the CLI/worker, not the API functions.)

- [ ] **Step 2: Document the new env vars**

Add to `.env.example`, after the existing `R2_*` block:

```
# Clerk (auth) — server-side secret only; the publishable key lives in
# websight-base's env, not here
CLERK_SECRET_KEY=
```

- [ ] **Step 3: Document the new scripts and API surface in README.md**

Add a new section to `README.md` after the existing `## Commands` section:

```markdown
## Auth / guest / paid gating API

As of the auth-subscriptions-api branch, this repo also exposes a small
Vercel-serverless HTTP API (`api/`) gating scans by guest/free/paid tier,
independent of the crawl pipeline above:

    npm run seed:plans          # creates the seeded Free plan (idempotent)
    npm run seed:admin -- <email>  # promotes an existing user to admin

Endpoints: `POST /api/scans/guest-init`, `POST /api/scans/consume`,
`GET /api/me`, `GET/POST/PATCH/DELETE /api/admin/plans`,
`GET/PATCH /api/admin/users`. Requires `CLERK_SECRET_KEY` (see
`.env.example`). Deployed as its own Vercel project, separate from
`websight-base`'s frontend deployment — see
`docs/superpowers/specs/2026-07-28-auth-subscriptions-api-design.md` for the
full design, including why the BullMQ worker's hosting gap is out of scope
here.
```

- [ ] **Step 4: Verify the whole suite still passes**

Run: `npm run typecheck`
Expected: no errors

Run: `npm test`
Expected: all tests pass (existing Phase 3 tests + all tests added in Tasks 1–12)

- [ ] **Step 5: Commit**

```bash
git add vercel.json .env.example README.md
git commit -m "docs: document auth/gating API deployment, env vars, and scripts"
```

---

## Self-review notes

- **Spec coverage**: schema (Task 1), all 7 endpoints from the spec's request/data-flow section (Tasks 8–12, `guest-init`+`consume` covering the guest and logged-in scan flows, `me` covering the summary endpoint, `admin/plans`+`admin/users` covering the rate card), error handling (`src/http/errors.ts`, Task 2, used throughout), hosting (Task 13's `vercel.json` + README), seed scripts (Task 6) — every section of the approved spec has a corresponding task.
- **Placeholder scan**: no TBD/TODO; every step has runnable code and exact commands.
- **Type consistency**: `ClerkVerifier`/`AuthenticatedUser` (Task 7) are the exact types imported and faked identically in Tasks 9–12's tests; `PlanInput`/`PlanTier` (Task 3) are reused unchanged by Task 11; `Db` type flows from `src/db/client.ts` (pre-existing) through every task without renaming.
