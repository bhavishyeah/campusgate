import { describe, expect, it, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import { authenticator } from "otplib";
import {
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_REGEX,
  generateMfaEnrollmentSecret,
  verifyTotp,
  generateRecoveryCodes,
  consumeRecoveryCode,
  normalizeRecoveryCode,
  mintStepUpToken,
  verifyStepUpToken,
  type JwtSigner,
  type JwtVerifier,
} from "../mfa.js";

// otplib config is pinned in the service module: { window: 1, step: 30 }. The
// happy-path tests rely on that being set at import time.

describe("MFA — TOTP enrollment + verification", () => {
  it("enroll → verify happy path at { window: 1, step: 30 }", async () => {
    const { secret, otpauthUri, qrCodeDataUrl } = await generateMfaEnrollmentSecret(
      "admin@example.test",
    );
    expect(secret).toBeTruthy();
    expect(otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);

    const code = authenticator.generate(secret);
    expect(verifyTotp(code, secret)).toBe(true);
  });

  it("rejects a wrong code", async () => {
    const { secret } = await generateMfaEnrollmentSecret("admin@example.test");
    expect(verifyTotp("000000", secret)).toBe(false);
    // A malformed code is a rejection, not a throw.
    expect(verifyTotp("not-a-code", secret)).toBe(false);
  });
});

describe("MFA — recovery codes", () => {
  it(`issues exactly ${RECOVERY_CODE_COUNT} codes each matching the regex`, async () => {
    const codes = await generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    for (const c of codes) {
      // plaintext is displayed grouped XXXXX-XXXXX; the bare form matches the regex.
      expect(c.plaintext).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
      expect(normalizeRecoveryCode(c.plaintext)).toMatch(RECOVERY_CODE_REGEX);
      expect(c.hash).toMatch(/^\$2[aby]\$/); // bcrypt hash
    }
    // All codes are distinct.
    expect(new Set(codes.map((c) => c.plaintext)).size).toBe(RECOVERY_CODE_COUNT);
    // bcrypt-hashing 10 codes at cost 12 is deliberately slow; allow headroom.
  }, 30_000);

  it("consumes a recovery code once (single-use)", async () => {
    const codes = await generateRecoveryCodes();
    const hashes = codes.map((c) => c.hash);
    const target = codes[3];

    const first = await consumeRecoveryCode(target.plaintext, hashes);
    expect(first).not.toBeNull();
    expect(first!.matchedHash).toBe(target.hash);

    // Simulate the route removing the consumed hash; a second use must fail.
    const remaining = hashes.filter((h) => h !== first!.matchedHash);
    const second = await consumeRecoveryCode(target.plaintext, remaining);
    expect(second).toBeNull();
  }, 30_000);

  it("rejects a code that does not match the format or any stored hash", async () => {
    const codes = await generateRecoveryCodes();
    const hashes = codes.map((c) => c.hash);
    expect(await consumeRecoveryCode("bad!", hashes)).toBeNull();
    expect(await consumeRecoveryCode("ABCDE-FGHJK", hashes)).toBeNull(); // valid format, wrong value
  }, 30_000);
});

describe("MFA — step-up token mint/verify", () => {
  let app: FastifyInstance;
  let signer: JwtSigner;
  let verifier: JwtVerifier;

  beforeAll(async () => {
    app = Fastify();
    await app.register(jwt, { secret: "test-step-up-secret" });
    await app.ready();
    signer = { sign: (payload, options) => app.jwt.sign(payload as never, options as never) };
    verifier = { verify: <T>(t: string) => app.jwt.verify(t) as T };
  });

  it("mints a token that verifies for the right user + action class", () => {
    const token = mintStepUpToken(signer, "user-1", "support_grant.create");
    const result = verifyStepUpToken(verifier, token, "user-1", "support_grant.create");
    expect(result.ok).toBe(true);
  });

  it("rejects a token for a different user", () => {
    const token = mintStepUpToken(signer, "user-1", "support_grant.create");
    const result = verifyStepUpToken(verifier, token, "user-2", "support_grant.create");
    expect(result).toEqual({ ok: false, reason: "userMismatch" });
  });

  it("rejects a token bound to a different action class", () => {
    const token = mintStepUpToken(signer, "user-1", "support_grant.create");
    const result = verifyStepUpToken(verifier, token, "user-1", "refund.issue");
    expect(result).toEqual({ ok: false, reason: "wrongAction" });
  });

  it("rejects a garbage / unsigned token", () => {
    const result = verifyStepUpToken(verifier, "not.a.jwt", "user-1", "support_grant.create");
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a token missing the stepUp claim", () => {
    // Sign a token WITHOUT stepUp:true to prove the claim is enforced.
    const token = app.jwt.sign(
      { userId: "user-1", jti: "j", action: "support_grant.create" } as never,
      { expiresIn: 300 } as never,
    );
    const result = verifyStepUpToken(verifier, token, "user-1", "support_grant.create");
    expect(result).toEqual({ ok: false, reason: "notStepUp" });
  });
});
