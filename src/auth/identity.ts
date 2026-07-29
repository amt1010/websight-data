import type { Db } from '../db/client.js';
import { findOrCreateUser } from '../db/users.js';
import type { ClerkVerifier } from './clerk.js';
import { BadRequestError } from '../http/errors.js';

export type Identity = { userId: number } | { guestToken: string };

export function validateGuestToken(guestToken: unknown): string {
  if (typeof guestToken !== 'string' || guestToken.trim().length === 0 || guestToken.length > 100) {
    throw new BadRequestError('guestToken must be a non-empty string');
  }
  return guestToken;
}

export async function resolveIdentity(
  db: Db,
  clerkVerifier: ClerkVerifier,
  authHeader: string | undefined,
  guestTokenInput: unknown
): Promise<Identity> {
  if (authHeader) {
    const { clerkUserId, email } = await clerkVerifier.verifyRequest(authHeader);
    const user = await findOrCreateUser(db, clerkUserId, email);
    return { userId: user.id };
  }
  const guestToken = validateGuestToken(guestTokenInput);
  return { guestToken };
}
