import { describe, expect, it } from "vitest";
import { canManageDocument, canReadDocument, type AclSubject } from "../acl";
import type { DocumentGrant, DocumentRow } from "../types";

function doc(ownerUserId: string): DocumentRow {
  return {
    id: "d1",
    institutionId: "i1",
    ownerUserId,
    title: "t",
    description: null,
    category: null,
    status: "ACTIVE",
    currentVersionId: "v1",
    retentionPolicyId: null,
    retainUntil: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function grant(partial: Partial<DocumentGrant>): DocumentGrant {
  return {
    id: "g1",
    documentId: "d1",
    granteeUserId: null,
    granteeDepartmentId: null,
    accessLevel: "READ",
    createdAt: "2026-01-01T00:00:00.000Z",
    revokedAt: null,
    revokedByUserId: null,
    ...partial,
  };
}

const outsider: AclSubject = { userId: "u-out", departmentScope: null, hasAdminViewAll: false };

describe("canReadDocument / canManageDocument", () => {
  it("admin.view_all → full READ + MANAGE on any doc", () => {
    const me: AclSubject = { userId: "u-admin", departmentScope: null, hasAdminViewAll: true };
    expect(canReadDocument(doc("someone"), [], me)).toBe(true);
    expect(canManageDocument(doc("someone"), [], me)).toBe(true);
  });

  it("owner → full READ + MANAGE on their own doc", () => {
    const me: AclSubject = { userId: "u-owner", departmentScope: null, hasAdminViewAll: false };
    expect(canReadDocument(doc("u-owner"), [], me)).toBe(true);
    expect(canManageDocument(doc("u-owner"), [], me)).toBe(true);
  });

  it("a live user READ grant → READ but not MANAGE", () => {
    const me: AclSubject = { userId: "u-g", departmentScope: null, hasAdminViewAll: false };
    const grants = [grant({ granteeUserId: "u-g", accessLevel: "READ" })];
    expect(canReadDocument(doc("owner"), grants, me)).toBe(true);
    expect(canManageDocument(doc("owner"), grants, me)).toBe(false);
  });

  it("a live user MANAGE grant → READ and MANAGE (MANAGE ⊇ READ)", () => {
    const me: AclSubject = { userId: "u-g", departmentScope: null, hasAdminViewAll: false };
    const grants = [grant({ granteeUserId: "u-g", accessLevel: "MANAGE" })];
    expect(canReadDocument(doc("owner"), grants, me)).toBe(true);
    expect(canManageDocument(doc("owner"), grants, me)).toBe(true);
  });

  it("a department grant extends to a member with the matching departmentScope", () => {
    const me: AclSubject = { userId: "u-g", departmentScope: "dept-1", hasAdminViewAll: false };
    const grants = [grant({ granteeDepartmentId: "dept-1", accessLevel: "READ" })];
    expect(canReadDocument(doc("owner"), grants, me)).toBe(true);
    // a different department does not match
    const other: AclSubject = { userId: "u-x", departmentScope: "dept-2", hasAdminViewAll: false };
    expect(canReadDocument(doc("owner"), grants, other)).toBe(false);
    // null departmentScope never matches a department grant
    expect(canReadDocument(doc("owner"), grants, outsider)).toBe(false);
  });

  it("a revoked grant is ignored", () => {
    const me: AclSubject = { userId: "u-g", departmentScope: null, hasAdminViewAll: false };
    const grants = [grant({ granteeUserId: "u-g", accessLevel: "MANAGE", revokedAt: "2026-02-01T00:00:00.000Z" })];
    expect(canReadDocument(doc("owner"), grants, me)).toBe(false);
    expect(canManageDocument(doc("owner"), grants, me)).toBe(false);
  });

  it("an unrelated caller with no grant → no access", () => {
    expect(canReadDocument(doc("owner"), [grant({ granteeUserId: "someone-else" })], outsider)).toBe(false);
  });
});
