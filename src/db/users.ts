import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { users, plans } from './schema.js';
import { NotFoundError } from '../http/errors.js';

export async function getDefaultFreePlan(db: Db) {
  const [row] = await db.select().from(plans).where(eq(plans.tier, 'free'));
  if (!row) throw new Error('No free-tier plan is seeded — run `npm run seed:plans` first');
  return row;
}

export async function getUserByClerkId(db: Db, clerkUserId: string) {
  const [row] = await db.select().from(users).where(eq(users.clerkUserId, clerkUserId));
  return row ?? null;
}

export async function findOrCreateUser(db: Db, clerkUserId: string, email: string) {
  const existing = await getUserByClerkId(db, clerkUserId);
  if (existing) return existing;
  const freePlan = await getDefaultFreePlan(db);
  const [row] = await db.insert(users).values({ clerkUserId, email, planId: freePlan.id }).returning();
  return row;
}

export async function getUserWithPlan(db: Db, userId: number) {
  const [row] = await db
    .select({ user: users, plan: plans })
    .from(users)
    .innerJoin(plans, eq(users.planId, plans.id))
    .where(eq(users.id, userId));
  return row ?? null;
}

export async function listUsersWithPlans(db: Db) {
  return db
    .select({ user: users, plan: plans })
    .from(users)
    .innerJoin(plans, eq(users.planId, plans.id));
}

export async function updateUserPlan(db: Db, userId: number, planId: number) {
  const [existingUser] = await db.select().from(users).where(eq(users.id, userId));
  if (!existingUser) throw new NotFoundError(`user ${userId} not found`);
  const [existingPlan] = await db.select().from(plans).where(eq(plans.id, planId));
  if (!existingPlan) throw new NotFoundError(`plan ${planId} not found`);
  const [row] = await db.update(users).set({ planId }).where(eq(users.id, userId)).returning();
  return row;
}

export async function promoteToAdmin(db: Db, email: string) {
  const [row] = await db.select().from(users).where(eq(users.email, email));
  if (!row) {
    throw new NotFoundError(`no user found with email ${email} — they must log in at least once before being promoted`);
  }
  const [updated] = await db.update(users).set({ role: 'admin' }).where(eq(users.id, row.id)).returning();
  return updated;
}
