import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from './helpers/testDb.js';
import { seedFreePlan } from '../src/seedPlans.js';
import { listPlans } from '../src/db/plans.js';

let db: TestDb;

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await resetDb(db);
});

describe('seedFreePlan', () => {
  it('creates the free plan once', async () => {
    const plan = await seedFreePlan(db, 3);
    expect(plan).toMatchObject({ name: 'Free', tier: 'free', scanLimit: 3 });
    expect(await listPlans(db)).toHaveLength(1);
  });

  it('is idempotent — running it again returns the existing plan without duplicating', async () => {
    const first = await seedFreePlan(db, 3);
    const second = await seedFreePlan(db, 3);
    expect(second.id).toBe(first.id);
    expect(await listPlans(db)).toHaveLength(1);
  });
});
