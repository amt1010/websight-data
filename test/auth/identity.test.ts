import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../helpers/testDb.js';
import { resolveIdentity } from '../../src/auth/identity.js';
import { createPlan } from '../../src/db/plans.js';
import type { ClerkVerifier } from '../../src/auth/clerk.js';

let db: TestDb;

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await resetDb(db);
});

function fakeVerifier(clerkUserId: string, email: string): ClerkVerifier {
  return { verifyRequest: async () => ({ clerkUserId, email }) };
}

describe('resolveIdentity', () => {
  it('resolves a logged-in user from a Bearer header', async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    const identity = await resolveIdentity(db, fakeVerifier('clerk_1', 'a@example.com'), 'Bearer whatever', undefined);
    expect(identity).toHaveProperty('userId');
  });

  it('resolves a guest from a guestToken when there is no auth header', async () => {
    const identity = await resolveIdentity(db, fakeVerifier('unused', 'unused'), undefined, 'guest-1');
    expect(identity).toEqual({ guestToken: 'guest-1' });
  });
});
