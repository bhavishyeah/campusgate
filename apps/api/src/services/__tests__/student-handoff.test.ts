import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", async () => {
  const { FakeOwnerDb } = await import("./helpers/fake-owner-db.js");
  const fake = new FakeOwnerDb();
  return { privilegedPrisma: fake, prisma: fake, __fake: fake, withTenant: (_i: string, fn: any) => fn(fake), Prisma: {} };
});

import * as dbModule from "@campusgate/db";
import { enrollApplicationSchema, grantStudentAccessSchema } from "@campusgate/shared";
import {
  EnrollConflict,
  enrollmentNoTaken,
  enrollmentPrefix,
  enrollmentYear,
  formatEnrollmentNo,
  generateEnrollmentNo,
  grantStudentRole,
  kolkataYear,
  profileStatusDeny,
  type OwnerStudentDb,
} from "../student-handoff.js";
import { issueAndSend, runBulkInvite } from "../account-invites.js";
import { InMemoryEmailSender, renderEnrolled, renderEnrolledActivation, setEmailSender } from "../email/index.js";
import { resetAllLimiters } from "../rate-limit.js";
import type { FakeOwnerDb } from "./helpers/fake-owner-db.js";

const f = (dbModule as unknown as { __fake: FakeOwnerDb }).__fake;

function owner(numbers: string[], extraTaken: () => string[] = () => []): OwnerStudentDb {
  return {
    studentProfile: {
      findMany: async ({ where }) => numbers.filter((n) => n.startsWith(where.enrollmentNo.startsWith)).map((enrollmentNo) => ({ enrollmentNo })),
      findFirst: async ({ where }) => (numbers.includes(where.enrollmentNo) || extraTaken().includes(where.enrollmentNo) ? { id: "x" } : null),
    },
  };
}

describe("enrollment number pattern", () => {
  it("builds PROGRAMCODE + YYYY + 3-digit sequence", () => {
    expect(formatEnrollmentNo(enrollmentPrefix("bca", 2024), 1)).toBe("BCA2024001");
    expect(formatEnrollmentNo("BCA2024", 42)).toBe("BCA2024042");
  });
  it("sanitises the program code, truncates to 12 and falls back to STU", () => {
    expect(enrollmentPrefix("b.c-a 1", 2024)).toBe("BCA12024");
    expect(enrollmentPrefix("ABCDEFGHIJKLMNOP", 2024)).toBe("ABCDEFGHIJKL2024");
    expect(enrollmentPrefix("---", 2024)).toBe("STU2024");
  });
  it("uses the Asia/Kolkata year, including across the 18:30 UTC year boundary", () => {
    expect(kolkataYear(new Date("2026-12-31T18:29:59Z"))).toBe(2026);
    expect(kolkataYear(new Date("2026-12-31T18:30:00Z"))).toBe(2027);
    expect(enrollmentYear(new Date("2024-12-31T18:30:00Z"), new Date("2030-01-01T00:00:00Z"))).toBe(2025);
    expect(enrollmentYear(null, new Date("2030-06-01T00:00:00Z"))).toBe(2030);
  });
});

describe("generateEnrollmentNo", () => {
  it("starts at 001 for an empty prefix", async () => {
    expect(await generateEnrollmentNo("BCA2024", owner([]))).toBe("BCA2024001");
  });
  it("continues after the highest number and ignores non-matching ones", async () => {
    const db = owner(["BCA2024001", "BCA2024009", "BCA2024X", "BCA2024-5", "BCA20240010x"]);
    expect(await generateEnrollmentNo("BCA2024", db)).toBe("BCA2024010");
  });
  it("widens past 999 and past four digits without wrapping", async () => {
    expect(await generateEnrollmentNo("BCA2024", owner(["BCA2024999"]))).toBe("BCA20241000");
    expect(await generateEnrollmentNo("BCA2024", owner(["BCA202412345"]))).toBe("BCA202412346");
  });
  it("two institutions holding 60 numbers under one prefix get 061, never 'could not allocate'", async () => {
    const nums = Array.from({ length: 60 }, (_, i) => `BCA2024${String(i + 1).padStart(3, "0")}`);
    expect(await generateEnrollmentNo("BCA2024", owner(nums))).toBe("BCA2024061");
  });
  it("steps over a number taken in a race and gives up after 5 tries", async () => {
    expect(await generateEnrollmentNo("BCA2024", owner([], () => ["BCA2024001", "BCA2024002"]))).toBe("BCA2024003");
    const all = ["001", "002", "003", "004", "005"].map((s) => `BCA2024${s}`);
    await expect(generateEnrollmentNo("BCA2024", owner([], () => all))).rejects.toBeInstanceOf(EnrollConflict);
  });
  it("two sequential allocations in a serialized fake never repeat", async () => {
    const taken: string[] = [];
    const db = owner([], () => taken);
    const a = await generateEnrollmentNo("BCA2024", db);
    taken.push(a);
    const b = await generateEnrollmentNo("BCA2024", { ...db, studentProfile: { ...db.studentProfile, findMany: async () => taken.map((enrollmentNo) => ({ enrollmentNo })) } });
    expect([a, b]).toEqual(["BCA2024001", "BCA2024002"]);
  });
  it("enrollmentNoTaken is an exact global check", async () => {
    expect(await enrollmentNoTaken("BCA2024001", owner(["BCA2024001"]))).toBe(true);
    expect(await enrollmentNoTaken("BCA2024002", owner(["BCA2024001"]))).toBe(false);
  });
});

