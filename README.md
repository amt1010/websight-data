# websight-data

Persistence, job queue, and object storage for WebSight (Phase 3 of the
WebSight roadmap). Wraps `websight-crawler`'s `crawl()` in a BullMQ job:
results are uploaded to Cloudflare R2 (screenshots/HTML) and persisted to
Postgres (Neon) via Drizzle. See the design spec in
`docs/superpowers/specs/2026-07-28-phase-3-data-jobs-design.md`. (This repo
also now hosts a separate auth/guest/paid-gating HTTP API — see below — but
Phase 3's own crawl pipeline still has no REST/GraphQL API in front of it.)

## Setup

    npm install
    cp .env.example .env   # fill in DATABASE_URL, REDIS_URL, R2_*
    npm run db:migrate

`db:migrate` only applies to whatever `DATABASE_URL` resolves to at the time
you run it (`drizzle.config.ts` falls back to `TEST_DATABASE_URL` if
`DATABASE_URL` is unset) — it does not also migrate the other one. Since
`DATABASE_URL` and `TEST_DATABASE_URL` are two separate Neon branches, run
`db:migrate` once against **each** (e.g. `DATABASE_URL=$TEST_DATABASE_URL npm
run db:migrate` for the test branch, then again with `DATABASE_URL` set to
the real branch) whenever the schema changes, and before the first real
`npm run cli -- enqueue`/`npm run worker` run against a fresh prod branch —
otherwise `enqueue`/the worker fail with `relation "crawls" does not exist`.

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

Test files run against shared live Neon/Upstash test instances rather than
mocks, so `vitest.config.ts` disables file-level parallelism
(`fileParallelism: false`) — otherwise concurrent test files racing against
the same tables/queue cause spurious foreign-key and "row not found"
failures.

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
