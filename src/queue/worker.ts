import { Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { crawl } from 'websight-crawler';
import type { Db } from '../db/client.js';
import { markCrawlRunning, markCrawlFailed, persistCrawlResult } from '../db/crawls.js';
import type { Storage } from '../storage/index.js';
import type { CrawlJobData } from './producer.js';

function pageKey(domain: string, crawlId: number, url: string, ext: 'png' | 'html'): string {
  const hash = Buffer.from(url).toString('base64url');
  return `${domain}/${crawlId}/${hash}.${ext}`;
}

export async function handleCrawlJob(
  db: Db,
  storage: Storage,
  data: CrawlJobData,
  runCrawl: typeof crawl = crawl
): Promise<void> {
  await markCrawlRunning(db, data.crawlId);

  try {
    const result = await runCrawl(data.domain, data.options);
    const storageKeys = new Map<string, { screenshotKey: string | null; htmlKey: string | null }>();

    for (const page of result.pages) {
      let screenshotKey: string | null = null;
      let htmlKey: string | null = null;

      if (page.status === 'ok') {
        try {
          screenshotKey = await storage.put(pageKey(result.domain, data.crawlId, page.url, 'png'), page.screenshot, 'image/png');
          htmlKey = await storage.put(
            pageKey(result.domain, data.crawlId, page.url, 'html'),
            Buffer.from(page.html, 'utf-8'),
            'text/html'
          );
        } catch (err) {
          console.error(`Failed to upload assets for ${page.url}:`, err);
        }
      }

      storageKeys.set(page.url, { screenshotKey, htmlKey });
    }

    await persistCrawlResult(db, data.crawlId, result, storageKeys);
  } catch (err) {
    await markCrawlFailed(db, data.crawlId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export function createCrawlWorker(connection: IORedis, db: Db, storage: Storage): Worker<CrawlJobData> {
  return new Worker<CrawlJobData>(
    'crawl',
    async (job) => {
      await handleCrawlJob(db, storage, job.data);
    },
    { connection }
  );
}
