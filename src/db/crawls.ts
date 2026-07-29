import { eq, and, isNull, desc } from 'drizzle-orm';
import type { CrawlResult } from 'websight-crawler';
import type { Db } from './client.js';
import { crawls, pages, clusters, integrations } from './schema.js';

export async function insertQueuedCrawl(
  db: Db,
  domain: string,
  owner: { userId?: number; guestToken?: string } = {}
): Promise<number> {
  const [row] = await db
    .insert(crawls)
    .values({ domain, status: 'queued', userId: owner.userId ?? null, guestToken: owner.guestToken ?? null })
    .returning({ id: crawls.id });
  return row.id;
}

export async function markCrawlRunning(db: Db, crawlId: number): Promise<void> {
  await db.update(crawls).set({ status: 'running', startedAt: new Date() }).where(eq(crawls.id, crawlId));
}

export async function markCrawlFailed(db: Db, crawlId: number, error: string): Promise<void> {
  await db.update(crawls).set({ status: 'failed', error, finishedAt: new Date() }).where(eq(crawls.id, crawlId));
}

export async function getCrawlStatus(db: Db, crawlId: number) {
  const [row] = await db.select().from(crawls).where(eq(crawls.id, crawlId));
  return row ?? null;
}

export async function getCrawlPages(db: Db, crawlId: number) {
  return db.select().from(pages).where(eq(pages.crawlId, crawlId));
}

export async function getCrawlClusters(db: Db, crawlId: number) {
  return db.select().from(clusters).where(eq(clusters.crawlId, crawlId));
}

export async function getCrawlIntegrations(db: Db, crawlId: number) {
  return db.select().from(integrations).where(eq(integrations.crawlId, crawlId));
}

export async function listCrawlsForOwner(db: Db, owner: { userId?: number; guestToken?: string }) {
  const condition =
    owner.userId !== undefined
      ? and(eq(crawls.userId, owner.userId), isNull(crawls.guestToken))
      : and(eq(crawls.guestToken, owner.guestToken!), isNull(crawls.userId));
  return db.select().from(crawls).where(condition).orderBy(desc(crawls.id));
}

export async function persistCrawlResult(
  db: Db,
  crawlId: number,
  result: CrawlResult,
  storageKeys: Map<string, { screenshotKey: string | null; htmlKey: string | null }>
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(crawls).set({ status: 'done', finishedAt: new Date() }).where(eq(crawls.id, crawlId));

    if (result.pages.length > 0) {
      await tx.insert(pages).values(
        result.pages.map((p) => ({
          crawlId,
          url: p.url,
          path: p.path,
          depth: p.depth,
          status: p.status,
          error: p.error ?? null,
          links: p.links,
          requestUrls: p.requestUrls,
          scriptSrcs: p.scriptSrcs,
          domFingerprint: p.domFingerprint,
          screenshotKey: storageKeys.get(p.url)?.screenshotKey ?? null,
          htmlKey: storageKeys.get(p.url)?.htmlKey ?? null,
        }))
      );
    }

    if (result.clusters.length > 0) {
      await tx.insert(clusters).values(
        result.clusters.map((c) => ({
          crawlId,
          urlPattern: c.urlPattern,
          pageUrls: c.pageUrls,
          representativeFingerprint: c.representativeFingerprint,
        }))
      );
    }

    if (result.integrations.length > 0) {
      await tx.insert(integrations).values(
        result.integrations.map((i) => ({
          crawlId,
          name: i.name,
          category: i.category,
          matchedUrls: i.matchedUrls,
        }))
      );
    }
  });
}
