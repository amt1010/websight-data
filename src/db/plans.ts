import { eq, count } from 'drizzle-orm';
import type { Db } from './client.js';
import { plans, users } from './schema.js';
import { BadRequestError, ConflictError, NotFoundError } from '../http/errors.js';

export type PlanTier = 'free' | 'paid';

export interface PlanInput {
  name: string;
  tier: PlanTier;
  scanLimit: number;
}

function validatePlanInput(input: PlanInput): void {
  if (!input.name || !input.name.trim()) throw new BadRequestError('name is required');
  if (input.tier !== 'free' && input.tier !== 'paid') throw new BadRequestError('tier must be "free" or "paid"');
  if (!Number.isInteger(input.scanLimit) || input.scanLimit <= 0) {
    throw new BadRequestError('scanLimit must be a positive integer');
  }
}

async function assertNoOtherFreePlan(db: Db, excludePlanId?: number): Promise<void> {
  const existingFree = await db.select().from(plans).where(eq(plans.tier, 'free'));
  const conflicting = existingFree.filter((p) => p.id !== excludePlanId);
  if (conflicting.length > 0) throw new ConflictError('a free-tier plan already exists');
}

export async function listPlans(db: Db) {
  return db.select().from(plans);
}

export async function getPlanById(db: Db, planId: number) {
  const [row] = await db.select().from(plans).where(eq(plans.id, planId));
  return row ?? null;
}

export async function createPlan(db: Db, input: PlanInput) {
  validatePlanInput(input);
  if (input.tier === 'free') await assertNoOtherFreePlan(db);
  const [row] = await db.insert(plans).values(input).returning();
  return row;
}

export async function updatePlan(db: Db, planId: number, input: PlanInput) {
  validatePlanInput(input);
  const existing = await getPlanById(db, planId);
  if (!existing) throw new NotFoundError(`plan ${planId} not found`);
  if (input.tier === 'free') await assertNoOtherFreePlan(db, planId);
  const [row] = await db.update(plans).set(input).where(eq(plans.id, planId)).returning();
  return row;
}

export async function deletePlan(db: Db, planId: number) {
  const existing = await getPlanById(db, planId);
  if (!existing) throw new NotFoundError(`plan ${planId} not found`);
  const [{ value }] = await db.select({ value: count() }).from(users).where(eq(users.planId, planId));
  if (value > 0) throw new ConflictError('plan has users assigned to it');
  await db.delete(plans).where(eq(plans.id, planId));
}
