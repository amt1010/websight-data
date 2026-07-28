import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../helpers/testDb.js';
import { createPlan } from '../../src/db/plans.js';
import { findOrCreateUser } from '../../src/db/users.js';
import {
  GUEST_SCAN_LIMIT,
  countScansForUser,
  countScansForGuestToken,
  recordScanForUser,
  recordScanForGuestToken,
} from '../../src/db/scanUsage.js';

let db: TestDb;

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await resetDb(db);
});

describe('scan usage tracking', () => {
  it('starts at zero for a fresh guest token', async () => {
    expect(await countScansForGuestToken(db, 'guest-1')).toBe(0);
  });

  it('increments guest usage on record', async () => {
    await recordScanForGuestToken(db, 'guest-1');
    expect(await countScansForGuestToken(db, 'guest-1')).toBe(1);
    expect(GUEST_SCAN_LIMIT).toBe(1);
  });

  it('keeps separate counts per guest token', async () => {
    await recordScanForGuestToken(db, 'guest-1');
    expect(await countScansForGuestToken(db, 'guest-2')).toBe(0);
  });

  it("increments a logged-in user's usage on record", async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    const user = await findOrCreateUser(db, 'clerk_1', 'a@example.com');
    await recordScanForUser(db, user.id);
    await recordScanForUser(db, user.id);
    expect(await countScansForUser(db, user.id)).toBe(2);
  });
});
