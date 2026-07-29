import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createDb, type Db } from '../../src/db/client.js';
import { countScansForGuestToken, GUEST_SCAN_LIMIT } from '../../src/db/scanUsage.js';
import { errorToResponse } from '../../src/http/errors.js';
import { applyCors } from '../../src/http/cors.js';
import { validateGuestToken } from '../../src/auth/identity.js';

export { validateGuestToken };

export async function guestInit(db: Db, guestTokenInput: unknown) {
  const guestToken = validateGuestToken(guestTokenInput);
  const used = await countScansForGuestToken(db, guestToken);
  return { guestToken, remainingScans: Math.max(0, GUEST_SCAN_LIMIT - used) };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
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