describe("grantStudentRole", () => {
  function fakeTx(over: { membership?: boolean; role?: boolean; existing?: boolean } = {}) {
    const calls: string[] = [];
    const tx: any = {
      role: { findFirst: vi.fn(async (a: any) => { calls.push(`role:${a.where.key}`); return over.role === false ? null : { id: "r-student" }; }) },
      institutionMembership: {
        findUnique: vi.fn(async () => (over.membership === false ? null : { id: "m1" })),
        create: vi.fn(async (a: any) => { calls.push(`membership.create:${a.data.membershipStatus}`); return { id: "m-new" }; }),
        update: vi.fn(async (a: any) => { calls.push(`version:${JSON.stringify(a.data.permissionsVersion)}`); return {}; }),
      },
      membershipRole: {
        findUnique: vi.fn(async () => (over.existing ? { id: "mr" } : null)),
        create: vi.fn(async (a: any) => { calls.push(`role.create:${a.data.roleId}:${a.data.institutionId}`); return {}; }),
      },
    };
    return { tx, calls };
  }
  it("creates the role row and bumps the version once", async () => {
    const { tx, calls } = fakeTx();
    expect(await grantStudentRole(tx, { userId: "u1", institutionId: "i1" })).toEqual({ created: true, membershipId: "m1" });
    expect(calls).toEqual(["role:STUDENT", "role.create:r-student:i1", 'version:{"increment":1}']);
  });
  it("is a no-op when the role is already there (no bump)", async () => {
    const { tx, calls } = fakeTx({ existing: true });
    expect(await grantStudentRole(tx, { userId: "u1", institutionId: "i1" })).toEqual({ created: false, membershipId: "m1" });
    expect(calls).toEqual(["role:STUDENT"]);
  });
  it("creates an ACTIVE membership when there is none", async () => {
    const { tx, calls } = fakeTx({ membership: false });
    const r = await grantStudentRole(tx, { userId: "u1", institutionId: "i1" });
    expect(r.membershipId).toBe("m-new");
    expect(calls).toContain("membership.create:ACTIVE");
  });
  it("throws when the STUDENT template role is missing", async () => {
    const { tx } = fakeTx({ role: false });
    await expect(grantStudentRole(tx, { userId: "u1", institutionId: "i1" })).rejects.toThrow(/STUDENT role template/);
  });
  it("accepts no role key: only userId and institutionId are read", () => {
    expect(grantStudentRole.length).toBe(2);
  });
});

describe("profileStatusDeny", () => {
  it("allows ENROLLED, ACTIVE and ON_LEAVE; blocks the rest with the real status", () => {
    for (const s of ["ENROLLED", "ACTIVE", "ON_LEAVE"]) expect(profileStatusDeny(s)).toBeNull();
    for (const s of ["SUSPENDED", "WITHDRAWN", "GRADUATED", "APPLICANT"]) {
      expect(profileStatusDeny(s)).toMatchObject({ status: 409, message: "Existing student record is not in a state that allows enrollment", auditMeta: { profileStatus: s } });
    }
  });
});

describe("enroll body schemas", () => {
  it("enrollmentNo is optional, trimmed, blank means undefined, over 100 is rejected, unknown keys rejected", () => {
    expect(enrollApplicationSchema.parse({})).toEqual({});
    expect(enrollApplicationSchema.parse({ enrollmentNo: "  A1  " }).enrollmentNo).toBe("A1");
    expect(enrollApplicationSchema.parse({ enrollmentNo: "   " }).enrollmentNo).toBeUndefined();
    expect(enrollApplicationSchema.parse({ enrollmentNo: "" }).enrollmentNo).toBeUndefined();
    expect(enrollApplicationSchema.safeParse({ enrollmentNo: "x".repeat(101) }).success).toBe(false);
    expect(enrollApplicationSchema.safeParse({ role: "ADMIN" }).success).toBe(false);
    expect(enrollApplicationSchema.safeParse({ userId: "u" }).success).toBe(false);
    expect(grantStudentAccessSchema.safeParse({ roleKey: "ADMIN" }).success).toBe(false);
    expect(grantStudentAccessSchema.safeParse({}).success).toBe(true);
  });
});

