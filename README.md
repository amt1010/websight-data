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
