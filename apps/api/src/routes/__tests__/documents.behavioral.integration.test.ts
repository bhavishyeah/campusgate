/**
 * Phase-9.7 Document Management BEHAVIORAL integration suite (design §16.2) —
 * runs against the REAL Supabase instance through a REAL Fastify app (real
 * `authenticate` + real documentsRoutes + the real withTenant/RLS path) but with
 * an INJECTED InMemoryObjectStore (NO real network blob I/O). It proves the
 * invariants the fast unit suite cannot:
 *   - upload v1 (version row + pointer + stub blob present); upload v2 (append,
 *     v1 blob + row untouched, pointer advances)
 *   - download-url mint only after authz + an access-log row
 *     (action=DOWNLOAD_URL_MINTED, versionId NOT NULL)
 *   - a NON-owner STUDENT user-grantee can mint; an ACCOUNTANT department-member
 *     (dept grant) can mint; a documents.download holder with NO grant → 404; an
 *     APPLICANT (no documents.download) → 403 at the coarse gate
 *   - revoke → next mint denied; archive hides from default list but owner still
 *     downloads; purge-request blocks download; purge deletes stub blobs + flips
 *     PURGED (further transition 409/guard); a ledger UPDATE/DELETE raises
 *     restrict_violation; metadata view writes NO access-log row; report JSON
 *   - every mutation writes a documents.* AuditEvent in-tx
 *
 * SELF-CONTAINED under a DISTINCT prefix (DOC9_TEST_); seeds + tears down its own
 * tenant/users/document data via adminClient. Requires live Supabase +
 * campass_app creds. Registered in the live-db suite set; passes IN ISOLATION.
 * Object-storage calls go through an INJECTED in-memory fake — no real blob I/O.
 * Many-round-trip cases carry { timeout: 60000 } (the free-tier pooler
 * anti-flake rule).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InMemoryObjectStore, setObjectStore } from "../../services/documents/storage.js";

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

process.env.DATABASE_URL = appDatabaseUrl;
process.env.PRIVILEGED_DATABASE_URL = adminDatabaseUrl;
process.env.DIRECT_URL = adminDatabaseUrl;

const adminClient = new PrismaClient({ datasources: { db: { url: adminDatabaseUrl } }, log: ["error"] });

const PFX = "DOC9_TEST_";
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
const financeDept = id("deptFinance");
const otherDept = id("deptOther");
const facultyUser = id("u_faculty"); // FACULTY -> document owner (upload_own, view_own, download, grants.manage)
const managerUser = id("u_manager"); // DOCUMENT_MANAGER -> admin keys + download
const studentUser = id("u_student"); // STUDENT -> download only (user-grant grantee)
const accountantUser = id("u_accountant"); // ACCOUNTANT in Finance -> download only (dept-grant grantee)
const applicantUser = id("u_applicant"); // APPLICANT -> NO documents.* key

let app: FastifyInstance;

function tokenFor(userId: string): string {
  return app.jwt.sign({ userId, role: "ADMIN", institutionId: instA });
}
const authHeader = (t: string) => ({ authorization: `Bearer ${t}` });

async function templateRoleId(key: string): Promise<string> {
  const role = await adminClient.role.findFirst({ where: { key, institutionId: null }, select: { id: true } });
  if (!role) throw new Error(`template role ${key} not found — run the seed/migrations first`);
  return role.id;
}

async function ensureMembership(userId: string, roleKey: string, departmentScope: string | null = null): Promise<void> {
  const mId = id(`mbr_${userId}`);
  const roleId = await templateRoleId(roleKey);
  await withRetry(() =>
    adminClient.institutionMembership.create({
      data: { id: mId, userId, institutionId: instA, membershipStatus: "ACTIVE", permissionsVersion: 0, departmentScope },
    }),
  );
  await withRetry(() =>
    adminClient.membershipRole.create({
      data: { id: id(`mrl_${userId}`), membershipId: mId, roleId, institutionId: instA },
    }),
  );
}

// ─── teardown (child-first inside a replica-role tx) ─────────────────────────
async function clearDocuments(): Promise<void> {
  const where = { institutionId: { startsWith: PFX } };
  await withRetry(() =>
    adminClient.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      await tx.documentAccessLog.deleteMany({ where });
      await tx.documentAccessGrant.deleteMany({ where });
      await tx.documentVersion.deleteMany({ where });
      await tx.document.deleteMany({ where });
      await tx.documentRetentionPolicy.deleteMany({ where });
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
  await clearDocuments();
  await withRetry(() => adminClient.membershipRole.deleteMany({ where }));
  await withRetry(() => adminClient.institutionMembership.deleteMany({ where }));
  await withRetry(() => adminClient.institutionModule.deleteMany({ where }));
  await withRetry(() => adminClient.user.deleteMany({ where }));
  await withRetry(() => adminClient.department.deleteMany({ where }));
  await withRetry(() => adminClient.institution.deleteMany({ where: { id: { startsWith: PFX } } }));
}

async function seed(): Promise<void> {
  await withRetry(() => adminClient.institution.create({ data: { id: instA, name: `${PFX}A`, code: id("CODE_A"), status: "ACTIVE" } }));
  await withRetry(() => adminClient.department.create({ data: { id: financeDept, name: `${PFX}Finance`, code: id("D_FIN"), institutionId: instA } }));
  await withRetry(() => adminClient.department.create({ data: { id: otherDept, name: `${PFX}Other`, code: id("D_OTH"), institutionId: instA } }));
  await withRetry(() =>
    adminClient.institutionModule.create({
      data: { id: id("imod_A"), institutionId: instA, moduleKey: "documents", state: "ACTIVE", entitledAt: new Date(), activatedAt: new Date() },
    }),
  );

  // The legacy `role` column is inert for authz (membership roles drive it); use
  // a legal UserRole enum value (GUARD) and bind the real FACULTY role via
  // membership. (UserRole has no FACULTY member — the service-requests precedent.)
  await withRetry(() => adminClient.user.create({ data: { id: facultyUser, email: `${PFX.toLowerCase()}fac@a.test`, role: "GUARD", accountStatus: "ACTIVE", institutionId: instA } }));
  await ensureMembership(facultyUser, "FACULTY");
  await withRetry(() => adminClient.user.create({ data: { id: managerUser, email: `${PFX.toLowerCase()}mgr@a.test`, role: "ADMIN", accountStatus: "ACTIVE", institutionId: instA } }));
  await ensureMembership(managerUser, "DOCUMENT_MANAGER");
  await withRetry(() => adminClient.user.create({ data: { id: studentUser, email: `${PFX.toLowerCase()}stud@a.test`, role: "STUDENT", accountStatus: "ACTIVE", institutionId: instA } }));
  await ensureMembership(studentUser, "STUDENT");
  // ACCOUNTANT whose membership department scope is Finance (the "all of Finance"
  // dept-grant case). ACCOUNTANT holds ONLY the baseline documents.download.
  await withRetry(() => adminClient.user.create({ data: { id: accountantUser, email: `${PFX.toLowerCase()}acc@a.test`, role: "ADMIN", accountStatus: "ACTIVE", institutionId: instA } }));
  await ensureMembership(accountantUser, "ACCOUNTANT", financeDept);
  await withRetry(() => adminClient.user.create({ data: { id: applicantUser, email: `${PFX.toLowerCase()}app@a.test`, role: "STUDENT", accountStatus: "ACTIVE", institutionId: instA } }));
  await ensureMembership(applicantUser, "APPLICANT");
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

let docSeq = 0;
async function uploadDoc(
  token: string,
  extraHeaders: Record<string, string> = {},
  bytes = "hello-doc",
) {
  docSeq += 1;
  return inject({
    method: "POST",
    url: "/api/documents",
    headers: {
      ...authHeader(token),
      "content-type": "application/octet-stream",
      "x-title": `Doc ${docSeq}`,
      "x-filename": `doc-${docSeq}.txt`,
      "x-contenttype": "text/plain",
      ...extraHeaders,
    },
    payload: Buffer.from(bytes),
  });
}

async function uploadVersion(token: string, docId: string, bytes: string) {
  return inject({
    method: "POST",
    url: `/api/documents/${docId}/versions`,
    headers: {
      ...authHeader(token),
      "content-type": "application/octet-stream",
      "x-filename": "v2.txt",
      "x-contenttype": "text/plain",
    },
    payload: Buffer.from(bytes),
  });
}

async function mintDownload(token: string, docId: string, versionId: string) {
  return inject({
    method: "POST",
    url: `/api/documents/${docId}/versions/${versionId}/download-url`,
    headers: authHeader(token),
  });
}

async function auditCount(action: string, result = "SUCCESS", resourceId?: string): Promise<number> {
  return adminClient.auditEvent.count({
    where: { institutionId: instA, action, result, ...(resourceId ? { resourceId } : {}) },
  });
}

let store: InMemoryObjectStore;

beforeAll(async () => {
  await teardown();
  await seed();

  const { documentsRoutes } = await import("../documents.js");

  app = Fastify();
  await app.register(jwt, { secret: "documents-behavioral-test-secret" });
  await app.register(documentsRoutes, { prefix: "/api/documents" });
  await app.ready();
}, 180_000);

beforeEach(() => {
  store = new InMemoryObjectStore();
  setObjectStore(store);
});

afterEach(() => {
  setObjectStore(null);
});

afterAll(async () => {
  if (app) await app.close();
  await teardown();
  await adminClient.$disconnect();
}, 120_000);

describe("documents behavioral (live DB + injected in-memory ObjectStore)", () => {
  it("upload v1 writes the version row + advances the pointer + stores the blob", { timeout: 60000 }, async () => {
    const res = await uploadDoc(tokenFor(facultyUser));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ownerUserId).toBe(facultyUser);
    expect(body.status).toBe("ACTIVE");
    expect(body.currentVersionId).toBe(body.currentVersion.id);
    expect(body.currentVersion.version).toBe(1);
    expect(body.currentVersion.sizeBytes).toBe(String(Buffer.from("hello-doc").length));
    // blob present under the tenant-prefixed key
    const key = `${instA}/${body.id}/${body.currentVersion.id}`;
    expect(store.has(key)).toBe(true);
    expect(await auditCount("documents.document.created", "SUCCESS", body.id)).toBe(1);
    expect(await auditCount("documents.version.uploaded", "SUCCESS", body.currentVersion.id)).toBe(1);
  });

  it("upload v2 appends (v1 blob + row untouched, pointer advances)", { timeout: 60000 }, async () => {
    const created = (await uploadDoc(tokenFor(facultyUser), {}, "v1-bytes")).json();
    const v1Id = created.currentVersion.id;
    const v1Key = `${instA}/${created.id}/${v1Id}`;

    const v2res = await uploadVersion(tokenFor(facultyUser), created.id, "v2-bytes-longer");
    expect(v2res.statusCode).toBe(201);
    const v2 = v2res.json();
    expect(v2.version).toBe(2);
    const v2Key = `${instA}/${created.id}/${v2.id}`;

    // both blobs present; v1 untouched; pointer advanced to v2
    expect(store.has(v1Key)).toBe(true);
    expect(store.has(v2Key)).toBe(true);
    const doc = await adminClient.document.findUnique({ where: { id: created.id }, select: { currentVersionId: true } });
    expect(doc!.currentVersionId).toBe(v2.id);
    const versions = await adminClient.documentVersion.findMany({ where: { documentId: created.id }, orderBy: { version: "asc" } });
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it("owner mints a download URL + writes exactly one DOWNLOAD_URL_MINTED access-log row (versionId NOT NULL)", { timeout: 60000 }, async () => {
    const created = (await uploadDoc(tokenFor(facultyUser))).json();
    const res = await mintDownload(tokenFor(facultyUser), created.id, created.currentVersion.id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.url).toContain("stub://");
    expect(typeof body.expiresAt).toBe("string");
    const logs = await adminClient.documentAccessLog.findMany({ where: { documentId: created.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("DOWNLOAD_URL_MINTED");
    expect(logs[0].versionId).toBe(created.currentVersion.id);
    expect(await auditCount("documents.download_url.minted", "SUCCESS", created.currentVersion.id)).toBe(1);
  });

  it("a NON-owner STUDENT user-grantee can mint; the same STUDENT with NO grant gets 404", { timeout: 60000 }, async () => {
    const created = (await uploadDoc(tokenFor(facultyUser))).json();

    // before any grant: STUDENT holds documents.download but no grant → 404
    const before = await mintDownload(tokenFor(studentUser), created.id, created.currentVersion.id);
    expect(before.statusCode).toBe(404);

    // owner grants READ to the STUDENT user
    const grantRes = await inject({
      method: "POST",
      url: `/api/documents/${created.id}/grants`,
      headers: authHeader(tokenFor(facultyUser)),
      payload: { granteeUserId: studentUser, accessLevel: "READ" },
    });
    expect(grantRes.statusCode).toBe(201);

    const after = await mintDownload(tokenFor(studentUser), created.id, created.currentVersion.id);
    expect(after.statusCode).toBe(200);
  });

  it("an ACCOUNTANT department-member (Finance dept grant) can mint; a member of another dept cannot", { timeout: 60000 }, async () => {
    const created = (await uploadDoc(tokenFor(facultyUser))).json();

    const grantRes = await inject({
      method: "POST",
      url: `/api/documents/${created.id}/grants`,
      headers: authHeader(tokenFor(facultyUser)),
      payload: { granteeDepartmentId: financeDept, accessLevel: "READ" },
    });
    expect(grantRes.statusCode).toBe(201);

    // ACCOUNTANT whose departmentScope is Finance → can mint
    const accRes = await mintDownload(tokenFor(accountantUser), created.id, created.currentVersion.id);
    expect(accRes.statusCode).toBe(200);

    // STUDENT (no user grant, departmentScope not Finance) → still 404
    const studRes = await mintDownload(tokenFor(studentUser), created.id, created.currentVersion.id);
    expect(studRes.statusCode).toBe(404);
  });

  it("an APPLICANT (no documents.download) is blocked at the coarse gate with 403", { timeout: 60000 }, async () => {
    const created = (await uploadDoc(tokenFor(facultyUser))).json();
    const res = await mintDownload(tokenFor(applicantUser), created.id, created.currentVersion.id);
    expect(res.statusCode).toBe(403);
  });

  it("revoke stops the next mint (revoked grantee → 404)", { timeout: 60000 }, async () => {
    const created = (await uploadDoc(tokenFor(facultyUser))).json();
    const grantRes = await inject({
      method: "POST",
      url: `/api/documents/${created.id}/grants`,
      headers: authHeader(tokenFor(facultyUser)),
      payload: { granteeUserId: studentUser, accessLevel: "READ" },
    });
    const grantId = grantRes.json().id as string;
    expect((await mintDownload(tokenFor(studentUser), created.id, created.currentVersion.id)).statusCode).toBe(200);

    const revoke = await inject({
      method: "DELETE",
      url: `/api/documents/${created.id}/grants/${grantId}`,
      headers: authHeader(tokenFor(facultyUser)),
    });
    expect(revoke.statusCode).toBe(200);
    expect((await mintDownload(tokenFor(studentUser), created.id, created.currentVersion.id)).statusCode).toBe(404);
  });

  it("archive hides from the default list but the owner can still download", { timeout: 60000 }, async () => {
    const created = (await uploadDoc(tokenFor(facultyUser))).json();
    const archive = await inject({
      method: "POST",
      url: `/api/documents/${created.id}/archive`,
      headers: authHeader(tokenFor(managerUser)),
    });
    expect(archive.statusCode).toBe(200);

    // default owner list (ACTIVE only) excludes the archived doc
    const list = await inject({ method: "GET", url: "/api/documents?scope=mine", headers: authHeader(tokenFor(facultyUser)) });
    expect(list.statusCode).toBe(200);
    expect((list.json().data as Array<{ id: string }>).some((d) => d.id === created.id)).toBe(false);

    // owner can still mint a download from ARCHIVED
    expect((await mintDownload(tokenFor(facultyUser), created.id, created.currentVersion.id)).statusCode).toBe(200);
  });

  it("purge-request blocks download; purge deletes stub blobs + flips PURGED (terminal; further transition 409)", { timeout: 60000 }, async () => {
    const created = (await uploadDoc(tokenFor(facultyUser))).json();
    const key = `${instA}/${created.id}/${created.currentVersion.id}`;
    expect(store.has(key)).toBe(true);

    const pr = await inject({ method: "POST", url: `/api/documents/${created.id}/purge-request`, headers: authHeader(tokenFor(managerUser)) });
    expect(pr.statusCode).toBe(200);

    // download refused from PURGE_PENDING
    expect((await mintDownload(tokenFor(facultyUser), created.id, created.currentVersion.id)).statusCode).toBe(403);

    const purge = await inject({ method: "POST", url: `/api/documents/${created.id}/purge`, headers: authHeader(tokenFor(managerUser)) });
    expect(purge.statusCode).toBe(200);
    expect(purge.json().status).toBe("PURGED");
    // blob deleted via the injected adapter; metadata tombstone retained
    expect(store.has(key)).toBe(false);
    const doc = await adminClient.document.findUnique({ where: { id: created.id }, select: { status: true } });
    expect(doc!.status).toBe("PURGED");
    expect(await auditCount("documents.purged", "SUCCESS", created.id)).toBe(1);

    // PURGED is terminal: a further archive is an illegal transition → 409
    const again = await inject({ method: "POST", url: `/api/documents/${created.id}/archive`, headers: authHeader(tokenFor(managerUser)) });
    expect(again.statusCode).toBe(409);
  });

  it("the access-log ledger rejects UPDATE/DELETE (append-only trigger)", { timeout: 60000 }, async () => {
    const created = (await uploadDoc(tokenFor(facultyUser))).json();
    await mintDownload(tokenFor(facultyUser), created.id, created.currentVersion.id);
    const log = await adminClient.documentAccessLog.findFirst({ where: { documentId: created.id } });
    expect(log).not.toBeNull();
    await expect(
      adminClient.documentAccessLog.update({ where: { id: log!.id }, data: { action: "DOWNLOAD_URL_MINTED" } }),
    ).rejects.toThrow(/restrict_violation|append-only/);
    await expect(
      adminClient.documentAccessLog.delete({ where: { id: log!.id } }),
    ).rejects.toThrow(/restrict_violation|append-only/);
  });

  it("a metadata view (GET /:id) writes NO access-log row (findings 1-2)", { timeout: 60000 }, async () => {
    const created = (await uploadDoc(tokenFor(facultyUser))).json();
    const view = await inject({ method: "GET", url: `/api/documents/${created.id}`, headers: authHeader(tokenFor(facultyUser)) });
    expect(view.statusCode).toBe(200);
    expect(view.json().versions).toHaveLength(1);
    const logs = await adminClient.documentAccessLog.count({ where: { documentId: created.id } });
    expect(logs).toBe(0);
  });

  it("a non-owner/non-grantee/non-admin gets 404 on GET /:id (not-public-by-default)", { timeout: 60000 }, async () => {
    const created = (await uploadDoc(tokenFor(facultyUser))).json();
    const res = await inject({ method: "GET", url: `/api/documents/${created.id}`, headers: authHeader(tokenFor(studentUser)) });
    expect(res.statusCode).toBe(404);
  });

  it("the aggregate report returns inventory + access-log summary + purge queue", { timeout: 60000 }, async () => {
    const created = (await uploadDoc(tokenFor(facultyUser))).json();
    await mintDownload(tokenFor(facultyUser), created.id, created.currentVersion.id);
    const res = await inject({ method: "GET", url: "/api/documents/report", headers: authHeader(tokenFor(managerUser)) });
    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(Array.isArray(report.inventory)).toBe(true);
    expect(report.inventory.some((r: { status: string }) => r.status === "ACTIVE")).toBe(true);
    expect(report.totalVersions).toBeGreaterThanOrEqual(1);
    expect(report.accessLog.totalDownloadUrlMints).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(report.purgeQueue)).toBe(true);
  });
});
