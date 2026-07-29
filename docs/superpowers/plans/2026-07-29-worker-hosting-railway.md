# BullMQ Worker Hosting on Railway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing BullMQ worker (`src/workerMain.ts`) deployable as an always-on Railway service, closing the long-open hosting gap, with zero changes to the crawl→upload→persist pipeline itself.

**Architecture:** A Docker image based on Playwright's official base image (matching the lockfile's resolved Playwright version) builds and runs the worker's compiled output. `railway.json` tells Railway to build with that Dockerfile and restart on failure. `workerMain.ts` gains a `SIGTERM` handler so Railway redeploys drain gracefully instead of killing an in-flight crawl.

**Tech Stack:** Docker, Railway (config-as-code via `railway.json`), Node.js 20, TypeScript (existing `tsc` build), BullMQ (existing).

## Global Constraints

- Docker base image pinned to `mcr.microsoft.com/playwright:v1.62.0-jammy` — must match the `playwright` version actually resolved in `package-lock.json` (currently `1.62.0` via the `websight-crawler` git dependency). If that lockfile version ever changes, the Dockerfile's two `FROM` lines must change with it.
- Runtime container runs **compiled** `dist/workerMain.js` (`node`, not `tsx`) — `tsx`/TypeScript stay dev-only.
- No change to `src/queue/worker.ts`, `src/queue/producer.ts`, `src/db/crawls.ts`, or `src/storage/index.ts` — this plan only changes where the process runs.
- No new automated tests are added for the Dockerfile/Railway config themselves (infra, not application logic) — verification is the manual `docker build`/`docker run` smoke test described in each task, matching this repo's existing "manual-only" bar for real R2/crawl integration (see `README.md`'s Status section).

---

### Task 1: Graceful `SIGTERM` shutdown in the worker entrypoint

**Files:**
- Modify: `src/workerMain.ts`

**Interfaces:**
- Consumes: nothing new — uses the existing `worker` (`Worker<CrawlJobData>` from `createCrawlWorker`) and `connection` (`Redis`) already constructed in this file.
- Produces: nothing consumed by later tasks — this is a self-contained behavioral fix.

This file currently only handles `SIGINT` (Ctrl-C). Railway sends `SIGTERM` on redeploy or manual stop, which today would kill the process without giving BullMQ's `worker.close()` a chance to let an in-flight job finish. There's no existing test file for this entrypoint (it's side-effecting top-level wiring code, same untested-entrypoint pattern as the rest of this repo's `*Main.ts`-style scripts) — verification here is `npm run typecheck` plus a manual signal-send smoke test, not a new unit test.

- [ ] **Step 1: Replace the single `SIGINT`-only handler with a shared shutdown function registered for both signals**

In `src/workerMain.ts`, replace:

```ts
process.on('SIGINT', async () => {
  await worker.close();
  await connection.quit();
  process.exit(0);
});
```

with:

```ts
async function shutdown(): Promise<void> {
  await worker.close();
  await connection.quit();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes with no errors.

- [ ] **Step 3: Manual smoke test**

With `TEST_REDIS_URL`/`TEST_DATABASE_URL`/R2 test credentials exported to match `REDIS_URL`/`DATABASE_URL`/`R2_*` (see `.env.example`), run:

```bash
npm run worker &
WORKER_PID=$!
sleep 2
kill -TERM $WORKER_PID
wait $WORKER_PID
```

Expected: the process logs its normal startup line, then exits cleanly (exit code 0, no unhandled-rejection stack trace) after receiving `SIGTERM` — confirming the new handler actually fires.

- [ ] **Step 4: Commit**

```bash
git add src/workerMain.ts
git commit -m "feat: handle SIGTERM for graceful worker shutdown"
```

---

### Task 2: Dockerfile and `.dockerignore`

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

**Interfaces:**
- Consumes: `package.json`/`package-lock.json` (existing `build` script: `tsc -p tsconfig.json`), `src/workerMain.ts` from Task 1 (compiled as part of `npm run build`).
- Produces: a runnable image whose `CMD` starts the worker — consumed by Task 3's `railway.json` (`dockerfilePath`) and Task 4's README instructions.

`websight-crawler` is installed as a **git dependency**
(`"websight-crawler": "github:amt1010/websight-crawler#v0.2.0"` in
`package.json`), so `git` must be present in the image at `npm ci` time in
both stages, even though Playwright's base image is not guaranteed to
include it.

- [ ] **Step 1: Write `Dockerfile`**

```dockerfile
FROM mcr.microsoft.com/playwright:v1.62.0-jammy AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.62.0-jammy
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
CMD ["node", "dist/workerMain.js"]
```

- [ ] **Step 2: Write `.dockerignore`**

```
node_modules
dist
.env
.env.example
test
docs
api
drizzle
.git
.github
*.md
```

- [ ] **Step 3: Build the image locally**

Run: `docker build -t websight-data-worker .`
Expected: build completes successfully (both stages), ending with the
image tagged `websight-data-worker`. This will pull the ~2GB Playwright
base image on first run — expect several minutes.

- [ ] **Step 4: Run the image against test infra**

With `TEST_REDIS_URL`/`TEST_DATABASE_URL`/real R2 test credentials at hand:

```bash
docker run --rm \
  -e REDIS_URL="$TEST_REDIS_URL" \
  -e DATABASE_URL="$TEST_DATABASE_URL" \
  -e R2_ACCOUNT_ID="$R2_ACCOUNT_ID" \
  -e R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
  -e R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  -e R2_BUCKET="$R2_BUCKET" \
  websight-data-worker &
