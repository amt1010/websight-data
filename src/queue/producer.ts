import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { CrawlOptions } from 'websight-crawler';
import type { Db } from '../db/client.js';
import { insertQueuedCrawl } from '../db/crawls.js';

export interface CrawlJobData {
  crawlId: number;
  domain: string;
  options: Partial<CrawlOptions>;
}

export function createCrawlQueue(connection: Redis): Queue<CrawlJobData> {
  return new Queue<CrawlJobData>('crawl', { connection });
}

export async function enqueueCrawl(
  db: Db,
  queue: Queue<CrawlJobData>,
  domain: string,
  options: Partial<CrawlOptions> = {}
): Promise<number> {
  const crawlId = await insertQueuedCrawl(db, domain);
  await queue.add('crawl', { crawlId, domain, options }, { jobId: `crawl-${crawlId}` });
  return crawlId;
}
