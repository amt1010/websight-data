import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../../helpers/testDb.js';
import { createCrawl, listCrawls, normalizeDomain } from '../../../api/crawls/index.js';
import { createPlan } from '../../../src/db/plans.js';
import type { ClerkVerifier } from '../../../src/auth/clerk.js';
import { QuotaExceededError, BadRequestError } from '../../../src/http/errors.js';
import type { CrawlJobData } from '../../../src/queue/producer.js';
import type { Queue } from 'bullmq';

let db: TestDb;

function fakeVerifier(clerkUserId: string, email: string): ClerkVerifier {
  return { verifyRequest: async () => ({ clerkUserId, email }) };
}

function fakeQueue(): Queue<CrawlJobData> {
  return { add: vi.fn().mockResolvedValue(undefined) } as unknown as Queue<CrawlJobData>;
}

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await resetDb(db);
});

describe('normalizeDomain', () => {
  it('strips protocol, path, and lowercases', () => {
    expect(normalizeDomain('https://Example.com/foo?x=1')).toBe('example.com');
  });

  it('rejects an empty domain', () => {
    expect(() => normalizeDomain('   ')).toThrow(BadRequestError);
  });
});

describe('createCrawl — guest', () => {
  it('enqueues a crawl and returns remainingScans', async () => {
    const queue = fakeQueue();
    const result = await createCrawl(db, queue, fakeVerifier('unused', 'unused'), undefined, {
      domain: 'example.com',
      guestToken: 'guest-1',
    });
    expect(result.remainingScans).toBe(0);
    expect(queue.add).toHaveBeenCalledOnce();
  });

  it('rejects a second guest crawl on the same token', async () => {
    const queue = fakeQueue();
    await createCrawl(db, queue, fakeVerifier('unused', 'unused'), undefined, { domain: 'example.com', guestToken: 'guest-1' });
    await expect(
      createCrawl(db, queue, fakeVerifier('unused', 'unused'), undefined, { domain: 'example.com', guestToken: 'guest-1' })
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });
});

describe('createCrawl — logged in', () => {
  it('enqueues a crawl for a plan with remaining quota', async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 2 });
    const queue = fakeQueue();
    const result = await createCrawl(db, queue, fakeVerifier('clerk_1', 'a@example.com'), 'Bearer whatever', {
      domain: 'example.com',
    });
    expect(result.remainingScans).toBe(1);
  });
});

describe('listCrawls', () => {
  it("returns only the caller's own crawls", async () => {
    const queue = fakeQueue();
    await createCrawl(db, queue, fakeVerifier('unused', 'unused'), undefined, { domain: 'mine.com', guestToken: 'guest-1' });
    await createCrawl(db, queue, fakeVerifier('unused', 'unused'), undefined, { domain: 'theirs.com', guestToken: 'guest-2' });

    const result = await listCrawls(db, fakeVerifier('unused', 'unused'), undefined, 'guest-1');
    expect(result.crawls).toHaveLength(1);
    expect(result.crawls[0]).toMatchObject({ domain: 'mine.com' });
  });
});
