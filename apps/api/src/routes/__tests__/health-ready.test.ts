import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

const queryRaw = vi.hoisted(() => vi.fn());
vi.mock("@campusgate/db", () => ({
  privilegedPrisma: { $queryRaw: queryRaw },
}));

import { healthRoutes } from "../health.js";

async function build(timeoutMs?: number) {
  const app = Fastify();
  await app.register(healthRoutes, { timeoutMs });
  return app;
}

describe("GET /api/health/ready", () => {
  beforeEach(() => {
    queryRaw.mockReset();
  });

  it("returns 200 db up when the query resolves", async () => {
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: "ok", db: "up" });
    expect(typeof body.timestamp).toBe("string");
    await app.close();
  });

  it("returns 503 db down without leaking error text when the query rejects", async () => {
    queryRaw.mockImplementation(async () => {
      throw new Error("FATAL: tenant/user postgres.secretref not found at db.example.supabase.co");
    });
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(Object.keys(res.json()).sort()).toEqual(["db", "status", "timestamp"]);
    expect(res.json()).toMatchObject({ status: "error", db: "down" });
    expect(res.body).not.toMatch(/secretref|supabase|FATAL|tenant/i);
    await app.close();
  });

  it("returns 503 when the query exceeds the timeout", async () => {
    queryRaw.mockReturnValue(new Promise(() => {})); // never settles
    const app = await build(50); // injectable timeout (production default 3000ms)
    const started = Date.now();
    const res = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "error", db: "down" });
    expect(res.body).not.toMatch(/timed out/i);
    await app.close();
  });

  it("does not require authentication", async () => {
    queryRaw.mockResolvedValue([]);
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
