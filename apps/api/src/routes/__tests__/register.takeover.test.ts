import Fastify from "fastify";
import jwt from "@fastify/jwt";
import bcrypt from "bcrypt";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", () => {
  const prisma = {
    department: { findMany: vi.fn(), findUnique: vi.fn() },
    user: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    institutionMembership: { findUnique: vi.fn() },
    session: { create: vi.fn() },
    securityEvent: { create: vi.fn() },
    studentProfile: { findUnique: vi.fn(), update: vi.fn() },
    program: { findFirst: vi.fn() },
  };
  return {
    prisma,
    privilegedPrisma: prisma,
    withTenant: (_i: string, fn: (tx: typeof prisma) => unknown) => fn(prisma),
    Prisma: {},
  };
});
vi.mock("../../services/notifications.js", () => ({ notifyInstitutionAdmins: vi.fn(async () => {}) }));

import { prisma } from "@campusgate/db";
import { authRoutes } from "../auth.js";
import { resetAllLimiters } from "../../services/rate-limit.js";

const m = prisma as any;
const body = (over: Record<string, unknown> = {}) => ({
  email: "stu@x.edu",
  password: "newpassword1",
  name: "Stu Dent",
  role: "STUDENT",
  enrollmentNo: "ENR1",
  departmentId: "dep1",
  program: "BTech",
  semester: 1,
  ...over,
});

async function makeApp() {
  const app = Fastify();
  await app.register(jwt, { secret: "test-secret" });
  await app.register(authRoutes, { prefix: "/api/auth" });
  return app;
}
const post = (app: Awaited<ReturnType<typeof makeApp>>, payload: unknown) =>
  app.inject({ method: "POST", url: "/api/auth/register", payload: payload as never });

describe("POST /register no longer activates existing accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllLimiters();
    vi.unstubAllEnvs();
    m.department.findUnique.mockResolvedValue({ id: "dep1", institutionId: "inst-1", institution: { status: "ACTIVE" } });
  });

  it("passwordless imported student with the matching enrollmentNo gets 409 and nothing is written", async () => {
    m.user.findFirst.mockResolvedValue({ id: "u1" });
    const res = await post(await makeApp(), body());
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Email already registered");
    expect(res.body).not.toMatch(/enrollment/i);
    expect(m.user.update).not.toHaveBeenCalled();
    expect(m.user.create).not.toHaveBeenCalled();
    expect(m.studentProfile.update).not.toHaveBeenCalled();
  });

  it("legacy bcrypt(enrollmentNo) account gets the same 409 and is untouched", async () => {
    m.user.findFirst.mockResolvedValue({ id: "u2", passwordHash: await bcrypt.hash("ENR1", 4) });
    const res = await post(await makeApp(), body());
    expect(res.statusCode).toBe(409);
    expect(m.user.update).not.toHaveBeenCalled();
  });

  it("the existing-email check is case-insensitive", async () => {
    m.user.findFirst.mockResolvedValue({ id: "u1" });
    await post(await makeApp(), body({ email: "STU@x.edu" }));
    expect(m.user.findFirst.mock.calls[0][0].where.email).toEqual({ equals: "STU@x.edu", mode: "insensitive" });
  });

  it("ALLOW_SELF_REGISTRATION=false returns 403", async () => {
    vi.stubEnv("ALLOW_SELF_REGISTRATION", "false");
    const res = await post(await makeApp(), body());
    expect(res.statusCode).toBe(403);
    expect(m.user.create).not.toHaveBeenCalled();
  });

  it("a brand-new registration still returns 201 PENDING_APPROVAL", async () => {
    m.user.findFirst.mockResolvedValue(null);
    m.studentProfile.findUnique.mockResolvedValue(null);
    m.program.findFirst.mockResolvedValue(null);
    m.user.create.mockResolvedValue({ id: "n1", email: "stu@x.edu", role: "STUDENT", accountStatus: "PENDING_APPROVAL" });
    const res = await post(await makeApp(), body());
    expect(res.statusCode).toBe(201);
    expect(res.json().user.accountStatus).toBe("PENDING_APPROVAL");
  });

  it("rejects a password over 72 bytes", async () => {
    const res = await post(await makeApp(), body({ password: "é".repeat(40) }));
    expect(res.statusCode).toBe(400);
  });

  it("limits registrations per email (5/hour) with 429 + Retry-After", async () => {
    m.user.findFirst.mockResolvedValue({ id: "u1" });
    const app = await makeApp();
    for (let i = 0; i < 5; i++) expect((await post(app, body())).statusCode).toBe(409);
    const res = await post(app, body());
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });
});

describe("POST /login legacy default", () => {
  beforeEach(() => vi.clearAllMocks());

  async function loginWith(password: string, enrollmentNo: string) {
    const passwordHash = await bcrypt.hash(password, 4);
    m.user.findUnique.mockResolvedValue({
      id: "u1", email: "stu@x.edu", role: "STUDENT", institutionId: "inst-1", accountStatus: "ACTIVE", passwordHash,
      institution: { status: "ACTIVE" }, studentProfile: { enrollmentNo }, hodProfile: null, guardProfile: null,
    });
    m.institutionMembership.findUnique.mockResolvedValue({ id: "mb", permissionsVersion: 0, roles: [] });
    m.user.update.mockResolvedValue({});
    m.session.create.mockResolvedValue({});
    m.securityEvent.create.mockResolvedValue({});
    return (await makeApp()).inject({ method: "POST", url: "/api/auth/login", payload: { email: "stu@x.edu", password } });
  }

  it("password equal to the enrollment number gets 403 not-activated and no token", async () => {
    const res = await loginWith("ENR1", "ENR1");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/not activated/i);
    expect(res.json().token).toBeUndefined();
    expect(m.session.create).not.toHaveBeenCalled();
  });

  it("a normal password still logs in", async () => {
    const res = await loginWith("a-real-password", "ENR1");
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();
  });

  it("a passwordless student gets the new not-activated message", async () => {
    m.user.findUnique.mockResolvedValue({
      id: "u1", role: "STUDENT", passwordHash: null, institution: { status: "ACTIVE" }, studentProfile: { enrollmentNo: "E" },
    });
    const res = await (await makeApp()).inject({ method: "POST", url: "/api/auth/login", payload: { email: "a@b.co", password: "x" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("Forgot password");
  });
});
