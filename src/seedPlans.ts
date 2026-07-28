import { pathToFileURL } from 'node:url';
import { createDb } from './db/client.js';
import { listPlans, createPlan, type PlanTier } from './db/plans.js';

export async function seedFreePlan(db: ReturnType<typeof createDb>, scanLimit: number) {
  const existingFree = (await listPlans(db)).find((p) => p.tier === ('free' as PlanTier));
  if (existingFree) return existingFree;
  return createPlan(db, { name: 'Free', tier: 'free', scanLimit });
}

async function main() {
  const db = createDb();
  const plan = await seedFreePlan(db, 3);
  console.log(`Free plan ready: id=${plan.id} scanLimit=${plan.scanLimit}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
