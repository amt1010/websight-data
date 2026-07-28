import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../../helpers/testDb.js';
import { handleUsersRequest } from '../../../api/admin/users.js';
import { createPlan } from '../../../src/db/plans.js';
import { findOrCreateUser, promoteToAdmin } from '../../../src/db/users.js';
import type { ClerkVerifier } from '../../../src/auth/clerk.js';
import { ForbiddenError, BadRequestError } from '../../../src/http/errors.js';

let db: TestDb;

function fakeVerifier(clerkUserId: string, email: string): ClerkVerifier {
  return { verifyRequest: async () => ({ clerkUserId, email }) };
}

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
  await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
});

afterAll(async () => {
  await resetDb(db);
});

describe('handleUsersRequest', () => {
  it('rejects a non-admin user', async () => {
    await findOrCreateUser(db, 'clerk_user', 'user@example.com');
    await expect(
      handleUsersRequest(db, fakeVerifier('clerk_user', 'user@example.com'), 'GET', 'Bearer x', undefined, {})
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lists users and reassigns a plan for an admin', async () => {
    await findOrCreateUser(db, 'clerk_admin', 'admin@example.com');
    await promoteToAdmin(db, 'admin@example.com');
    const target = await findOrCreateUser(db, 'clerk_target', 'target@example.com');
    const paid = await createPlan(db, { name: 'Pro', tier: 'paid', scanLimit: 50 });
    const verifier = fakeVerifier('clerk_admin', 'admin@example.com');

    const listed = (await handleUsersRequest(db, verifier, 'GET', 'Bearer x', undefined, {})) as unknown[];
    expect(listed).toHaveLength(2);

    const updated = (await handleUsersRequest(
      db,
      verifier,
      'PATCH',
      'Bearer x',
      { planId: paid.id },
      { id: String(target.id) }
    )) as { planId: number };
    expect(updated.planId).toBe(paid.id);
  });

  it('rejects a PATCH with no planId in the body', async () => {
    await findOrCreateUser(db, 'clerk_admin', 'admin@example.com');
    await promoteToAdmin(db, 'admin@example.com');
    const target = await findOrCreateUser(db, 'clerk_target', 'target@example.com');
    const verifier = fakeVerifier('clerk_admin', 'admin@example.com');
    await expect(
      handleUsersRequest(db, verifier, 'PATCH', 'Bearer x', {}, { id: String(target.id) })
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});
