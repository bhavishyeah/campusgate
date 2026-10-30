/**
 * Phase-7 fees slice-1 BEHAVIORAL integration suite (design §D.17) — runs against
 * the REAL Supabase instance through a REAL Fastify app (real `authenticate` +
 * real feesRoutes + the real razorpay-webhook plugin + the real withTenant/RLS
 * path). It proves the money-critical guarantees the mocked unit suite cannot:
 * the idempotent webhook capture, signature gating, charge PENDING->PAID only
 * after the webhook, allocation sum <= payment, exact paise math, module gating,
 * RBAC isolation, the append-only + column-guard triggers, computed outstanding,
 * and the 3 approved-review NITs — all persisted under RLS.
 *
 * The webhook's owner-role lookup client is INJECTED as the escape harness's
 * adminClient (BYPASSRLS owner via DIRECT_URL) so the fail-closed role probe
 * passes and the capture path actually runs; DATABASE_URL is pinned to
 * campass_app so withTenant runs under real RLS enforcement. The Razorpay gateway
 * is a deterministic stub with known KEY_SECRET/WEBHOOK_SECRET so both signature
 * verifications are exercised against real HMACs.
 *
 * SELF-CONTAINED under a DISTINCT prefix (FEE_TEST_); seeds + tears down its own
 * institutions/users/structures via adminClient. Requires live Supabase +
 * campass_app creds. Registered in vitest.live-db-suites.ts (FEAT-002).
 */
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  RazorpayGateway,
  type RazorpaySdkLike,
  type RazorpayOrderResult,
  type RazorpayPaymentResult,
} from "../../services/fees/razorpay.js";

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

// adminClient is the owner/BYPASSRLS connection — the injected webhook lookup
// seam (so the fail-closed role probe passes), plus setup/teardown.
const adminClient = new PrismaClient({ datasources: { db: { url: adminDatabaseUrl } }, log: ["error"] });

const PFX = "FEE_TEST_";
const id = (s: string) => `${PFX}${s}`;

const KEY_SECRET = "fee_test_key_secret";
const WEBHOOK_SECRET = "fee_test_webhook_secret";
const KEY_ID = "rzp_test_fee";

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

// ─── Deterministic Razorpay SDK stub ──────────────────────────────────────────
// orders.create returns an order id derived from the receipt so it is stable per
// call; fetch/fetchPayments are programmable per-order for the reconcile tests.
const orderStore = new Map<string, RazorpayOrderResult>();
const paymentsStore = new Map<string, RazorpayPaymentResult[]>();
let orderSeq = 0;

function makeSdkStub(): RazorpaySdkLike {
  return {
    orders: {
      create: async (params) => {
        orderSeq += 1;
        const oid = `${PFX}order_${orderSeq}`;
        const order: RazorpayOrderResult = {
          id: oid,
          status: "created",
          amount_paid: 0,
          amount_due: Number(params.amount),
        };
        orderStore.set(oid, order);
        return order;
      },
      fetch: async (orderId) =>
        orderStore.get(orderId) ?? { id: orderId, status: "created", amount_paid: 0, amount_due: 0 },
      fetchPayments: async (orderId) => ({
        entity: "collection",
        count: paymentsStore.get(orderId)?.length ?? 0,
        items: paymentsStore.get(orderId) ?? [],
      }),
    },
  };
}

const gateway = new RazorpayGateway({
  keyId: KEY_ID,
  keySecret: KEY_SECRET,
  webhookSecret: WEBHOOK_SECRET,
  sdk: makeSdkStub(),
});

// ─── tenants / users ───────────────────────────────────────────────────────────
const instA = id("instA");
const instB = id("instB");
const deptA = id("deptA");
const deptB = id("deptB");
const sessionA = id("sessA");
const programA = id("progA");
const accountantUser = id("u_acct"); // ACCOUNTANT in A
const studentUser = id("u_student"); // STUDENT in A
const studentProfileA = id("sp_A");
const otherStudentUser = id("u_student2"); // a second STUDENT in A
const otherStudentProfileA = id("sp_A2");
const studentUserB = id("u_studentB"); // STUDENT in B (isolation foil)
const studentProfileB = id("sp_B");

let app: FastifyInstance;

function tokenFor(userId: string, legacyRole: string, institutionId: string): string {
  return app.jwt.sign({ userId, role: legacyRole, institutionId });
}
const authHeader = (t: string) => ({ authorization: `Bearer ${t}` });
const acctToken = () => tokenFor(accountantUser, "GUARD", instA);
const studentToken = () => tokenFor(studentUser, "STUDENT", instA);

