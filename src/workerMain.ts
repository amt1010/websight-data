import { Redis } from 'ioredis';
import { createDb } from './db/client.js';
import { createCrawlWorker } from './queue/worker.js';
import { createR2Storage } from './storage/index.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

const db = createDb();
const storage = createR2Storage({
  accountId: requireEnv('R2_ACCOUNT_ID'),
  accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
  secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
  bucket: requireEnv('R2_BUCKET'),
});
const connection = new Redis(requireEnv('REDIS_URL'), { maxRetriesPerRequest: null });

const worker = createCrawlWorker(connection, db, storage);
console.log('Crawl worker started, listening for jobs on the "crawl" queue...');

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed:`, err);
});

process.on('SIGINT', async () => {
  await worker.close();
  await connection.quit();
  process.exit(0);
});
