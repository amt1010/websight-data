import { describe, it, expect } from 'vitest';
import { createClerkVerifier } from '../../src/auth/clerk.js';
import { AuthError } from '../../src/http/errors.js';

describe('createClerkVerifier', () => {
  const verifier = createClerkVerifier('test-secret', {
    verifyTokenFn: async (token: string) => {
      if (token !== 'good-token') throw new Error('invalid');
      return { sub: 'clerk_123' } as never;
    },
    getUserFn: async (userId: string) => ({
      emailAddresses: [{ emailAddress: `${userId}@example.com` }],
    }),
  });

  it('rejects a missing Authorization header', async () => {
    await expect(verifier.verifyRequest(undefined)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a header without a Bearer prefix', async () => {
    await expect(verifier.verifyRequest('Basic xyz')).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects an invalid token', async () => {
    await expect(verifier.verifyRequest('Bearer bad-token')).rejects.toBeInstanceOf(AuthError);
  });

  it('resolves clerkUserId and email for a valid token', async () => {
    const result = await verifier.verifyRequest('Bearer good-token');
    expect(result).toEqual({ clerkUserId: 'clerk_123', email: 'clerk_123@example.com' });
  });
});