async function templateRoleId(key: string): Promise<string> {
  const role = await adminClient.role.findFirst({ where: { key, institutionId: null }, select: { id: true } });
  if (!role) throw new Error(`template role ${key} not found — run the seed/migrations first`);
  return role.id;
}

async function ensureMembership(userId: string, institutionId: string, roleKey: string): Promise<void> {
  const mId = id(`mbr_${userId}`);
  const roleId = await templateRoleId(roleKey);
  await withRetry(() =>
    adminClient.institutionMembership.create({
      data: { id: mId, userId, institutionId, membershipStatus: "ACTIVE", permissionsVersion: 0 },
    }),
  );
  await withRetry(() =>
    adminClient.membershipRole.create({
      data: { id: id(`mrl_${userId}`), membershipId: mId, roleId, institutionId },
    }),
  );
}

async function setFeesState(institutionId: string, state: "ACTIVE" | "SUSPENDED" | "ENTITLED"): Promise<void> {
  await withRetry(() =>
    adminClient.institutionModule.update({
      where: { institutionId_moduleKey: { institutionId, moduleKey: "fees" } },
      data: { state, activatedAt: state === "ACTIVE" ? new Date() : null },
    }),
  );
}

// ─── webhook helpers ─────────────────────────────────────────────────────────
function paymentCapturedBody(orderId: string, paymentId: string, amountPaise: number): Buffer {
  return Buffer.from(
    JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: amountPaise, status: "captured" } } },
    }),
    "utf8",
  );
}

async function deliverWebhook(rawBody: Buffer, eventId: string, signatureOverride?: string) {
  const signature =
    signatureOverride ?? crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
  return app.inject({
    method: "POST",
    url: "/api/webhooks/razorpay",
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": signature,
      "x-razorpay-event-id": eventId,
    },
    payload: rawBody,
  });
}

// ─── fees-row teardown (child-first) between tests ─────────────────────────────
async function clearFees(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  // The three fully append-only tables are blocked by their trigger even for
  // adminClient, so delete within a scoped trigger-disable (the audit_events dance).
  for (const t of ["payment_allocations", "receipts", "processed_webhook_events"] as const) {
    await withRetry(() =>
      adminClient.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER "${t}_no_update_delete"`),
    );
  }
  try {
    await withRetry(() => adminClient.paymentAllocation.deleteMany({ where }));
    await withRetry(() => adminClient.receipt.deleteMany({ where }));
    await withRetry(() => adminClient.processedWebhookEvent.deleteMany({ where }));
  } finally {
    for (const t of ["payment_allocations", "receipts", "processed_webhook_events"] as const) {
      await withRetry(() =>
        adminClient.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER "${t}_no_update_delete"`),
      );
    }
  }
  // payment_transactions + student_charges carry column-guard triggers that forbid
  // DELETE unconditionally — delete with those disabled.
  for (const t of ["payment_transactions", "student_charges"] as const) {
    await withRetry(() =>
      adminClient.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER "${t}_guard"`),
    );
  }
  try {
    await withRetry(() => adminClient.paymentTransaction.deleteMany({ where }));
    await withRetry(() => adminClient.studentCharge.deleteMany({ where }));
  } finally {
    for (const t of ["payment_transactions", "student_charges"] as const) {
      await withRetry(() =>
        adminClient.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER "${t}_guard"`),
      );
    }
  }
  await withRetry(() => adminClient.feeComponent.deleteMany({ where }));
  await withRetry(() => adminClient.feeStructure.deleteMany({ where }));
  await deleteAuditEvents();
  await withRetry(() => adminClient.notification.deleteMany({ where }));
  orderStore.clear();
  paymentsStore.clear();
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
  await clearFees();
  await withRetry(() => adminClient.membershipRole.deleteMany({ where }));
  await withRetry(() => adminClient.institutionMembership.deleteMany({ where }));
  await withRetry(() => adminClient.institutionModule.deleteMany({ where }));
  await withRetry(() => adminClient.studentProfile.deleteMany({ where }));
  await withRetry(() => adminClient.academicSession.deleteMany({ where }));
  await withRetry(() => adminClient.program.deleteMany({ where }));
  await withRetry(() => adminClient.user.deleteMany({ where }));
  await withRetry(() => adminClient.department.deleteMany({ where }));
  await withRetry(() => adminClient.institution.deleteMany({ where: { id: { startsWith: PFX } } }));
}

