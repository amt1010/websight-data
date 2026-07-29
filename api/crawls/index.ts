import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import { createDb, type Db } from '../../src/db/client.js';
import { createCrawlQueue, enqueueCrawl, type CrawlJobData } from '../../src/queue/producer.js';
import { listCrawlsForOwner } from '../../src/db/crawls.js';
import {
  countScansForGuestToken,
  countScansForUser,
  recordScanForGuestToken,
  recordScanForUser,
  GUEST_SCAN_LIMIT,
} from '../../src/db/scanUsage.js';
import { getUserWithPlan } from '../../src/db/users.js';
import { createClerkVerifier, type ClerkVerifier } from '../../src/auth/clerk.js';
import { resolveIdentity } from '../../src/auth/identity.js';
import { BadRequestError, QuotaExceededError, errorToResponse } from '../../src/http/errors.js';
import { requireEnv } from '../../src/env.js';

export function normalizeDomain(input: unknown): string {
  if (typeof input !== 'string') throw new BadRequestError('domain must be a string');
  const stripped = input
    .trim()
    .replace(/^https?:\/\//i, '')
    .split(/[/?#]/)[0]
    .toLowerCase();
  if (!stripped) throw new BadRequestError('domain must not be empty');
  return stripped;
}

export async function createCrawl(
  db: Db,
  queue: Queue<CrawlJobData>,
  clerkVerifier: ClerkVerifier,
  authHeader: string | undefined,
  body: { domain?: unknown; guestToken?: unknown }
): Promise<{ crawlId: number; remainingScans: number }> {
  const domain = normalizeDomain(body?.domain);
  const identity = await resolveIdentity(db, clerkVerifier, authHeader, body?.guestToken);

  if ('userId' in identity) {
    const withPlan = await getUserWithPlan(db, identity.userId);
    const used = await countScansForUser(db, identity.userId);
    if (used >= withPlan!.plan.scanLimit) {
      throw new QuotaExceededError({ plan: withPlan!.plan.name, scanLimit: withPlan!.plan.scanLimit, used });
    }
    await recordScanForUser(db, identity.userId);
    const crawlId = await enqueueCrawl(db, queue, domain, {}, { userId: identity.userId });
    return { crawlId, remainingScans: withPlan!.plan.scanLimit - used - 1 };
  }

  const used = await countScansForGuestToken(db, identity.guestToken);
  if (used >= GUEST_SCAN_LIMIT) {
    throw new QuotaExceededError({ plan: 'Guest', scanLimit: GUEST_SCAN_LIMIT, used });
  }
  await recordScanForGuestToken(db, identity.guestToken);
  const crawlId = await enqueueCrawl(db, queue, domain, {}, { guestToken: identity.guestToken });
  return { crawlId, remainingScans: GUEST_SCAN_LIMIT - used - 1 };
}

export async function listCrawls(
  db: Db,
  clerkVerifier: ClerkVerifier,
  authHeader: string | undefined,
  guestTokenInput: unknown
) {
  const identity = await resolveIdentity(db, clerkVerifier, authHeader, guestTokenInput);
  const rows = await listCrawlsForOwner(db, identity);
  return {
    crawls: rows.map((r) => ({ id: r.id, domain: r.domain, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt })),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const clerkVerifier = createClerkVerifier(requireEnv('CLERK_SECRET_KEY'));
    const db = createDb();

    if (req.method === 'POST') {
      const connection = new Redis(requireEnv('REDIS_URL'), { maxRetriesPerRequest: null });
      const queue = createCrawlQueue(connection);
      try {
        const result = await createCrawl(db, queue, clerkVerifier, req.headers.authorization, req.body ?? {});
        res.status(201).json(result);
      } finally {
        await queue.close();
        await connection.quit();
      }
      return;
    }

    if (req.method === 'GET') {
      const result = await listCrawls(db, clerkVerifier, req.headers.authorization, req.query.guestToken);
      res.status(200).json(result);
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const { status, body } = errorToResponse(err);
    res.status(status).json(body);
  }
}
