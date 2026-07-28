# Auth / Guest / Paid Gating — Backend (Sub-project 1): Design

Status: approved
Date: 2026-07-28
Repo: websight-data (extends the existing repo, no new repo)

## Context

This is **not** a ROADMAP.md phase — it's a separate feature layered on top
of the current fully-mocked demo: a new home page with login + guest mode,
where guests get one scan limited to the Overview and Sitemap tabs, logged-in
"Free" users get a few more scans under the same tab restriction, and "Paid"
users get full tab access under an admin-configurable quota (a "rate card" of
plans and scans-per-plan).

Scans in this feature still render the existing hardcoded `BSW` mock data —
wiring real crawl results into the UI is the already-planned Phase 4 work
(`ROADMAP.md`) and is explicitly **not** part of this. This feature and
Phase 4 are independent: this one gates access to the mock demo; Phase 4
replaces the mock with real data. They happen to share the same repo
(`websight-data`) for their API surface.

The overall gating feature was decomposed into three sub-projects, each with
its own spec → plan → branch, per the branch-per-initiative convention
already used for Phase 2/3:

1. **This spec** — auth + subscriptions + rate-card API (`websight-data`).
2. Frontend home page, login/guest mode, tab gating (`websight-base`) — not
   yet speced.
3. Frontend admin rate-card config UI (`websight-base`) — not yet speced.

### Relationship to Phase 4

Phase 4 (real crawl data wiring) was independently brainstormed earlier and
had tentatively settled on a custom JWT auth scheme over an Express server,
before this feature's design started. That direction is **superseded**: once
Phase 4 resumes, its endpoints (e.g. `POST /crawls`, `GET /crawls/:id`) will
be added to the same API surface this spec builds, reusing Clerk for
identity and the same `users` table, rather than standing up a second,
independent auth system in the same repo. No code exists yet for either
direction, so nothing is being migrated — this is simply the stack that
wins going forward.

## Providers

- **Auth**: Clerk (managed) — `@clerk/clerk-react` on the frontend,
  `@clerk/backend` verifying session JWTs on the API. Chosen over a
  hand-rolled email/password + JWT scheme to avoid owning password storage,
  reset flows, and session security for a project this size.
- **Postgres**: Neon — same instance/branching setup as Phase 3
  (`DATABASE_URL` / `TEST_DATABASE_URL`).
- **Hosting**: `websight-data`'s API deploys as its own **Vercel project**
  (serverless functions, file-based routing under `api/`) — separate from
  `websight-base`'s existing Vercel deployment. This means the API is
  **plain Vercel serverless functions, not Fastify** (Fastify's
  connection/plugin model doesn't map cleanly onto stateless per-invocation
  functions) — see Components below.

### Known gap, explicitly out of scope here

The existing BullMQ worker (Phase 3) has no hosting story either — it's
"manual-only" per `websight-data`'s README. This feature never touches the
worker or the crawler (scans render mock data, not real crawls), so that gap
is irrelevant to this spec. It remains open for whenever Phase 4 resumes, or
as a Phase 5 hardening item.

## Schema (Drizzle, Postgres — additions to the existing schema.ts)

```ts
export const plans = pgTable('plans', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),                 // e.g. "Free", "Pro", "Enterprise"
  tier: text('tier', { enum: ['free', 'paid'] }).notNull(),
  scanLimit: integer('scan_limit').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  clerkUserId: text('clerk_user_id').notNull().unique(),
  email: text('email').notNull(),
  role: text('role', { enum: ['user', 'admin'] }).notNull().default('user'),
  planId: integer('plan_id').notNull().references(() => plans.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const scanUsage = pgTable('scan_usage', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
  guestToken: text('guest_token'),
  scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Notes:

- `plans` covers **both** Free and Paid tiers — a seeded `tier:'free'` row is
  the default every new user gets, and the admin rate-card UI (sub-project
  3) manages both the free row and any number of paid rows through the same
  CRUD surface. `plans.tier` is what drives tab access (free → Overview +
  Sitemap only; paid → all tabs); `plans.scanLimit` is what drives quota.
- **Guest** has no row anywhere in `users`/`plans` — there is no account to
  attach a plan to. Its 1-scan limit is a hardcoded application constant
  (`GUEST_SCAN_LIMIT = 1`), and usage is tracked in `scan_usage` via
  `guestToken` instead of `userId`. Exactly one of `userId`/`guestToken` is
  set per `scan_usage` row; enforced at the application layer (not a DB
  constraint, consistent with this schema's existing style of
  application-enforced invariants over DB-level checks).
- A user's `planId` defaults to the seeded Free plan on first login
  (find-or-create — see Components) and is only ever changed by an admin via
  `PATCH /api/admin/users/:id` — no self-service upgrade flow in this pass.

## Components

```
websight-data/
  api/
    scans/
      guest-init.ts   POST  — issue/validate a guestToken, return remaining scans
      consume.ts      POST  — spend a scan (guest or logged-in), 402 if over quota
    me.ts              GET   — current user's email/role/plan/remaining scans
    admin/
      plans.ts         GET/POST/PATCH/DELETE — rate-card CRUD (method switch)
      users.ts         GET/PATCH — list users, reassign a user's plan
  src/
    auth.ts            Clerk JWT verify + local find-or-create-user helper,
                        imported by every authenticated route above
    db/
      schema.ts        (existing file, gains plans/users/scanUsage)
      users.ts         findOrCreateUser(clerkUserId, email), getUserWithPlan(id)
      plans.ts         CRUD helpers used by api/admin/plans.ts
      scanUsage.ts      recordScan / countScans(userId | guestToken)
