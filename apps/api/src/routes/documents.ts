import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import ExcelJS from "exceljs";
import { withTenant, Prisma } from "@campusgate/db";
import {
  createDocumentSchema,
  newDocumentVersionSchema,
  createDocumentGrantSchema,
  upsertDocumentRetentionPolicySchema,
  patchDocumentRetentionPolicySchema,
  documentListQuerySchema,
  documentsUserLookupQuerySchema,
} from "@campusgate/shared";
import { authenticate } from "../middleware/auth.js";
import { requirePermission, requireModuleActive, can } from "../services/authz-engine.js";
import { recordAuditEvent } from "../services/audit.js";
import { getObjectStore, ObjectStoreError } from "../services/documents/storage.js";

const MODULE_KEY = "documents" as const;

// Server-side upload cap (design §D.1): 25 MiB. A larger body → 413 via the
// route bodyLimit + a defensive buffer-length check.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// Signed download URL TTL (design FR-4): 120 seconds.
export const DOWNLOAD_URL_TTL_SECONDS = 120;

// ─── Forward-only document lifecycle (design §12) ────────────────────────────
// Mirrors the DB column guard document_status_guard. PURGED is terminal (no
// outgoing edge). Exported pure for unit testing.
export const DOC_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  ACTIVE: ["ARCHIVED", "PURGE_PENDING"],
  ARCHIVED: ["ACTIVE", "PURGE_PENDING"],
  PURGE_PENDING: ["PURGED"],
  PURGED: [],
};

