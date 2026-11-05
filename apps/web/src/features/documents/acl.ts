import type { AccessLevel, DocumentGrant, DocumentRow } from "./types";

/** The caller's identity for the client-side ACL mirror. */
export interface AclSubject {
  userId: string;
  /** The caller's department scope (membership), or null if none. */
  departmentScope: string | null;
  /** Holds documents.admin.view_all (ADMIN / DOCUMENT_MANAGER). */
  hasAdminViewAll: boolean;
}

/** MANAGE ⊇ READ. */
function levelSatisfies(have: AccessLevel, want: AccessLevel): boolean {
  if (want === "READ") return have === "READ" || have === "MANAGE";
  return have === "MANAGE";
}

/**
 * Does a live grant give `me` at least `want` access to `doc`?
 * A grant counts only when it is not revoked and targets either me (user) or my
 * department (departmentScope).
 */
function liveGrantSatisfies(grants: DocumentGrant[], me: AclSubject, want: AccessLevel): boolean {
  return grants.some((g) => {
    if (g.revokedAt !== null) return false;
    const targetsMe = g.granteeUserId !== null && g.granteeUserId === me.userId;
    const targetsMyDept =
      g.granteeDepartmentId !== null && me.departmentScope !== null && g.granteeDepartmentId === me.departmentScope;
    if (!targetsMe && !targetsMyDept) return false;
    return levelSatisfies(g.accessLevel, want);
  });
}

/**
 * Client-side MIRROR of the server canAccessDocument order (UX gate only — the
 * server stays authoritative). Order: admin key → owner → live grant.
 */
function canAccess(doc: DocumentRow, grants: DocumentGrant[], me: AclSubject, want: AccessLevel): boolean {
  if (me.hasAdminViewAll) return true;
  if (doc.ownerUserId === me.userId) return true;
  return liveGrantSatisfies(grants, me, want);
}

export function canReadDocument(doc: DocumentRow, grants: DocumentGrant[], me: AclSubject): boolean {
  return canAccess(doc, grants, me, "READ");
}

export function canManageDocument(doc: DocumentRow, grants: DocumentGrant[], me: AclSubject): boolean {
  return canAccess(doc, grants, me, "MANAGE");
}
