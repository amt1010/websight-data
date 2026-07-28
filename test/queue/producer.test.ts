import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestConnection } from '../helpers/testRedis.js';
import { createTestDb, resetDb, type TestDb } from '../helpers/testDb.js';
import { createCrawlQueue, enqueueCrawl } from '../../src/queue/producer.js';
import { getCrawlStatus } from '../../src/db/crawls.js';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import type { CrawlJobData } from '../../src/queue/producer.js';

let connection: Redis;
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

    const job = await queue.getJob(`crawl-${crawlId}`);
    expect(job?.data).toEqual({ crawlId, domain: 'example.com', options: {} });
  });
});