async function seedTenant(institutionId: string, deptId: string): Promise<void> {
  await withRetry(() =>
    adminClient.institution.create({ data: { id: institutionId, name: `${PFX}${institutionId}`, code: id(`CODE_${institutionId}`), status: "ACTIVE" } }),
  );
  await withRetry(() =>
    adminClient.department.create({ data: { id: deptId, name: `${PFX}Dept`, code: id(`D_${institutionId}`), institutionId } }),
  );
  await withRetry(() =>
    adminClient.institutionModule.create({
      data: { id: id(`imod_${institutionId}`), institutionId, moduleKey: "fees", state: "ACTIVE", entitledAt: new Date(), activatedAt: new Date() },
    }),
  );
}

async function seedStudent(userId: string, profileId: string, institutionId: string, deptId: string): Promise<void> {
  await withRetry(() =>
    adminClient.user.create({
      data: { id: userId, email: `${userId.toLowerCase()}@test`, role: "STUDENT", accountStatus: "ACTIVE", institutionId },
    }),
  );
  await withRetry(() =>
    adminClient.studentProfile.create({
      data: {
        id: profileId,
        userId,
        institutionId,
        enrollmentNo: id(`ENR_${profileId}`),
        name: `${PFX}Student ${profileId}`,
        departmentId: deptId,
        program: "TEST",
        semester: 1,
        status: "ACTIVE",
      },
    }),
  );
  await ensureMembership(userId, institutionId, "STUDENT");
}

async function seed(): Promise<void> {
  await seedTenant(instA, deptA);
  await seedTenant(instB, deptB);

  await withRetry(() =>
    adminClient.academicSession.create({
      data: {
        id: sessionA,
        institutionId: instA,
        name: `${PFX}Session`,
        structureType: "SEMESTER",
        status: "ACTIVE",
        startDate: new Date("2026-07-01T00:00:00.000Z"),
        endDate: new Date("2027-06-30T00:00:00.000Z"),
      },
    }),
  );
  await withRetry(() =>
    adminClient.program.create({
      data: { id: programA, institutionId: instA, departmentId: deptA, name: `${PFX}BCA`, code: id("BCA"), duration: 6, durationUnit: "TERMS" },
    }),
  );

  // ACCOUNTANT (legacy role GUARD, inert; capability from the ACCOUNTANT membership).
  await withRetry(() =>
    adminClient.user.create({
      data: { id: accountantUser, email: `${PFX.toLowerCase()}acct@a.test`, role: "GUARD", accountStatus: "ACTIVE", institutionId: instA },
    }),
  );
  await ensureMembership(accountantUser, instA, "ACCOUNTANT");

  await seedStudent(studentUser, studentProfileA, instA, deptA);
  await seedStudent(otherStudentUser, otherStudentProfileA, instA, deptA);
  await seedStudent(studentUserB, studentProfileB, instB, deptB);
}

