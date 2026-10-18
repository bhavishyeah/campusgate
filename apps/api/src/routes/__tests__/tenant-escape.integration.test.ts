/**
 * Cross-tenant escape suite (tenancy.md §7) — runs against the REAL Supabase
 * tables through the `campass_app` runtime connection, proving Row-Level Security
 * isolates tenants even when the application layer forgets to filter.
 *
 * Requires live Supabase + the campass_app credentials in apps/api/.env. This is
 * the real-DB suite; the other api integration suites mock @campusgate/db.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appClient,
  adminClient,
  seedBothTenants,
  cleanup,
  countRemainingTestRows,
  disconnect,
  seeded,
  RLS_TABLES,
  PREFIX,
} from "./helpers/tenant-escape-setup.js";

// Imported dynamically in beforeAll so the setup module (which pins
// DATABASE_URL to campass_app) has executed before @campusgate/db is loaded.
type WithTenant = <T>(
  institutionId: string,
  fn: (tx: any) => Promise<T>,
) => Promise<T>;
let withTenant: WithTenant;

describe("Cross-tenant escape suite (real DB, RLS enforced)", () => {
  beforeAll(async () => {
    ({ withTenant } = (await import("@campusgate/db")) as unknown as {
      withTenant: WithTenant;
    });
    await seedBothTenants();
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    const remaining = await countRemainingTestRows();
    expect(remaining).toBe(0);
    await disconnect();
  }, 120_000);

  it("1. read escape: tenant A cannot read tenant B's pass by id or via list", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    const foreign = await withTenant(A.institutionId, (tx) =>
      tx.gatePass.findUnique({ where: { id: B.gatePassId } }),
    );
    expect(foreign).toBeNull();

    const own = await withTenant(A.institutionId, (tx) =>
      tx.gatePass.findMany({}),
    );
    expect(own.length).toBeGreaterThan(0);
    for (const row of own) {
      expect(row.institutionId).toBe(A.institutionId);
      expect(row.id).not.toBe(B.gatePassId);
    }
  }, 60_000);

  it("2. write escape: tenant A cannot create a pass referencing tenant B's student", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.gatePass.create({
          data: {
            passNumber: `${PREFIX}ILLEGAL_FOREIGN_PARENT`,
            institutionId: A.institutionId,
            studentId: B.studentProfileId, // B's student under A's tenant
            reasonId: A.reasonId,
            requestedExit: new Date(),
            expectedReturn: new Date(Date.now() + 3600_000),
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("3. spoofed-tenant insert: tenant A cannot insert a row stamped institutionId = B", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    await expect(
      withTenant(A.institutionId, (tx) =>
        tx.notification.create({
          data: {
            institutionId: B.institutionId, // spoof: claim to belong to B
            userId: B.userId,
            title: `${PREFIX}SPOOF`,
            body: "should be rejected by WITH CHECK",
            type: "TEST",
          },
        }),
      ),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("4. HEADLINE: a deliberately buggy query that forgets the tenant filter still returns only A's rows", async () => {
    const A = seeded.A!;
    const B = seeded.B!;

    // No where clause at all — the app "forgot" to scope. RLS is the backstop.
    const rows = await withTenant(A.institutionId, (tx) =>
      tx.gatePass.findMany({}),
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.institutionId).toBe(A.institutionId);
    }
    // None of B's rows leaked.
    expect(rows.some((r: { id: string }) => r.id === B.gatePassId)).toBe(false);

    // And it matches exactly A's seeded count (verified independently via admin).
    const aCount = await adminClient.gatePass.count({
      where: { institutionId: A.institutionId },
    });
    expect(rows.length).toBe(aCount);
  }, 60_000);

  it("5. fail-closed: a query with no tenant context set returns zero rows", async () => {
    // appClient outside withTenant => app.current_institution_id unset => NULL => no rows.
    const rows = await appClient.gatePass.findMany({
      where: { institutionId: { startsWith: PREFIX } },
    });
    expect(rows.length).toBe(0);
  }, 60_000);

  it("6. meta: every tenant-owned table has RLS enabled + forced and both policies", async () => {
    const rls = await adminClient.$queryRawUnsafe<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
      RLS_TABLES as unknown as string[],
    );

    const byName = new Map(rls.map((r) => [r.relname, r]));
    for (const table of RLS_TABLES) {
      const row = byName.get(table);
      expect(row, `table ${table} missing from pg_class`).toBeTruthy();
      expect(row!.relrowsecurity, `RLS not ENABLED on ${table}`).toBe(true);
      expect(row!.relforcerowsecurity, `RLS not FORCED on ${table}`).toBe(true);
    }

    const policies = await adminClient.$queryRawUnsafe<
      { tablename: string; policyname: string }[]
    >(
      `SELECT tablename, policyname
         FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
      RLS_TABLES as unknown as string[],
    );

    for (const table of RLS_TABLES) {
      const names = policies.filter((p) => p.tablename === table).map((p) => p.policyname);
      expect(names, `${table} missing tenant_isolation_select`).toContain(
        "tenant_isolation_select",
      );
      expect(names, `${table} missing tenant_isolation_modify`).toContain(
        "tenant_isolation_modify",
      );
    }
  }, 60_000);
});
