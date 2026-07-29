import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createDb, type Db } from '../../src/db/client.js';
import {
  countScansForGuestToken,
  countScansForUser,
  recordScanForGuestToken,
  recordScanForUser,
  GUEST_SCAN_LIMIT,
} from '../../src/db/scanUsage.js';
import { findOrCreateUser, getUserWithPlan } from '../../src/db/users.js';
import { createClerkVerifier, type ClerkVerifier } from '../../src/auth/clerk.js';
import { QuotaExceededError, errorToResponse } from '../../src/http/errors.js';
import { applyCors } from '../../src/http/cors.js';
import { requireEnv } from '../../src/env.js';
import { validateGuestToken } from './guest-init.js';

export async function consumeScan(
  db: Db,
  clerkVerifier: ClerkVerifier,
  authHeader: string | undefined,
  guestTokenInput: unknown
): Promise<{ remainingScans: number }> {
  if (authHeader) {
    const { clerkUserId, email } = await clerkVerifier.verifyRequest(authHeader);
    const user = await findOrCreateUser(db, clerkUserId, email);
    const withPlan = await getUserWithPlan(db, user.id);
    const used = await countScansForUser(db, user.id);
    if (used >= withPlan!.plan.scanLimit) {
      throw new QuotaExceededError({ plan: withPlan!.plan.name, scanLimit: withPlan!.plan.scanLimit, used });
    }
    await recordScanForUser(db, user.id);
    return { remainingScans: withPlan!.plan.scanLimit - used - 1 };
  }

  const guestToken = validateGuestToken(guestTokenInput);
  const used = await countScansForGuestToken(db, guestToken);
  if (used >= GUEST_SCAN_LIMIT) {
    throw new QuotaExceededError({ plan: 'Guest', scanLimit: GUEST_SCAN_LIMIT, used });
  }
  await recordScanForGuestToken(db, guestToken);
  return { remainingScans: GUEST_SCAN_LIMIT - used - 1 };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const clerkVerifier = createClerkVerifier(requireEnv('CLERK_SECRET_KEY'));
    const result = await consumeScan(createDb(), clerkVerifier, req.headers.authorization, req.body?.guestToken);
    res.status(200).json(result);
  } catch (err) {
    const { status, body } = errorToResponse(err);
    res.status(status).json(body);
  }
}
