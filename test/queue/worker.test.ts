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
