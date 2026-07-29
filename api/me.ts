import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createDb, type Db } from '../src/db/client.js';
import { findOrCreateUser, getUserWithPlan } from '../src/db/users.js';
import { countScansForUser } from '../src/db/scanUsage.js';
import { createClerkVerifier, type ClerkVerifier } from '../src/auth/clerk.js';
import { errorToResponse } from '../src/http/errors.js';
import { applyCors } from '../src/http/cors.js';
import { requireEnv } from '../src/env.js';

export async function getMe(db: Db, clerkVerifier: ClerkVerifier, authHeader: string | undefined) {
  const { clerkUserId, email } = await clerkVerifier.verifyRequest(authHeader);
  const user = await findOrCreateUser(db, clerkUserId, email);
  const withPlan = await getUserWithPlan(db, user.id);
  const used = await countScansForUser(db, user.id);
  return {
    email: withPlan!.user.email,
    role: withPlan!.user.role,
    plan: { name: withPlan!.plan.name, tier: withPlan!.plan.tier, scanLimit: withPlan!.plan.scanLimit },
    remainingScans: Math.max(0, withPlan!.plan.scanLimit - used),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const clerkVerifier = createClerkVerifier(requireEnv('CLERK_SECRET_KEY'));
    const result = await getMe(createDb(), clerkVerifier, req.headers.authorization);
    res.status(200).json(result);
  } catch (err) {
    const { status, body } = errorToResponse(err);
    res.status(status).json(body);
  }
}
