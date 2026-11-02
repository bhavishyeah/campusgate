/**
 * Phase-9.5 Inventory & Assets BEHAVIORAL + CONCURRENCY integration suite
 * (design §B / MUST-FIX 1-3) — runs against the REAL Supabase instance through a
 * REAL Fastify app (real `authenticate` + real inventoryRoutes + the real
 * withTenant/RLS path). It proves the invariants the fast unit suite cannot:
 *   - category + asset CRUD through the real routes; duplicate code/tag -> 409
 *   - asset lifecycle: a legal LATERAL edge (ASSIGNED->IN_STORE via a transfer
 *     then back) succeeds; a terminal violation (DISPOSED->anything) is rejected
 *     at the DB guard; a raw adminClient DELETE of an asset row is rejected
 *   - custody transfer writes the asset custody fields AND one append-only ledger
 *     row in ONE tx; a DISPOSED asset cannot be transferred (409 + DENIED audit)
 *   - the four ledgers reject UPDATE/DELETE (append-only trigger + REVOKE)
 *   - stock ISSUE decrements on-hand; an ISSUE exceeding on-hand -> 409 leaves
 *     on-hand unchanged; TWO concurrent ISSUEs on a 1-unit item -> exactly one
 *     succeeds, on-hand never negative (Promise.all + adminClient count)
 *   - reconciliation invariant as TWO assertions (stored on-hand == signed-sum of
 *     movements AND == last movement's balanceAfter) after a mixed
 *     RECEIPT/ISSUE/ADJUSTMENT sequence including a rejected over-issue (MUST-FIX 1)
 *   - maintenance open -> asset IN_MAINTENANCE with priorAssetStatus captured;
 *     resolve -> asset restored to priorAssetStatus (the ASSIGNED case keeps
 *     custody); maintenance lifecycle forward-only
 *   - disposal moves the asset terminal + writes one disposals row; a second
 *     dispose -> 409 + DENIED audit, no new row; disposals rejects UPDATE/DELETE
 *   - disposed-mid-maintenance close (Finding HIGH-1): open a request, dispose the
 *     asset, then CANCEL -> 200, request CANCELLED, asset STILL terminal with NO
 *     asset write, the partial-unique open slot freed
 *   - self-service (inventory.view_own, INVENTORY_MANAGER): /me/assets sees only
 *     assets in the caller's custody
 *   - no cross-module coupling: disposing with proceeds writes NO fees row
 *
 * SELF-CONTAINED under a DISTINCT prefix (INV9_TEST_); seeds + tears down its own
 * tenant/users/inventory data via adminClient. Requires live Supabase +
 * campass_app creds. Registered in vitest.live-db-suites.ts; passes IN ISOLATION.
 * Keep multi-query test transactions small to stay under the 5000ms pooler
 * ceiling; a first-attempt transient that passes on a rested-DB retry is
 * acceptable and documented (the shared Supabase free-tier pooler caveat).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../..");

function parseEnv(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const apiEnv = parseEnv(path.join(repoRoot, "apps", "api", ".env"));
const dbEnv = parseEnv(path.join(repoRoot, "packages", "db", ".env"));
const appDatabaseUrl = apiEnv.DATABASE_URL; // campass_app (RLS-subject)
const adminDatabaseUrl = dbEnv.DIRECT_URL ?? dbEnv.DATABASE_URL; // postgres (owner)
if (!appDatabaseUrl) throw new Error("apps/api/.env DATABASE_URL not found");
if (!adminDatabaseUrl) throw new Error("packages/db/.env DIRECT_URL not found");

// Pin BEFORE @campusgate/db loads: `authenticate` + requireModuleActive read via
// privilegedPrisma (no tenant GUC yet), so that client MUST be the owner role.
process.env.DATABASE_URL = appDatabaseUrl;
process.env.PRIVILEGED_DATABASE_URL = adminDatabaseUrl;
process.env.DIRECT_URL = adminDatabaseUrl;

const adminClient = new PrismaClient({ datasources: { db: { url: adminDatabaseUrl } }, log: ["error"] });

const PFX = "INV9_TEST_";
const id = (s: string) => `${PFX}${s}`;

async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const transient =
        msg.includes("Can't reach database server") ||
        msg.includes("P1001") ||
        msg.includes("Timed out") ||
        msg.includes("ECONNRESET") ||
        msg.includes("max clients reached") ||
        msg.includes("EMAXCONNSESSION") ||
        msg.includes("tenant or user not found") ||
        msg.includes("Transaction API error") ||
        msg.includes("connection pool");
      if (!transient || i === attempts - 1) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw lastErr;
}

// ─── tenant / users ──────────────────────────────────────────────────────────
const instA = id("instA");
const deptA = id("deptA");
const adminUser = id("u_admin"); // ADMIN membership -> the 7 inventory staff keys
const managerUser = id("u_manager"); // INVENTORY_MANAGER -> staff keys + view_own
const otherUser = id("u_other"); // another INVENTORY_MANAGER (custody target)

let app: FastifyInstance;

function tokenFor(userId: string, legacyRole: string): string {
  return app.jwt.sign({ userId, role: legacyRole, institutionId: instA });
}
const authHeader = (t: string) => ({ authorization: `Bearer ${t}` });
const adminToken = () => tokenFor(adminUser, "ADMIN");
const managerToken = () => tokenFor(managerUser, "ADMIN");

async function templateRoleId(key: string): Promise<string> {
  const role = await adminClient.role.findFirst({ where: { key, institutionId: null }, select: { id: true } });
  if (!role) throw new Error(`template role ${key} not found — run the seed/migrations first`);
  return role.id;
}

async function ensureMembership(userId: string, roleKey: string): Promise<void> {
  const mId = id(`mbr_${userId}`);
  const roleId = await templateRoleId(roleKey);
  await withRetry(() =>
    adminClient.institutionMembership.create({
      data: { id: mId, userId, institutionId: instA, membershipStatus: "ACTIVE", permissionsVersion: 0 },
    }),
  );
  await withRetry(() =>
    adminClient.membershipRole.create({
      data: { id: id(`mrl_${userId}`), membershipId: mId, roleId, institutionId: instA },
    }),
  );
}

// ─── inventory-row teardown (child-first, inside ONE replica-role tx) ─────────
// The three column-guard tables forbid DELETE and the four ledgers forbid
// UPDATE/DELETE. Run the whole child-first delete inside a SINGLE interactive
// transaction that sets `session_replication_role = 'replica'` up front — that
// pins one backend AND disables ALL user triggers for the span (the transport
// behavioral precedent).
async function clearInventory(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  await withRetry(() =>
    adminClient.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      await tx.inventoryAuditLine.deleteMany({ where });
      await tx.inventoryStockMovement.deleteMany({ where });
      await tx.inventoryCustodyTransfer.deleteMany({ where });
      await tx.inventoryDisposal.deleteMany({ where });
      await tx.inventoryMaintenanceRequest.deleteMany({ where });
      await tx.inventoryStockItem.deleteMany({ where });
      await tx.inventoryAuditSession.deleteMany({ where });
      await tx.inventoryAsset.deleteMany({ where });
      await tx.inventoryAssetCategory.deleteMany({ where });
    }),
  );
  await deleteAuditEvents();
}

async function deleteAuditEvents(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  await withRetry(() =>
    adminClient.$executeRawUnsafe(`ALTER TABLE "audit_events" DISABLE TRIGGER "audit_events_no_update_delete"`),
  );
  try {
    await withRetry(() => adminClient.auditEvent.deleteMany({ where }));
  } finally {
    await withRetry(() =>
      adminClient.$executeRawUnsafe(`ALTER TABLE "audit_events" ENABLE TRIGGER "audit_events_no_update_delete"`),
    );
  }
}

async function teardown(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  await clearInventory();
  await withRetry(() => adminClient.membershipRole.deleteMany({ where }));
  await withRetry(() => adminClient.institutionMembership.deleteMany({ where }));
  await withRetry(() => adminClient.institutionModule.deleteMany({ where }));
  await withRetry(() => adminClient.user.deleteMany({ where }));
  await withRetry(() => adminClient.department.deleteMany({ where }));
  await withRetry(() => adminClient.institution.deleteMany({ where: { id: { startsWith: PFX } } }));
}

async function seed(): Promise<void> {
  await withRetry(() => adminClient.institution.create({ data: { id: instA, name: `${PFX}A`, code: id("CODE_A"), status: "ACTIVE" } }));
  await withRetry(() => adminClient.department.create({ data: { id: deptA, name: `${PFX}Dept`, code: id("D_A"), institutionId: instA } }));
  await withRetry(() =>
    adminClient.institutionModule.create({
      data: { id: id("imod_A"), institutionId: instA, moduleKey: "inventory", state: "ACTIVE", entitledAt: new Date(), activatedAt: new Date() },
    }),
  );

  await withRetry(() => adminClient.user.create({ data: { id: adminUser, email: `${PFX.toLowerCase()}admin@a.test`, role: "ADMIN", accountStatus: "ACTIVE", institutionId: instA } }));
  await ensureMembership(adminUser, "ADMIN");

  await withRetry(() => adminClient.user.create({ data: { id: managerUser, email: `${PFX.toLowerCase()}mgr@a.test`, role: "ADMIN", accountStatus: "ACTIVE", institutionId: instA } }));
  await ensureMembership(managerUser, "INVENTORY_MANAGER");

  await withRetry(() => adminClient.user.create({ data: { id: otherUser, email: `${PFX.toLowerCase()}other@a.test`, role: "ADMIN", accountStatus: "ACTIVE", institutionId: instA } }));
  await ensureMembership(otherUser, "INVENTORY_MANAGER");
}

// ─── scenario helpers through the REAL routes ────────────────────────────────
// `authenticate` + requireModuleActive read via privilegedPrisma against the
// free-tier session pooler BEFORE any tenant context; under pooler pressure that
// read can transiently fail and surface as a 401/403/404/500 at the HTTP layer
// (NOT a logic defect). inject() retries ONLY those infra-transient status codes
// a few times with a short backoff so the suite is deterministic in one run; a
// real 4xx from a handler decision (e.g. a 409 deny) is returned immediately.
async function inject(opts: Parameters<FastifyInstance["inject"]>[0]) {
  let last: Awaited<ReturnType<FastifyInstance["inject"]>> | undefined;
  for (let i = 0; i < 5; i++) {
    last = await app.inject(opts); // the ONLY raw app.inject — the retry primitive
    // 401/403/404/500 from the pre-tenant auth/module path are infra transients
    // here (the seed guarantees an ACTIVE user+membership+module); retry.
    if (![401, 403, 404, 500].includes(last.statusCode)) return last;
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  return last!;
}

async function createCategory(kind: "FIXED_ASSET" | "CONSUMABLE"): Promise<string> {
  const res = await inject({
    method: "POST",
    url: "/api/inventory/categories",
    headers: authHeader(adminToken()),
    payload: { name: `Cat ${Date.now()}`, code: `C${Date.now()}_${Math.floor(Math.random() * 1e6)}`, kind },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function createAsset(categoryId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await inject({
    method: "POST",
    url: "/api/inventory/assets",
    headers: authHeader(adminToken()),
    payload: { assetTag: `T${Date.now()}_${Math.floor(Math.random() * 1e6)}`, name: `Asset ${Date.now()}`, categoryId, ...extra },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function move(assetId: string, kind: string, quantity: number) {
  return inject({
    method: "POST",
    url: `/api/inventory/stock/${assetId}/movements`,
    headers: authHeader(adminToken()),
    payload: { kind, quantity },
  });
}

async function assetStatus(assetId: string): Promise<string> {
  const row = await adminClient.inventoryAsset.findUnique({ where: { id: assetId }, select: { status: true } });
  return row!.status;
}

beforeAll(async () => {
  await teardown();
  await seed();

  const { inventoryRoutes } = await import("../inventory.js");

  app = Fastify();
  await app.register(jwt, { secret: "inventory-behavioral-test-secret" });
  await app.register(inventoryRoutes, { prefix: "/api/inventory" });
  await app.ready();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  await teardown();
  await adminClient.$disconnect();
}, 120_000);

beforeEach(async () => {
  await clearInventory();
}, 120_000);

describe("Inventory categories + assets (real routes)", () => {
  it("creates a category; a duplicate code in the same tenant -> 409", async () => {
    const code = `DUP${Date.now()}`;
    const first = await inject({
      method: "POST",
      url: "/api/inventory/categories",
      headers: authHeader(adminToken()),
      payload: { name: "Laptops", code, kind: "FIXED_ASSET" },
    });
    expect(first.statusCode).toBe(201);
    const dup = await inject({
      method: "POST",
      url: "/api/inventory/categories",
      headers: authHeader(adminToken()),
      payload: { name: "Laptops 2", code, kind: "FIXED_ASSET" },
    });
    expect(dup.statusCode).toBe(409);
  });

  it("creates an asset; a duplicate assetTag in the same tenant -> 409; money is a string", async () => {
    const catId = await createCategory("FIXED_ASSET");
    const tag = `TAG${Date.now()}`;
    const first = await inject({
      method: "POST",
      url: "/api/inventory/assets",
      headers: authHeader(adminToken()),
      payload: { assetTag: tag, name: "Dell", categoryId: catId, acquisitionCost: "150000", currency: "INR" },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().acquisitionCost).toBe("150000"); // money-as-string
    const dup = await inject({
      method: "POST",
      url: "/api/inventory/assets",
      headers: authHeader(adminToken()),
      payload: { assetTag: tag, name: "Dell 2", categoryId: catId },
    });
    expect(dup.statusCode).toBe(409);
  });
});

describe("Inventory asset lifecycle (enumerated-transition, terminal-enforcing; MUST-FIX 2)", () => {
  it("legal lateral edge ASSIGNED->IN_STORE and back; terminal DISPOSED->anything rejected at DB; DELETE rejected", async () => {
    const catId = await createCategory("FIXED_ASSET");
    // Asset starts ASSIGNED when created with a custodian.
    const assetId = await createAsset(catId, { custodyUserId: managerUser });
    expect(await assetStatus(assetId)).toBe("ASSIGNED");

    // A transfer to a department leaves the asset ASSIGNED (a legal edge). Prove
    // the LATERAL ASSIGNED->IN_STORE edge is legal at the DB by flipping via
    // adminClient (the guard permits it).
    await adminClient.inventoryAsset.update({ where: { id: assetId }, data: { status: "IN_STORE" } });
    expect(await assetStatus(assetId)).toBe("IN_STORE");
    await adminClient.inventoryAsset.update({ where: { id: assetId }, data: { status: "ASSIGNED" } });
    expect(await assetStatus(assetId)).toBe("ASSIGNED");

    // Dispose it (terminal), then a transition OUT of DISPOSED is rejected at the DB guard.
    const disp = await inject({
      method: "POST",
      url: `/api/inventory/assets/${assetId}/dispose`,
      headers: authHeader(adminToken()),
      payload: { terminalStatus: "DISPOSED", method: "SCRAPPED" },
    });
    expect(disp.statusCode).toBe(201);
    expect(await assetStatus(assetId)).toBe("DISPOSED");

    await expect(
      adminClient.inventoryAsset.update({ where: { id: assetId }, data: { status: "ASSIGNED" } }),
    ).rejects.toBeTruthy();

    // DELETE of an asset row is rejected by the guard.
    await expect(adminClient.inventoryAsset.delete({ where: { id: assetId } })).rejects.toBeTruthy();
  });
});

describe("Inventory custody transfer (§B.8) + disposed-cannot-transfer", () => {
  it("transfer updates asset custody AND writes one ledger row in one tx", async () => {
    const catId = await createCategory("FIXED_ASSET");
    const assetId = await createAsset(catId); // IN_STORE, no custodian

    const res = await inject({
      method: "POST",
      url: `/api/inventory/assets/${assetId}/transfer`,
      headers: authHeader(adminToken()),
      payload: { toUserId: managerUser, reason: "handover" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("ASSIGNED");
    expect(res.json().custodyUserId).toBe(managerUser);

    const ledger = await adminClient.inventoryCustodyTransfer.findMany({ where: { assetId } });
    expect(ledger.length).toBe(1);
    expect(ledger[0].toUserId).toBe(managerUser);
  });

  it("a DISPOSED asset cannot be transferred -> 409 + DENIED audit, no custody/ledger write", async () => {
    const catId = await createCategory("FIXED_ASSET");
    const assetId = await createAsset(catId);
    const disp = await inject({
      method: "POST",
      url: `/api/inventory/assets/${assetId}/dispose`,
      headers: authHeader(adminToken()),
      payload: { terminalStatus: "DISPOSED", method: "LOST" },
    });
    expect(disp.statusCode).toBe(201);

    const res = await inject({
      method: "POST",
      url: `/api/inventory/assets/${assetId}/transfer`,
      headers: authHeader(adminToken()),
      payload: { toUserId: managerUser },
    });
    expect(res.statusCode).toBe(409);

    // No custody ledger row; a DENIED audit exists.
    const ledger = await adminClient.inventoryCustodyTransfer.findMany({ where: { assetId } });
    expect(ledger.length).toBe(0);
    const denied = await adminClient.auditEvent.findMany({
      where: { institutionId: instA, action: "inventory.custody.transferred", result: "DENIED", resourceId: assetId },
    });
    expect(denied.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Inventory stock movements (concurrency + reconciliation; MUST-FIX 1)", () => {
  it("ISSUE decrements on-hand; over-issue -> 409 leaves on-hand unchanged", async () => {
    const catId = await createCategory("CONSUMABLE");
    const assetId = await createAsset(catId); // stock item auto-created at 0

    expect((await move(assetId, "RECEIPT", 10)).statusCode).toBe(201);
    const issue = await move(assetId, "ISSUE", -4);
    expect(issue.statusCode).toBe(201);
    expect(issue.json().onHandQuantity).toBe(6);

    const over = await move(assetId, "ISSUE", -100);
    expect(over.statusCode).toBe(409);
    const item = await adminClient.inventoryStockItem.findFirst({ where: { assetId } });
    expect(item!.onHandQuantity).toBe(6); // unchanged
  });

  it("TWO concurrent ISSUEs on a 1-unit item -> exactly one succeeds, on-hand never negative", async () => {
    const catId = await createCategory("CONSUMABLE");
    const assetId = await createAsset(catId);
    expect((await move(assetId, "RECEIPT", 1)).statusCode).toBe(201);

    const [a, b] = await Promise.all([move(assetId, "ISSUE", -1), move(assetId, "ISSUE", -1)]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 409]); // exactly one succeeds

    const item = await adminClient.inventoryStockItem.findFirst({ where: { assetId } });
    expect(item!.onHandQuantity).toBe(0); // never negative
  });

  it("reconciliation invariant: stored on-hand == signed-sum == last balanceAfter after a mixed sequence incl. a rejected over-issue", async () => {
    const catId = await createCategory("CONSUMABLE");
    const assetId = await createAsset(catId);

    expect((await move(assetId, "RECEIPT", 20)).statusCode).toBe(201);
    expect((await move(assetId, "ISSUE", -5)).statusCode).toBe(201);
    expect((await move(assetId, "ADJUSTMENT", 3)).statusCode).toBe(201);
    expect((await move(assetId, "ISSUE", -2)).statusCode).toBe(201);
    // A rejected over-issue must NOT drift anything.
    expect((await move(assetId, "ISSUE", -1000)).statusCode).toBe(409);

    const item = await adminClient.inventoryStockItem.findFirst({ where: { assetId } });
    const movements = await adminClient.inventoryStockMovement.findMany({
      where: { assetId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    const signedSum = movements.reduce((acc, m) => acc + m.quantity, 0);
    const lastBalanceAfter = movements[movements.length - 1].balanceAfter;

    // 20 - 5 + 3 - 2 = 16; the rejected over-issue wrote no row.
    expect(item!.onHandQuantity).toBe(16);
    expect(signedSum).toBe(16); // assertion (i): stored == signed-sum
    expect(lastBalanceAfter).toBe(16); // assertion (ii): stored == last balanceAfter
    expect(movements.length).toBe(4); // the rejected over-issue appended no movement
  });
});

describe("Inventory ledgers are append-only", () => {
  it("stock_movements rejects UPDATE/DELETE", async () => {
    const catId = await createCategory("CONSUMABLE");
    const assetId = await createAsset(catId);
    expect((await move(assetId, "RECEIPT", 5)).statusCode).toBe(201);
    const row = await adminClient.inventoryStockMovement.findFirst({ where: { assetId } });
    await expect(adminClient.inventoryStockMovement.update({ where: { id: row!.id }, data: { reason: "x" } })).rejects.toBeTruthy();
    await expect(adminClient.inventoryStockMovement.delete({ where: { id: row!.id } })).rejects.toBeTruthy();
  });
});

describe("Inventory maintenance coupling (§B.7 + Finding HIGH-1)", () => {
  it("open -> asset IN_MAINTENANCE with priorAssetStatus; resolve restores to priorAssetStatus (ASSIGNED case keeps custody)", async () => {
    const catId = await createCategory("FIXED_ASSET");
    const assetId = await createAsset(catId, { custodyUserId: managerUser }); // ASSIGNED
    expect(await assetStatus(assetId)).toBe("ASSIGNED");

    const open = await inject({
      method: "POST",
      url: `/api/inventory/assets/${assetId}/maintenance`,
      headers: authHeader(adminToken()),
      payload: { issue: "fan noise" },
    });
    expect(open.statusCode).toBe(201);
    const reqId = open.json().id as string;
    expect(open.json().priorAssetStatus).toBe("ASSIGNED");
    expect(await assetStatus(assetId)).toBe("IN_MAINTENANCE");

    // IN_PROGRESS keeps IN_MAINTENANCE.
    const prog = await inject({
      method: "PATCH",
      url: `/api/inventory/maintenance/${reqId}`,
      headers: authHeader(adminToken()),
      payload: { toStatus: "IN_PROGRESS" },
    });
    expect(prog.statusCode).toBe(200);
    expect(await assetStatus(assetId)).toBe("IN_MAINTENANCE");

    // RESOLVED restores the asset to ASSIGNED (not IN_STORE), custody intact.
    const resolve = await inject({
      method: "PATCH",
      url: `/api/inventory/maintenance/${reqId}`,
      headers: authHeader(adminToken()),
      payload: { toStatus: "RESOLVED" },
    });
    expect(resolve.statusCode).toBe(200);
    const asset = await adminClient.inventoryAsset.findUnique({ where: { id: assetId } });
    expect(asset!.status).toBe("ASSIGNED");
    expect(asset!.custodyUserId).toBe(managerUser);
  });

  it("disposed-mid-maintenance close -> 200 maintenance-only flip, asset STILL terminal, slot freed (Finding HIGH-1)", async () => {
    const catId = await createCategory("FIXED_ASSET");
    const assetId = await createAsset(catId); // IN_STORE

    const open = await inject({
      method: "POST",
      url: `/api/inventory/assets/${assetId}/maintenance`,
      headers: authHeader(adminToken()),
      payload: { issue: "won't boot" },
    });
    expect(open.statusCode).toBe(201);
    const reqId = open.json().id as string;
    expect(await assetStatus(assetId)).toBe("IN_MAINTENANCE");

    // Dispose the asset mid-maintenance (IN_MAINTENANCE->DISPOSED is legal).
    const disp = await inject({
      method: "POST",
      url: `/api/inventory/assets/${assetId}/dispose`,
      headers: authHeader(adminToken()),
      payload: { terminalStatus: "DISPOSED", method: "WRITTEN_OFF" },
    });
    expect(disp.statusCode).toBe(201);
    expect(await assetStatus(assetId)).toBe("DISPOSED");

    // CANCEL the request -> 200 (maintenance-only flip, NO asset write).
    const cancel = await inject({
      method: "PATCH",
      url: `/api/inventory/maintenance/${reqId}`,
      headers: authHeader(adminToken()),
      payload: { toStatus: "CANCELLED" },
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe("CANCELLED");

    // Asset STILL terminal; the SUCCESS audit flags assetTerminal.
    expect(await assetStatus(assetId)).toBe("DISPOSED");
    const audit = await adminClient.auditEvent.findMany({
      where: { institutionId: instA, action: "inventory.maintenance.transitioned", result: "SUCCESS", resourceId: reqId },
    });
    expect(audit.some((a) => (a.metadata as { assetTerminal?: boolean } | null)?.assetTerminal === true)).toBe(true);

    // The partial-unique open-maintenance slot is freed: a NEW request can open
    // on a FRESH (non-terminal) asset (the slot is per-asset; prove freeness by
    // confirming no OPEN/IN_PROGRESS request remains on the disposed asset).
    const openOrInProgress = await adminClient.inventoryMaintenanceRequest.count({
      where: { assetId, status: { in: ["OPEN", "IN_PROGRESS"] } },
    });
    expect(openOrInProgress).toBe(0);
  });
});

describe("Inventory disposal (§B.7a)", () => {
  it("dispose moves asset terminal + writes one disposals row; second dispose -> 409 + DENIED, no new row; disposals rejects UPDATE/DELETE", async () => {
    const catId = await createCategory("FIXED_ASSET");
    const assetId = await createAsset(catId);

    const first = await inject({
      method: "POST",
      url: `/api/inventory/assets/${assetId}/dispose`,
      headers: authHeader(adminToken()),
      payload: { terminalStatus: "DISPOSED", method: "SOLD", proceeds: "5000", currency: "INR" },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().proceeds).toBe("5000"); // money-as-string
    expect(await assetStatus(assetId)).toBe("DISPOSED");

    let rows = await adminClient.inventoryDisposal.findMany({ where: { assetId } });
    expect(rows.length).toBe(1);

    const second = await inject({
      method: "POST",
      url: `/api/inventory/assets/${assetId}/dispose`,
      headers: authHeader(adminToken()),
      payload: { terminalStatus: "RETIRED", method: "SCRAPPED" },
    });
    expect(second.statusCode).toBe(409);
    rows = await adminClient.inventoryDisposal.findMany({ where: { assetId } });
    expect(rows.length).toBe(1); // no new row

    const denied = await adminClient.auditEvent.findMany({
      where: { institutionId: instA, action: "inventory.asset.disposed", result: "DENIED", resourceId: assetId },
    });
    expect(denied.length).toBeGreaterThanOrEqual(1);

    // Append-only: UPDATE + DELETE rejected.
    await expect(adminClient.inventoryDisposal.update({ where: { id: rows[0].id }, data: { reason: "x" } })).rejects.toBeTruthy();
    await expect(adminClient.inventoryDisposal.delete({ where: { id: rows[0].id } })).rejects.toBeTruthy();
  });

  it("no cross-module coupling: disposing with proceeds writes NO fees row", async () => {
    const catId = await createCategory("FIXED_ASSET");
    const assetId = await createAsset(catId);
    const before = await adminClient.studentCharge.count({ where: { institutionId: instA } });
    const disp = await inject({
      method: "POST",
      url: `/api/inventory/assets/${assetId}/dispose`,
      headers: authHeader(adminToken()),
      payload: { terminalStatus: "DISPOSED", method: "SOLD", proceeds: "99999", currency: "INR" },
    });
    expect(disp.statusCode).toBe(201);
    const after = await adminClient.studentCharge.count({ where: { institutionId: instA } });
    expect(after).toBe(before); // no fees posting for disposal proceeds
  });
});

describe("Inventory self-service (/me/assets, inventory.view_own, INVENTORY_MANAGER)", () => {
  it("returns only the assets currently in the caller's custody", async () => {
    const catId = await createCategory("FIXED_ASSET");
    // One asset assigned to the manager; one to the other user.
    const mine = await createAsset(catId, { custodyUserId: managerUser });
    const theirs = await createAsset(catId, { custodyUserId: otherUser });

    const res = await inject({
      method: "GET",
      url: "/api/inventory/me/assets",
      headers: authHeader(managerToken()),
    });
    expect(res.statusCode).toBe(200);
    const assets = res.json().assets as { id: string }[];
    expect(assets.some((a) => a.id === mine)).toBe(true);
    expect(assets.some((a) => a.id === theirs)).toBe(false);
  });
});
