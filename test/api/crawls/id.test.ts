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
