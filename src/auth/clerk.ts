import { verifyToken, createClerkClient } from '@clerk/backend';
import { AuthError } from '../http/errors.js';

export interface AuthenticatedUser {
  clerkUserId: string;
  email: string;
}

type VerifyTokenFn = (token: string, options: { secretKey: string }) => Promise<{ sub: string }>;
type GetUserFn = (userId: string) => Promise<{ emailAddresses: { emailAddress: string }[] }>;

export interface ClerkVerifier {
  verifyRequest(authHeader: string | undefined): Promise<AuthenticatedUser>;
}

export function createClerkVerifier(
  secretKey: string,
  deps: { verifyTokenFn?: VerifyTokenFn; getUserFn?: GetUserFn } = {}
): ClerkVerifier {
  const verifyTokenFn = deps.verifyTokenFn ?? (verifyToken as unknown as VerifyTokenFn);
  const getUserFn =
    deps.getUserFn ??
    (async (userId: string) => {
      const client = createClerkClient({ secretKey });
      return client.users.getUser(userId);
    });

  return {
    async verifyRequest(authHeader) {
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new AuthError('Missing bearer token');
      }
      const token = authHeader.slice('Bearer '.length);
      let payload: { sub: string };
      try {
        payload = await verifyTokenFn(token, { secretKey });
      } catch {
        throw new AuthError('Invalid or expired token');
      }
      const user = await getUserFn(payload.sub);
      const email = user.emailAddresses[0]?.emailAddress;
      if (!email) throw new AuthError('Clerk user has no email address');
      return { clerkUserId: payload.sub, email };
    },
  };
}