describe("enrolled email templates", () => {
  const link = "https://app.x.edu/activate#token=abc";
  it("plain variant: institution in the subject, escaped, text part, no tracking or images", () => {
    const m = renderEnrolled({ institutionName: "<b>Demo & Co</b>", link: "https://app.x.edu/login" });
    expect(m.subject).toBe("You're enrolled - <b>Demo & Co</b>");
    expect(m.html).toContain("&lt;b&gt;Demo &amp; Co&lt;/b&gt;");
    expect(m.html).not.toContain("<b>Demo");
    expect(m.html).not.toMatch(/<img|pixel|track/i);
    expect(m.text).toContain("Sign in: https://app.x.edu/login");
    expect(m.text).not.toMatch(/expires/i);
  });
  it("activation variant: link, expiry and institution name", () => {
    const m = renderEnrolledActivation({ institutionName: "Demo College", link, expiresInHours: 72 });
    expect(m.subject).toBe("Activate your account, you're enrolled - Demo College");
    expect(m.text).toContain(link);
    expect(m.text).toContain("expires in 3 days");
    expect(m.html).not.toMatch(/<img|pixel|track/i);
  });
  it("strips control characters from the institution name", () => {
    expect(renderEnrolled({ institutionName: "A\r\nBcc: x@y", link: "https://a/login" }).subject).not.toMatch(/[\r\n]/);
  });
});

describe("issueAndSend with the enrolled template", () => {
  let mail: InMemoryEmailSender;
  beforeEach(() => {
    f.tokens = []; f.users = []; f.sessions = []; f.events = []; f.memberships = []; f.membershipRoles = [];
    f.membershipPerms.clear();
    f.institutions = [{ id: "inst-1", name: "Demo College", status: "ACTIVE" }];
    resetAllLimiters();
    vi.unstubAllEnvs();
    vi.stubEnv("FRONTEND_URL", "https://app.x.edu");
    mail = new InMemoryEmailSender();
    setEmailSender(mail);
  });

  it("issues an activation token and sends the enrolled activation mail", async () => {
    const u = f.addUser({ email: "new@x.edu", studentProfile: { enrollmentNo: "E1", status: "ENROLLED" } });
    const r = await issueAndSend({
      userId: u.id, institutionId: "inst-1", institutionName: "Demo College", email: "new@x.edu",
      purpose: "ACCOUNT_ACTIVATION", template: "enrolled", budgetCeiling: 250,
    });
    expect(r.status).toBe("SENT");
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].subject).toBe("Activate your account, you're enrolled - Demo College");
    expect(mail.sent[0].text).toContain("https://app.x.edu/activate#token=");
    expect(f.tokens[0].purpose).toBe("ACCOUNT_ACTIVATION");
    expect(f.tokens[0].emailSentAt).not.toBeNull();
  });

  it("without the template the existing activation mail is unchanged", async () => {
    const u = f.addUser({ email: "new@x.edu", studentProfile: { enrollmentNo: "E1", status: "ACTIVE" } });
    await issueAndSend({
      userId: u.id, institutionId: "inst-1", institutionName: "Demo College", email: "new@x.edu",
      purpose: "ACCOUNT_ACTIVATION", budgetCeiling: 250,
    });
    expect(mail.sent[0].subject).toBe("Activate your CampusGate account - Demo College");
  });

  it("bulk ALL_PENDING and explicit bulk still exclude ENROLLED students", async () => {
    const enrolled = f.addUser({ email: "e@x.edu", studentProfile: { enrollmentNo: "E1", status: "ENROLLED" } });
    const active = f.addUser({ email: "a@x.edu", studentProfile: { enrollmentNo: "E2", status: "ACTIVE" } });
    const all = await runBulkInvite({ institutionId: "inst-1", actorUserId: "admin", body: { mode: "ALL_PENDING", dryRun: false, resendRecent: false } as never });
    expect(all.results.map((x) => x.email)).toEqual(["a@x.edu"]);
    const picked = await runBulkInvite({
      institutionId: "inst-1", actorUserId: "admin",
      body: { mode: "SELECTED", userIds: [enrolled.id, active.id], dryRun: true, resendRecent: false } as never,
    });
    expect(picked.skipped.notEligible).toBe(1);
  });
});
