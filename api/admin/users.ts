import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createDb, type Db } from '../../src/db/client.js';
import { findOrCreateUser, listUsersWithPlans, updateUserPlan } from '../../src/db/users.js';
import { createClerkVerifier, type ClerkVerifier } from '../../src/auth/clerk.js';
import { ForbiddenError, BadRequestError, errorToResponse } from '../../src/http/errors.js';
import { applyCors } from '../../src/http/cors.js';
import { requireEnv } from '../../src/env.js';

async function requireAdmin(db: Db, clerkVerifier: ClerkVerifier, authHeader: string | undefined) {
  const { clerkUserId, email } = await clerkVerifier.verifyRequest(authHeader);
  const user = await findOrCreateUser(db, clerkUserId, email);
  if (user.role !== 'admin') throw new ForbiddenError('admin role required');
  return user;
}

export async function handleUsersRequest(
  db: Db,
  clerkVerifier: ClerkVerifier,
  method: string,
  authHeader: string | undefined,
  body: unknown,
  query: { id?: string }
) {
  await requireAdmin(db, clerkVerifier, authHeader);

  if (method === 'GET') return listUsersWithPlans(db);
  if (method === 'PATCH') {
    const planId = (body as { planId?: unknown })?.planId;
    if (typeof planId !== 'number') throw new BadRequestError('planId is required');
    return updateUserPlan(db, Number(query.id), planId);
  }
  throw new Error(`Unsupported method ${method}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  try {
    const clerkVerifier = createClerkVerifier(requireEnv('CLERK_SECRET_KEY'));
    const result = await handleUsersRequest(
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
