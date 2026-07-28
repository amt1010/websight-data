import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../../helpers/testDb.js';
import { handlePlansRequest } from '../../../api/admin/plans.js';
import { createPlan } from '../../../src/db/plans.js';
import { findOrCreateUser, promoteToAdmin } from '../../../src/db/users.js';
import type { ClerkVerifier } from '../../../src/auth/clerk.js';
import { ForbiddenError, NotFoundError } from '../../../src/http/errors.js';

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

describe('handlePlansRequest', () => {
  it('rejects a non-admin user', async () => {
    await findOrCreateUser(db, 'clerk_user', 'user@example.com');
    await expect(
      handlePlansRequest(db, fakeVerifier('clerk_user', 'user@example.com'), 'GET', 'Bearer x', undefined, {})
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lists, creates, updates, and deletes a plan for an admin', async () => {
    await findOrCreateUser(db, 'clerk_admin', 'admin@example.com');
    await promoteToAdmin(db, 'admin@example.com');
    const verifier = fakeVerifier('clerk_admin', 'admin@example.com');

    const listed = (await handlePlansRequest(db, verifier, 'GET', 'Bearer x', undefined, {})) as unknown[];
    expect(listed).toHaveLength(1);

    const created = (await handlePlansRequest(
      db,
      verifier,
      'POST',
      'Bearer x',
      { name: 'Pro', tier: 'paid', scanLimit: 50 },
      {}
    )) as { id: number };

    const updated = (await handlePlansRequest(
      db,
      verifier,
      'PATCH',
      'Bearer x',
      { name: 'Pro', tier: 'paid', scanLimit: 100 },
      { id: String(created.id) }
    )) as { scanLimit: number };
    expect(updated.scanLimit).toBe(100);

    const deleted = await handlePlansRequest(db, verifier, 'DELETE', 'Bearer x', undefined, { id: String(created.id) });
    expect(deleted).toEqual({ deleted: true });
  });

  it('propagates NotFoundError for an unknown plan id', async () => {
    await findOrCreateUser(db, 'clerk_admin', 'admin@example.com');
    await promoteToAdmin(db, 'admin@example.com');
    const verifier = fakeVerifier('clerk_admin', 'admin@example.com');
    await expect(
      handlePlansRequest(db, verifier, 'PATCH', 'Bearer x', { name: 'X', tier: 'paid', scanLimit: 1 }, { id: '999999' })
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
