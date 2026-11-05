// Hand-written from api-contract.md. Dates are ISO strings.
// NOTE: `sizeBytes` is serialized as a STRING in every response (DB BigInt
// coercion) — never treat it as a number; parse via labels.formatBytes.

export type DocStatus = "ACTIVE" | "ARCHIVED" | "PURGE_PENDING" | "PURGED";
export type AccessLevel = "READ" | "MANAGE";

export interface DocumentRow {
  id: string;
  institutionId: string;
  ownerUserId: string;
  title: string;
  description: string | null;
  category: string | null;
  status: DocStatus;
  currentVersionId: string | null;
  retentionPolicyId: string | null;
  retainUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  version: number;
  filename: string;
  contentType: string;
  /** BigInt coerced to string by the API. */
  sizeBytes: string;
  checksumSha256: string | null;
  createdAt: string;
}

export interface DocumentGrant {
  id: string;
  documentId: string;
  granteeUserId: string | null;
  granteeDepartmentId: string | null;
  accessLevel: AccessLevel;
  createdAt: string;
  revokedAt: string | null;
  revokedByUserId: string | null;
}

/** GET /api/documents/:id */
export interface DocumentDetail {
  doc: DocumentRow;
  versions: DocumentVersion[];
  grants: DocumentGrant[];
}

/** POST /api/documents — the created row plus the v1 version. */
export interface CreatedDocument extends DocumentRow {
  currentVersion: DocumentVersion;
}

/** GET /api/documents list envelope. */
export interface DocumentListEnvelope {
  page: number;
  pageSize: number;
  total: number;
  data: DocumentRow[];
}

export interface RetentionPolicy {
  id: string;
  name: string;
  retentionDays: number;
  category: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentReport {
  inventory: { status: DocStatus; count: number }[];
  totalVersions: number;
  accessLog: { totalDownloadUrlMints: number };
  purgeQueue: { id: string; title: string; retainUntil: string | null }[];
}

export interface AccessLogRow {
  id: string;
  documentId: string;
  versionId: string | null;
  actorUserId: string | null;
  action: string;
  createdAt: string;
}

export interface UserLookupItem {
  id: string;
  email: string;
  name: string | null;
}

export interface MintedDownloadUrl {
  url: string;
  expiresAt: string;
}
