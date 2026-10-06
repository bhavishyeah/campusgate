import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@campusgate/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    gate: { findMany: vi.fn(), findFirst: vi.fn() },
    gateEvent: { count: vi.fn() },
  },
}));

import { prisma } from "@campusgate/db";
import { adminRoutes } from "../admin.js";

type MockFn = ReturnType<typeof vi.fn>;

const mockedPrisma = prisma as unknown as {
  user: { findUnique: MockFn };
  gate: { findMany: MockFn; findFirst: MockFn };
  gateEvent: { count: MockFn };
};

async function makeApp() {
  const app = Fastify();
  await app.register(jwt, { secret: "test-secret" });
  return app;
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("Gate health monitoring routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00.000Z"));

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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("GET /gates/health computes health states and uses tenant scope", async () => {
    const app = await makeApp();
    await app.register(adminRoutes, { prefix: "/api/admin" });

    mockedPrisma.gate.findMany.mockResolvedValue([
      {
        id: "g-op",
        name: "Main Gate",
        location: "Front",
        isActive: true,
        assignedGuards: [{ guard: { id: "gr-1", name: "Rahul" } }],
        gateEvents: [
          {
            timestamp: new Date("2026-10-03T11:45:00.000Z"),
            guard: { id: "gr-1", name: "Rahul" },
          },
        ],
      },
      {
        id: "g-warn-activity",
        name: "Hostel Gate",
        location: null,
        isActive: true,
        assignedGuards: [],
        gateEvents: [
          {
            timestamp: new Date("2026-10-03T11:20:00.000Z"),
            guard: { id: "gr-2", name: "Aman" },
          },
        ],
      },
      {
        id: "g-offline",
        name: "Back Gate",
        location: null,
        isActive: true,
        assignedGuards: [],
        gateEvents: [
          {
            timestamp: new Date("2026-10-03T08:30:00.000Z"),
            guard: { id: "gr-3", name: "Neha" },
          },
        ],
      },
      {
        id: "g-warn-no-activity",
        name: "North Gate",
        location: null,
        isActive: true,
        assignedGuards: [],
        gateEvents: [],
      },
      {
        id: "g-closed",
        name: "Service Gate",
        location: null,
        isActive: false,
        assignedGuards: [],
        gateEvents: [],
      },
    ]);

    mockedPrisma.gateEvent.count.mockImplementation(({ where }: { where: { gateId: string; eventType: string } }) => {
      const key = `${where.gateId}:${where.eventType}`;
      const map: Record<string, number> = {
        "g-op:EXIT": 5,
        "g-op:RETURN": 4,
        "g-warn-activity:EXIT": 2,
        "g-warn-activity:RETURN": 2,
        "g-offline:EXIT": 1,
        "g-offline:RETURN": 0,
        "g-warn-no-activity:EXIT": 0,
        "g-warn-no-activity:RETURN": 0,
        "g-closed:EXIT": 0,
        "g-closed:RETURN": 0,
      };
      return map[key] ?? 0;
    });

    const token = app.jwt.sign({ userId: "u-admin", role: "ADMIN", institutionId: "inst-1" });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/gates/health",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.gate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { institutionId: "inst-1" } })
    );

    const body = JSON.parse(res.body) as Array<{ gateId: string; status: string; todayExits: number; todayReturns: number }>;

    expect(body.find((g) => g.gateId === "g-op")?.status).toBe("OPERATIONAL");
    expect(body.find((g) => g.gateId === "g-warn-activity")?.status).toBe("WARNING");
    expect(body.find((g) => g.gateId === "g-offline")?.status).toBe("OFFLINE");
    expect(body.find((g) => g.gateId === "g-warn-no-activity")?.status).toBe("WARNING");
    expect(body.find((g) => g.gateId === "g-closed")?.status).toBe("CLOSED");

    expect(body.find((g) => g.gateId === "g-op")?.todayExits).toBe(5);
    expect(body.find((g) => g.gateId === "g-op")?.todayReturns).toBe(4);

    await app.close();
  });

  it("GET /gates/:gateId/health returns 404 for cross-tenant or unknown gate", async () => {
    const app = await makeApp();
    await app.register(adminRoutes, { prefix: "/api/admin" });

    mockedPrisma.gate.findFirst.mockResolvedValue(null);

    const token = app.jwt.sign({ userId: "u-admin", role: "ADMIN", institutionId: "inst-1" });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/gates/g-other-tenant/health",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(404);
    expect(mockedPrisma.gate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "g-other-tenant", institutionId: "inst-1" } })
    );

    await app.close();
  });

  it("GET /gates/:gateId/health returns detail payload including recent events", async () => {
    const app = await makeApp();
    await app.register(adminRoutes, { prefix: "/api/admin" });

    mockedPrisma.gate.findFirst.mockResolvedValue({
      id: "g-1",
      name: "Main Gate",
      location: "Front",
      isActive: true,
      assignedGuards: [{ guard: { id: "gr-1", name: "Rahul" } }],
      gateEvents: [
        {
          id: "ev-1",
          eventType: "EXIT",
          timestamp: new Date("2026-10-03T11:50:00.000Z"),
          guard: { name: "Rahul" },
          pass: {
            passNumber: "CG-2026-0001",
            student: { name: "Aditi", enrollmentNo: "ITM123" },
          },
        },
      ],
    });

    mockedPrisma.gateEvent.count.mockImplementation(({ where }: { where: { eventType: string } }) => {
      if (where.eventType === "EXIT") return 10;
      if (where.eventType === "RETURN") return 9;
      return 0;
    });

    const token = app.jwt.sign({ userId: "u-admin", role: "ADMIN", institutionId: "inst-1" });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/gates/g-1/health",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      gateId: string;
      status: string;
      recentEvents: Array<{ id: string; type: string; passNumber: string; studentName: string }>;
    };

    expect(body.gateId).toBe("g-1");
    expect(body.status).toBe("OPERATIONAL");
    expect(body.recentEvents[0]).toEqual(
      expect.objectContaining({
        id: "ev-1",
        type: "EXIT",
        passNumber: "CG-2026-0001",
        studentName: "Aditi",
      })
    );

    await app.close();
  });
});
