import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../../helpers/testDb.js';
import { consumeScan } from '../../../api/scans/consume.js';
import { createPlan } from '../../../src/db/plans.js';
import { findOrCreateUser } from '../../../src/db/users.js';
import type { ClerkVerifier } from '../../../src/auth/clerk.js';
import { QuotaExceededError } from '../../../src/http/errors.js';

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

describe('consumeScan — guest', () => {
  it('allows the first guest scan', async () => {
    const result = await consumeScan(db, fakeVerifier('unused', 'unused'), undefined, 'guest-1');
    expect(result).toEqual({ remainingScans: 0 });
  });

  it('rejects a second guest scan on the same token', async () => {
    await consumeScan(db, fakeVerifier('unused', 'unused'), undefined, 'guest-1');
    await expect(consumeScan(db, fakeVerifier('unused', 'unused'), undefined, 'guest-1')).rejects.toBeInstanceOf(
      QuotaExceededError
    );
  });
});

describe('consumeScan — logged in', () => {
  it('allows scans up to the plan limit, then rejects', async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 2 });
    const verifier = fakeVerifier('clerk_1', 'a@example.com');

    const first = await consumeScan(db, verifier, 'Bearer whatever', undefined);
    expect(first).toEqual({ remainingScans: 1 });

    const second = await consumeScan(db, verifier, 'Bearer whatever', undefined);
    expect(second).toEqual({ remainingScans: 0 });

    await expect(consumeScan(db, verifier, 'Bearer whatever', undefined)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('finds-or-creates the user on first call', async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 5 });
    const verifier = fakeVerifier('clerk_2', 'b@example.com');
    await consumeScan(db, verifier, 'Bearer whatever', undefined);
    const found = await findOrCreateUser(db, 'clerk_2', 'b@example.com');
    expect(found.email).toBe('b@example.com');
  });
});
