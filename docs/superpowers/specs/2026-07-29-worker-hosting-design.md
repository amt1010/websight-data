# BullMQ Worker Hosting — Design

Status: approved
Date: 2026-07-29
Repo: websight-data (extends the existing repo, no new repo)

## Context

Phase 3 (`docs/superpowers/specs/2026-07-28-phase-3-data-jobs-design.md`)
built the crawl pipeline as a BullMQ worker (`src/queue/worker.ts`, started
via `npm run worker` / `src/workerMain.ts`) that holds an open Upstash Redis
connection and blocks waiting for jobs. That spec explicitly deferred
"worker deployment/hosting" to Phase 5 and the auth-subscriptions-api spec
confirmed it again as an unrelated, still-open gap: this repo's `api/`
routes deploy as Vercel serverless functions, but the worker itself has
never run anywhere except a developer's own terminal ("manual-only, local
for now" per the README).

The blocker is structural, not a missing config flag: Vercel Functions
(even under Fluid Compute, which allows regular Node.js and up to 300s
duration) are invocation-triggered and instance-recycled — there's no
primitive for a process that just stays alive indefinitely with no
incoming request driving it, which is exactly what BullMQ's `Worker` is.
A full-site Playwright crawl can also run well past any per-invocation
duration cap, which rules out a cron-drain workaround even if the
triggering problem were solved. Vercel Queues (newer, Fluid-Compute-native,
public beta) was considered as an alternative that avoids a separate host
entirely, but was rejected for now — it would mean rewriting the
producer/worker and re-verifying crawl duration against function limits,
versus this option which hosts the existing, already-tested worker code
unchanged.

This spec covers hosting the existing worker on Railway as an always-on
service, with no changes to the crawl→upload→persist pipeline itself.

## Decision: Railway, Docker-based deploy

Railway was chosen over Render/Fly.io for this pass: a background worker
with no HTTP surface is a natural fit for a single always-on Railway
service, and its GitHub-integration auto-deploy mirrors the pattern already
used for `websight-base`'s Vercel deployment (connect once in the
dashboard, push to `main` to deploy).

The build uses a **Dockerfile**, not Railway's default Nixpacks
buildpacks. Reason: the worker's crawl step depends on
`websight-crawler`, which depends on Playwright, which needs a specific
set of system libraries (fonts, codecs, etc.) alongside a matching-version
Chromium binary. Nixpacks has no reliable way to provision these; Playwright
publishes an official Docker image with everything preinstalled, pinned to
an exact Playwright version. `websight-data`'s lockfile currently resolves
`playwright@1.62.0` (via the `websight-crawler` git dependency), so the
base image is pinned to `mcr.microsoft.com/playwright:v1.62.0-jammy` —
this pin must move in lockstep with any future `websight-crawler` version
bump that changes the resolved Playwright version, or the container's
bundled browser will mismatch the npm package and fail at runtime.

## Architecture

```
GitHub (websight-data, main)
        │  push
        ▼
Railway (GitHub integration, auto-deploy)
        │  docker build (Dockerfile)
        ▼
Container: mcr.microsoft.com/playwright:v1.62.0-jammy
        │  npm ci → npm run build → node dist/workerMain.js
        ▼
Long-running worker process
        │  REDIS_URL (Upstash), DATABASE_URL (Neon), R2_* — Railway env vars
        ▼
Same pipeline as today: crawl() → storage.put() → persistCrawlResult()
```

The worker code path (`src/queue/worker.ts`, `src/queue/producer.ts`,
`src/db/crawls.ts`, `src/storage/index.ts`) is unchanged. `enqueueCrawl()`
— called today only from the CLI, and in the future from Phase 4's API —
still just pushes a job onto the same Upstash Redis queue; a
Railway-hosted worker consumes it exactly as a local `npm run worker`
process would. Only the process's *host* changes.

## Components

- **`Dockerfile`** (new) — multi-stage: `npm ci`, `npm run build` (compiles
  `src/` to `dist/` via the existing `tsc` build script), then
  `CMD ["node", "dist/workerMain.js"]`. Runs compiled output rather than
  `tsx` so the runtime image doesn't need `tsx`/TypeScript as production
  dependencies — `tsx` remains dev-only, used for local `npm run worker`.
- **`.dockerignore`** (new) — excludes `node_modules`, `dist`, `.env`,
  `test/`, `docs/`, `api/` (the Vercel-only serverless routes have no
  reason to ship inside the worker image).
- **`railway.json`** (new) — `builder: "DOCKERFILE"`,
  `restartPolicyType: "ON_FAILURE"`. No exposed port: this is a background
  worker, not a web service, and Railway supports port-less services.
- **`src/workerMain.ts`** (modified) — add a `SIGTERM` handler that mirrors
  the existing `SIGINT` handler (`worker.close()` then
  `connection.quit()`). Railway sends `SIGTERM` on redeploy/manual stop;
  today only `SIGINT` (Ctrl-C) is handled, so a routine redeploy would kill
  the process without giving BullMQ's graceful-close a chance to let an
  in-flight job finish.
- **`README.md`** (modified) — replace the "manual-only, local for now"
  worker language with a "Deploying the worker" section: create a Railway
  project, connect the `websight-data` GitHub repo, set `REDIS_URL`,
  `DATABASE_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` in the Railway dashboard, deploy.
  `npm run worker` (via `tsx`) remains the local-dev path, unchanged.

## Error handling

- **Container crash/OOM**: Railway's `ON_FAILURE` restart policy restarts
  the container. The in-flight BullMQ job becomes "stalled" and is
  requeued per BullMQ's existing default retry config — unchanged from
  what the Phase 3 design doc already specified for a worker crash, now
  backed by an actual restart policy instead of relying on whoever's
  terminal the worker happened to be running in.
- **`SIGTERM` (redeploy/manual stop)**: now caught identically to
  `SIGINT` — `worker.close()` waits for the in-progress job to finish
  before the process exits, so a routine redeploy doesn't strand a crawl
  mid-page-visit.
- **Build failure** (e.g. a future Playwright version bump without
  updating the Docker base image tag): fails at Railway's build step;
  the previously-deployed container keeps running unaffected.

## Testing

No new automated tests — this is a deployment/infra change, not
application logic; `src/queue/worker.ts` and its existing test coverage
are untouched. Verification is manual, matching the bar the README
already sets for real R2 uploads and real-domain crawls ("manual-only"):

1. `docker build .` succeeds locally.
2. `docker run` the image against `TEST_REDIS_URL`/`TEST_DATABASE_URL` and
   real R2 test credentials, enqueue one crawl via
   `npm run cli -- enqueue <domain>` from outside the container, and
   confirm the containerized worker picks up the job and the crawl reaches
   `status='done'`.

## Out of scope (confirmed)

- Creating the actual Railway project, connecting the GitHub repo, and
  setting environment variables in the Railway dashboard, and triggering
  the first real deploy — done manually by the project owner per the
  updated README, not by this spec's implementation.
- Migrating to Vercel Queues or any other queue technology — rejected for
  this pass, see Decision above.
- Autoscaling, multiple worker replicas, dead-letter queues, retry
  alerting — still Phase 5 per the Phase 3 design doc.
- Any change to the crawl/upload/persist pipeline logic itself.
