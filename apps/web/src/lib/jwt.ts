import { jwtDecode } from "jwt-decode";

/**
 * Shape of the claims the API signs into the login JWT (apps/api auth.ts).
 * The login response BODY omits these — they live ONLY inside the signed token,
 * so the web app must decode the token to populate its authorization model.
 */
export interface AuthClaims {
  userId: string;
  membershipId: string | null;
  institutionId: string | null;
  roles: string[];
  permissions: string[];
  permissionsVersion: number | null;
  role: string;
  jti: string;
  exp?: number;
  iat?: number;
}

/**
 * Decode (NOT verify) the JWT claims. Verification is the API's job — there is
 * no secret in the browser. A malformed/missing token yields empty claims,
 * which leaves the user logged-in-but-powerless (can() denies everything)
 * rather than crashing.
 */
export function decodeAuthClaims(token: string): Partial<AuthClaims> {
  try {
    return jwtDecode<AuthClaims>(token);
  } catch {
    return {};
  }
}
