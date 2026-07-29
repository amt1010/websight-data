import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createDb, type Db } from '../../src/db/client.js';
import { getCrawlStatus, getCrawlPages, getCrawlClusters, getCrawlIntegrations } from '../../src/db/crawls.js';
import { createR2Storage, type Storage } from '../../src/storage/index.js';
import { createClerkVerifier, type ClerkVerifier } from '../../src/auth/clerk.js';
import { resolveIdentity } from '../../src/auth/identity.js';
import { BadRequestError, ForbiddenError, NotFoundError, errorToResponse } from '../../src/http/errors.js';
import { applyCors } from '../../src/http/cors.js';
import { requireEnv } from '../../src/env.js';

const SIGNED_URL_EXPIRY_SECONDS = 3600;

export async function getCrawlDetail(
  db: Db,
  storage: Storage,
  clerkVerifier: ClerkVerifier,
  authHeader: string | undefined,
  guestTokenInput: unknown,
  crawlId: number
) {
  const identity = await resolveIdentity(db, clerkVerifier, authHeader, guestTokenInput);
  const row = await getCrawlStatus(db, crawlId);
  if (!row) throw new NotFoundError(`No crawl with id ${crawlId}`);

  const owns =
    ('userId' in identity && row.userId === identity.userId) ||
    ('guestToken' in identity && row.guestToken === identity.guestToken);
  if (!owns) throw new ForbiddenError('You do not have access to this crawl');

  const base = {
    id: row.id,
    domain: row.domain,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    error: row.error,
  };
  if (row.status !== 'done') return base;

  const [pages, clusters, integrations] = await Promise.all([
    getCrawlPages(db, crawlId),
    getCrawlClusters(db, crawlId),
    getCrawlIntegrations(db, crawlId),
  ]);

  const pagesWithUrls = await Promise.all(
    pages.map(async (p) => {
      const { screenshotKey, htmlKey, ...rest } = p;
      return {
        ...rest,
        screenshotUrl: screenshotKey ? await storage.getSignedUrl(screenshotKey, SIGNED_URL_EXPIRY_SECONDS) : null,
        htmlUrl: htmlKey ? await storage.getSignedUrl(htmlKey, SIGNED_URL_EXPIRY_SECONDS) : null,
      };
    })
  );

  return { ...base, pages: pagesWithUrls, clusters, integrations };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const crawlId = Number(req.query.id);
    if (!Number.isFinite(crawlId)) throw new BadRequestError('invalid crawl id');

    const clerkVerifier = createClerkVerifier(requireEnv('CLERK_SECRET_KEY'));
    const storage = createR2Storage({
      accountId: requireEnv('R2_ACCOUNT_ID'),
      accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
      bucket: requireEnv('R2_BUCKET'),
    });
    const result = await getCrawlDetail(
      createDb(),
      storage,
      clerkVerifier,
      req.headers.authorization,
      req.query.guestToken,
      crawlId
    );
    res.status(200).json(result);
  } catch (err) {
    const { status, body } = errorToResponse(err);
    res.status(status).json(body);
  }
}