/** Legal forward-only edge test (self transition is a no-op, always legal). */
export function isLegalDocTransition(from: string, to: string): boolean {
  if (from === to) return true;
  return (DOC_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

/** The tenant-prefixed storage key scheme (design §7). All three segments are
 *  server-minted; institutionId comes ONLY from the verified token. */
export function buildStorageKey(
  institutionId: string,
  documentId: string,
  versionId: string,
): string {
  return `${institutionId}/${documentId}/${versionId}`;
}

// ─── Record-level access (design §11) ────────────────────────────────────────
// A single pure helper decides record-level access after the coarse
// requirePermission + requireModuleActive guards. Pure → unit-testable.
export interface DocAuthContext {
  userId: string;
  departmentScope: string | null;
  permissions: string[];
}
export interface DocForAccess {
  ownerUserId: string;
}
export interface GrantForAccess {
  granteeUserId: string | null;
  granteeDepartmentId: string | null;
  accessLevel: "READ" | "MANAGE";
  revokedAt: Date | null;
}

const LEVEL_RANK: Record<string, number> = { READ: 1, MANAGE: 2 };

/**
 * Ordered rules (design §11):
 *  1. ADMIN / DOCUMENT_MANAGER (holder of documents.admin.view_all) → full
 *     (READ + MANAGE) access to any tenant document.
 *  2. auth.userId === doc.ownerUserId → full access to OWN doc.
 *  3. A LIVE grant (revokedAt IS NULL) whose granteeUserId === auth.userId OR
 *     whose granteeDepartmentId === auth.departmentScope, with
 *     accessLevel >= requested level (MANAGE ⊇ READ) → that level.
 *  4. Otherwise → NOT visible.
 * Returns true iff the requester may act at `level` on the document.
 */
export function canAccessDocument(
  auth: DocAuthContext,
  doc: DocForAccess,
  grants: readonly GrantForAccess[],
  level: "READ" | "MANAGE",
): boolean {
  if (auth.permissions.includes("documents.admin.view_all")) return true;
  if (auth.userId === doc.ownerUserId) return true;
  const want = LEVEL_RANK[level];
  for (const g of grants) {
    if (g.revokedAt !== null) continue;
    const matchesUser = g.granteeUserId !== null && g.granteeUserId === auth.userId;
    const matchesDept =
      g.granteeDepartmentId !== null &&
      auth.departmentScope !== null &&
      g.granteeDepartmentId === auth.departmentScope;
    if ((matchesUser || matchesDept) && (LEVEL_RANK[g.accessLevel] ?? 0) >= want) {
      return true;
    }
  }
  return false;
}

/** sha256 hex of the received bytes (server-computed; never trust the client). */
export function sha256Hex(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

/** A document row is "serializable" once its BigInt version sizes are coerced. */
function serializeVersion<T extends { sizeBytes: bigint }>(v: T): Omit<T, "sizeBytes"> & { sizeBytes: string } {
  return { ...v, sizeBytes: v.sizeBytes.toString() };
}

/**
 * Document Management routes (design §15), registered at `/api/documents` (see
 * server.ts). Documents is a GATED "booster" module — every route carries
 * `requireModuleActive("documents")` IN ADDITION to `requirePermission(...)`.
 *
 * House pattern (mirrors service-requests.ts / inventory.ts):
 *  - a single top-level `authenticate` preHandler;
 *  - per-route `[requirePermission(key), requireModuleActive("documents")]`
 *    (the read routes needing an OR of coarse keys use an inline dual gate since
 *    requirePermission takes exactly one key — the service-requests precedent);
 *  - every handler body runs inside `withTenant(institutionId, tx => ...)` with
 *    institutionId from the verified token, never from input;
 *  - deny branches record a DENIED audit (where a mutation audit key applies)
 *    then RETURN the 4xx from a normally-returning withTenant callback;
 *  - ALL object-storage access goes through getObjectStore() — NO fetch to
 *    /storage/v1/ in this file.
 *
 * NOT-PUBLIC-BY-DEFAULT: a requester with a coarse view/download permission but
 * NO owner/grant/admin relationship to a specific document gets 404 on
 * detail/download (existence-hiding); the record-level canAccessDocument check
 * is the SOLE real visibility gate.
 */
export async function documentsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  const gate = MODULE_KEY;

  // Encapsulated raw-body parser (the razorpay-webhook.ts pattern): capture the
  // exact bytes for application/octet-stream into a Buffer. Content-type parsers
  // are encapsulated, so this does NOT affect the default JSON parser on the
  // other API routes. bodyLimit is enforced per-route on the upload handlers.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES },
    (_req, body, done) => done(null, body),
  );

  function actor(request: FastifyRequest) {
    return {
      actorUserId: request.user.userId,
      actorRoleKey: request.auth?.roles[0] ?? request.user.role,
      actorMembershipId: request.auth?.membershipId ?? null,
      requestRef: request.id,
    };
  }

  function docAuth(request: FastifyRequest): DocAuthContext {
    return {
      userId: request.auth!.userId,
      departmentScope: request.auth!.departmentScope,
      permissions: request.auth!.permissions,
    };
  }

  interface Deny {
    deny: string;
    status: number;
  }
  function deny(message: string, status: number): Deny {
    return { deny: message, status };
  }
  function isDeny(x: unknown): x is { deny: Deny } {
    return (
      typeof x === "object" &&
      x !== null &&
      "deny" in x &&
      typeof (x as { deny: unknown }).deny === "object"
    );
  }

  function isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
  }
  function isRestrictViolation(err: unknown): boolean {
    const msg = String((err as Error)?.message ?? err);
    return (
      msg.includes("restrict_violation") ||
      msg.includes("illegal") ||
      msg.includes("append-only") ||
      msg.includes("immutable")
    );
  }

  // Read the raw body Buffer; reject an empty or too-large body.
  function readUploadBody(request: FastifyRequest): Buffer | Deny {
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return deny("request body (file bytes) is required", 400);
    }
    if (body.length > MAX_UPLOAD_BYTES) {
      return deny("file too large", 413);
    }
    return body;
  }

  // Load the full grant set for a document (for the record-level check).
  async function loadGrants(
    tx: Prisma.TransactionClient,
    institutionId: string,
    documentId: string,
  ): Promise<GrantForAccess[]> {
    return tx.documentAccessGrant.findMany({
      where: { institutionId, documentId },
      select: {
        granteeUserId: true,
        granteeDepartmentId: true,
        accessLevel: true,
        revokedAt: true,
      },
    }) as unknown as Promise<GrantForAccess[]>;
  }

  // ─── 1. POST / — create a document + its first version (upload) ─────────────
  app.post(
    "/",
    {
      preHandler: [requirePermission("documents.upload_own"), requireModuleActive(gate)],
      bodyLimit: MAX_UPLOAD_BYTES,
    },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const parsedMeta = createDocumentSchema.safeParse({
        title: headerOrQuery(request, "title"),
        description: headerOrQuery(request, "description"),
        category: headerOrQuery(request, "category"),
        filename: headerOrQuery(request, "filename"),
        contentType: headerOrQuery(request, "contentType"),
        retentionPolicyId: headerOrQuery(request, "retentionPolicyId"),
      });
      if (!parsedMeta.success) return reply.status(400).send({ error: parsedMeta.error.flatten() });
      const meta = parsedMeta.data;

      const bodyOrDeny = readUploadBody(request);
      if (!Buffer.isBuffer(bodyOrDeny)) {
        return reply.status(bodyOrDeny.status).send({ error: bodyOrDeny.deny });
      }
      const body = bodyOrDeny;

      // Mint ids + storage key server-side (institutionId from the token ONLY).
      const documentId = randomUUID();
      const versionId = randomUUID();
      const storageKey = buildStorageKey(institutionId, documentId, versionId);
      const checksumSha256 = sha256Hex(body);
      const sizeBytes = BigInt(body.length);

      // Validate an optional retention policy same-tenant BEFORE storing bytes.
      if (meta.retentionPolicyId) {
        const policyExists = await withTenant(institutionId, (tx) =>
          tx.documentRetentionPolicy.findFirst({
            where: { id: meta.retentionPolicyId, institutionId },
            select: { id: true },
          }),
        );
        if (!policyExists) return reply.status(400).send({ error: "retention policy not found" });
      }

      // Store the object FIRST (design §8). A putObject failure commits nothing.
      try {
        await getObjectStore().putObject({
          key: storageKey,
          body,
          contentType: meta.contentType,
        });
      } catch (err) {
        request.log.error(
          { err: storageErr(err), key: storageKey },
          "documents: putObject failed on create",
        );
        return reply.status(502).send({ error: "Storage write failed" });
      }

      // Then commit the metadata in one tenant tx. On tx failure, compensate by
      // deleting the orphaned blob (best-effort).
      try {
        const created = await withTenant(institutionId, async (tx) => {
          const doc = await tx.document.create({
            data: {
              id: documentId,
              institutionId,
              title: meta.title,
              description: meta.description ?? null,
              category: meta.category ?? null,
              ownerUserId: userId,
              status: "ACTIVE",
              retentionPolicyId: meta.retentionPolicyId ?? null,
              createdByUserId: userId,
            },
          });
          const version = await tx.documentVersion.create({
            data: {
              id: versionId,
              institutionId,
              documentId: doc.id,
              version: 1,
              filename: meta.filename,
              contentType: meta.contentType,
              sizeBytes,
              checksumSha256,
              storageKey,
              uploadedByUserId: userId,
            },
          });
          await tx.document.update({
            where: { id: doc.id },
            data: { currentVersionId: version.id },
          });
          await recordAuditEvent(
            {
              action: "documents.document.created",
              result: "SUCCESS",
              ...actor(request),
              institutionId,
              resourceType: "Document",
              resourceId: doc.id,
            },
            tx,
          );
          await recordAuditEvent(
            {
              action: "documents.version.uploaded",
              result: "SUCCESS",
              ...actor(request),
              institutionId,
              resourceType: "DocumentVersion",
              resourceId: version.id,
              metadata: { documentId: doc.id, version: 1 },
            },
            tx,
          );
          return { doc, version };
        });

        return reply.status(201).send({
          ...created.doc,
          currentVersionId: created.version.id,
          currentVersion: serializeVersion(created.version),
        });
      } catch (err) {
        // The blob is orphaned (no row references it). Best-effort compensating
        // delete; a failure there is WARN (the blob is unreferenced + sweepable).
        await getObjectStore()
          .deleteObject(storageKey)
          .catch((delErr) =>
            request.log.warn(
              { err: storageErr(delErr), key: storageKey },
              "documents: compensating deleteObject failed (orphaned blob)",
            ),
          );
        request.log.error({ err: String(err), key: storageKey }, "documents: create tx failed");
        return reply.status(500).send({ error: "Document create failed" });
      }
    },
  );

  // ─── 2. POST /:id/versions — append a new version (upload) ──────────────────
  app.post(
    "/:id/versions",
    {
      preHandler: [requirePermission("documents.upload_own"), requireModuleActive(gate)],
      bodyLimit: MAX_UPLOAD_BYTES,
    },
    async (request, reply) => {
      const { institutionId, userId } = request.user;
      const { id } = request.params as { id: string };
      const parsedMeta = newDocumentVersionSchema.safeParse({
        filename: headerOrQuery(request, "filename"),
        contentType: headerOrQuery(request, "contentType"),
      });
      if (!parsedMeta.success) return reply.status(400).send({ error: parsedMeta.error.flatten() });
      const meta = parsedMeta.data;

      const bodyOrDeny = readUploadBody(request);
      if (!Buffer.isBuffer(bodyOrDeny)) {
        return reply.status(bodyOrDeny.status).send({ error: bodyOrDeny.deny });
      }
      const body = bodyOrDeny;

      // Authorize + compute the next version number inside the tenant tx FIRST
      // (read-only), so we never store bytes for an unauthorized / illegal upload.
      const pre = await withTenant(institutionId, async (tx) => {
        const doc = await tx.document.findFirst({
          where: { id, institutionId },
          select: { id: true, ownerUserId: true, status: true },
        });
        if (!doc) return { notFound: true as const };
        const grants = await loadGrants(tx, institutionId, doc.id);
        // Owner or a live MANAGE-grantee may upload a new version.
        if (!canAccessDocument(docAuth(request), doc, grants, "MANAGE")) {
          return { notFound: true as const }; // existence-hiding for non-owner/non-grantee
        }
        if (doc.status !== "ACTIVE") {
          return { deny: deny("document is not ACTIVE", 409) };
        }
        const last = await tx.documentVersion.findFirst({
          where: { institutionId, documentId: doc.id },
          orderBy: { version: "desc" },
          select: { version: true },
        });
        return { doc, nextVersion: (last?.version ?? 0) + 1 };
      });

      if ("notFound" in pre) return reply.status(404).send({ error: "document not found" });
      if (isDeny(pre)) return reply.status(pre.deny.status).send({ error: pre.deny.deny });

      const versionId = randomUUID();
      const storageKey = buildStorageKey(institutionId, pre.doc.id, versionId);
      const checksumSha256 = sha256Hex(body);
      const sizeBytes = BigInt(body.length);

      // Store the object FIRST (design §8).
      try {
        await getObjectStore().putObject({ key: storageKey, body, contentType: meta.contentType });
      } catch (err) {
        request.log.error(
          { err: storageErr(err), key: storageKey },
          "documents: putObject failed on new version",
        );
        return reply.status(502).send({ error: "Storage write failed" });
      }

      try {
        const result = await withTenant(institutionId, async (tx) => {
          // Re-read + re-guard that the document is still ACTIVE inside the tx.
          const doc = await tx.document.findFirst({
            where: { id: pre.doc.id, institutionId },
            select: { id: true, status: true },
          });
          if (!doc || doc.status !== "ACTIVE") {
            return { stale: true as const };
          }
          const version = await tx.documentVersion.create({
            data: {
              id: versionId,
              institutionId,
              documentId: doc.id,
              version: pre.nextVersion,
              filename: meta.filename,
              contentType: meta.contentType,
              sizeBytes,
              checksumSha256,
              storageKey,
              uploadedByUserId: userId,
            },
          });
          await tx.document.update({
            where: { id: doc.id },
            data: { currentVersionId: version.id },
          });
          await recordAuditEvent(
            {
              action: "documents.version.uploaded",
              result: "SUCCESS",
              ...actor(request),
              institutionId,
              resourceType: "DocumentVersion",
              resourceId: version.id,
              metadata: { documentId: doc.id, version: version.version },
            },
            tx,
          );
          return { version };
        });

        if ("stale" in result) {
          await getObjectStore().deleteObject(storageKey).catch(() => {});
          return reply.status(409).send({ error: "document is not ACTIVE" });
        }
        return reply.status(201).send(serializeVersion(result.version));
      } catch (err) {
        await getObjectStore()
          .deleteObject(storageKey)
          .catch((delErr) =>
            request.log.warn(
              { err: storageErr(delErr), key: storageKey },
              "documents: compensating deleteObject failed (orphaned version blob)",
            ),
          );
        request.log.error({ err: String(err), key: storageKey }, "documents: new-version tx failed");
        return reply.status(500).send({ error: "Version upload failed" });
      }
    },
  );

  // ─── 3. GET / — list documents (view_own OR admin.view_all) ─────────────────
  // Inline dual gate: own-scope (documents.view_own) returns OWN docs;
  // tenant-scope (documents.admin.view_all) returns all. A caller with neither
  // coarse key is 403.
  app.get("/", { preHandler: [requireModuleActive(gate)] }, async (request, reply) => {
    if (!request.auth) return reply.status(401).send({ error: "Unauthorized" });
    const hasOwn = can(request.auth, "documents.view_own");
    const hasAll = can(request.auth, "documents.admin.view_all");
    if (!hasOwn && !hasAll) {
      return reply.status(403).send({ error: "Forbidden: missing permission" });
    }
    const { institutionId, userId } = request.user;
    const parsed = documentListQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const q = parsed.data;

    // Scope resolution: a non-admin is always own-scoped; an admin defaults to
    // tenant-scope but may request ?scope=mine.
    const tenantScoped = hasAll && q.scope !== "mine";

    const where: Prisma.DocumentWhereInput = {
      institutionId,
      ...(tenantScoped ? {} : { ownerUserId: userId }),
      // Default listing hides ARCHIVED/PURGED unless an explicit status filter is
      // given (archive = hidden from the default active listing, design §8).
      ...(q.status
        ? { status: q.status as Prisma.EnumDocumentStatusFilter["equals"] }
        : { status: "ACTIVE" }),
      ...(tenantScoped && q.ownerUserId ? { ownerUserId: q.ownerUserId } : {}),
      ...(q.category ? { category: q.category } : {}),
    };

    const result = await withTenant(institutionId, async (tx) => {
      const [total, rows] = await Promise.all([
        tx.document.count({ where }),
        tx.document.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
      ]);
      return { total, rows };
    });

    return reply.send({ page: q.page, pageSize: q.pageSize, total: result.total, data: result.rows });
  });

  // ─── 4. GET /:id — document detail + versions + grants (NOT logged) ─────────
  app.get("/:id", { preHandler: [requireModuleActive(gate)] }, async (request, reply) => {
    if (!request.auth) return reply.status(401).send({ error: "Unauthorized" });
    if (
      !can(request.auth, "documents.view_own") &&
      !can(request.auth, "documents.download") &&
      !can(request.auth, "documents.admin.view_all")
    ) {
      return reply.status(403).send({ error: "Forbidden: missing permission" });
    }
    const { institutionId } = request.user;
    const { id } = request.params as { id: string };

    const found = await withTenant(institutionId, async (tx) => {
      const doc = await tx.document.findFirst({ where: { id, institutionId } });
      if (!doc) return null;
      const grants = await loadGrants(tx, institutionId, doc.id);
      if (!canAccessDocument(docAuth(request), doc, grants, "READ")) {
        return { hidden: true as const };
      }
      const [versions, fullGrants] = await Promise.all([
        tx.documentVersion.findMany({
          where: { institutionId, documentId: doc.id },
          orderBy: { version: "asc" },
        }),
        tx.documentAccessGrant.findMany({
          where: { institutionId, documentId: doc.id },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        }),
      ]);
      return { doc, versions: versions.map(serializeVersion), grants: fullGrants };
    });

    // Not-public-by-default: both "no row" and "not visible to me" → 404.
    if (!found || "hidden" in found) {
      return reply.status(404).send({ error: "document not found" });
    }
    return reply.send(found);
  });

  // ─── 5. POST /:id/versions/:vid/download-url — mint a signed URL ────────────
  app.post(
    "/:id/versions/:vid/download-url",
    { preHandler: [requireModuleActive(gate)] },
    async (request, reply) => {
      if (!request.auth) return reply.status(401).send({ error: "Unauthorized" });
      if (
        !can(request.auth, "documents.download") &&
        !can(request.auth, "documents.view_own") &&
        !can(request.auth, "documents.admin.view_all")
      ) {
        return reply.status(403).send({ error: "Forbidden: missing permission" });
      }
      const { institutionId } = request.user;
      const { id, vid } = request.params as { id: string; vid: string };

      const pre = await withTenant(institutionId, async (tx) => {
        const doc = await tx.document.findFirst({
          where: { id, institutionId },
          select: { id: true, ownerUserId: true, status: true },
        });
        if (!doc) return { notFound: true as const };
        const grants = await loadGrants(tx, institutionId, doc.id);
        if (!canAccessDocument(docAuth(request), doc, grants, "READ")) {
          return { notFound: true as const }; // existence-hiding
        }
        // Lifecycle gate: bytes are gone or going.
        if (doc.status === "PURGE_PENDING" || doc.status === "PURGED") {
          return { deny: deny("document is not downloadable", 403) };
        }
        const version = await tx.documentVersion.findFirst({
          where: { id: vid, institutionId, documentId: doc.id },
          select: { id: true, storageKey: true },
        });
        if (!version) return { notFound: true as const };
        return { doc, version };
      });

      if ("notFound" in pre) return reply.status(404).send({ error: "document not found" });
      if (isDeny(pre)) return reply.status(pre.deny.status).send({ error: pre.deny.deny });

      // Mint the short-lived signed URL AFTER the authorization check.
      let signed;
      try {
        signed = await getObjectStore().getSignedDownloadUrl(
          pre.version.storageKey,
          DOWNLOAD_URL_TTL_SECONDS,
        );
      } catch (err) {
        request.log.error(
          { err: storageErr(err), key: pre.version.storageKey },
          "documents: getSignedDownloadUrl failed",
        );
        return reply.status(502).send({ error: "Signed URL unavailable" });
      }

      // Write the append-only access-log row + audit in one tenant tx.
      await withTenant(institutionId, async (tx) => {
        await tx.documentAccessLog.create({
          data: {
            institutionId,
            documentId: pre.doc.id,
            versionId: pre.version.id,
            userId: request.user.userId,
            action: "DOWNLOAD_URL_MINTED",
          },
        });
        await recordAuditEvent(
          {
            action: "documents.download_url.minted",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "DocumentVersion",
            resourceId: pre.version.id,
            metadata: { documentId: pre.doc.id },
          },
          tx,
        );
      });

      return reply.send({ url: signed.url, expiresAt: signed.expiresAt.toISOString() });
    },
  );

  // ─── 6. POST /:id/grants — grant access (grants.manage) ─────────────────────
  app.post(
    "/:id/grants",
    { preHandler: [requirePermission("documents.grants.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const parsed = createDocumentGrantSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const doc = await tx.document.findFirst({
          where: { id, institutionId },
          select: { id: true, ownerUserId: true },
        });
        if (!doc) return { notFound: true as const };
        const grants = await loadGrants(tx, institutionId, doc.id);
        // Owner / admin / MANAGE-grantee may administer grants → else 403.
        if (!canAccessDocument(docAuth(request), doc, grants, "MANAGE")) {
          await recordAuditEvent(
            {
              action: "documents.grant.created",
              result: "DENIED",
              ...actor(request),
              institutionId,
              resourceType: "Document",
              resourceId: doc.id,
              metadata: { reason: "not_owner_or_manager" },
            },
            tx,
          );
          return { deny: deny("Forbidden: cannot manage grants on this document", 403) };
        }

        // Grantee must exist same-tenant.
        if (data.granteeUserId) {
          const u = await tx.user.findFirst({
            where: { id: data.granteeUserId, institutionId },
            select: { id: true },
          });
          if (!u) return { deny: deny("grantee user not found", 400) };
        } else if (data.granteeDepartmentId) {
          const d = await tx.department.findFirst({
            where: { id: data.granteeDepartmentId, institutionId },
            select: { id: true },
          });
          if (!d) return { deny: deny("grantee department not found", 400) };
        }

        let grant;
        try {
          grant = await tx.documentAccessGrant.create({
            data: {
              institutionId,
              documentId: doc.id,
              granteeUserId: data.granteeUserId ?? null,
              granteeDepartmentId: data.granteeDepartmentId ?? null,
              accessLevel: data.accessLevel,
              grantedByUserId: request.user.userId,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("a live grant already exists for this grantee", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "documents.grant.created",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "DocumentAccessGrant",
            resourceId: grant.id,
            metadata: { documentId: doc.id, accessLevel: data.accessLevel },
          },
          tx,
        );
        return { grant };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "document not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send(outcome.grant);
    },
  );

  // ─── 7. DELETE /:id/grants/:grantId — revoke a grant (grants.manage) ────────
  app.delete(
    "/:id/grants/:grantId",
    { preHandler: [requirePermission("documents.grants.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id, grantId } = request.params as { id: string; grantId: string };

      const outcome = await withTenant(institutionId, async (tx) => {
        const doc = await tx.document.findFirst({
          where: { id, institutionId },
          select: { id: true, ownerUserId: true },
        });
        if (!doc) return { notFound: true as const };
        const grants = await loadGrants(tx, institutionId, doc.id);
        if (!canAccessDocument(docAuth(request), doc, grants, "MANAGE")) {
          return { deny: deny("Forbidden: cannot manage grants on this document", 403) };
        }
        const grant = await tx.documentAccessGrant.findFirst({
          where: { id: grantId, institutionId, documentId: doc.id, revokedAt: null },
          select: { id: true },
        });
        if (!grant) return { grantNotFound: true as const };
        await tx.documentAccessGrant.update({
          where: { id: grant.id },
          data: { revokedAt: new Date(), revokedByUserId: request.user.userId },
        });
        await recordAuditEvent(
          {
            action: "documents.grant.revoked",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "DocumentAccessGrant",
            resourceId: grant.id,
            metadata: { documentId: doc.id },
          },
          tx,
        );
        return { ok: true as const };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "document not found" });
      if ("grantNotFound" in outcome) return reply.status(404).send({ error: "grant not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send({ status: "revoked" });
    },
  );

  // ─── 7b. GET /users/lookup — grantee picker for the grant-management screen ──
  // Gated by documents.grants.manage (the key the grant form uses to set
  // granteeUserId). FACULTY (the document-owning role) holds grants.manage but
  // has NO admin.users.view (strict least privilege), so without this the grant
  // form would have no way to resolve a user id. Returns ONLY non-student tenant
  // users (id/email/name) — a grant manager cannot enumerate students through it
  // (the inventory G-INV1 / hostel G-HOS6 / service-requests G-SR1 precedent).
  // Read-only, no audit.
  app.get(
    "/users/lookup",
    { preHandler: [requirePermission("documents.grants.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = documentsUserLookupQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { q, limit } = parsed.data;
      const users = await withTenant(institutionId, (tx) =>
        tx.user.findMany({
          where: {
            institutionId,
            studentProfile: null,
            OR: [
              { email: { contains: q, mode: "insensitive" } },
              { facultyProfile: { name: { contains: q, mode: "insensitive" } } },
            ],
          },
          orderBy: [{ email: "asc" }],
          take: limit,
          select: { id: true, email: true, facultyProfile: { select: { name: true } } },
        }),
      );
      return reply.send({
        users: users.map((u) => ({ id: u.id, email: u.email, name: u.facultyProfile?.name ?? null })),
      });
    },
  );

  // ─── 8-11. Lifecycle transitions (retention.manage) ─────────────────────────
  const lifecycleRoutes: Array<{
    path: string;
    to: "ARCHIVED" | "ACTIVE" | "PURGE_PENDING";
    action: "documents.document.archived" | "documents.document.unarchived" | "documents.document.purge_requested";
  }> = [
    { path: "/:id/archive", to: "ARCHIVED", action: "documents.document.archived" },
    { path: "/:id/unarchive", to: "ACTIVE", action: "documents.document.unarchived" },
    { path: "/:id/purge-request", to: "PURGE_PENDING", action: "documents.document.purge_requested" },
  ];
  for (const route of lifecycleRoutes) {
    app.post(
      route.path,
      { preHandler: [requirePermission("documents.retention.manage"), requireModuleActive(gate)] },
      async (request, reply) => {
        const { institutionId } = request.user;
        const { id } = request.params as { id: string };

        const outcome = await withTenant(institutionId, async (tx) => {
          const doc = await tx.document.findFirst({
            where: { id, institutionId },
            select: { id: true, status: true },
          });
          if (!doc) return { notFound: true as const };
          if (!isLegalDocTransition(doc.status, route.to)) {
            await recordAuditEvent(
              {
                action: route.action,
                result: "DENIED",
                ...actor(request),
                institutionId,
                resourceType: "Document",
                resourceId: doc.id,
                metadata: { from: doc.status, to: route.to, reason: "illegal_transition" },
              },
              tx,
            );
            return { deny: deny(`illegal transition ${doc.status} -> ${route.to}`, 409) };
          }
          try {
            await tx.document.update({ where: { id: doc.id }, data: { status: route.to } });
          } catch (err) {
            if (isRestrictViolation(err)) return { deny: deny("illegal transition", 409) };
            throw err;
          }
          await recordAuditEvent(
            {
              action: route.action,
              result: "SUCCESS",
              ...actor(request),
              institutionId,
              resourceType: "Document",
              resourceId: doc.id,
              metadata: { from: doc.status, to: route.to },
            },
            tx,
          );
          return { ok: true as const };
        });

        if ("notFound" in outcome) return reply.status(404).send({ error: "document not found" });
        if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
        return reply.send({ status: route.to });
      },
    );
  }

  // ─── 12. POST /:id/purge — delete blobs + flip PURGED (retention.manage) ────
  app.post(
    "/:id/purge",
    { preHandler: [requirePermission("documents.retention.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };

      // Load the doc + every version's storage key.
      const pre = await withTenant(institutionId, async (tx) => {
        const doc = await tx.document.findFirst({
          where: { id, institutionId },
          select: { id: true, status: true },
        });
        if (!doc) return { notFound: true as const };
        if (doc.status !== "PURGE_PENDING") {
          return { deny: deny("document is not PURGE_PENDING", 409) };
        }
        const versions = await tx.documentVersion.findMany({
          where: { institutionId, documentId: doc.id },
          select: { storageKey: true },
        });
        return { doc, keys: versions.map((v) => v.storageKey) };
      });

      if ("notFound" in pre) return reply.status(404).send({ error: "document not found" });
      if (isDeny(pre)) return reply.status(pre.deny.status).send({ error: pre.deny.deny });

      // Delete every version blob FIRST; the first failure aborts (stay
      // PURGE_PENDING, 502, retryable next sweep).
      for (const key of pre.keys) {
        try {
          await getObjectStore().deleteObject(key);
        } catch (err) {
          request.log.error(
            { err: storageErr(err), key },
            "documents: purge deleteObject failed",
          );
          return reply.status(502).send({ error: "Storage delete failed" });
        }
      }

      // Flip to PURGED + audit (metadata + version rows RETAINED as a tombstone).
      try {
        await withTenant(institutionId, async (tx) => {
          await tx.document.update({ where: { id: pre.doc.id }, data: { status: "PURGED" } });
          await recordAuditEvent(
            {
              action: "documents.purged",
              result: "SUCCESS",
              ...actor(request),
              institutionId,
              resourceType: "Document",
              resourceId: pre.doc.id,
              metadata: { versionsPurged: pre.keys.length },
            },
            tx,
          );
        });
      } catch (err) {
        if (isRestrictViolation(err)) return reply.status(409).send({ error: "illegal transition" });
        throw err;
      }
      return reply.send({ status: "PURGED" });
    },
  );

  // ─── 13-15. Retention policies CRUD (retention.manage) ──────────────────────
  app.get(
    "/retention-policies",
    { preHandler: [requirePermission("documents.retention.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const policies = await withTenant(institutionId, (tx) =>
        tx.documentRetentionPolicy.findMany({
          where: { institutionId },
          orderBy: [{ name: "asc" }, { id: "asc" }],
        }),
      );
      return reply.send(policies);
    },
  );

  app.post(
    "/retention-policies",
    { preHandler: [requirePermission("documents.retention.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const parsed = upsertDocumentRetentionPolicySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        let policy;
        try {
          policy = await tx.documentRetentionPolicy.create({
            data: {
              institutionId,
              name: data.name,
              retentionDays: data.retentionDays,
              category: data.category ?? null,
              createdByUserId: request.user.userId,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("a policy with this name already exists", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "documents.retention_policy.upserted",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "DocumentRetentionPolicy",
            resourceId: policy.id,
          },
          tx,
        );
        return { policy };
      });

      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.status(201).send(outcome.policy);
    },
  );

  app.patch(
    "/retention-policies/:policyId",
    { preHandler: [requirePermission("documents.retention.manage"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { policyId } = request.params as { policyId: string };
      const parsed = patchDocumentRetentionPolicySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      const outcome = await withTenant(institutionId, async (tx) => {
        const existing = await tx.documentRetentionPolicy.findFirst({
          where: { id: policyId, institutionId },
          select: { id: true },
        });
        if (!existing) return { notFound: true as const };
        let policy;
        try {
          policy = await tx.documentRetentionPolicy.update({
            where: { id: existing.id },
            data: {
              ...(data.name !== undefined ? { name: data.name } : {}),
              ...(data.retentionDays !== undefined ? { retentionDays: data.retentionDays } : {}),
              ...("category" in data ? { category: data.category ?? null } : {}),
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { deny: deny("a policy with this name already exists", 409) };
          throw err;
        }
        await recordAuditEvent(
          {
            action: "documents.retention_policy.upserted",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "DocumentRetentionPolicy",
            resourceId: policy.id,
          },
          tx,
        );
        return { policy };
      });

      if ("notFound" in outcome) return reply.status(404).send({ error: "retention policy not found" });
      if (isDeny(outcome)) return reply.status(outcome.deny.status).send({ error: outcome.deny.deny });
      return reply.send(outcome.policy);
    },
  );

  // ─── 16. GET /report — aggregate JSON (admin.view_all) ──────────────────────
  app.get(
    "/report",
    { preHandler: [requirePermission("documents.admin.view_all"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const report = await withTenant(institutionId, async (tx) => {
        const [byStatus, totalVersions, totalMints, purgeQueue] = await Promise.all([
          tx.document.groupBy({ by: ["status"], where: { institutionId }, _count: { _all: true } }),
          tx.documentVersion.count({ where: { institutionId } }),
          tx.documentAccessLog.count({
            where: { institutionId, action: "DOWNLOAD_URL_MINTED" },
          }),
          tx.document.findMany({
            where: { institutionId, status: "PURGE_PENDING" },
            select: { id: true, title: true, retainUntil: true },
            orderBy: [{ retainUntil: "asc" }, { id: "asc" }],
            take: 200,
          }),
        ]);
        return {
          inventory: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
          totalVersions,
          accessLog: { totalDownloadUrlMints: totalMints },
          purgeQueue,
        };
      });
      return reply.send(report);
    },
  );

  // ─── 17. GET /report/export — XLSX (admin.view_all, audited) ────────────────
  app.get(
    "/report/export",
    { preHandler: [requirePermission("documents.admin.view_all"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const rows = await withTenant(institutionId, (tx) =>
        tx.document.findMany({
          where: { institutionId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 5000,
        }),
      );

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Documents");
      sheet.columns = [
        { header: "ID", key: "id", width: 28 },
        { header: "Title", key: "title", width: 40 },
        { header: "Category", key: "category", width: 20 },
        { header: "Owner User", key: "ownerUserId", width: 28 },
        { header: "Status", key: "status", width: 16 },
        { header: "Retention Policy", key: "retentionPolicyId", width: 28 },
        { header: "Retain Until", key: "retainUntil", width: 22 },
        { header: "Created At", key: "createdAt", width: 22 },
      ];
      for (const r of rows) {
        sheet.addRow({
          id: r.id,
          title: r.title,
          category: r.category ?? "",
          ownerUserId: r.ownerUserId,
          status: r.status,
          retentionPolicyId: r.retentionPolicyId ?? "",
          retainUntil: r.retainUntil ? r.retainUntil.toISOString() : "",
          createdAt: r.createdAt.toISOString(),
        });
      }
      sheet.getRow(1).font = { bold: true };

      await withTenant(institutionId, (tx) =>
        recordAuditEvent(
          {
            action: "documents.report.exported",
            result: "SUCCESS",
            ...actor(request),
            institutionId,
            resourceType: "Document",
            resourceId: null,
            metadata: { rows: rows.length },
          },
          tx,
        ),
      );

      const filename = `documents-${new Date().toISOString().slice(0, 10)}.xlsx`;
      const buffer = await workbook.xlsx.writeBuffer();
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(Buffer.from(buffer));
    },
  );

  // ─── 18. GET /:id/access-log — per-document ledger (audit.view) ─────────────
  app.get(
    "/:id/access-log",
    { preHandler: [requirePermission("documents.audit.view"), requireModuleActive(gate)] },
    async (request, reply) => {
      const { institutionId } = request.user;
      const { id } = request.params as { id: string };
      const result = await withTenant(institutionId, async (tx) => {
        const doc = await tx.document.findFirst({
          where: { id, institutionId },
          select: { id: true },
        });
        if (!doc) return null;
        const logs = await tx.documentAccessLog.findMany({
          where: { institutionId, documentId: doc.id },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1000,
        });
        return logs;
      });
      if (!result) return reply.status(404).send({ error: "document not found" });
      return reply.send(result);
    },
  );
}

// ─── Small module-local helpers ──────────────────────────────────────────────

/** Read an upload-metadata value from the `x-<field>` header or the query. The
 *  raw body carries the file bytes, so metadata rides on headers/query (§8). */
function headerOrQuery(request: FastifyRequest, field: string): string | undefined {
  const headerKey = `x-${field.toLowerCase()}`;
  const h = request.headers[headerKey];
  if (typeof h === "string" && h.length > 0) return h;
  const q = (request.query as Record<string, unknown> | undefined)?.[field];
  if (typeof q === "string" && q.length > 0) return q;
  return undefined;
}

/** Shape a storage error for a log line WITHOUT ever leaking the service-role
 *  key. ObjectStoreError carries only status + op; a generic error carries only
 *  its message (adapter never puts the key in the message). */
function storageErr(err: unknown): Record<string, unknown> {
  if (err instanceof ObjectStoreError) {
    return { op: err.op, status: err.status };
  }
  return { message: String((err as Error)?.message ?? err) };
}
