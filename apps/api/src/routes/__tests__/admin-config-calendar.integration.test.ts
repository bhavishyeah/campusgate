import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", () => {
  const prisma = {
    user: { findUnique: vi.fn() },
    institutionMembership: { findUnique: vi.fn() },
    institutionConfig: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
    academicCalendarDay: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    academicCalendarDayRevision: { create: vi.fn() },
    auditEvent: { create: vi.fn() },
  };
  return {
    prisma,
    privilegedPrisma: prisma,
    withTenant: (_institutionId: string, fn: (tx: typeof prisma) => unknown) => fn(prisma),
    Prisma: {},
  };
});

import { prisma } from "@campusgate/db";
import { ROLE_PERMISSIONS } from "@campusgate/shared";
import { adminRoutes } from "../admin.js";

// An ADMIN membership in the roles[].role.permissions[].permission.key shape
// authenticate selects, so the flipped (§7) admin routes resolve the admin.* /
// campus_movement.* key set.
function adminMembership() {
  return {
    id: "mbr-test",
    membershipStatus: "ACTIVE",
    permissionsVersion: 0,
    roles: [
      {
        role: {
          key: "ADMIN",
          permissions: (ROLE_PERMISSIONS.ADMIN ?? []).map((k) => ({ permission: { key: k } })),
        },
      },
    ],
  };
}

type MockFn = ReturnType<typeof vi.fn>;

const mockedPrisma = prisma as unknown as {
  user: { findUnique: MockFn };
  institutionConfig: { findUnique: MockFn; create: MockFn; upsert: MockFn };
  academicCalendarDay: {
    findMany: MockFn;
    upsert: MockFn;
    findUnique: MockFn;
    findFirst: MockFn;
    create: MockFn;
    update: MockFn;
    delete: MockFn;
  };
  academicCalendarDayRevision: { create: MockFn };
  auditEvent: { create: MockFn };
};

async function makeApp() {
  const app = Fastify();
  await app.register(jwt, { secret: "test-secret" });
  return app;
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("Admin config/calendar routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    (prisma as any).institutionMembership.findUnique.mockResolvedValue(adminMembership());

    mockedPrisma.user.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === "u-admin") {
        return {
          id: "u-admin",
          role: "ADMIN",
          institutionId: "inst-1",
          accountStatus: "ACTIVE",
          institution: { status: "ACTIVE" },
        };
      }
      return null;
    });
  });

  it("GET /institution-config resolves config in caller tenant", async () => {
    const app = await makeApp();
    await app.register(adminRoutes, { prefix: "/api/admin" });

    mockedPrisma.institutionConfig.findUnique.mockResolvedValue({
      id: "cfg-1",
      institutionId: "inst-1",
      timezone: "Asia/Kolkata",
      weekStartDay: "MONDAY",
      workingDaysOfWeek: [1, 2, 3, 4, 5, 6],
      lowAllowanceThresholdMinutes: 60,
    });

    const token = app.jwt.sign({ userId: "u-admin", role: "ADMIN", institutionId: "inst-1" });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/institution-config",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.institutionConfig.findUnique).toHaveBeenCalledWith({
      where: { institutionId: "inst-1" },
    });

    await app.close();
  });

  it("PUT /institution-config upserts using auth tenant scope", async () => {
    const app = await makeApp();
    await app.register(adminRoutes, { prefix: "/api/admin" });

    mockedPrisma.institutionConfig.upsert.mockResolvedValue({ id: "cfg-1" });
    mockedPrisma.auditEvent.create.mockResolvedValue({});

    const token = app.jwt.sign({ userId: "u-admin", role: "ADMIN", institutionId: "inst-1" });

    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/institution-config",
      headers: authHeader(token),
      payload: {
        timezone: "Asia/Kolkata",
        weekStartDay: "MONDAY",
        workingDaysOfWeek: [1, 2, 3, 4, 5],
        lowAllowanceThresholdMinutes: 45,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.institutionConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { institutionId: "inst-1" },
      })
    );

    await app.close();
  });

  it("GET /academic-calendar filters by auth tenant and range", async () => {
    const app = await makeApp();
    await app.register(adminRoutes, { prefix: "/api/admin" });

    mockedPrisma.academicCalendarDay.findMany.mockResolvedValue([]);

    const token = app.jwt.sign({ userId: "u-admin", role: "ADMIN", institutionId: "inst-1" });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/academic-calendar?startDate=2026-10-01T00:00:00.000Z&endDate=2026-10-31T23:59:59.999Z",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.academicCalendarDay.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ institutionId: "inst-1" }),
      })
    );

    await app.close();
  });

  it("PUT/DELETE calendar day keep tenant boundary", async () => {
    const app = await makeApp();
    await app.register(adminRoutes, { prefix: "/api/admin" });

    // Generalized handler (Phase 1): resolves the row via findFirst keyed on
    // (institutionId, date, departmentId ?? null), writes an append-only revision
    // in the same tx, then create/update (no compound-unique upsert).
    mockedPrisma.academicCalendarDay.findFirst.mockResolvedValue(null);
    mockedPrisma.academicCalendarDay.create.mockResolvedValue({
      id: "acd-1",
      date: new Date("2026-10-12T00:00:00.000Z"),
      dayType: "HOLIDAY",
    });
    mockedPrisma.academicCalendarDayRevision.create.mockResolvedValue({ id: "rev-1" });
    mockedPrisma.auditEvent.create.mockResolvedValue({});
    mockedPrisma.academicCalendarDay.delete.mockResolvedValue({});

    const token = app.jwt.sign({ userId: "u-admin", role: "ADMIN", institutionId: "inst-1" });

    const upsertRes = await app.inject({
      method: "PUT",
      url: "/api/admin/academic-calendar/day",
      headers: authHeader(token),
      payload: { date: "2026-10-12", dayType: "HOLIDAY", note: "Dussehra" },
    });

    expect(upsertRes.statusCode).toBe(200);
    // Row resolved with a tenant-scoped find on (institutionId, date, departmentId).
    expect(mockedPrisma.academicCalendarDay.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ institutionId: "inst-1", departmentId: null }),
      })
    );
    // Append-only revision written in-tenant before the mutation.
    expect(mockedPrisma.academicCalendarDayRevision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ institutionId: "inst-1", changeType: "CREATE" }),
      })
    );

    // DELETE path resolves an existing row, then writes a DELETE revision + deletes.
    mockedPrisma.academicCalendarDay.findFirst.mockResolvedValueOnce({
      id: "acd-1",
      institutionId: "inst-1",
      date: new Date("2026-10-12T00:00:00.000Z"),
      dayType: "HOLIDAY",
      note: "Dussehra",
      departmentId: null,
      academicSessionId: null,
      academicTermId: null,
    });

    const deleteRes = await app.inject({
      method: "DELETE",
      url: "/api/admin/academic-calendar/day/2026-10-12",
      headers: authHeader(token),
    });

    expect(deleteRes.statusCode).toBe(200);
    expect(mockedPrisma.academicCalendarDay.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "acd-1" } })
    );
    expect(mockedPrisma.academicCalendarDayRevision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ changeType: "DELETE" }),
      })
    );

    await app.close();
  });
});
