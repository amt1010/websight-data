import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createDb, type Db } from '../../src/db/client.js';
import { countScansForGuestToken, GUEST_SCAN_LIMIT } from '../../src/db/scanUsage.js';
import { BadRequestError, errorToResponse } from '../../src/http/errors.js';

export function validateGuestToken(guestToken: unknown): string {
  if (typeof guestToken !== 'string' || guestToken.trim().length === 0 || guestToken.length > 100) {
    throw new BadRequestError('guestToken must be a non-empty string');
  }
  return guestToken;
}

export async function guestInit(db: Db, guestTokenInput: unknown) {
  const guestToken = validateGuestToken(guestTokenInput);
  const used = await countScansForGuestToken(db, guestToken);
  return { guestToken, remainingScans: Math.max(0, GUEST_SCAN_LIMIT - used) };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const result = await guestInit(createDb(), req.body?.guestToken);
    res.status(200).json(result);
  } catch (err) {
    const { status, body } = errorToResponse(err);
    res.status(status).json(body);
  }
}