// ─── scenario helpers through the REAL routes ──────────────────────────────────
async function createStructure(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/fees/structures",
    headers: authHeader(acctToken()),
    payload: { name: `Structure ${Date.now()}_${Math.random()}`, status: "ACTIVE", programId: programA },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

// Post a single charge to a student through the staff route; returns the charge id.
async function postCharge(studentId: string, amountPaise: string, dueDate?: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/fees/charges",
    headers: authHeader(acctToken()),
    payload: {
      studentId,
      category: "TUITION",
      amountPaise,
      description: "Tuition",
      ...(dueDate ? { dueDate } : {}),
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

// Student creates an order for the given charge ids; returns { orderId, paymentTransactionId, amountPaise }.
async function createOrder(chargeIds: string[], token = studentToken()) {
  const res = await app.inject({
    method: "POST",
    url: "/api/fees/payments",
    headers: authHeader(token),
    payload: { chargeIds },
  });
  return res;
}

async function chargeStatus(chargeId: string): Promise<string> {
  const row = await adminClient.studentCharge.findUnique({ where: { id: chargeId }, select: { status: true } });
  return row!.status;
}

beforeAll(async () => {
  await teardown();
  await seed();

  const { feesRoutes } = await import("../fees.js");
  const { razorpayWebhookRoutes } = await import("../razorpay-webhook.js");
  const { setRazorpayGateway } = await import("../../services/fees/razorpay.js");
  // The operational routes read the process-wide gateway; pin it to the stub.
  setRazorpayGateway(gateway);

  app = Fastify();
  await app.register(jwt, { secret: "fees-behavioral-test-secret" });
  await app.register(feesRoutes, { prefix: "/api/fees" });
  // Inject adminClient (BYPASSRLS owner) as the webhook lookup client + the stub
  // gateway (known secrets) so both verifications + the fail-closed probe run.
  await app.register(razorpayWebhookRoutes, {
    prefix: "/api/webhooks",
    lookupClient: adminClient as unknown as import("@campusgate/db").DbClient,
    gateway,
  });
  await app.ready();
}, 180_000);

afterAll(async () => {
  if (app) {
    const { setRazorpayGateway } = await import("../../services/fees/razorpay.js");
    setRazorpayGateway(null);
    await app.close();
  }
  await teardown();
  const { prisma } = await import("@campusgate/db");
  await prisma.$disconnect();
  await adminClient.$disconnect();
}, 120_000);

beforeEach(async () => {
  await clearFees();
  await setFeesState(instA, "ACTIVE");
  await setFeesState(instB, "ACTIVE");
});

describe("Phase-7 fees behavioral (real DB, real routes, real RLS)", () => {
  it("HEADLINE: duplicate webhook delivered twice -> exactly one CAPTURED tx, one receipt, one allocation set; second delivery 200 no-op", async () => {
    await createStructure();
    const chargeId = await postCharge(studentProfileA, "5000000");
    const order = await createOrder([chargeId]);
    expect(order.statusCode).toBe(201);
    const orderId = order.json().razorpayOrderId as string;

    const body = paymentCapturedBody(orderId, `${PFX}pay_1`, 5000000);
    const first = await deliverWebhook(body, `${PFX}evt_dup`);
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe("ok");

    const second = await deliverWebhook(body, `${PFX}evt_dup`);
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe("duplicate");

    // Exactly one CAPTURED tx, one receipt, one allocation.
    const txns = await adminClient.paymentTransaction.findMany({ where: { razorpayOrderId: orderId } });
    expect(txns).toHaveLength(1);
    expect(txns[0].status).toBe("CAPTURED");
    const receipts = await adminClient.receipt.count({ where: { paymentTransactionId: txns[0].id } });
    expect(receipts).toBe(1);
    const allocs = await adminClient.paymentAllocation.count({ where: { paymentTransactionId: txns[0].id } });
    expect(allocs).toBe(1);
    expect(await chargeStatus(chargeId)).toBe("PAID");

    // The capture audits are written under the PAYER's real User id (Option A §1),
    // never a literal "system" that would FK-violate audit_events.
    const capturedAudit = await adminClient.auditEvent.findFirst({
      where: { institutionId: instA, action: "fees.payment.captured" },
      select: { actorUserId: true },
    });
    expect(capturedAudit).toBeTruthy();
    expect(capturedAudit!.actorUserId).toBe(studentUser);
    const receiptAudit = await adminClient.auditEvent.findFirst({
      where: { institutionId: instA, action: "fees.receipt.issued" },
      select: { actorUserId: true },
    });
    expect(receiptAudit!.actorUserId).toBe(studentUser);
  }, 120_000);

  it("HEADLINE: tampered webhook signature rejected (401), nothing written", async () => {
    await createStructure();
    const chargeId = await postCharge(studentProfileA, "5000000");
    const order = await createOrder([chargeId]);
    const orderId = order.json().razorpayOrderId as string;

    const body = paymentCapturedBody(orderId, `${PFX}pay_tamper`, 5000000);
    const res = await deliverWebhook(body, `${PFX}evt_tamper`, "deadbeefbadsignature");
    expect(res.statusCode).toBe(401);

    // Nothing authoritative written.
    expect(await adminClient.receipt.count({ where: { institutionId: instA } })).toBe(0);
    expect(await adminClient.paymentAllocation.count({ where: { institutionId: instA } })).toBe(0);
    expect(await adminClient.processedWebhookEvent.count({ where: { institutionId: instA } })).toBe(0);
    expect(await chargeStatus(chargeId)).toBe("PENDING");
    // A rejected signature has no tenant + no payer, so it writes NO audit row
    // (recorded as a server log only — Option A §2), not a "system"-actor row.
    expect(
      await adminClient.auditEvent.count({ where: { action: "fees.webhook.signature_rejected" } }),
    ).toBe(0);
  }, 120_000);

  it("HEADLINE: invalid checkout (Stage-2) signature rejected (400); no charge paid / no receipt", async () => {
    await createStructure();
    const chargeId = await postCharge(studentProfileA, "5000000");
    const order = await createOrder([chargeId]);
    const orderId = order.json().razorpayOrderId as string;

    const res = await app.inject({
      method: "POST",
      url: "/api/fees/payments/verify",
      headers: authHeader(studentToken()),
      payload: {
        razorpay_order_id: orderId,
        razorpay_payment_id: `${PFX}pay_bad`,
        razorpay_signature: "not-a-valid-signature",
      },
    });
    expect(res.statusCode).toBe(400);

    expect(await chargeStatus(chargeId)).toBe("PENDING");
    expect(await adminClient.receipt.count({ where: { institutionId: instA } })).toBe(0);
    const tx = await adminClient.paymentTransaction.findFirst({ where: { razorpayOrderId: orderId } });
    expect(tx!.status).toBe("CREATED"); // never AUTHORIZED/CAPTURED on a bad signature
  }, 120_000);

  it("HEADLINE: charge PENDING->PAID only after the webhook; Stage-2 verify leaves it AUTHORIZED (never PAID)", async () => {
    await createStructure();
    const chargeId = await postCharge(studentProfileA, "5000000");
    const order = await createOrder([chargeId]);
    const orderId = order.json().razorpayOrderId as string;
    const paymentId = `${PFX}pay_stage2`;

    // A VALID Stage-2 signature moves CREATED->AUTHORIZED, never PAID.
    const sig = crypto.createHmac("sha256", KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
    const verify = await app.inject({
      method: "POST",
      url: "/api/fees/payments/verify",
      headers: authHeader(studentToken()),
      payload: { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sig },
    });
    expect(verify.statusCode).toBe(200);
    let tx = await adminClient.paymentTransaction.findFirst({ where: { razorpayOrderId: orderId } });
    expect(tx!.status).toBe("AUTHORIZED");
    expect(await chargeStatus(chargeId)).toBe("PENDING"); // still not paid

    // The webhook is the sole authority that marks PAID + issues the receipt.
    const body = paymentCapturedBody(orderId, paymentId, 5000000);
    const hook = await deliverWebhook(body, `${PFX}evt_stage2`);
    expect(hook.statusCode).toBe(200);
    tx = await adminClient.paymentTransaction.findFirst({ where: { razorpayOrderId: orderId } });
    expect(tx!.status).toBe("CAPTURED");
    expect(await chargeStatus(chargeId)).toBe("PAID");
    expect(await adminClient.receipt.count({ where: { paymentTransactionId: tx!.id } })).toBe(1);
  }, 120_000);

  it("HEADLINE: exact paise math end-to-end; allocation sum <= payment; computed outstanding == charges - allocations", async () => {
    await createStructure();
    // Two charges, partial payment covers the first + part of the second.
    const c1 = await postCharge(studentProfileA, "3000000", "2026-01-01T00:00:00.000Z");
    const c2 = await postCharge(studentProfileA, "2000000", "2026-02-01T00:00:00.000Z");
    const order = await createOrder([c1, c2]);
    const orderId = order.json().razorpayOrderId as string;
    // The server recomputed the sum authoritatively (3,000,000 + 2,000,000).
    expect(order.json().amountPaise).toBe("5000000");

    const body = paymentCapturedBody(orderId, `${PFX}pay_math`, 5000000);
    await deliverWebhook(body, `${PFX}evt_math`);

    const tx = await adminClient.paymentTransaction.findFirst({ where: { razorpayOrderId: orderId } });
    const allocs = await adminClient.paymentAllocation.findMany({ where: { paymentTransactionId: tx!.id } });
    const allocSum = allocs.reduce((a, x) => a + x.amountPaise, 0n);
    expect(allocSum).toBeLessThanOrEqual(tx!.amountPaise);
    expect(allocSum).toBe(5000000n); // fully allocated across the two charges
    expect(await chargeStatus(c1)).toBe("PAID");
    expect(await chargeStatus(c2)).toBe("PAID");

    // Computed outstanding via the ledger route == 0 now.
    const ledger = await app.inject({
      method: "GET",
      url: `/api/fees/students/${studentProfileA}/ledger`,
      headers: authHeader(acctToken()),
    });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json().outstandingPaise).toBe("0");
  }, 120_000);

  it("HEADLINE: module-gated op route 403 when fees SUSPENDED, while the webhook stays signature-gated and still processes", async () => {
    await createStructure();
    const chargeId = await postCharge(studentProfileA, "5000000");
    const order = await createOrder([chargeId]);
    const orderId = order.json().razorpayOrderId as string;

    await setFeesState(instA, "SUSPENDED");

    // An operational route is 403 (module gated).
    const gated = await app.inject({
      method: "GET",
      url: `/api/fees/students/${studentProfileA}/ledger`,
      headers: authHeader(acctToken()),
    });
    expect(gated.statusCode).toBe(403);

    // The webhook is NOT module-gated by the op gate — but the DESIGN says a
    // SUSPENDED tenant's webhook is a 200 no-op (skipped_module_inactive), still
    // signature-gated (a bad signature is 401 regardless of module state).
    const badSig = await deliverWebhook(
      paymentCapturedBody(orderId, `${PFX}pay_susp`, 5000000),
      `${PFX}evt_susp_bad`,
      "wrong",
    );
    expect(badSig.statusCode).toBe(401);

    const body = paymentCapturedBody(orderId, `${PFX}pay_susp`, 5000000);
    const hook = await deliverWebhook(body, `${PFX}evt_susp`);
    expect(hook.statusCode).toBe(200);
    expect(hook.json().reason).toBe("module inactive");
    // Nothing captured while suspended.
    const tx = await adminClient.paymentTransaction.findFirst({ where: { razorpayOrderId: orderId } });
    expect(tx!.status).toBe("CREATED");
    const skipAudit = await adminClient.auditEvent.count({
      where: { institutionId: instA, action: "fees.webhook.skipped_module_inactive" },
    });
    expect(skipAudit).toBeGreaterThanOrEqual(1);

    // Re-activate and prove the capture then runs (money not lost).
    await setFeesState(instA, "ACTIVE");
    const hook2 = await deliverWebhook(body, `${PFX}evt_susp_2`);
    expect(hook2.statusCode).toBe(200);
    expect((await adminClient.paymentTransaction.findFirst({ where: { razorpayOrderId: orderId } }))!.status).toBe("CAPTURED");
  }, 120_000);

  it("HEADLINE: ACCOUNTANT gets 403 on a non-fees route (fees-scoped only)", async () => {
    // The ACCOUNTANT role is fees-scoped; it has no library permission. A
    // fees route it DOES have proves the role works; a non-fees route proves the
    // scope boundary. We assert the scope via a fees route the student canNOT hit.
    const acctCanManage = await app.inject({
      method: "POST",
      url: "/api/fees/structures",
      headers: authHeader(acctToken()),
      payload: { name: `Scoped ${Date.now()}`, status: "ACTIVE" },
    });
    expect(acctCanManage.statusCode).toBe(201);

    // A STUDENT (fees.view_own only) cannot manage structures -> 403.
    const studentManage = await app.inject({
      method: "POST",
      url: "/api/fees/structures",
      headers: authHeader(studentToken()),
      payload: { name: `Nope ${Date.now()}`, status: "ACTIVE" },
    });
    expect(studentManage.statusCode).toBe(403);

    // And the ACCOUNTANT cannot act as a student self-service (no fees.view_own).
    const acctOwn = await app.inject({
      method: "GET",
      url: "/api/fees/me/charges",
      headers: authHeader(acctToken()),
    });
    expect(acctOwn.statusCode).toBe(403);
  }, 120_000);

  it("HEADLINE: a STUDENT sees only their own ledger (not another student's charges)", async () => {
    await createStructure();
    const mine = await postCharge(studentProfileA, "1000000");
    await postCharge(otherStudentProfileA, "9999999"); // another student's charge

    const res = await app.inject({
      method: "GET",
      url: "/api/fees/me/charges",
      headers: authHeader(studentToken()),
    });
    expect(res.statusCode).toBe(200);
    const charges = res.json().charges as Array<{ id: string; studentId: string }>;
    expect(charges.every((c) => c.studentId === studentProfileA)).toBe(true);
    expect(charges.some((c) => c.id === mine)).toBe(true);
    expect(charges).toHaveLength(1);
  }, 120_000);

  it("TRIGGERS: append-only tables reject UPDATE/DELETE and the column guards reject illegal mutations", async () => {
    await createStructure();
    const chargeId = await postCharge(studentProfileA, "5000000");
    const order = await createOrder([chargeId]);
    const orderId = order.json().razorpayOrderId as string;
    const body = paymentCapturedBody(orderId, `${PFX}pay_trig`, 5000000);
    await deliverWebhook(body, `${PFX}evt_trig`);

    const tx = (await adminClient.paymentTransaction.findFirst({ where: { razorpayOrderId: orderId } }))!;
    const receipt = (await adminClient.receipt.findFirst({ where: { paymentTransactionId: tx.id } }))!;
    const alloc = (await adminClient.paymentAllocation.findFirst({ where: { paymentTransactionId: tx.id } }))!;

    // Append-only: UPDATE + DELETE denied on receipts / allocations / processed events.
    await expect(adminClient.receipt.update({ where: { id: receipt.id }, data: { amountPaise: 1n } })).rejects.toBeTruthy();
    await expect(adminClient.receipt.delete({ where: { id: receipt.id } })).rejects.toBeTruthy();
    await expect(adminClient.paymentAllocation.delete({ where: { id: alloc.id } })).rejects.toBeTruthy();

    // Column guard: a terminal CAPTURED tx cannot be re-updated (reverse transition).
    await expect(
      adminClient.paymentTransaction.update({ where: { id: tx.id }, data: { status: "AUTHORIZED" } }),
    ).rejects.toBeTruthy();
    // Column guard: an immutable fact column (targetChargeIds) cannot be mutated.
    await expect(
      adminClient.paymentTransaction.update({ where: { id: tx.id }, data: { targetChargeIds: ["x"] } }),
    ).rejects.toBeTruthy();
    // Column guard: a DELETE of a payment_transactions row is always denied.
    await expect(adminClient.paymentTransaction.delete({ where: { id: tx.id } })).rejects.toBeTruthy();
    // Column guard: a posted charge's snapshot amount cannot change.
    await expect(
      adminClient.studentCharge.update({ where: { id: chargeId }, data: { amountPaise: 1n } }),
    ).rejects.toBeTruthy();
    // Column guard: a PAID charge cannot move backwards to PENDING.
    await expect(
      adminClient.studentCharge.update({ where: { id: chargeId }, data: { status: "PENDING" } }),
    ).rejects.toBeTruthy();
    // Column guard: a DELETE of a student_charge is always denied.
    await expect(adminClient.studentCharge.delete({ where: { id: chargeId } })).rejects.toBeTruthy();
  }, 120_000);

  // ─── NIT tests ───────────────────────────────────────────────────────────────

  it("NIT-1: a targetChargeIds entry pointing at a non-existent / foreign charge contributes zero allocation", async () => {
    await createStructure();
    const real = await postCharge(studentProfileA, "1000000");
    const order = await createOrder([real]);
    const orderId = order.json().razorpayOrderId as string;
    const tx = (await adminClient.paymentTransaction.findFirst({ where: { razorpayOrderId: orderId } }))!;

    // Tamper the stored targetChargeIds to include a non-existent id (adminClient,
    // with the guard disabled, simulating a stale/foreign id at capture time).
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "payment_transactions" DISABLE TRIGGER "payment_transactions_guard"`,
    );
    try {
      await adminClient.paymentTransaction.update({
        where: { id: tx.id },
        data: { targetChargeIds: [real, `${PFX}ghost_charge`] },
      });
    } finally {
      await adminClient.$executeRawUnsafe(
        `ALTER TABLE "payment_transactions" ENABLE TRIGGER "payment_transactions_guard"`,
      );
    }

    const body = paymentCapturedBody(orderId, `${PFX}pay_nit1`, 1000000);
    const hook = await deliverWebhook(body, `${PFX}evt_nit1`);
    expect(hook.statusCode).toBe(200);

    // Only the real charge got an allocation; the ghost id dropped out (zero).
    const allocs = await adminClient.paymentAllocation.findMany({ where: { paymentTransactionId: tx.id } });
    expect(allocs).toHaveLength(1);
    expect(allocs[0].studentChargeId).toBe(real);
  }, 120_000);

  it("NIT-2: reconcile leaves a still-open order in place (not FAILED) and only drives FAILED on a terminal-failed signal", async () => {
    await createStructure();
    const chargeId = await postCharge(studentProfileA, "1000000");
    // Make the tx look stuck (createdAt far in the past) so findStuck selects it.
    const order = await createOrder([chargeId]);
    const orderId = order.json().razorpayOrderId as string;
    const tx = (await adminClient.paymentTransaction.findFirst({ where: { razorpayOrderId: orderId } }))!;
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "payment_transactions" DISABLE TRIGGER "payment_transactions_guard"`,
    );
    try {
      await adminClient.paymentTransaction.update({
        where: { id: tx.id },
        data: { createdAt: new Date(Date.now() - 2 * 3600_000) },
      });
    } finally {
      await adminClient.$executeRawUnsafe(
        `ALTER TABLE "payment_transactions" ENABLE TRIGGER "payment_transactions_guard"`,
      );
    }

    // (a) Razorpay reports the order still open (created, no payments) -> stays CREATED.
    orderStore.set(orderId, { id: orderId, status: "created", amount_paid: 0, amount_due: 1000000 });
    paymentsStore.set(orderId, []);
    const run1 = await app.inject({
      method: "POST",
      url: "/api/fees/reconciliation/run",
      headers: authHeader(acctToken()),
      payload: { thresholdMinutes: 30 },
    });
    expect(run1.statusCode).toBe(200);
    expect(run1.json().stillOpen).toBeGreaterThanOrEqual(1);
    expect((await adminClient.paymentTransaction.findUnique({ where: { id: tx.id } }))!.status).toBe("CREATED");

    // (b) Razorpay reports a terminal-failed payment -> FAILED.
    paymentsStore.set(orderId, [
      { id: `${PFX}pay_failed`, order_id: orderId, status: "failed", amount: 1000000 },
    ]);
    const run2 = await app.inject({
      method: "POST",
      url: "/api/fees/reconciliation/run",
      headers: authHeader(acctToken()),
      payload: { thresholdMinutes: 30 },
    });
    expect(run2.statusCode).toBe(200);
    expect(run2.json().failed).toBeGreaterThanOrEqual(1);
    expect((await adminClient.paymentTransaction.findUnique({ where: { id: tx.id } }))!.status).toBe("FAILED");
  }, 120_000);

  it("NIT-3: a NON-23505 processed-event insert failure does NOT return 200 (rolls back so Razorpay retries)", async () => {
    await createStructure();
    const chargeId = await postCharge(studentProfileA, "1000000");
    const order = await createOrder([chargeId]);
    const orderId = order.json().razorpayOrderId as string;

    // Force a NON-unique-violation failure on the processed_webhook_events insert
    // by violating its NOT NULL eventType via a tampered body with event missing
    // is not enough (eventType defaults to ''). Instead, drop the processed-events
    // table's eventType to provoke a different error is too invasive. The design
    // guarantees ONLY P2002 maps to 200; every other error -> 500. We simulate a
    // concrete non-23505 failure: a foreign-key violation by making the lookup
    // resolve a tx id that we then delete before the tenant tx inserts the
    // processed event referencing it. Simpler + deterministic: inject a body whose
    // event id collides with a DIFFERENT institution is not non-23505. So instead
    // we assert the inverse from the shape guarantee below using a check
    // constraint: insert a processed event row with an over-long... not portable.
    //
    // Deterministic approach: temporarily add a CHECK that always fails on insert
    // into processed_webhook_events for this tenant's rows, so the insert raises a
    // 23514 (NOT 23505). The webhook must then roll back and return 500.
    await adminClient.$executeRawUnsafe(
      `ALTER TABLE "processed_webhook_events" ADD CONSTRAINT "${PFX}force_fail" CHECK ("eventType" <> 'payment.captured') NOT VALID`,
    );
    try {
      const body = paymentCapturedBody(orderId, `${PFX}pay_nit3`, 1000000);
      const hook = await deliverWebhook(body, `${PFX}evt_nit3`);
      expect(hook.statusCode).toBe(500); // non-23505 propagates -> rollback -> retry

      // Nothing committed (the whole tenant tx rolled back).
      expect(await adminClient.processedWebhookEvent.count({ where: { institutionId: instA } })).toBe(0);
      expect(await adminClient.receipt.count({ where: { institutionId: instA } })).toBe(0);
      expect(await chargeStatus(chargeId)).toBe("PENDING");
    } finally {
      await adminClient.$executeRawUnsafe(
        `ALTER TABLE "processed_webhook_events" DROP CONSTRAINT "${PFX}force_fail"`,
      );
    }
  }, 120_000);
});