```

Then from the host (outside the container):

```bash
DATABASE_URL="$TEST_DATABASE_URL" npm run cli -- enqueue example.com
DATABASE_URL="$TEST_DATABASE_URL" npm run cli -- status <crawlId-printed-above>
```

Expected: `status` eventually reports `"status":"done"` (poll a few times —
a real crawl takes some seconds), confirming the containerized worker
picked up the job over the same Redis queue and ran it to completion.
Stop the container afterward (`docker stop` or Ctrl-C on the `docker run`
job).

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "feat: add Docker image for the BullMQ worker"
```

---

### Task 3: Railway deploy config

**Files:**
- Create: `railway.json`

**Interfaces:**
- Consumes: `Dockerfile` from Task 2 (referenced by path).
- Produces: nothing consumed by later tasks in this plan — read directly by Railway at deploy time.

- [ ] **Step 1: Write `railway.json`**

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile"
  },
  "deploy": {
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

- [ ] **Step 2: Validate it's well-formed JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('railway.json','utf8')); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add railway.json
git commit -m "feat: add Railway deploy config for the worker"
```

---

### Task 4: README — document the worker deploy path

**Files:**
- Modify: `README.md:34-36` (the line between the `npm run worker` bullet in the Commands block and the `## Status` heading)

**Interfaces:**
- Consumes: the env var names already listed in `.env.example` (`REDIS_URL`, `DATABASE_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`).
- Produces: nothing — this is the terminal documentation task.

- [ ] **Step 1: Insert a new "Deploying the worker" section**

In `README.md`, between the end of the `## Commands` code block
(`npm run worker # start the long-running job worker`) and the
`## Status` heading, insert:

```markdown
## Deploying the worker

`npm run worker` (above) is the local-dev path. In production the worker
runs as an always-on Railway service built from the repo's `Dockerfile`
(pinned to `mcr.microsoft.com/playwright:v1.62.0-jammy` — keep this in
sync with the `playwright` version resolved in `package-lock.json`) and
`railway.json`.

One-time setup (Railway dashboard):

1. Create a new Railway project, connect the `websight-data` GitHub repo.
   Railway will detect `railway.json` and build with the Dockerfile.
2. Set these environment variables on the service: `REDIS_URL`,
   `DATABASE_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (same values as `.env.example`,
   pointed at the real Neon/Upstash/R2 instances, not the test ones).
3. Deploy. Railway auto-deploys on every push to `main` from then on,
   same as the Vercel projects in this repo's sibling repos.

The worker has no HTTP surface — it's a background service, not a web
service; don't attach a port or health-check URL to it in Railway.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document Railway deploy path for the worker"
```

---

## Self-Review Notes

- Spec coverage: Dockerfile/base-image pin (Task 2), `.dockerignore` (Task 2), `railway.json` (Task 3), `SIGTERM` handling (Task 1), README update (Task 4) — all components from the design spec have a task. Manual-verification testing bar from the spec's Testing section is Task 2 Steps 3–4. Out-of-scope items (creating the actual Railway project, migrating queue tech, autoscaling) are correctly not tasks here.
- No placeholders: every step has literal file contents or literal commands, no "add appropriate X" language.
- Type/name consistency: `shutdown`, `worker`, `connection` in Task 1 match the existing names already in `src/workerMain.ts` (see design spec's Components section); `dist/workerMain.js` in Task 2's Dockerfile matches `tsconfig.json`'s `outDir: "dist"` / `rootDir: "src"`.
