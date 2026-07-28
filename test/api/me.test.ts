import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../helpers/testDb.js';
import { getMe } from '../../api/me.js';
import { createPlan } from '../../src/db/plans.js';
import type { ClerkVerifier } from '../../src/auth/clerk.js';

let db: TestDb;

function fakeVerifier(clerkUserId: string, email: string): ClerkVerifier {
  return { verifyRequest: async () => ({ clerkUserId, email }) };
}

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await resetDb(db);
});

describe('getMe', () => {
  it("returns the caller's email, role, plan, and remaining scans", async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    const result = await getMe(db, fakeVerifier('clerk_1', 'a@example.com'), 'Bearer whatever');
    expect(result).toEqual({
      email: 'a@example.com',
      role: 'user',
      plan: { name: 'Free', tier: 'free', scanLimit: 3 },
      remainingScans: 3,
    });
  });

  it('reflects consumed scans in remainingScans', async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    const verifier = fakeVerifier('clerk_1', 'a@example.com');
    await getMe(db, verifier, 'Bearer whatever'); // creates the user
    const { recordScanForUser } = await import('../../src/db/scanUsage.js');
    const { findOrCreateUser } = await import('../../src/db/users.js');
    const user = await findOrCreateUser(db, 'clerk_1', 'a@example.com');
    await recordScanForUser(db, user.id);
    const result = await getMe(db, verifier, 'Bearer whatever');
    expect(result.remainingScans).toBe(2);
  });
});
