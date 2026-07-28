import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../helpers/testDb.js';
import { listPlans, getPlanById, createPlan, updatePlan, deletePlan } from '../../src/db/plans.js';
import { users } from '../../src/db/schema.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../src/http/errors.js';

let db: TestDb;

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await resetDb(db);
});

describe('plans data access', () => {
  it('creates and lists a plan', async () => {
    const plan = await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    expect(await listPlans(db)).toEqual([plan]);
    expect(await getPlanById(db, plan.id)).toEqual(plan);
  });

  it('rejects a second free-tier plan', async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    await expect(createPlan(db, { name: 'Free 2', tier: 'free', scanLimit: 5 })).rejects.toBeInstanceOf(ConflictError);
  });

  it('rejects an invalid plan payload', async () => {
    await expect(createPlan(db, { name: '', tier: 'free', scanLimit: 3 })).rejects.toBeInstanceOf(BadRequestError);
    await expect(createPlan(db, { name: 'X', tier: 'paid', scanLimit: 0 })).rejects.toBeInstanceOf(BadRequestError);
    // @ts-expect-error deliberately invalid tier for the runtime check
    await expect(createPlan(db, { name: 'X', tier: 'gold', scanLimit: 3 })).rejects.toBeInstanceOf(BadRequestError);
  });

  it('updates a plan', async () => {
    const plan = await createPlan(db, { name: 'Pro', tier: 'paid', scanLimit: 10 });
    const updated = await updatePlan(db, plan.id, { name: 'Pro', tier: 'paid', scanLimit: 20 });
    expect(updated.scanLimit).toBe(20);
  });

  it('throws NotFoundError updating an unknown plan', async () => {
    await expect(updatePlan(db, 999999, { name: 'X', tier: 'paid', scanLimit: 1 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deletes an unused plan', async () => {
    const plan = await createPlan(db, { name: 'Pro', tier: 'paid', scanLimit: 10 });
    await deletePlan(db, plan.id);
    expect(await getPlanById(db, plan.id)).toBeNull();
  });

  it('refuses to delete a plan with users assigned', async () => {
    const plan = await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    await db.insert(users).values({ clerkUserId: 'clerk_1', email: 'a@example.com', planId: plan.id });
    await expect(deletePlan(db, plan.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it('throws NotFoundError deleting an unknown plan', async () => {
    await expect(deletePlan(db, 999999)).rejects.toBeInstanceOf(NotFoundError);
  });
});
