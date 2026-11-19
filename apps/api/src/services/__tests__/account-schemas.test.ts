import { describe, expect, it } from "vitest";
import { bulkInviteSchema, passwordSchema, resetPasswordSchema } from "@campusgate/shared";

describe("passwordSchema", () => {
  it("accepts 72 ASCII chars, rejects 73 and 40 two-byte chars (80 bytes), rejects <8", () => {
    expect(passwordSchema.safeParse("a".repeat(72)).success).toBe(true);
    expect(passwordSchema.safeParse("a".repeat(73)).success).toBe(false);
    expect(passwordSchema.safeParse("é".repeat(40)).success).toBe(false);
    expect(passwordSchema.safeParse("short").success).toBe(false);
  });
});

describe("resetPasswordSchema", () => {
  it("requires a 43-char base64url token", () => {
    const ok = "A".repeat(43);
    expect(resetPasswordSchema.safeParse({ token: ok, password: "longenough1" }).success).toBe(true);
    expect(resetPasswordSchema.safeParse({ token: "short", password: "longenough1" }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ token: ok + "!", password: "longenough1" }).success).toBe(false);
  });
});

describe("bulkInviteSchema", () => {
  it("rejects ALL_PENDING with resendRecent or userIds, SELECTED without userIds, >100 ids", () => {
    expect(bulkInviteSchema.safeParse({ mode: "ALL_PENDING", resendRecent: true }).success).toBe(false);
    expect(bulkInviteSchema.safeParse({ mode: "ALL_PENDING", userIds: ["a"] }).success).toBe(false);
    expect(bulkInviteSchema.safeParse({ mode: "SELECTED" }).success).toBe(false);
    expect(bulkInviteSchema.safeParse({ mode: "SELECTED", userIds: Array(101).fill("a") }).success).toBe(false);
    expect(bulkInviteSchema.safeParse({ mode: "ALL_PENDING" }).success).toBe(true);
    expect(bulkInviteSchema.safeParse({ mode: "SELECTED", userIds: ["a"], resendRecent: true }).success).toBe(true);
  });
});
