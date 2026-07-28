import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetDb, type TestDb } from '../helpers/testDb.js';
import { createPlan } from '../../src/db/plans.js';
import {
  getDefaultFreePlan,
  findOrCreateUser,
  getUserByClerkId,
  getUserWithPlan,
  listUsersWithPlans,
  updateUserPlan,
  promoteToAdmin,
} from '../../src/db/users.js';
import { NotFoundError } from '../../src/http/errors.js';

let db: TestDb;

beforeEach(async () => {
  db = createTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await resetDb(db);
});

describe('users data access', () => {
  it('finds the seeded free plan', async () => {
    const free = await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    expect(await getDefaultFreePlan(db)).toEqual(free);
  });

  it('errors clearly when no free plan is seeded', async () => {
    await expect(getDefaultFreePlan(db)).rejects.toThrow(/seed:plans/);
  });

  it('creates a user on first login and reuses it on the next', async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    const first = await findOrCreateUser(db, 'clerk_1', 'a@example.com');
    const second = await findOrCreateUser(db, 'clerk_1', 'a@example.com');
    expect(second.id).toBe(first.id);
    expect(await getUserByClerkId(db, 'clerk_1')).toEqual(first);
  });

  it('joins a user with their plan', async () => {
    const free = await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    const user = await findOrCreateUser(db, 'clerk_1', 'a@example.com');
    const withPlan = await getUserWithPlan(db, user.id);
    expect(withPlan?.plan).toEqual(free);
  });

  it('lists all users with their plans', async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    await findOrCreateUser(db, 'clerk_1', 'a@example.com');
    await findOrCreateUser(db, 'clerk_2', 'b@example.com');
    expect(await listUsersWithPlans(db)).toHaveLength(2);
  });

  it('reassigns a user to a different plan', async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    const paid = await createPlan(db, { name: 'Pro', tier: 'paid', scanLimit: 50 });
    const user = await findOrCreateUser(db, 'clerk_1', 'a@example.com');
    const updated = await updateUserPlan(db, user.id, paid.id);
    expect(updated.planId).toBe(paid.id);
  });

  it('throws NotFoundError reassigning an unknown user or plan', async () => {
    const free = await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    const user = await findOrCreateUser(db, 'clerk_1', 'a@example.com');
    await expect(updateUserPlan(db, 999999, free.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateUserPlan(db, user.id, 999999)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('promotes an existing user to admin by email', async () => {
    await createPlan(db, { name: 'Free', tier: 'free', scanLimit: 3 });
    await findOrCreateUser(db, 'clerk_1', 'a@example.com');
    const promoted = await promoteToAdmin(db, 'a@example.com');
    expect(promoted.role).toBe('admin');
  });

  it('throws NotFoundError promoting an email with no user yet', async () => {
    await expect(promoteToAdmin(db, 'nobody@example.com')).rejects.toBeInstanceOf(NotFoundError);
  });
});
