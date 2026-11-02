import { describe, it, expect } from "vitest";
import { decodeAuthClaims } from "@/lib/jwt";

/** base64url-encode a UTF-8 string (no padding) for building a test JWT. */
function base64url(input: string): string {
  return Buffer.from(input, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("decodeAuthClaims", () => {
  it("returns the claims from a valid hand-built JWT", () => {
    const payload = {
      userId: "u-1",
      membershipId: "m-1",
      institutionId: "i-1",
      roles: ["ACCOUNTANT"],
      permissions: ["fees.view"],
      permissionsVersion: 3,
      role: "ACCOUNTANT",
      jti: "j-1",
    };
    const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = base64url(JSON.stringify(payload));
    const token = `${header}.${body}.signature`;

    const claims = decodeAuthClaims(token);
    expect(claims.userId).toBe("u-1");
    expect(claims.roles).toEqual(["ACCOUNTANT"]);
    expect(claims.permissions).toEqual(["fees.view"]);
    expect(claims.permissionsVersion).toBe(3);
  });

  it("returns {} on a malformed token", () => {
    expect(decodeAuthClaims("not-a-jwt")).toEqual({});
  });

  it("returns {} on an empty string", () => {
    expect(decodeAuthClaims("")).toEqual({});
  });
});
