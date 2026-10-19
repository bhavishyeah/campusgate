import { randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import qrcode from "qrcode";
import { authenticator } from "otplib";

// Pinned otplib config (design §5.1): window = ±1 step, step = 30s ⇒ ±30s skew.
// Every clock-skew reference in this design means exactly this single config.
authenticator.options = { window: 1, step: 30 };

// Number of one-time recovery codes issued at enrollment (design §5.2, pinned).
export const RECOVERY_CODE_COUNT = 10;

// Crockford base32 alphabet: 0-9 A-Z excluding I, L, O, U. Recovery codes are 10
// such characters, displayed grouped XXXXX-XXXXX, stored/compared without the
// separator. The validator/tests assert this exact regex (design §5.2 / §8.1).
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const RECOVERY_CODE_REGEX = /^[0-9A-HJKMNP-TV-Z]{10}$/;

// bcrypt cost for recovery-code hashes (mirrors the password hashing cost).
const RECOVERY_CODE_BCRYPT_COST = 12;

// Step-up token lifetime (design §5.3): a fresh MFA assertion valid for 5 minutes.
export const STEP_UP_TTL_SECONDS = 5 * 60;

/** A newly-generated TOTP enrollment secret + the otpauth URI + its QR data URL. */
export interface MfaEnrollmentSecret {
  secret: string;
  otpauthUri: string;
  qrCodeDataUrl: string;
}

/**
 * Generate a TOTP secret for a platform account and render its enrollment
 * material. The caller stores `secret` on `User.mfaSecret` WITHOUT enabling MFA
 * (design §5.2 POST /enroll/start) and returns the URI + QR to the client.
 *
 * `accountName` is the user's email (the authenticator label); `issuer` names
 * the platform in the authenticator app.
 */
export async function generateMfaEnrollmentSecret(
  accountName: string,
  issuer = "CAMPASS",
): Promise<MfaEnrollmentSecret> {
  const secret = authenticator.generateSecret();
  const otpauthUri = authenticator.keyuri(accountName, issuer, secret);
  const qrCodeDataUrl = await qrcode.toDataURL(otpauthUri);
  return { secret, otpauthUri, qrCodeDataUrl };
}

/** Verify a 6-digit TOTP `code` against a stored base32 `secret`. */
export function verifyTotp(code: string, secret: string): boolean {
  // otplib throws on malformed secrets/tokens; a bad code is a rejection, not a 500.
  try {
    return authenticator.verify({ token: code.trim(), secret });
  } catch {
    return false;
  }
}

/** A plaintext recovery code (shown once) paired with its bcrypt hash (stored). */
export interface GeneratedRecoveryCode {
  plaintext: string; // grouped XXXXX-XXXXX for display
  hash: string; // bcrypt hash of the hyphen-stripped code
}

/** Draw one 10-char Crockford-base32 code from a CSPRNG (no modulo bias). */
function drawRecoveryCode(): string {
  const chars: string[] = [];
  while (chars.length < 10) {
    for (const byte of randomBytes(10)) {
      // Reject bytes >= 256 - (256 % 32) to avoid modulo bias.
      if (byte >= 256 - (256 % CROCKFORD_ALPHABET.length)) continue;
      chars.push(CROCKFORD_ALPHABET[byte % CROCKFORD_ALPHABET.length]);
      if (chars.length === 10) break;
    }
  }
  return chars.join("");
}

/** Group a 10-char code as XXXXX-XXXXX for display. */
function groupForDisplay(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/**
 * Normalize a user-supplied recovery code for comparison: strip whitespace and
 * hyphens, upper-case. Returns the bare 10-char form (or the input upper-cased
 * if it does not match, so the regex check below rejects it).
 */
export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * Generate exactly RECOVERY_CODE_COUNT recovery codes. Returns the plaintext
 * (grouped, shown to the user ONCE) and the bcrypt hashes (stored in
 * `User.mfaRecoveryCodes`). Never persist the plaintext.
 */
export async function generateRecoveryCodes(): Promise<GeneratedRecoveryCode[]> {
  const out: GeneratedRecoveryCode[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const bare = drawRecoveryCode();
    const hash = await bcrypt.hash(bare, RECOVERY_CODE_BCRYPT_COST);
    out.push({ plaintext: groupForDisplay(bare), hash });
  }
  return out;
}

/**
 * Try to consume a recovery code. Given the user-supplied `input` and the stored
 * `hashes`, returns the hash that matched (so the caller can remove it from
 * `mfaRecoveryCodes`, enforcing single-use) or null if no stored hash matches.
 */
export async function consumeRecoveryCode(
  input: string,
  hashes: string[],
): Promise<{ matchedHash: string } | null> {
  const bare = normalizeRecoveryCode(input);
  if (!RECOVERY_CODE_REGEX.test(bare)) return null;
  for (const hash of hashes) {
    if (await bcrypt.compare(bare, hash)) {
      return { matchedHash: hash };
    }
  }
  return null;
}

// ─── Step-up token (design §5.3) ────────────────────────────────────────────
// A short-lived signed JWT { userId, jti, stepUp:true, action, exp:5m } minted
// after a fresh MFA assertion and sent on a high-risk request in `x-step-up`.
// Multi-use within the TTL but action-class bound (the `action` claim), so a
// stolen token cannot authorize a DIFFERENT action class.

/** The claims carried by a step-up token. */
export interface StepUpClaims {
  userId: string;
  jti: string;
  stepUp: true;
  action: string;
}

/**
 * A minimal JWT signer/verifier interface, satisfied by the Fastify `app.jwt`
 * decorator (which wraps the same signing key as the login tokens, design §5.3).
 * Keeping it abstract lets the unit tests mint/verify with the same signer
 * without standing up a full server.
 */
export interface JwtSigner {
  sign(payload: object, options?: { expiresIn?: number | string }): string;
}
export interface JwtVerifier {
  verify<T = unknown>(token: string): T;
}

/** Mint a step-up token bound to `action` for `userId`, valid STEP_UP_TTL_SECONDS. */
export function mintStepUpToken(
  signer: JwtSigner,
  userId: string,
  action: string,
): string {
  const claims: StepUpClaims = { userId, jti: randomUUID(), stepUp: true, action };
  return signer.sign(claims, { expiresIn: STEP_UP_TTL_SECONDS });
}

export type StepUpVerifyResult =
  | { ok: true; claims: StepUpClaims }
  | { ok: false; reason: "invalid" | "userMismatch" | "notStepUp" | "wrongAction" };

/**
 * Verify a step-up token for `expectedUserId` + `expectedAction`. Checks the
 * signature + expiry (via the verifier, which throws on either), then the
 * `userId`, `stepUp === true`, and `action === expectedAction` claims. Any
 * failure is a rejection, never a throw out of this function.
 */
export function verifyStepUpToken(
  verifier: JwtVerifier,
  token: string,
  expectedUserId: string,
  expectedAction: string,
): StepUpVerifyResult {
  let claims: StepUpClaims;
  try {
    claims = verifier.verify<StepUpClaims>(token);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (claims.stepUp !== true) return { ok: false, reason: "notStepUp" };
  if (claims.userId !== expectedUserId) return { ok: false, reason: "userMismatch" };
  if (claims.action !== expectedAction) return { ok: false, reason: "wrongAction" };
  return { ok: true, claims };
}
