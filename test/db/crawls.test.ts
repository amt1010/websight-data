import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../helpers/testDb.js';
import {
  insertQueuedCrawl,
  markCrawlRunning,
  markCrawlFailed,
  getCrawlStatus,
  persistCrawlResult,
  getCrawlPages,
  getCrawlClusters,
  getCrawlIntegrations,
  listCrawlsForOwner,
} from '../../src/db/crawls.js';
import { createPlan } from '../../src/db/plans.js';
import { findOrCreateUser } from '../../src/db/users.js';
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

  it('records an owner (userId or guestToken) when provided', async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    const user = await findOrCreateUser(db, 'clerk_1', 'a@example.com');

    const withUser = await insertQueuedCrawl(db, 'example.com', { userId: user.id });
    const userRow = await getCrawlStatus(db, withUser);
    expect(userRow).toMatchObject({ userId: user.id, guestToken: null });

    const withGuest = await insertQueuedCrawl(db, 'example.com', { guestToken: 'guest-xyz' });
    const guestRow = await getCrawlStatus(db, withGuest);
    expect(guestRow).toMatchObject({ userId: null, guestToken: 'guest-xyz' });
  });

  it('defaults to no owner when none is provided', async () => {
    const crawlId = await insertQueuedCrawl(db, 'example.com');
    const row = await getCrawlStatus(db, crawlId);
    expect(row).toMatchObject({ userId: null, guestToken: null });
  });
});

describe('owner-scoped and result reads', () => {
  it("lists only a user's own crawls, newest first", async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    const owner = await findOrCreateUser(db, 'clerk_owner', 'owner@example.com');
    const other = await findOrCreateUser(db, 'clerk_other', 'other@example.com');

    const a = await insertQueuedCrawl(db, 'a.com', { userId: owner.id });
    const b = await insertQueuedCrawl(db, 'b.com', { userId: owner.id });
    await insertQueuedCrawl(db, 'other.com', { userId: other.id });

    const rows = await listCrawlsForOwner(db, { userId: owner.id });
    expect(rows.map((r) => r.id)).toEqual([b, a]);
  });

  it("lists only a guest token's own crawls", async () => {
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
