import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", async () => {
  const { FakeOwnerDb } = await import("./helpers/fake-owner-db.js");
  const fake = new FakeOwnerDb();
  return { privilegedPrisma: fake, prisma: fake, __fake: fake, withTenant: (_i: string, fn: any) => fn(fake), Prisma: {} };
});

import * as dbModule from "@campusgate/db";
import { runBulkInvite } from "../account-invites.js";
import { EmailSendError, setEmailSender } from "../email/index.js";
import { resetAllLimiters } from "../rate-limit.js";
import type { FakeOwnerDb } from "./helpers/fake-owner-db.js";

const f = (dbModule as unknown as { __fake: FakeOwnerDb }).__fake;

function reset() {
  f.tokens = []; f.users = []; f.sessions = []; f.events = []; f.memberships = []; f.membershipRoles = [];
  f.membershipPerms.clear();
  f.institutions = [{ id: "inst-1", name: "Demo College", status: "ACTIVE" }];
  resetAllLimiters();
}

describe("runBulkInvite provider errors", () => {
  beforeEach(() => {
    reset();
    vi.unstubAllEnvs();
    vi.stubEnv("FRONTEND_URL", "https://app.x.edu");
  });

  it("stops after 3 consecutive 401s, skips the rest and leaves failedAt null", async () => {
    for (let i = 0; i < 10; i++) {
      f.addUser({ email: `s${i}@x.edu`, studentProfile: { enrollmentNo: `E${i}`, status: "ACTIVE" } });
    }
    let calls = 0;
    setEmailSender({
      kind: "memory",
      isConfigured: () => true,
      send: async () => {
        calls++;
        throw new EmailSendError("PROVIDER_REJECTED", "rejected", 401);
      },
    });
    const r = await runBulkInvite({
      institutionId: "inst-1",
      actorUserId: "admin",
      body: { mode: "ALL_PENDING", dryRun: false, resendRecent: false } as never,
    });
    expect(calls).toBeLessThanOrEqual(3 + 4); // 5 workers can have sends in flight when the third fails
    expect(r.failed).toBeGreaterThanOrEqual(3);
    expect(r.skipped.providerError).toBeGreaterThan(0);
    expect(r.results.some((x) => x.outcome === "SKIPPED_PROVIDER_ERROR")).toBe(true);
    expect(r.sent).toBe(0);
    expect(f.tokens.every((t) => t.failedAt === null && t.supersededAt && t.emailSentAt === null)).toBe(true);
  });
});
