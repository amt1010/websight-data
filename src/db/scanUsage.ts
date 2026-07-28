import { eq, count } from 'drizzle-orm';
import type { Db } from './client.js';
import { scanUsage } from './schema.js';

export const GUEST_SCAN_LIMIT = 1;

export async function countScansForUser(db: Db, userId: number): Promise<number> {
  const [{ value }] = await db.select({ value: count() }).from(scanUsage).where(eq(scanUsage.userId, userId));
  return value;
}

export async function countScansForGuestToken(db: Db, guestToken: string): Promise<number> {
  const [{ value }] = await db
    .select({ value: count() })
    .from(scanUsage)
    .where(eq(scanUsage.guestToken, guestToken));
  return value;
}

export async function recordScanForUser(db: Db, userId: number): Promise<void> {
  await db.insert(scanUsage).values({ userId, guestToken: null });
}

export async function recordScanForGuestToken(db: Db, guestToken: string): Promise<void> {
  await db.insert(scanUsage).values({ guestToken, userId: null });
}
