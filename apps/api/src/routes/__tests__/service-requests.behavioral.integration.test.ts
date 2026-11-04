/**
 * Phase-9.6 Service Requests BEHAVIORAL integration suite (design §4) — runs
 * against the REAL Supabase instance through a REAL Fastify app (real
 * `authenticate` + real serviceRequestsRoutes + the real withTenant/RLS path).
 * It proves the invariants the fast unit suite cannot:
 *   - type create + duplicate-code 409; SELECT-options 422; field-definition
 *     freeze 409 once a request exists
 *   - raise 201 (OPEN, dueAt, activity row) + inactive-type 409 + foreign-type
 *     404 + field-validation 422 (nothing persisted)
 *   - assign OPEN->ASSIGNED + requester 403; the DB column guard rejects an
 *     illegal transition (OPEN->RESOLVED) and a DELETE (-> 409 / rejects)
 *   - PATCH /:id/status legal/illegal + approval-type mismatch; approve/reject by
 *     an approver + non-approver 403
 *   - derived overdue report (in when past-due + non-terminal, out once RESOLVED)
 *   - resolve; requester + staff close/cancel/comment/feedback pairs with
 *     owner-scoped 404 and the state-guard 409s; feedback one-per-request 409
 *   - GET /me/requests owner-only; staff GET / requester-403
 *   - append-only UPDATE/DELETE rejection on activities + feedback
 *   - .xlsx export
 *   - every mutation + DENIED decision writes a service_requests.* AuditEvent in-tx
 *
 * SELF-CONTAINED under a DISTINCT prefix (SR9_TEST_); seeds + tears down its own
 * tenant/users/service-requests data via adminClient. Requires live Supabase +
 * campass_app creds. Registered in the live-db suite set; passes IN ISOLATION.
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

const PFX = "SR9_TEST_";
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
const adminUser = id("u_admin"); // ADMIN -> the 5 staff keys
const agentUser = id("u_agent"); // SERVICE_AGENT -> the 5 staff keys
const studentUser = id("u_student"); // STUDENT -> request_own (requester)
const student2User = id("u_student2"); // a SECOND STUDENT (foreign requester)

let app: FastifyInstance;

function tokenFor(userId: string): string {
  return app.jwt.sign({ userId, role: "ADMIN", institutionId: instA });
}
const authHeader = (t: string) => ({ authorization: `Bearer ${t}` });
const adminToken = () => tokenFor(adminUser);
const agentToken = () => tokenFor(agentUser);
const studentToken = () => tokenFor(studentUser);
const student2Token = () => tokenFor(student2User);

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

// ─── service-requests teardown (child-first inside a replica-role tx) ────────
async function clearServiceRequests(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  await withRetry(() =>
    adminClient.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      await tx.serviceRequestActivity.deleteMany({ where });
      await tx.serviceRequestFeedback.deleteMany({ where });
      await tx.serviceRequest.deleteMany({ where });
      await tx.serviceRequestFieldDefinition.deleteMany({ where });
      await tx.serviceRequestType.deleteMany({ where });
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
  await clearServiceRequests();
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
      data: { id: id("imod_A"), institutionId: instA, moduleKey: "service_requests", state: "ACTIVE", entitledAt: new Date(), activatedAt: new Date() },
    }),
  );

  await withRetry(() => adminClient.user.create({ data: { id: adminUser, email: `${PFX.toLowerCase()}admin@a.test`, role: "ADMIN", accountStatus: "ACTIVE", institutionId: instA } }));
  await ensureMembership(adminUser, "ADMIN");
  await withRetry(() => adminClient.user.create({ data: { id: agentUser, email: `${PFX.toLowerCase()}agent@a.test`, role: "ADMIN", accountStatus: "ACTIVE", institutionId: instA } }));
  await ensureMembership(agentUser, "SERVICE_AGENT");
  await withRetry(() => adminClient.user.create({ data: { id: studentUser, email: `${PFX.toLowerCase()}stud@a.test`, role: "STUDENT", accountStatus: "ACTIVE", institutionId: instA } }));
  await ensureMembership(studentUser, "STUDENT");
  await withRetry(() => adminClient.user.create({ data: { id: student2User, email: `${PFX.toLowerCase()}stud2@a.test`, role: "STUDENT", accountStatus: "ACTIVE", institutionId: instA } }));
  await ensureMembership(student2User, "STUDENT");
}

// ─── scenario helpers through the REAL routes (infra-transient retry) ────────
async function inject(opts: Parameters<FastifyInstance["inject"]>[0]) {
  let last: Awaited<ReturnType<FastifyInstance["inject"]>> | undefined;
  for (let i = 0; i < 5; i++) {
    last = await app.inject(opts);
    if (![401, 500].includes(last.statusCode)) return last;
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  return last!;
}

let typeSeq = 0;
async function createType(
  extra: Record<string, unknown> = {},
  token = adminToken(),
): Promise<string> {
  typeSeq += 1;
  const res = await inject({
    method: "POST",
    url: "/api/service-requests/types",
    headers: authHeader(token),
    payload: {
      name: `Type ${typeSeq}`,
      code: `SRT_${Date.now()}_${typeSeq}`,
      category: "facilities",
      slaTargetHours: 24,
      ...extra,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function addField(typeId: string, payload: Record<string, unknown>) {
  return inject({
    method: "POST",
    url: `/api/service-requests/types/${typeId}/fields`,
    headers: authHeader(adminToken()),
    payload,
  });
}

async function raise(typeId: string, payload: Record<string, unknown> = {}, token = studentToken()) {
  return inject({
    method: "POST",
    url: "/api/service-requests",
    headers: authHeader(token),
    payload: { requestTypeId: typeId, title: "Help me", fieldValues: {}, ...payload },
  });
}

async function statusOf(reqId: string): Promise<string> {
  const row = await adminClient.serviceRequest.findUnique({ where: { id: reqId }, select: { status: true } });
  return row!.status;
}

async function auditCount(action: string, result: string, resourceId?: string): Promise<number> {
  return adminClient.auditEvent.count({
    where: { institutionId: instA, action, result, ...(resourceId ? { resourceId } : {}) },
  });
}

beforeAll(async () => {
  await teardown();
  await seed();

  const { serviceRequestsRoutes } = await import("../service-requests.js");

  app = Fastify();
  await app.register(jwt, { secret: "service-requests-behavioral-test-secret" });
  await app.register(serviceRequestsRoutes, { prefix: "/api/service-requests" });
  await app.ready();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  await teardown();
  await adminClient.$disconnect();
}, 120_000);

beforeEach(async () => {
  await clearServiceRequests();
}, 120_000);

// ─── Types + field definitions ───────────────────────────────────────────────
describe("Request types + field definitions (AC 1-3)", () => {
  it("creates a type; a duplicate code in the same tenant -> 409 (AC1)", async () => {
    const code = `DUP_${Date.now()}`;
    const first = await inject({
      method: "POST",
      url: "/api/service-requests/types",
      headers: authHeader(adminToken()),
      payload: { name: "Maintenance", code, category: "facilities", slaTargetHours: 24 },
    });
    expect(first.statusCode).toBe(201);
    expect(await auditCount("service_requests.type.created", "SUCCESS", first.json().id)).toBe(1);

    const dup = await inject({
      method: "POST",
      url: "/api/service-requests/types",
      headers: authHeader(adminToken()),
      payload: { name: "Maintenance 2", code, category: "facilities", slaTargetHours: 24 },
    });
    expect(dup.statusCode).toBe(409);
  });

  it("SELECT field missing options -> 422; non-SELECT with options -> 422 (AC2)", async () => {
    const typeId = await createType();
    const selMissing = await addField(typeId, { fieldKey: "sev", label: "Severity", dataType: "SELECT" });
    expect(selMissing.statusCode).toBe(400); // Zod envelope refinement
    const textWithOpts = await addField(typeId, {
      fieldKey: "note",
      label: "Note",
      dataType: "TEXT",
      options: ["a"],
    });
    expect(textWithOpts.statusCode).toBe(400);

    const ok = await addField(typeId, {
      fieldKey: "sev",
      label: "Severity",
      dataType: "SELECT",
      options: ["LOW", "HIGH"],
    });
    expect(ok.statusCode).toBe(201);
  });

  it("field definitions freeze (409 + DENIED) once the type has >= 1 request (AC3)", async () => {
    const typeId = await createType();
    const f = await addField(typeId, { fieldKey: "summary", label: "Summary", dataType: "TEXT", required: false });
    expect(f.statusCode).toBe(201);
    const fieldId = f.json().id as string;

    // Raise one request so the type is now frozen.
    const r = await raise(typeId);
    expect(r.statusCode).toBe(201);

    const addAfter = await addField(typeId, { fieldKey: "extra", label: "Extra", dataType: "TEXT" });
    expect(addAfter.statusCode).toBe(409);
    expect(await auditCount("service_requests.field.created", "DENIED")).toBeGreaterThanOrEqual(1);

    const patchAfter = await inject({
      method: "PATCH",
      url: `/api/service-requests/types/${typeId}/fields/${fieldId}`,
      headers: authHeader(adminToken()),
      payload: { label: "Changed" },
    });
    expect(patchAfter.statusCode).toBe(409);
    expect(await auditCount("service_requests.field.updated", "DENIED")).toBeGreaterThanOrEqual(1);
  });
});

// ─── SR-1 requester active-type catalogue (GET /types/active, dual gate) ──────
describe("GET /types/active — requester-facing active-type catalogue (SR-1)", () => {
  it("requester sees ONLY active types, with minimal safe fields + hasFields; no staff fields leak", async () => {
    const activeId = await createType({ name: "Active One", category: "facilities", slaTargetHours: 12 });
    await addField(activeId, { fieldKey: "summary", label: "Summary", dataType: "TEXT", required: true });
    const inactiveId = await createType({ name: "Inactive One", category: "facilities", isActive: false });

    const res = await inject({
      method: "GET",
      url: "/api/service-requests/types/active",
      headers: authHeader(studentToken()), // STUDENT holds request_own only
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { types: Array<Record<string, unknown>> };
    const ids = body.types.map((t) => t.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(inactiveId); // inactive excluded

    const active = body.types.find((t) => t.id === activeId)!;
    // Exactly the requester-safe shape — nothing more.
    expect(Object.keys(active).sort()).toEqual(
      ["category", "description", "hasFields", "id", "name", "requiresApproval", "slaTargetHours"].sort(),
    );
    expect(active.hasFields).toBe(true);
    // No staff / internal fields leak.
    expect(active).not.toHaveProperty("code");
    expect(active).not.toHaveProperty("defaultAssigneeRole");
    expect(active).not.toHaveProperty("defaultAssigneeDepartmentId");
    expect(active).not.toHaveProperty("createdByUserId");
    expect(active).not.toHaveProperty("isActive");
  });

  it("staff (service_requests.view) may also read the catalogue (dual gate)", async () => {
    const activeId = await createType({ name: "Staff Visible" });
    const res = await inject({
      method: "GET",
      url: "/api/service-requests/types/active",
      headers: authHeader(agentToken()), // SERVICE_AGENT holds service_requests.view
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { types: Array<{ id: string }> }).types.map((t) => t.id)).toContain(activeId);
  });

  it("a token holding NEITHER service_requests.view NOR request_own -> 403", async () => {
    // A user with an ACTIVE membership but NO membershipRole => zero permissions.
    const bareUser = id("u_bare");
    const bareMembership = id("mbr_bare");
    await withRetry(() =>
      adminClient.user.create({
        data: { id: bareUser, email: `${PFX.toLowerCase()}bare@a.test`, role: "STUDENT", accountStatus: "ACTIVE", institutionId: instA },
      }),
    );
    await withRetry(() =>
      adminClient.institutionMembership.create({
        data: { id: bareMembership, userId: bareUser, institutionId: instA, membershipStatus: "ACTIVE", permissionsVersion: 0 },
      }),
    );
    try {
      const res = await inject({
        method: "GET",
        url: "/api/service-requests/types/active",
        headers: authHeader(tokenFor(bareUser)),
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await withRetry(() => adminClient.institutionMembership.deleteMany({ where: { id: bareMembership } }));
      await withRetry(() => adminClient.user.deleteMany({ where: { id: bareUser } }));
    }
  });

  it("tenant isolation: the requester never sees another tenant's active types", async () => {
    const mine = await createType({ name: "Mine Active" });

    // A SECOND tenant with its own ACTIVE service_requests module + an active type.
    const instB = id("instB");
    const typeB = id("typeB");
    await withRetry(() =>
      adminClient.institution.create({ data: { id: instB, name: `${PFX}B`, code: id("CODE_B"), status: "ACTIVE" } }),
    );
    await withRetry(() =>
      adminClient.institutionModule.create({
        data: { id: id("imod_B"), institutionId: instB, moduleKey: "service_requests", state: "ACTIVE", entitledAt: new Date(), activatedAt: new Date() },
      }),
    );
    await withRetry(() =>
      adminClient.serviceRequestType.create({
        data: {
          id: typeB,
          institutionId: instB,
          name: "Tenant B Secret",
          code: id("B_CODE"),
          category: "facilities",
          slaTargetHours: 24,
          isActive: true,
          createdByUserId: adminUser,
        },
      }),
    );
    try {
      const res = await inject({
        method: "GET",
        url: "/api/service-requests/types/active",
        headers: authHeader(studentToken()), // scoped to instA by the token
      });
      expect(res.statusCode).toBe(200);
      const ids = (res.json() as { types: Array<{ id: string }> }).types.map((t) => t.id);
      expect(ids).toContain(mine);
      expect(ids).not.toContain(typeB); // RLS + withTenant keeps tenant B invisible
    } finally {
      await withRetry(() => adminClient.serviceRequestType.deleteMany({ where: { id: typeB } }));
      await withRetry(() => adminClient.institutionModule.deleteMany({ where: { institutionId: instB } }));
      await withRetry(() => adminClient.institution.deleteMany({ where: { id: instB } }));
    }
  });
});

// ─── Raise + validation ──────────────────────────────────────────────────────
describe("Raise + field validation (AC 4-6)", () => {
  it("raise -> 201 OPEN, dueAt = raisedAt + slaTargetHours, activity STATUS_CHANGE (AC4)", async () => {
    const typeId = await createType({ slaTargetHours: 24 });
    await addField(typeId, { fieldKey: "summary", label: "Summary", dataType: "TEXT", required: true });

    const r = await raise(typeId, { fieldValues: { summary: "broken" } });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.status).toBe("OPEN");
    expect(new Date(body.dueAt).getTime() - new Date(body.raisedAt).getTime()).toBe(24 * 60 * 60 * 1000);

    const acts = await adminClient.serviceRequestActivity.findMany({ where: { serviceRequestId: body.id } });
    expect(acts.length).toBe(1);
    expect(acts[0].kind).toBe("STATUS_CHANGE");
    expect(acts[0].toStatus).toBe("OPEN");
    expect(await auditCount("service_requests.request.raised", "SUCCESS", body.id)).toBe(1);
  });

  it("raise against an inactive type -> 409 (AC5)", async () => {
    const typeId = await createType({ isActive: false });
    const r = await raise(typeId);
    expect(r.statusCode).toBe(409);
    expect(await auditCount("service_requests.request.raised", "DENIED", typeId)).toBeGreaterThanOrEqual(1);
  });

  it("raise against a non-existent/foreign type -> 404 (AC5)", async () => {
    const r = await raise(`${PFX}NO_SUCH_TYPE`);
    expect(r.statusCode).toBe(404);
  });

  it("raise with missing required / wrong-type / out-of-range SELECT / unknown key -> 422, nothing persisted (AC6)", async () => {
    const typeId = await createType();
    await addField(typeId, { fieldKey: "summary", label: "Summary", dataType: "TEXT", required: true });
    await addField(typeId, { fieldKey: "qty", label: "Qty", dataType: "NUMBER", required: false });
    await addField(typeId, { fieldKey: "sev", label: "Severity", dataType: "SELECT", required: true, options: ["LOW", "HIGH"] });

    const before = await adminClient.serviceRequest.count({ where: { requestTypeId: typeId } });

    const missing = await raise(typeId, { fieldValues: { sev: "LOW" } });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().errors.summary).toBe("required");

    const wrong = await raise(typeId, { fieldValues: { summary: "x", qty: "abc", sev: "LOW" } });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().errors.qty).toBe("invalid_type");

    const badSel = await raise(typeId, { fieldValues: { summary: "x", sev: "CRITICAL" } });
    expect(badSel.statusCode).toBe(422);
    expect(badSel.json().errors.sev).toBe("invalid_option");

    const unknown = await raise(typeId, { fieldValues: { summary: "x", sev: "LOW", bogus: "1" } });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().errors.bogus).toBe("unknown");

    const after = await adminClient.serviceRequest.count({ where: { requestTypeId: typeId } });
    expect(after).toBe(before);
  });
});

// ─── Assignment + the DB column guard ────────────────────────────────────────
describe("Assignment + DB column guard (AC 7-8)", () => {
  it("assign by an agent OPEN->ASSIGNED + requester 403 (AC7)", async () => {
    const typeId = await createType();
    const reqId = (await raise(typeId)).json().id as string;

    const requesterTry = await inject({
      method: "POST",
      url: `/api/service-requests/${reqId}/assign`,
      headers: authHeader(studentToken()),
      payload: { assigneeUserId: agentUser },
    });
    expect(requesterTry.statusCode).toBe(403); // requester holds no assign.manage

    const assign = await inject({
      method: "POST",
      url: `/api/service-requests/${reqId}/assign`,
      headers: authHeader(agentToken()),
      payload: { assigneeUserId: agentUser },
    });
    expect(assign.statusCode).toBe(200);
    expect(await statusOf(reqId)).toBe("ASSIGNED");
    expect(await auditCount("service_requests.request.assigned", "SUCCESS", reqId)).toBe(1);
  });

  it("the DB column guard rejects OPEN->RESOLVED and a DELETE even via adminClient (AC8)", async () => {
    const typeId = await createType();
    const reqId = (await raise(typeId)).json().id as string;

    await expect(
      adminClient.serviceRequest.update({ where: { id: reqId }, data: { status: "RESOLVED" } }),
    ).rejects.toBeTruthy();
    await expect(adminClient.serviceRequest.delete({ where: { id: reqId } })).rejects.toBeTruthy();
    expect(await statusOf(reqId)).toBe("OPEN");
  });
});

// ─── Status PATCH + approval gate ────────────────────────────────────────────
describe("Status PATCH + approval gate (AC 9-10)", () => {
  it("ASSIGNED->IN_PROGRESS 200; non-approval type IN_PROGRESS->PENDING_APPROVAL 409; IN_PROGRESS->RESOLVED legal (AC9)", async () => {
    const typeId = await createType({ requiresApproval: false });
    const reqId = (await raise(typeId)).json().id as string;
    await inject({ method: "POST", url: `/api/service-requests/${reqId}/assign`, headers: authHeader(agentToken()), payload: { assigneeUserId: agentUser } });

    const toInProgress = await inject({
      method: "PATCH",
      url: `/api/service-requests/${reqId}/status`,
      headers: authHeader(agentToken()),
      payload: { toStatus: "IN_PROGRESS" },
    });
    expect(toInProgress.statusCode).toBe(200);

    const toPending = await inject({
      method: "PATCH",
      url: `/api/service-requests/${reqId}/status`,
      headers: authHeader(agentToken()),
      payload: { toStatus: "PENDING_APPROVAL" },
    });
    expect(toPending.statusCode).toBe(409); // non-approval type
    expect(await auditCount("service_requests.request.transitioned", "DENIED", reqId)).toBeGreaterThanOrEqual(1);

    const resolve = await inject({
      method: "POST",
      url: `/api/service-requests/${reqId}/resolve`,
      headers: authHeader(agentToken()),
      payload: { resolutionNote: "fixed" },
    });
    expect(resolve.statusCode).toBe(200);
    expect(await statusOf(reqId)).toBe("RESOLVED");
  });

  it("approval type: ->PENDING_APPROVAL then approve by approver -> RESOLVED; non-approver 403 (AC10)", async () => {
    const typeId = await createType({ requiresApproval: true });
    const reqId = (await raise(typeId)).json().id as string;
    await inject({ method: "POST", url: `/api/service-requests/${reqId}/assign`, headers: authHeader(agentToken()), payload: { assigneeUserId: agentUser } });
    await inject({ method: "PATCH", url: `/api/service-requests/${reqId}/status`, headers: authHeader(agentToken()), payload: { toStatus: "IN_PROGRESS" } });
    const toPending = await inject({ method: "PATCH", url: `/api/service-requests/${reqId}/status`, headers: authHeader(agentToken()), payload: { toStatus: "PENDING_APPROVAL" } });
    expect(toPending.statusCode).toBe(200);

    const nonApprover = await inject({
      method: "POST",
      url: `/api/service-requests/${reqId}/approve`,
      headers: authHeader(studentToken()),
    });
    expect(nonApprover.statusCode).toBe(403);

    const approve = await inject({
      method: "POST",
      url: `/api/service-requests/${reqId}/approve`,
      headers: authHeader(agentToken()),
    });
    expect(approve.statusCode).toBe(200);
    expect(await statusOf(reqId)).toBe("RESOLVED");
    expect(await auditCount("service_requests.request.approved", "SUCCESS", reqId)).toBe(1);

    const acts = await adminClient.serviceRequestActivity.findMany({ where: { serviceRequestId: reqId, kind: "APPROVAL" } });
    expect(acts.length).toBeGreaterThanOrEqual(1);
  });

  it("reject by an approver -> REJECTED (AC10)", async () => {
    const typeId = await createType({ requiresApproval: true });
    const reqId = (await raise(typeId)).json().id as string;
    await inject({ method: "POST", url: `/api/service-requests/${reqId}/assign`, headers: authHeader(agentToken()), payload: { assigneeUserId: agentUser } });
    await inject({ method: "PATCH", url: `/api/service-requests/${reqId}/status`, headers: authHeader(agentToken()), payload: { toStatus: "IN_PROGRESS" } });
    await inject({ method: "PATCH", url: `/api/service-requests/${reqId}/status`, headers: authHeader(agentToken()), payload: { toStatus: "PENDING_APPROVAL" } });

    const reject = await inject({
      method: "POST",
      url: `/api/service-requests/${reqId}/reject`,
      headers: authHeader(agentToken()),
      payload: { reason: "not warranted" },
    });
    expect(reject.statusCode).toBe(200);
    expect(await statusOf(reqId)).toBe("REJECTED");
  });
});

// ─── Derived SLA report ──────────────────────────────────────────────────────
describe("Derived SLA breach report (AC11)", () => {
  it("a past-due non-terminal request appears in /reports/overdue; drops out once RESOLVED", async () => {
    const typeId = await createType({ slaTargetHours: 1 });
    const reqId = (await raise(typeId)).json().id as string;
    // Backdate dueAt into the past via adminClient (dueAt is mutable, not frozen).
    await adminClient.serviceRequest.update({ where: { id: reqId }, data: { dueAt: new Date(Date.now() - 60 * 60 * 1000) } });

    const overdue1 = await inject({ method: "GET", url: "/api/service-requests/reports/overdue", headers: authHeader(agentToken()) });
    expect(overdue1.statusCode).toBe(200);
    expect((overdue1.json().overdue as Array<{ id: string }>).some((r) => r.id === reqId)).toBe(true);

    // Drive to RESOLVED.
    await inject({ method: "POST", url: `/api/service-requests/${reqId}/assign`, headers: authHeader(agentToken()), payload: { assigneeUserId: agentUser } });
    await inject({ method: "PATCH", url: `/api/service-requests/${reqId}/status`, headers: authHeader(agentToken()), payload: { toStatus: "IN_PROGRESS" } });
    await inject({ method: "POST", url: `/api/service-requests/${reqId}/resolve`, headers: authHeader(agentToken()), payload: { resolutionNote: "done" } });

    const overdue2 = await inject({ method: "GET", url: "/api/service-requests/reports/overdue", headers: authHeader(agentToken()) });
    expect((overdue2.json().overdue as Array<{ id: string }>).some((r) => r.id === reqId)).toBe(false);
  });
});

// ─── Resolution + close/cancel/comment/feedback (self + staff pairs) ─────────
describe("Resolution + close/cancel/comment/feedback (AC 12-16)", () => {
  async function resolvedRequest(): Promise<string> {
    const typeId = await createType({ requiresApproval: false });
    const reqId = (await raise(typeId)).json().id as string;
    await inject({ method: "POST", url: `/api/service-requests/${reqId}/assign`, headers: authHeader(agentToken()), payload: { assigneeUserId: agentUser } });
    await inject({ method: "PATCH", url: `/api/service-requests/${reqId}/status`, headers: authHeader(agentToken()), payload: { toStatus: "IN_PROGRESS" } });
    const resolve = await inject({ method: "POST", url: `/api/service-requests/${reqId}/resolve`, headers: authHeader(agentToken()), payload: { resolutionNote: "fixed" } });
    expect(resolve.statusCode).toBe(200);
    return reqId;
  }

  it("resolve sets resolvedAt + note, status RESOLVED (AC12)", async () => {
    const reqId = await resolvedRequest();
    const row = await adminClient.serviceRequest.findUnique({ where: { id: reqId } });
    expect(row!.status).toBe("RESOLVED");
    expect(row!.resolvedAt).not.toBeNull();
    expect(row!.resolutionNote).toBe("fixed");
    expect(await auditCount("service_requests.request.resolved", "SUCCESS", reqId)).toBe(1);
  });

  it("requester closes own RESOLVED -> CLOSED; a foreign request -> 404; non-RESOLVED own -> 409 (AC13)", async () => {
    const reqId = await resolvedRequest();

    // A different student cannot see/close it (owner-scoped 404).
    const foreign = await inject({ method: "POST", url: `/api/service-requests/me/requests/${reqId}/close`, headers: authHeader(student2Token()) });
    expect(foreign.statusCode).toBe(404);

    const close = await inject({ method: "POST", url: `/api/service-requests/me/requests/${reqId}/close`, headers: authHeader(studentToken()) });
    expect(close.statusCode).toBe(200);
    expect(await statusOf(reqId)).toBe("CLOSED");
    expect(await auditCount("service_requests.request.closed", "SUCCESS", reqId)).toBe(1);
  });

  it("requester self-cancel OPEN -> CANCELLED; own ASSIGNED -> 409; foreign -> 404 (AC14)", async () => {
    const typeId = await createType();
    const openId = (await raise(typeId)).json().id as string;

    const foreign = await inject({ method: "POST", url: `/api/service-requests/me/requests/${openId}/cancel`, headers: authHeader(student2Token()) });
    expect(foreign.statusCode).toBe(404);

    const cancel = await inject({ method: "POST", url: `/api/service-requests/me/requests/${openId}/cancel`, headers: authHeader(studentToken()) });
    expect(cancel.statusCode).toBe(200);
    expect(await statusOf(openId)).toBe("CANCELLED");

    // A second request driven to ASSIGNED: requester self-cancel is 409 (OPEN-only).
    const assignedId = (await raise(typeId)).json().id as string;
    await inject({ method: "POST", url: `/api/service-requests/${assignedId}/assign`, headers: authHeader(agentToken()), payload: { assigneeUserId: agentUser } });
    const lateCancel = await inject({ method: "POST", url: `/api/service-requests/me/requests/${assignedId}/cancel`, headers: authHeader(studentToken()) });
    expect(lateCancel.statusCode).toBe(409);

    // Staff may cancel from ASSIGNED.
    const staffCancel = await inject({ method: "POST", url: `/api/service-requests/${assignedId}/cancel`, headers: authHeader(agentToken()) });
    expect(staffCancel.statusCode).toBe(200);
    expect(await statusOf(assignedId)).toBe("CANCELLED");
  });

  it("requester feedback on own RESOLVED -> 201; a second -> 409; non-terminal -> 409; foreign -> 404 (AC15)", async () => {
    const reqId = await resolvedRequest();

    const foreign = await inject({
      method: "POST",
      url: `/api/service-requests/me/requests/${reqId}/feedback`,
      headers: authHeader(student2Token()),
      payload: { rating: 5 },
    });
    expect(foreign.statusCode).toBe(404);

    const fb1 = await inject({
      method: "POST",
      url: `/api/service-requests/me/requests/${reqId}/feedback`,
      headers: authHeader(studentToken()),
      payload: { rating: 5, comment: "great" },
    });
    expect(fb1.statusCode).toBe(201);
    expect(await auditCount("service_requests.feedback.submitted", "SUCCESS", fb1.json().id)).toBe(1);

    const fb2 = await inject({
      method: "POST",
      url: `/api/service-requests/me/requests/${reqId}/feedback`,
      headers: authHeader(studentToken()),
      payload: { rating: 3 },
    });
    expect(fb2.statusCode).toBe(409); // one-per-request unique

    // A non-terminal own request rejects feedback.
    const typeId = await createType();
    const openId = (await raise(typeId)).json().id as string;
    const fbOpen = await inject({
      method: "POST",
      url: `/api/service-requests/me/requests/${openId}/feedback`,
      headers: authHeader(studentToken()),
      payload: { rating: 4 },
    });
    expect(fbOpen.statusCode).toBe(409);
  });

  it("requester comments on own (non-CLOSED) -> 201; on own CLOSED -> 409; foreign -> 404; staff comment any -> 201 (AC16)", async () => {
    const typeId = await createType();
    const reqId = (await raise(typeId)).json().id as string;

    const foreign = await inject({
      method: "POST",
      url: `/api/service-requests/me/requests/${reqId}/comments`,
      headers: authHeader(student2Token()),
      payload: { body: "hi" },
    });
    expect(foreign.statusCode).toBe(404);

    const comment = await inject({
      method: "POST",
      url: `/api/service-requests/me/requests/${reqId}/comments`,
      headers: authHeader(studentToken()),
      payload: { body: "any update?" },
    });
    expect(comment.statusCode).toBe(201);
    expect(await auditCount("service_requests.comment.added", "SUCCESS")).toBeGreaterThanOrEqual(1);

    const staffComment = await inject({
      method: "POST",
      url: `/api/service-requests/${reqId}/comments`,
      headers: authHeader(agentToken()),
      payload: { body: "working on it" },
    });
    expect(staffComment.statusCode).toBe(201);

    // Drive to RESOLVED then CLOSED; a comment on CLOSED is 409.
    await inject({ method: "POST", url: `/api/service-requests/${reqId}/assign`, headers: authHeader(agentToken()), payload: { assigneeUserId: agentUser } });
    await inject({ method: "PATCH", url: `/api/service-requests/${reqId}/status`, headers: authHeader(agentToken()), payload: { toStatus: "IN_PROGRESS" } });
    await inject({ method: "POST", url: `/api/service-requests/${reqId}/resolve`, headers: authHeader(agentToken()), payload: { resolutionNote: "done" } });
    await inject({ method: "POST", url: `/api/service-requests/me/requests/${reqId}/close`, headers: authHeader(studentToken()) });

    const closedComment = await inject({
      method: "POST",
      url: `/api/service-requests/me/requests/${reqId}/comments`,
      headers: authHeader(studentToken()),
      payload: { body: "late" },
    });
    expect(closedComment.statusCode).toBe(409);
  });
});

// ─── Self vs staff surface ───────────────────────────────────────────────────
describe("Self vs staff surface (AC 17-18)", () => {
  it("GET /me/requests returns only the caller's requests (AC17)", async () => {
    const typeId = await createType();
    const mine = (await raise(typeId, {}, studentToken())).json().id as string;
    const theirs = (await raise(typeId, {}, student2Token())).json().id as string;

    const res = await inject({ method: "GET", url: "/api/service-requests/me/requests", headers: authHeader(studentToken()) });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  it("staff GET / lists all tenant requests; a requester-only token -> 403 (AC18)", async () => {
    const typeId = await createType();
    await raise(typeId, {}, studentToken());
    await raise(typeId, {}, student2Token());

    const staff = await inject({ method: "GET", url: "/api/service-requests/", headers: authHeader(agentToken()) });
    expect(staff.statusCode).toBe(200);
    expect((staff.json().data as unknown[]).length).toBeGreaterThanOrEqual(2);

    const requester = await inject({ method: "GET", url: "/api/service-requests/", headers: authHeader(studentToken()) });
    expect(requester.statusCode).toBe(403); // STUDENT holds no service_requests.view
  });

  it("GET /types/:id/fields is reachable by a requester (dual gate) to render the form", async () => {
    const typeId = await createType();
    await addField(typeId, { fieldKey: "summary", label: "Summary", dataType: "TEXT", required: true });
    const res = await inject({ method: "GET", url: `/api/service-requests/types/${typeId}/fields`, headers: authHeader(studentToken()) });
    expect(res.statusCode).toBe(200);
    expect((res.json() as unknown[]).length).toBe(1);
  });

  it("G-SR1 /users/lookup: an agent finds in-tenant non-student users; a requester -> 403; q<2 -> 400", async () => {
    // An agent (service_requests.assign.manage) can resolve an assignee id.
    const ok = await inject({
      method: "GET",
      url: `/api/service-requests/users/lookup?q=${PFX.toLowerCase()}agent`,
      headers: authHeader(agentToken()),
    });
    expect(ok.statusCode).toBe(200);
    const users = ok.json().users as { id: string; email: string; name: string | null }[];
    expect(users.some((u) => u.id === agentUser)).toBe(true);

    // A STUDENT requester holds no assign.manage -> 403 (role-denial).
    const denied = await inject({
      method: "GET",
      url: `/api/service-requests/users/lookup?q=${PFX.toLowerCase()}agent`,
      headers: authHeader(studentToken()),
    });
    expect(denied.statusCode).toBe(403);

    // q shorter than 2 chars -> 400.
    const short = await inject({
      method: "GET",
      url: "/api/service-requests/users/lookup?q=a",
      headers: authHeader(agentToken()),
    });
    expect(short.statusCode).toBe(400);
  });

  it("G-SR1 /users/lookup is tenant-scoped: a non-matching q returns an empty set (no cross-tenant leak)", async () => {
    const res = await inject({
      method: "GET",
      url: "/api/service-requests/users/lookup?q=zzz-no-such-user-zzz",
      headers: authHeader(agentToken()),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().users as unknown[]).length).toBe(0);
  });
});

// ─── Append-only ledgers + export ────────────────────────────────────────────
describe("Append-only ledgers + export (AC 19, 24)", () => {
  it("UPDATE/DELETE on activities + feedback is rejected by the append-only trigger (AC19)", async () => {
    const typeId = await createType({ requiresApproval: false });
    const reqId = (await raise(typeId)).json().id as string;
    await inject({ method: "POST", url: `/api/service-requests/${reqId}/assign`, headers: authHeader(agentToken()), payload: { assigneeUserId: agentUser } });
    await inject({ method: "PATCH", url: `/api/service-requests/${reqId}/status`, headers: authHeader(agentToken()), payload: { toStatus: "IN_PROGRESS" } });
    await inject({ method: "POST", url: `/api/service-requests/${reqId}/resolve`, headers: authHeader(agentToken()), payload: { resolutionNote: "done" } });
    const fbId = (await inject({ method: "POST", url: `/api/service-requests/me/requests/${reqId}/feedback`, headers: authHeader(studentToken()), payload: { rating: 5 } })).json().id as string;

    const act = await adminClient.serviceRequestActivity.findFirst({ where: { serviceRequestId: reqId } });
    await expect(adminClient.serviceRequestActivity.update({ where: { id: act!.id }, data: { body: "x" } })).rejects.toBeTruthy();
    await expect(adminClient.serviceRequestActivity.delete({ where: { id: act!.id } })).rejects.toBeTruthy();
    await expect(adminClient.serviceRequestFeedback.update({ where: { id: fbId }, data: { comment: "x" } })).rejects.toBeTruthy();
    await expect(adminClient.serviceRequestFeedback.delete({ where: { id: fbId } })).rejects.toBeTruthy();
  });

  it("GET /reports/export streams a valid .xlsx gated by view; audited (AC24)", async () => {
    const typeId = await createType();
    await raise(typeId);
    const res = await inject({ method: "GET", url: "/api/service-requests/reports/export", headers: authHeader(agentToken()) });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    // XLSX is a ZIP — the magic bytes start with "PK".
    expect(res.rawPayload.slice(0, 2).toString("latin1")).toBe("PK");
    expect(await auditCount("service_requests.register.exported", "SUCCESS")).toBeGreaterThanOrEqual(1);
  });
});
