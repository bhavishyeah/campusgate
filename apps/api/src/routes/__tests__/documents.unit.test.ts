/**
 * Phase-9.7 Document Management FAST unit specs (no DB, no Fastify). Covers the
 * PURE pieces the live-DB suites would be wasteful to re-prove (design §16.1):
 *   - the canAccessDocument matrix (owner, user-grant, dept-grant via
 *     departmentScope, MANAGE⊇READ, revoked-grant denies, admin sees all,
 *     unrelated → deny, not-public-by-default);
 *   - isLegalDocTransition (every legal + illegal edge, PURGED terminal);
 *   - buildStorageKey + sha256Hex;
 *   - the exported Zod schemas (valid/invalid, incl. the grant XOR rule).
 *
 * The transition/access logic mirrors documents.ts EXACTLY so drift is caught by
 * the behavioral suite that drives the real handler.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canAccessDocument,
  isLegalDocTransition,
  buildStorageKey,
  sha256Hex,
  DOC_STATUS_TRANSITIONS,
  type DocAuthContext,
  type GrantForAccess,
} from "../documents.js";
import {
  createDocumentSchema,
  newDocumentVersionSchema,
  createDocumentGrantSchema,
  upsertDocumentRetentionPolicySchema,
  documentListQuerySchema,
} from "@campusgate/shared";

const ownerAuth: DocAuthContext = {
  userId: "owner-1",
  departmentScope: "dept-1",
  permissions: ["documents.upload_own", "documents.view_own", "documents.download"],
};
const adminAuth: DocAuthContext = {
  userId: "admin-1",
  departmentScope: null,
  permissions: ["documents.admin.view_all", "documents.download"],
};
const strangerAuth: DocAuthContext = {
  userId: "stranger-1",
  departmentScope: "dept-9",
  permissions: ["documents.download"],
};
const doc = { ownerUserId: "owner-1" };

function liveUserGrant(userId: string, level: "READ" | "MANAGE"): GrantForAccess {
  return { granteeUserId: userId, granteeDepartmentId: null, accessLevel: level, revokedAt: null };
}
function liveDeptGrant(deptId: string, level: "READ" | "MANAGE"): GrantForAccess {
  return { granteeUserId: null, granteeDepartmentId: deptId, accessLevel: level, revokedAt: null };
}

describe("canAccessDocument (design §11)", () => {
  it("admin / DOCUMENT_MANAGER (admin.view_all) sees any document at any level", () => {
    expect(canAccessDocument(adminAuth, doc, [], "READ")).toBe(true);
    expect(canAccessDocument(adminAuth, doc, [], "MANAGE")).toBe(true);
  });

  it("owner has full access to OWN doc", () => {
    expect(canAccessDocument(ownerAuth, doc, [], "READ")).toBe(true);
    expect(canAccessDocument(ownerAuth, doc, [], "MANAGE")).toBe(true);
  });

  it("a live user-grant grants exactly its level (MANAGE ⊇ READ)", () => {
    expect(canAccessDocument(strangerAuth, doc, [liveUserGrant("stranger-1", "READ")], "READ")).toBe(true);
    expect(canAccessDocument(strangerAuth, doc, [liveUserGrant("stranger-1", "READ")], "MANAGE")).toBe(false);
    expect(canAccessDocument(strangerAuth, doc, [liveUserGrant("stranger-1", "MANAGE")], "READ")).toBe(true);
    expect(canAccessDocument(strangerAuth, doc, [liveUserGrant("stranger-1", "MANAGE")], "MANAGE")).toBe(true);
  });

  it("a department grant matches via departmentScope", () => {
    const deptMember: DocAuthContext = { userId: "acc-1", departmentScope: "finance", permissions: ["documents.download"] };
    expect(canAccessDocument(deptMember, doc, [liveDeptGrant("finance", "READ")], "READ")).toBe(true);
    // a member of a different department is not covered
    expect(canAccessDocument(strangerAuth, doc, [liveDeptGrant("finance", "READ")], "READ")).toBe(false);
  });

  it("a revoked grant denies", () => {
    const revoked: GrantForAccess = {
      granteeUserId: "stranger-1",
      granteeDepartmentId: null,
      accessLevel: "MANAGE",
      revokedAt: new Date(),
    };
    expect(canAccessDocument(strangerAuth, doc, [revoked], "READ")).toBe(false);
  });

  it("an unrelated requester (coarse download only, no grant) is NOT visible (404 path)", () => {
    expect(canAccessDocument(strangerAuth, doc, [], "READ")).toBe(false);
  });

  it("a null departmentScope never matches a department grant", () => {
    const noDept: DocAuthContext = { userId: "x", departmentScope: null, permissions: ["documents.download"] };
    expect(canAccessDocument(noDept, doc, [liveDeptGrant("finance", "READ")], "READ")).toBe(false);
  });
});

describe("isLegalDocTransition (design §12)", () => {
  it("permits exactly the forward-only legal edges + the no-op self transition", () => {
    expect(isLegalDocTransition("ACTIVE", "ARCHIVED")).toBe(true);
    expect(isLegalDocTransition("ACTIVE", "PURGE_PENDING")).toBe(true);
    expect(isLegalDocTransition("ARCHIVED", "ACTIVE")).toBe(true);
    expect(isLegalDocTransition("ARCHIVED", "PURGE_PENDING")).toBe(true);
    expect(isLegalDocTransition("PURGE_PENDING", "PURGED")).toBe(true);
    expect(isLegalDocTransition("ACTIVE", "ACTIVE")).toBe(true);
  });

  it("rejects illegal edges and treats PURGED as terminal", () => {
    expect(isLegalDocTransition("ACTIVE", "PURGED")).toBe(false);
    expect(isLegalDocTransition("ARCHIVED", "PURGED")).toBe(false);
    expect(isLegalDocTransition("PURGE_PENDING", "ACTIVE")).toBe(false);
    expect(isLegalDocTransition("PURGED", "ACTIVE")).toBe(false);
    expect(isLegalDocTransition("PURGED", "ARCHIVED")).toBe(false);
    expect(DOC_STATUS_TRANSITIONS.PURGED).toHaveLength(0);
  });
});

describe("buildStorageKey + sha256Hex", () => {
  it("builds the tenant-prefixed key <institutionId>/<documentId>/<versionId>", () => {
    expect(buildStorageKey("inst", "doc", "ver")).toBe("inst/doc/ver");
  });

  it("computes the sha256 hex of the received bytes", () => {
    const body = Buffer.from("payload");
    const expected = createHash("sha256").update(body).digest("hex");
    expect(sha256Hex(body)).toBe(expected);
    expect(sha256Hex(body)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("documents Zod schemas (design §10)", () => {
  it("createDocumentSchema accepts valid metadata + rejects an empty title", () => {
    expect(
      createDocumentSchema.safeParse({ title: "Policy", filename: "p.pdf", contentType: "application/pdf" }).success,
    ).toBe(true);
    expect(
      createDocumentSchema.safeParse({ title: "", filename: "p.pdf", contentType: "application/pdf" }).success,
    ).toBe(false);
  });

  it("newDocumentVersionSchema requires filename + contentType", () => {
    expect(newDocumentVersionSchema.safeParse({ filename: "v2.pdf", contentType: "application/pdf" }).success).toBe(true);
    expect(newDocumentVersionSchema.safeParse({ filename: "" }).success).toBe(false);
  });

  it("createDocumentGrantSchema enforces the grantee XOR", () => {
    expect(createDocumentGrantSchema.safeParse({ granteeUserId: "u1", accessLevel: "READ" }).success).toBe(true);
    expect(createDocumentGrantSchema.safeParse({ granteeDepartmentId: "d1", accessLevel: "MANAGE" }).success).toBe(true);
    // both → invalid
    expect(
      createDocumentGrantSchema.safeParse({ granteeUserId: "u1", granteeDepartmentId: "d1", accessLevel: "READ" }).success,
    ).toBe(false);
    // neither → invalid
    expect(createDocumentGrantSchema.safeParse({ accessLevel: "READ" }).success).toBe(false);
  });

  it("upsertDocumentRetentionPolicySchema bounds retentionDays", () => {
    expect(upsertDocumentRetentionPolicySchema.safeParse({ name: "P", retentionDays: 30 }).success).toBe(true);
    expect(upsertDocumentRetentionPolicySchema.safeParse({ name: "P", retentionDays: 0 }).success).toBe(false);
  });

  it("documentListQuerySchema applies bounded defaults", () => {
    const parsed = documentListQuerySchema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(20);
  });
});
