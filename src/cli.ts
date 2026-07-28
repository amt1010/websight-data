#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { Redis } from 'ioredis';
import { createDb } from './db/client.js';
import { getCrawlStatus } from './db/crawls.js';
import { createCrawlQueue, enqueueCrawl } from './queue/producer.js';

export type CliCommand = { command: 'enqueue'; domain: string } | { command: 'status'; crawlId: number };

export function parseCliCommand(argv: string[]): CliCommand {
  const [command, arg] = argv;

  if (command === 'enqueue') {
    if (!arg) throw new Error('Usage: websight-data enqueue <domain>');
    return { command: 'enqueue', domain: arg };
  }

  if (command === 'status') {
    const crawlId = Number(arg);
    if (!Number.isFinite(crawlId)) throw new Error('Usage: websight-data status <crawlId>');
    return { command: 'status', crawlId };
  }

  throw new Error('Usage: websight-data <enqueue <domain> | status <crawlId>>');
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

async function main() {
  const parsed = parseCliCommand(process.argv.slice(2));
  const db = createDb();

  if (parsed.command === 'enqueue') {
    const connection = new Redis(requireEnv('REDIS_URL'), { maxRetriesPerRequest: null });
    const queue = createCrawlQueue(connection);
    const crawlId = await enqueueCrawl(db, queue, parsed.domain);
    console.log(`Enqueued crawl ${crawlId} for ${parsed.domain}`);
    await queue.close();
    await connection.quit();
    return;
  }

  const status = await getCrawlStatus(db, parsed.crawlId);
  console.log(JSON.stringify(status, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
