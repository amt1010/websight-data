import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createDb, type Db } from '../../src/db/client.js';
import { findOrCreateUser } from '../../src/db/users.js';
import { listPlans, createPlan, updatePlan, deletePlan, type PlanInput } from '../../src/db/plans.js';
import { createClerkVerifier, type ClerkVerifier } from '../../src/auth/clerk.js';
import { ForbiddenError, errorToResponse } from '../../src/http/errors.js';
import { applyCors } from '../../src/http/cors.js';
import { requireEnv } from '../../src/env.js';

async function requireAdmin(db: Db, clerkVerifier: ClerkVerifier, authHeader: string | undefined) {
  const { clerkUserId, email } = await clerkVerifier.verifyRequest(authHeader);
  const user = await findOrCreateUser(db, clerkUserId, email);
  if (user.role !== 'admin') throw new ForbiddenError('admin role required');
  return user;
}

export async function handlePlansRequest(
  db: Db,
  clerkVerifier: ClerkVerifier,
  method: string,
  authHeader: string | undefined,
  body: unknown,
  query: { id?: string }
) {
  await requireAdmin(db, clerkVerifier, authHeader);

  if (method === 'GET') return listPlans(db);
  if (method === 'POST') return createPlan(db, body as PlanInput);
  if (method === 'PATCH') return updatePlan(db, Number(query.id), body as PlanInput);
  if (method === 'DELETE') {
    await deletePlan(db, Number(query.id));
    return { deleted: true };
  }
  throw new Error(`Unsupported method ${method}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  try {
    const clerkVerifier = createClerkVerifier(requireEnv('CLERK_SECRET_KEY'));
    const result = await handlePlansRequest(
      createDb(),
      clerkVerifier,
      req.method ?? 'GET',
      req.headers.authorization,
      req.body,
      req.query as { id?: string }
    );
    res.status(200).json(result);
  } catch (err) {
    const { status, body } = errorToResponse(err);
    res.status(status).json(body);
  }
}