```

Each `api/**/*.ts` file is a self-contained Vercel serverless function; there
is no shared long-running server process for this API (unlike the existing
BullMQ worker, which is unaffected by this change).

## Request / data flow

- **Guest**: frontend generates a `guestToken` (uuid) into `localStorage` on
  first visit if none exists. On app load, `POST /api/scans/guest-init
  {guestToken}` creates the token's usage identity if unseen and returns
  `{guestToken, remainingScans}`, so the frontend knows upfront whether
  Analyze is usable. Clicking Analyze calls `POST /api/scans/consume
  {guestToken}`, which first counts existing `scan_usage` rows for that
  token against `GUEST_SCAN_LIMIT` — 402 (no row written) if already at the
  limit, otherwise inserts one `scan_usage` row and returns the updated
  `remainingScans`.
- **Logged in**: Clerk's frontend SDK handles signup/login and issues a
  session JWT; every request sends `Authorization: Bearer <clerk-jwt>`.
  `auth.ts` verifies it via `@clerk/backend`, then `findOrCreateUser` looks
  up (or creates, on first-ever login) the local `users` row keyed by
  `clerkUserId`, defaulting `planId` to the seeded Free plan. `GET /api/me`
  returns `{email, role, plan:{name,tier,scanLimit}, remainingScans}` — this
  drives which tabs the frontend renders. `POST /api/scans/consume` (no
  `guestToken` — identity comes from the verified JWT) spends a scan the
  same way: count first against `plan.scanLimit`, 402 with no row written if
  already at the limit, otherwise insert and return updated
  `remainingScans`.
- **Admin**: same Clerk login; `users.role === 'admin'` (bootstrapped via a
  `npm run seed:admin -- <email>` script — not self-service). Admin routes
  check `role === 'admin'` after normal Clerk verification, then perform
  plan CRUD or user→plan reassignment.
- **Tab-gating enforcement**: which tabs render is a client-side decision
  driven by `/api/me` or `/api/scans/guest-init`'s response — acceptable
  because the gated tabs only ever show mock `BSW` data, nothing sensitive.
  The scan quota itself (`consume`) **is** server-enforced, since that's the
  actual metered resource.

## Error handling

- `401` — missing/invalid Clerk JWT on any authenticated route.
- `403` — valid JWT but `role !== 'admin'` on any `/api/admin/*` route.
- `402 Payment Required` — scan quota exceeded (guest, free, or paid); body
  includes `{plan, scanLimit, used}` so the frontend can render a specific
  limit/upsell message.
- `400` — malformed/missing `guestToken` on guest routes; invalid `plans`
  payload on admin create/update (missing `name`, non-positive `scanLimit`,
  invalid `tier`).
- `404` — admin references a `planId`/`userId` that doesn't exist.
- `409` — admin tries to delete a plan that still has users assigned to it;
  require reassignment first rather than orphaning `users.planId`.

## Testing

- Vitest against the existing real-Neon-test-branch convention
  (`fileParallelism: false`, matching Phase 3's `crawls.ts` tests), covering:
  - `plans` CRUD, including the 409-on-delete-with-assigned-users guard.
  - Quota enforcement at each boundary: guest's 1st vs. 2nd scan, a Free
    plan's `scanLimit` edge, a Paid plan's `scanLimit` edge.
  - `findOrCreateUser` on first Clerk login (row created once, reused on
    subsequent logins).
  - Admin-role gating: 403 for non-admins on every `/api/admin/*` route.
  - Guest-token validation: 400 on a malformed/missing token.
- Clerk verification is mocked/stubbed in tests (per `@clerk/backend`'s
  testing utilities) rather than hitting real Clerk — mirrors the existing
  pattern of faking `crawl()` in the BullMQ producer/worker tests rather
  than running a real crawl.
- No serverless-specific integration tests (e.g. real Vercel deploy-preview
  hits) in this pass — unit/integration coverage of route-handler logic is
  the bar, consistent with "manual-only" real-infra testing already accepted
  elsewhere in this repo (real R2 uploads, real-domain crawls).

## Out of scope for this sub-project (confirmed)

- Real payment collection (Stripe or otherwise) — rate-card config + manual
  plan assignment only, this pass.
- Self-service plan upgrades — admin-only reassignment.
- Real crawl data, or anything from Phase 4 — scans continue to render the
  mock `BSW` object.
- Home page, login UI, guest-mode UX, tab-gating UI — sub-project 2.
- Admin rate-card config UI — sub-project 3.
- BullMQ worker hosting/deployment — pre-existing gap, unrelated to this
  feature, revisit whenever Phase 4 resumes or during Phase 5 hardening.
- Guest abuse resistance — a guest's quota is keyed solely by a client-side
  `guestToken`, so clearing `localStorage` (or using a different browser)
  resets it. Accepted for this pass since guest is capped at a single scan
  of mock data; IP-based or fingerprint-based limiting is a future
  hardening concern if abuse is observed, not a launch requirement.
