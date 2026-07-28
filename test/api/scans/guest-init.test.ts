import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../../helpers/testDb.js';
import { guestInit } from '../../../api/scans/guest-init.js';
import { recordScanForGuestToken } from '../../../src/db/scanUsage.js';
import { BadRequestError } from '../../../src/http/errors.js';

let db: TestDb;

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await resetDb(db);
});

describe('guestInit', () => {
  it('returns a fresh token with 1 remaining scan', async () => {
    expect(await guestInit(db, 'guest-1')).toEqual({ guestToken: 'guest-1', remainingScans: 1 });
  });

  it('returns 0 remaining after a scan is recorded', async () => {
    await recordScanForGuestToken(db, 'guest-1');
    expect(await guestInit(db, 'guest-1')).toEqual({ guestToken: 'guest-1', remainingScans: 0 });
  });

  it('rejects a missing guestToken', async () => {
    await expect(guestInit(db, undefined)).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects an empty guestToken', async () => {
    await expect(guestInit(db, '   ')).rejects.toBeInstanceOf(BadRequestError);
  });
});
