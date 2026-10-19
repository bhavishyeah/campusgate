/**
 * Super Admin & platform security integration suite (design §9.2) — runs against
 * the REAL Supabase instance through the SAME two connections the escape suite
 * uses (campass_app = RLS-subject appClient; postgres = RLS-bypass owner
 * adminClient), imported from the escape-setup helper so DATABASE_URL is pinned
 * to campass_app BEFORE @campusgate/db loads. It proves the FEAT-003 security
 * spine end-to-end at the database layer:
 *   (1) break-glass scope through the REAL withSupportGrant + read-only writes
 *   (3) the three GUC states on the audit_events SELECT + INSERT WITH CHECK
 *   (4) append-only: GRANT + the BEFORE UPDATE OR DELETE trigger (owner too)
 *   (5) tenant transparency of support_grants
 *   (6) grant lazy-expiry idempotency (one winner under concurrency)
 *
 * This suite is SELF-CONTAINED: it seeds its own two institutions under a
 * DISTINCT prefix (SASEC_TEST_) and tears them down itself, so it never races
 * the escape suite's ESCAPE_TEST_ rows even when vitest runs the two real-DB
 * files in parallel. Requires live Supabase + campass_app credentials.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { appClient, adminClient, disconnect } from "./helpers/tenant-escape-setup.js";

type WithSupportGrant = <T>(institutionId: string, fn: (tx: any) => Promise<T>) => Promise<T>;
type WithTenant = <T>(institutionId: string, fn: (tx: any) => Promise<T>) => Promise<T>;

let withSupportGrant: WithSupportGrant;
let withTenant: WithTenant;

const PFX = "SASEC_TEST_";
const id = (s: string) => `${PFX}${s}`;

const instA = id("inst_A");
const instB = id("inst_B");
const userA = id("user_A");
const userB = id("user_B");
const auditAId = id("audit_A");
const auditBId = id("audit_B");
const grantAId = id("grant_A");
const grantExpiredId = id("grant_expired");

// Minimal seed: the FEAT-003 DB cases only need institutions, users, audit_events
// and support_grants. No student/pass/department rows are required (the
// break-glass proxy's passes list is exercised by the live smoke test, not here).
async function seedTenant(key: "A" | "B") {
  const instId = key === "A" ? instA : instB;
  const uId = key === "A" ? userA : userB;

  await adminClient.institution.create({
    data: { id: instId, name: `${PFX}Inst ${key}`, code: id(`CODE_${key}`), status: "ACTIVE" },
  });
  await adminClient.user.create({
    data: { id: uId, email: `${PFX.toLowerCase()}${key.toLowerCase()}@example.test`, role: "ADMIN", institutionId: instId },
  });
  await adminClient.auditEvent.create({
    data: { id: key === "A" ? auditAId : auditBId, institutionId: instId, actorUserId: uId, actorRoleKey: "ADMIN", action: "campus_movement.pass.approved", resourceType: "GatePass", result: "SUCCESS" },
  });
}

async function seedAll() {
  await teardownAll(); // idempotent clean of any residue
  await seedTenant("A");
  await seedTenant("B");

  // ACTIVE grant for tenant A, operator = A's user.
  await adminClient.supportGrant.create({
    data: { id: grantAId, institutionId: instA, grantedToUserId: userA, purpose: `${PFX}break-glass probe`, status: "ACTIVE", activatedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000) },
  });
  // Stale ACTIVE grant (expiresAt in the past) for lazy-expiry idempotency.
  await adminClient.supportGrant.create({
    data: { id: grantExpiredId, institutionId: instA, grantedToUserId: userA, purpose: `${PFX}stale`, status: "ACTIVE", activatedAt: new Date(Date.now() - 7200_000), expiresAt: new Date(Date.now() - 3600_000) },
  });
}

async function teardownAll() {
  const where = { institutionId: { startsWith: PFX } };
  // audit_events is append-only (trigger rejects DELETE even for the owner);
  // disable the trigger for this scoped teardown delete, then re-enable it.
  await adminClient.$executeRawUnsafe(`ALTER TABLE "audit_events" DISABLE TRIGGER "audit_events_no_update_delete"`);
  try {
    await adminClient.auditEvent.deleteMany({ where });
  } finally {
    await adminClient.$executeRawUnsafe(`ALTER TABLE "audit_events" ENABLE TRIGGER "audit_events_no_update_delete"`);
  }
  await adminClient.supportGrant.deleteMany({ where });
  await adminClient.user.deleteMany({ where });
  await adminClient.institution.deleteMany({ where: { id: { startsWith: PFX } } });
}

describe("Super Admin & platform security (real DB, RLS + trigger enforced)", () => {
  beforeAll(async () => {
    const db = (await import("@campusgate/db")) as unknown as {
      withSupportGrant: WithSupportGrant;
      withTenant: WithTenant;
    };
    withSupportGrant = db.withSupportGrant;
    withTenant = db.withTenant;
    await seedAll();
  }, 120_000);

  afterAll(async () => {
    await teardownAll();
    await disconnect();
  }, 120_000);

  // ── (1) break-glass scope through the REAL helper ─────────────────────────
  it("1. break-glass read through withSupportGrant returns ONLY tenant A's rows", async () => {
    const scoped = await withSupportGrant(instA, (tx) =>
      tx.auditEvent.findMany({ where: { institutionId: instA } }),
    );
    expect(scoped.length).toBeGreaterThan(0);
    for (const r of scoped) expect(r.institutionId).toBe(instA);
    expect(scoped.some((r: { id: string }) => r.id === auditBId)).toBe(false);

    // Filter-less probe: RLS alone (campass_app NOBYPASSRLS + GUC) scopes to A.
    const probe = await withSupportGrant(instA, (tx) => tx.auditEvent.findMany({}));
    expect(probe.length).toBeGreaterThan(0);
    for (const r of probe) expect(r.institutionId).toBe(instA);
    expect(probe.some((r: { id: string }) => r.id === auditBId)).toBe(false);
  }, 60_000);

  it("1b. break-glass transaction is READ-ONLY by construction (a write is rejected)", async () => {
    await expect(
      withSupportGrant(instA, (tx) =>
        tx.notification.create({
          data: { institutionId: instA, userId: userA, title: `${PFX}SHOULD_FAIL`, body: "read-only", type: "TEST" },
        }),
      ),
    ).rejects.toThrow(/read-only transaction/i);
  }, 60_000);

  // ── (3) three GUC states on the audit_events SELECT + INSERT WITH CHECK ───
  it("3. audit_events RLS is fail-closed across unset / empty-string / foreign GUC", async () => {
    // Foreign-tenant GUC: set A, probe B. SELECT only A; INSERT A ok, B rejected.
    await appClient.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_institution_id', $1, true)`, instA);
      const rows = await tx.auditEvent.findMany({});
      for (const r of rows) expect(r.institutionId).toBe(instA);
      expect(rows.some((r: { id: string }) => r.id === auditBId)).toBe(false);
      await tx.auditEvent.create({
        data: { id: id(`ins_ok_${randomUUID()}`), institutionId: instA, actorUserId: userA, actorRoleKey: "ADMIN", action: "campus_movement.pass.approved", resourceType: "GatePass", result: "SUCCESS" },
      });
    });

    // INSERT stamped B while GUC = A → WITH CHECK rejects.
    await expect(
      appClient.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_institution_id', $1, true)`, instA);
        await tx.auditEvent.create({
          data: { institutionId: instB, actorUserId: userB, actorRoleKey: "ADMIN", action: "campus_movement.pass.approved", resourceType: "GatePass", result: "SUCCESS" },
        });
      }),
    ).rejects.toBeTruthy();

    // Empty-string GUC: SELECT zero, INSERT rejected (nullif collapses '').
    await appClient.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_institution_id', '', true)`);
      const rows = await tx.auditEvent.findMany({ where: { institutionId: { startsWith: PFX } } });
      expect(rows.length).toBe(0);
    });
    await expect(
      appClient.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_institution_id', '', true)`);
        await tx.auditEvent.create({
          data: { institutionId: "", actorUserId: userA, actorRoleKey: "ADMIN", action: "campus_movement.pass.approved", resourceType: "GatePass", result: "SUCCESS" },
        });
      }),
    ).rejects.toBeTruthy();

    // Unset GUC: SELECT zero, INSERT rejected.
    const unset = await appClient.auditEvent.findMany({ where: { institutionId: { startsWith: PFX } } });
    expect(unset.length).toBe(0);
    await expect(
      appClient.auditEvent.create({
        data: { institutionId: instA, actorUserId: userA, actorRoleKey: "ADMIN", action: "campus_movement.pass.approved", resourceType: "GatePass", result: "SUCCESS" },
      }),
    ).rejects.toBeTruthy();
  }, 90_000);

  // ── (4) append-only: GRANT + trigger (owner too) ──────────────────────────
  it("4. audit_events is append-only: campass_app UPDATE/DELETE + owner trigger both reject", async () => {
    // campass_app UPDATE rejected by the GRANT (UPDATE/DELETE revoked).
    await expect(
      appClient.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_institution_id', $1, true)`, instA);
        await tx.$executeRawUnsafe(`UPDATE "audit_events" SET "actorRoleKey" = 'X' WHERE "id" = $1`, auditAId);
      }),
    ).rejects.toBeTruthy();

    // The trigger rejects even the privileged OWNER for UPDATE and DELETE.
    await expect(
      adminClient.$executeRawUnsafe(`UPDATE "audit_events" SET "actorRoleKey" = 'X' WHERE "id" = $1`, auditAId),
    ).rejects.toThrow(/append-only/i);
    await expect(
      adminClient.$executeRawUnsafe(`DELETE FROM "audit_events" WHERE "id" = $1`, auditAId),
    ).rejects.toThrow(/append-only/i);

    // A privileged support_grants UPDATE (lazy-expiry path) still SUCCEEDS —
    // the trigger is scoped to audit_events only.
    const updated = await adminClient.supportGrant.updateMany({
      where: { id: grantAId },
      data: { revokedReason: `${PFX}trigger-scope-check` },
    });
    expect(updated.count).toBe(1);
    await adminClient.supportGrant.updateMany({ where: { id: grantAId }, data: { revokedReason: null } });
  }, 90_000);

  // ── (5) tenant transparency ───────────────────────────────────────────────
  it("5. tenant A sees only its own support_grants; others invisible / fail-closed", async () => {
    const grants = await withTenant(instA, (tx) => tx.supportGrant.findMany({}));
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) expect(g.institutionId).toBe(instA);

    // Without a tenant GUC, campass_app sees zero grants (fail-closed).
    const none = await appClient.supportGrant.findMany({ where: { institutionId: { startsWith: PFX } } });
    expect(none.length).toBe(0);
  }, 60_000);

  // ── (6) lazy-expiry idempotency ───────────────────────────────────────────
  it("6. two concurrent lazy-expiry updateMany produce exactly one winner", async () => {
    const now = new Date();
    const [a, b] = await Promise.all([
      adminClient.supportGrant.updateMany({ where: { id: grantExpiredId, status: "ACTIVE", expiresAt: { lte: now } }, data: { status: "EXPIRED" } }),
      adminClient.supportGrant.updateMany({ where: { id: grantExpiredId, status: "ACTIVE", expiresAt: { lte: now } }, data: { status: "EXPIRED" } }),
    ]);
    const winners = [a.count, b.count].filter((c) => c === 1).length;
    expect(winners).toBe(1);
    const grant = await adminClient.supportGrant.findUnique({ where: { id: grantExpiredId } });
    expect(grant!.status).toBe("EXPIRED");
  }, 60_000);
});
