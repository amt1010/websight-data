import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../helpers/testDb.js';
import { plans, users, scanUsage } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';

let db: TestDb;

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await resetDb(db);
});

describe('plans/users/scan_usage schema', () => {
  it('round-trips a plan row', async () => {
    const [plan] = await db.insert(plans).values({ name: 'Free', tier: 'free', scanLimit: 3 }).returning();
    const [row] = await db.select().from(plans).where(eq(plans.id, plan.id));
    expect(row).toMatchObject({ name: 'Free', tier: 'free', scanLimit: 3 });
  });

  it('round-trips a user row referencing a plan', async () => {
    const [plan] = await db.insert(plans).values({ name: 'Free', tier: 'free', scanLimit: 3 }).returning();
    const [user] = await db
      .insert(users)
      .values({ clerkUserId: 'clerk_1', email: 'a@example.com', planId: plan.id })
      .returning();
    expect(user).toMatchObject({ clerkUserId: 'clerk_1', email: 'a@example.com', role: 'user', planId: plan.id });
  });

  it('round-trips a scan_usage row for a guest token', async () => {
    const [row] = await db.insert(scanUsage).values({ guestToken: 'guest-abc' }).returning();
    expect(row).toMatchObject({ guestToken: 'guest-abc', userId: null });
  });
});
