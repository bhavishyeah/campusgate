# CAMPASS Phase 9.7 — Document Management (backend only)

Combined requirements + technical design. The 7th and FINAL module of Phase 9 and
of the entire backend (Phases 0–9). Backend only. Work DIRECTLY on `main` in
`c:\campusgate` (NO worktree). Do NOT push or deploy. HEAD is `fbac57f` on
`origin/main` (Phase 9 Faculty + HR + Hostel + Transport + Inventory + Service
Requests complete; 22 migrations applied).

This design is grounded in, and mirrors, the REAL repo files cited throughout:
`apps/api/src/services/fees/razorpay.ts` (the injectable gateway seam),
`packages/db/prisma/migrations/20270124000000_phase9_service_requests/migration.sql`
(newest frozen lettered a–j migration), `packages/shared/src/modules.ts`,
`packages/shared/src/permissions.ts`, `packages/shared/src/audit-actions.ts`,
`apps/api/src/services/authz-engine.ts`, `apps/api/src/services/audit.ts`,
`apps/api/src/routes/service-requests.ts`, `apps/api/vitest.live-db-suites.ts`,
`apps/api/src/services/__tests__/catalogue-sync.test.ts`,
`apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts`, and
`apps/api/.env.example`.

---

## 1. Summary

Document Management stores large file BLOBS in OBJECT STORAGE (Supabase Storage),
NOT the relational DB. The relational DB stores only document METADATA — filename,
content type, size, sha256 checksum, ownership, access grants, version chain,
retention state, and the tenant-prefixed storage key — with the usual CAMPASS
guarantees: `institutionId` + composite same-tenant FKs on every table, ENABLE +
FORCE RLS with fail-closed nullif-guarded policies, append-only ledgers for the
version history and the access/download log, a forward-only document lifecycle
column guard, a targeted `campass_app` GRANT refresh, and full audit.

What makes this module structurally different from 9.1–9.6: all object-storage
access sits behind a SMALL storage-adapter interface (`ObjectStore`) with a
`SupabaseStorageAdapter` implementation and an in-memory stub, wired through an
injectable `getObjectStore` / `setObjectStore` singleton seam that MIRRORS
`razorpay.ts` EXACTLY. No storage SDK call is ever scattered through a route;
swapping the blob backend to R2/S3 later is one new adapter file. Fast/mocked
tests inject the in-memory stub and NEVER touch the network; the behavioral
live-DB suite injects an in-memory fake; a separate gated smoke check exercises
the real Supabase adapter end-to-end.

Not-public-by-default is the core access rule: a document is invisible unless the
requester is its OWNER, holds an active ACCESS GRANT, or is an ADMIN /
DOCUMENT_MANAGER. Downloads are minted as SHORT-LIVED SIGNED URLs on demand AFTER
the authorization check — never the service-role key, never a public URL.

This is a GATED "booster" module registered under a NEW key `documents`, which is
foundational-not-gated (`MODULE_DEPENDENCIES.documents = []`) exactly like every
Phase-9 module. The existing `StudentDocument` (SIS, `schema.prisma:615`) and
`ApplicationDocument` (admissions, `schema.prisma:2009`) tables are SEPARATE and
NOT touched — there is NO cross-module coupling in either direction.

---

## 2. Product decisions (called out explicitly, with rationale)

These four decisions are made here so the reviewer and planner can act on them;
each is internally consistent with the rest of the design.

### D-1. Upload transport — SERVER-RECEIVES-BYTES, then `adapter.putObject`

The API receives the file bytes (Fastify multipart) and the handler calls
`adapter.putObject`. We do NOT mint a signed UPLOAD url for the client to PUT to.

Rationale: a clean, single authorization story. The server is the only party that
touches storage with the service-role key; the checksum and size are computed
server-side from the exact bytes stored (no client-reported size/checksum to
trust); the tenant-prefixed key is minted server-side; and a permission + module +
ownership check gates the write in one place. The brief explicitly prefers
server-receives-bytes "for a clean authorization story unless size argues
otherwise," and documents are ordinary institutional files (policies, forms,
certificates, letters) that comfortably fit a bounded server-side limit. We cap
upload size at **25 MiB** (`MAX_UPLOAD_BYTES = 25 * 1024 * 1024`); a larger body is
rejected 413. `getSignedUploadUrl` is a REQUIRED method on the `ObjectStore` interface,
implemented by `SupabaseStorageAdapter` (via `POST /storage/v1/object/upload/sign/
{bucket}/{key}`) and by the in-memory stub, so the swap-to-R2/S3 contract stays
honest — but it is NOT wired to any route in this module (review finding 7). A
future large-file path can call it without reshaping the seam or handling an
`undefined` method.

**Transport mechanism (grounded in the repo).** `@fastify/multipart` is NOT a
current dependency and this module does NOT add it. Instead the upload routes use
the SAME proven house pattern as `apps/api/src/routes/razorpay-webhook.ts`: an
ENCAPSULATED `app.addContentTypeParser(..., { parseAs: "buffer" }, ...)` inside the
`documentsRoutes` plugin that captures the exact raw bytes into a `Buffer` (content-
type parsers are encapsulated, so this does NOT affect the default JSON parser on
the other API routes). The upload endpoints accept `application/octet-stream` (raw
body = the file bytes) with the document metadata (`title`, `description`,
`category`, `filename`, `contentType`, optional `retentionPolicyId`) carried as
query params / headers (e.g. `x-filename`, `x-content-type`) and validated by Zod.
This adds ZERO new dependencies and mirrors code already in the tree. The 25 MiB
cap is enforced by Fastify's `bodyLimit` on the route (reject → 413) plus a
defensive `buffer.length` check. (If the planner later prefers true multipart form
uploads, adding a pinned `@fastify/multipart` is a drop-in behind the same handler
logic — the ObjectStore seam and the store-first ordering are unaffected — but this
design commits to the dependency-free raw-body parser to match the proven
house pattern.)

### D-2. Soft-delete vs hard-purge — BOTH, as two forward-only lifecycle stages

A document has a forward-only status lifecycle `ACTIVE → ARCHIVED →
PURGE_PENDING → PURGED` (terminal `PURGED`), enforced by a column-guard trigger
exactly like `service_request_status_guard`.

- **Soft-delete = ARCHIVE** (`ACTIVE → ARCHIVED`): a status flip only. Blobs are
  retained; versions stay downloadable by authorized users; the row is hidden from
  the default active listing but still addressable. Reversible path `ARCHIVED →
  ACTIVE` is allowed (un-archive).
- **Retention expiry / purge request = `ARCHIVED → PURGE_PENDING`** (or `ACTIVE →
  PURGE_PENDING` for an immediate admin purge): marks the document for blob
  deletion. Downloads are refused (403) from `PURGE_PENDING` onward.
- **Hard purge = `PURGE_PENDING → PURGED`**: the purge handler deletes EVERY
  version's blob via `adapter.deleteObject`, then flips the row to `PURGED`
  (terminal), nulls nothing in the metadata (the metadata row and its version
  rows are RETAINED as a tombstone audit record — only the bytes are gone), and
  writes an audit event. `PURGED` has no outgoing edge.

Rationale: institutions need a recoverable "remove from view" (ARCHIVED) distinct
from an irreversible "destroy the bytes" (PURGED), and a retention policy drives
documents toward purge over time. Keeping the metadata tombstone after PURGED
preserves the immutable version history + access ledger for compliance while the
storage cost (the blobs) is reclaimed. This mirrors the inventory asset forward-
only + terminal lifecycle and the service-requests terminal-state guard.

### D-3. Grant model — grantee may be a USER **or** a DEPARTMENT; access level READ or MANAGE

`DocumentAccessGrant` carries an EXCLUSIVE-OR grantee: exactly one of
`granteeUserId` (a `User` in the same tenant) OR `granteeDepartmentId` (a
`Department` in the same tenant) is non-null (CHECK). `accessLevel` is `READ` or
`MANAGE`.

Rationale: user-only grants force an owner to re-grant every time department
membership changes; a department grant (e.g. "all of Finance can read this
policy") is the common institutional case and maps cleanly onto the existing
`Department` tenant table and the `User.departmentId` the token already carries.
We deliberately do NOT support role-key grants: role membership is tenant-wide and
would make "grant to a role" indistinguishable from a permission change, blurring
the RBAC boundary. A department grant is evaluated at authorization time by
comparing the requester's `user.departmentId` to the grant's
`granteeDepartmentId`. `accessLevel = MANAGE` lets a non-owner grantee manage
grants on that document (delegated administration); `READ` is download-only.
Grants are mutable config (grant / revoke) with audit — they are NOT append-only.
Revoke sets `revokedAt` (soft, keeps the audit trail) so a revoked grant stops
authorizing new signed-URL mints immediately; already-minted short-lived URLs
simply expire on their own (we do not and cannot recall them).

### D-4. `@supabase/supabase-js` vs raw REST — RAW REST via `fetch`

The `SupabaseStorageAdapter` talks to the Supabase Storage REST API directly with
the built-in `fetch`, using the server-only service-role key as a bearer token. We
do NOT add `@supabase/supabase-js`.

Rationale: the adapter interface is tiny (put / signed-download / signed-upload /
delete / head) and the Storage REST surface for those operations is small, stable,
and well-documented. `razorpay.ts` sets the precedent of preferring a
dependency-light, auditable trust boundary (it uses Node built-in `crypto` for the
signature path rather than the SDK helper). Node 22 ships a global `fetch`, so
raw REST adds ZERO new dependencies, keeps the fast suite free of any SDK import,
and keeps the swap-to-R2/S3 promise honest (the interface, not an SDK type, is the
contract). The adapter interface makes either choice fine; we choose the one that
adds no dependency and the smallest trust surface. The endpoints used:
`POST /storage/v1/object/{bucket}/{key}` (upload, `x-upsert: false`),
`POST /storage/v1/object/sign/{bucket}/{key}` body `{ "expiresIn": <seconds> }`
(returns a `signedURL` to prefix with `SUPABASE_URL`), `DELETE
/storage/v1/object/{bucket}/{key}` (delete), and `HEAD`/`GET
/storage/v1/object/info/{bucket}/{key}` (head/metadata).

---

## 3. Functional Requirements

- **FR-1 Documents + metadata.** A `Document` row per logical document: `title`
  (non-empty), optional `description`, optional `category` (free string),
  `ownerUserId` → `User` (same-tenant composite FK), `currentVersionId` (nullable
  pointer to the current `DocumentVersion`), `status`
  (`ACTIVE|ARCHIVED|PURGE_PENDING|PURGED`, default `ACTIVE`), optional
  `retentionPolicyId` → `DocumentRetentionPolicy`, `retainUntil` (nullable
  computed timestamp), timestamps. NOT public by default.
- **FR-2 Versions (append-only).** A `DocumentVersion` row per uploaded revision:
  `documentId`, `version` (1-based integer, increasing), `filename` (non-empty),
  `contentType` (non-empty), `sizeBytes` (BigInt ≥ 0), `checksumSha256` (64-hex),
  `storageKey` (tenant-prefixed, unique per tenant), `uploadedByUserId` → `User`
  (composite FK), `uploadedAt`. Append-only: uploading a new version appends a row
  + a new object and advances `Document.currentVersionId`. Prior version rows and
  their blobs never mutate and remain downloadable by authorized users.
- **FR-3 Upload via adapter.** Upload (server-receives-bytes, D-1) validates
  permission + module + the per-document rule, computes sha256 + byte size from
  the received bytes, stores the object under the tenant-prefixed key via
  `adapter.putObject`, THEN commits the version row + advances the pointer in one
  tenant transaction. Partial-failure ordering is store-object-first (§8).
- **FR-4 Download via signed URL.** Download authorizes (permission + tenant +
  ownership-or-grant), refuses if `status ∈ {PURGE_PENDING, PURGED}`, then mints a
  SHORT-LIVED signed download URL via `adapter.getSignedDownloadUrl` (TTL 120 s)
  and returns `{ url, expiresAt }` + writes an append-only access-log row. Never
  returns the service-role key or a public URL.
- **FR-5 Access grants.** Owner / ADMIN / DOCUMENT_MANAGER / a `MANAGE`-level
  grantee may grant (to a user OR a department, READ or MANAGE) and revoke. A
  revoked grant stops authorizing future mints (D-3). ANY same-tenant user who
  holds a LIVE grant (user-grant or department-grant) can mint a download URL —
  including a department grant to a staff department such as Finance (whose users
  hold the ACCOUNTANT role). This is why the coarse `documents.download` key is a
  GENUINE baseline-reachability key held by EVERY non-applicant authenticated
  tenant role (§14.3, review finding A), making the coarse `requirePermission`
  gate a true no-op so the record-level `canAccessDocument` check (§11) is the SOLE
  real visibility gate.
- **FR-6 Download/access audit (append-only).** Every download-url mint — and
  ONLY a download-url mint — writes a `DocumentAccessLog` row (`documentId`,
  `versionId` NOT NULL, `userId`, `action = DOWNLOAD_URL_MINTED`, `createdAt`) —
  a document-specific ledger distinct from the system `AuditEvent` log.
  Append-only. Metadata views (`GET /:id`) are NOT logged to this ledger (review
  findings 1–2).
- **FR-7 Retention + lifecycle.** A `DocumentRetentionPolicy`
  (name, `retentionDays`, optional `category` scope) + the forward-only document
  status lifecycle (D-2). A purge deletes every version blob via
  `adapter.deleteObject` and marks `PURGED`, audited.
- **FR-8 Reports + self-service.** Owner self-service: upload, list/download OWN
  docs, manage grants on OWN docs (via the owner self key). Grantee download via
  grant. DOCUMENT_MANAGER / ADMIN: see all tenant docs, manage retention policies,
  administer any grant, run reports. The AGGREGATE staff JSON report (document
  inventory + access-log SUMMARY counts + retention/purge queue) and its optional
  ExcelJS XLSX export are gated by `documents.admin.view_all` (mirrors
  `service-requests.ts` which already imports `exceljs`); the per-document
  access-log DETAIL ledger (`GET /:id/access-log`) is gated by the separate
  `documents.audit.view` key (review finding 8). A user who is neither owner nor
  grantee nor admin gets 404 on a document detail/download (not-public-by-default,
  tested).

---

## 4. Non-Functional Requirements

- **NFR-1 Storage-backend swappability.** All object-storage access behind the
  `ObjectStore` interface; no SDK/REST call in any route; one new adapter swaps
  the backend. Injectable seam mirrors `razorpay.ts`.
- **NFR-2 Server-only secret.** `SUPABASE_SERVICE_ROLE_KEY` is server-only, never
  the anon key, never client-exposed; production-guard throws only when
  `NODE_ENV==='production'` and unset; dev/test tolerate absent/mocked (mirror
  `razorpay.ts` + the `JWT_SECRET` guard in `server.ts`).
- **NFR-3 Tenant isolation.** `institutionId` + composite FKs + ENABLE/FORCE RLS
  fail-closed on every new table; all reads/writes via `withTenant`;
  `privilegedPrisma` only for the module-active guard's point lookup (already in
  `authz-engine.ts`). `campass_app` stays NOSUPERUSER NOBYPASSRLS.
- **NFR-4 Immutability.** Version history + access log are append-only (trigger +
  INSERT,SELECT grant only). Document lifecycle is forward-only via a column
  guard.
- **NFR-5 Test hygiene.** Fast suite (`npm test -w @campusgate/api`, currently 651
  green) stays fast + offline via the in-memory stub. Live suites via `npm run
  test:integration`; each passes in isolation; raised timeouts for
  many-round-trip tests; tenant-escape covers every new table with NO real blob
  I/O; a gated real-Supabase smoke check verifies the adapter.

---

## 5. Prisma schema additions (`packages/db/prisma/schema.prisma`)

Appended AFTER the service-requests block, in the exact house style (see
`ServiceRequest*` at `schema.prisma:4140+`): `@id @default(cuid())`,
`institutionId` + `institution Institution @relation(...)`, `@@unique([id,
institutionId])` anchoring the composite same-tenant FKs, per-query `@@index`,
`@@map` to snake_case, and comments noting that composite FKs / CHECKs / RLS /
triggers live in the raw SQL. The composite same-tenant FKs, CHECKs, RLS, and
triggers are declared ONLY in the migration SQL (Prisma models the single-column
relation for client typing; the migration replaces it with the composite — the
known cosmetic diff).

### 5.1 Enums

```prisma
enum DocumentStatus {
  ACTIVE
  ARCHIVED
  PURGE_PENDING
  PURGED
}

enum DocumentAccessLevel {
  READ
  MANAGE
}

enum DocumentAccessAction {
  DOWNLOAD_URL_MINTED
}
```

### 5.2 Tables (six new, each tenant-owned)

1. **`document_retention_policies`** (`DocumentRetentionPolicy`) — mutable-with-
   audit, NO trigger. Columns: `id`, `institutionId`, `name` (CHECK non-empty),
   `retentionDays` (Int, CHECK ≥ 1), `category` (String?, optional scope),
   `createdByUserId` (recorded id, NO FK — the transport/hostel/inventory actor-id
   precedent), `createdAt`, `updatedAt`. Business unique
   `(institutionId, name)`. `@@index([institutionId])`.
2. **`documents`** (`Document`) — forward-only lifecycle column guard. Columns:
   `id`, `institutionId`, `title` (CHECK non-empty), `description` (String?),
   `category` (String?), `ownerUserId` (composite FK → users), `currentVersionId`
   (String?, nullable pointer; NO FK to avoid the versions↔documents circular FK —
   validated in-handler, the service-requests `currentVersionId`-style pointer
   rationale), `status DocumentStatus @default(ACTIVE)`, `retentionPolicyId`
   (String?, composite FK → document_retention_policies, MATCH SIMPLE nullable
   no-op), `retainUntil` (DateTime?), `createdByUserId` (recorded id, NO FK),
   `createdAt`, `updatedAt`. Indexes `(institutionId)`,
   `(institutionId, ownerUserId)`, `(institutionId, status)`,
   `(institutionId, retentionPolicyId)`, `(institutionId, retainUntil)`.
3. **`document_versions`** (`DocumentVersion`) — APPEND-ONLY (createdAt-only via
   `uploadedAt`, NO `updatedAt`). Columns: `id`, `institutionId`, `documentId`
   (composite FK → documents), `version` (Int, CHECK ≥ 1), `filename` (CHECK
   non-empty), `contentType` (CHECK non-empty), `sizeBytes` (BigInt, CHECK ≥ 0),
   `checksumSha256` (CHECK `~ '^[0-9a-f]{64}$'`), `storageKey` (CHECK non-empty),
   `uploadedByUserId` (composite FK → users), `uploadedAt DateTime @default(now())`.
   Business uniques `(institutionId, documentId, version)` and
   `(institutionId, storageKey)`. Indexes `(institutionId)`,
   `(institutionId, documentId)`.
4. **`document_access_grants`** (`DocumentAccessGrant`) — mutable config
   (grant/revoke-with-audit), NO trigger. Columns: `id`, `institutionId`,
   `documentId` (composite FK → documents), `granteeUserId` (String?, composite FK
   → users, MATCH SIMPLE), `granteeDepartmentId` (String?, composite FK →
   departments, MATCH SIMPLE), `accessLevel DocumentAccessLevel`,
   `grantedByUserId` (composite FK → users), `createdAt`, `updatedAt`,
   `revokedAt DateTime?`, `revokedByUserId` (String?, recorded id, NO FK). CHECK
   XOR grantee: exactly one of `granteeUserId` / `granteeDepartmentId` non-null.
   Partial unique for a LIVE grant per grantee (so re-granting after revoke
   works): `CREATE UNIQUE INDEX ... (institutionId, documentId, granteeUserId)
   WHERE "granteeUserId" IS NOT NULL AND "revokedAt" IS NULL` and the symmetric
   department partial unique. Indexes `(institutionId)`,
   `(institutionId, documentId)`, `(institutionId, granteeUserId)`,
   `(institutionId, granteeDepartmentId)`.
5. **`document_access_logs`** (`DocumentAccessLog`) — APPEND-ONLY. Columns: `id`,
   `institutionId`, `documentId` (composite FK → documents), `versionId`
   (String, NOT NULL, recorded id, NO FK — every logged action is a signed-URL
   mint against the then-current version), `userId` (composite FK → users),
   `action DocumentAccessAction`, `createdAt DateTime @default(now())`. Indexes
   `(institutionId)`, `(institutionId, documentId)`,
   `(institutionId, userId)`, `(institutionId, createdAt)`.

   > SCOPE DECISION (review findings 1 + 2): this slice logs ONLY the
   > signed-URL-mint action. The `DocumentAccessAction` enum has exactly ONE value
   > (`DOWNLOAD_URL_MINTED`); `versionId` is NOT NULL because every ledger row is a
   > mint against a concrete version. Metadata views (`GET /:id`) are NOT written
   > to the access ledger and emit NO audit event — they are ordinary authorized
   > reads. This keeps the enum, the column, the audit-key catalogue (§14.4), and
   > the route table (§15) internally consistent; a future slice can add a
   > `METADATA_VIEWED` value + a nullable `versionId` migration if metadata-view
   > logging is ever required.

> The `documents ↔ document_versions` relationship is a parent→children composite
> FK on `document_versions(institutionId, documentId)`. The reverse "current"
> pointer `documents.currentVersionId` is a plain nullable String with NO FK (the
> pointer is validated in the handler within the same tenant tx). This avoids a
> circular composite FK and matches the recorded-id/pointer precedent.

---

## 6. ObjectStore seam (`apps/api/src/services/documents/storage.ts`)

Mirrors `apps/api/src/services/fees/razorpay.ts` EXACTLY: an injectable interface,
a concrete adapter whose constructor reads server-only env with a
production-only guard, a lazy module-level singleton accessor, and a setter test
seam. Routes call `getObjectStore()`; tests call `setObjectStore(stub)`.

### 6.1 The interface (the injectable seam, like `RazorpaySdkLike`)

```ts
export interface PutObjectInput {
  key: string;              // tenant-prefixed storage key (§7)
  body: Buffer;             // the received bytes
  contentType: string;
}
export interface HeadObjectResult {
  exists: boolean;
  sizeBytes?: number;
  contentType?: string;
}
export interface SignedUrlResult {
  url: string;              // absolute, short-lived
  expiresAt: Date;
}

/** The minimal object-storage surface the documents flow needs. Declared as an
 *  interface so fast suites inject a stub WITHOUT any SDK/network, and the blob
 *  backend can be swapped (R2/S3) by writing one new class. */
export interface ObjectStore {
  putObject(input: PutObjectInput): Promise<void>;
  getSignedDownloadUrl(key: string, expiresInSeconds: number): Promise<SignedUrlResult>;
  getSignedUploadUrl(key: string, expiresInSeconds: number): Promise<SignedUrlResult>; // REQUIRED method; implemented by every adapter + the stub, but NO 9.7 route calls it (D-1). Required (not optional) so the swap-to-R2/S3 contract is honest and a future large-file path never has to handle `undefined` (review finding 7).
  deleteObject(key: string): Promise<void>;
  headObject(key: string): Promise<HeadObjectResult>;
}
```

### 6.2 `SupabaseStorageAdapter` (concrete, raw REST via `fetch` — D-4)

Mirrors the `RazorpayGateway` class: constructor takes optional overrides, else
reads env; `isProd()` guard throws ONLY in production when a required value is
unset. This mirrors the razorpay prod-guard SHAPE (throw only in production,
dev/test tolerate absent) — NOT byte-for-byte: `razorpay.ts` guards only the
SECRETS (`keySecret`, `webhookSecret`) and never the non-secret `keyId`, whereas
this adapter ADDITIONALLY guards `SUPABASE_URL` because the adapter is
non-functional without it (the URL is required to form every request). The
service-role key guard is the direct secret-guard analogue; the URL guard is a
benign superset (review finding 6).

```ts
function isProd(): boolean { return process.env.NODE_ENV === "production"; }

export class SupabaseStorageAdapter implements ObjectStore {
  private readonly supabaseUrl: string;
  private readonly serviceRoleKey: string; // SERVER-ONLY; never logged, never returned
  private readonly bucket: string;

  constructor(opts?: { supabaseUrl?: string; serviceRoleKey?: string; bucket?: string }) {
    this.supabaseUrl    = opts?.supabaseUrl    ?? process.env.SUPABASE_URL ?? "";
    this.serviceRoleKey = opts?.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    this.bucket         = opts?.bucket         ?? process.env.SUPABASE_STORAGE_BUCKET ?? "documents";
    if (isProd()) {
      if (!this.supabaseUrl)    throw new Error("SUPABASE_URL must be set in production");
      if (!this.serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY must be set in production");
    }
  }
  // putObject: POST  /storage/v1/object/{bucket}/{key}         (x-upsert:false, Authorization: Bearer <serviceRoleKey>, apikey header)
  // getSignedDownloadUrl: POST /storage/v1/object/sign/{bucket}/{key} body {expiresIn}; returns supabaseUrl + signedURL + expiresAt
  // getSignedUploadUrl:   POST /storage/v1/object/upload/sign/{bucket}/{key}; returns a signed upload token/URL (implemented, unwired in 9.7)
  // deleteObject: DELETE /storage/v1/object/{bucket}/{key}
  // headObject:   GET    /storage/v1/object/info/{bucket}/{key}  (404 => {exists:false})
}
```

Every method maps a non-2xx response to a typed `ObjectStoreError` (§9). The
service-role key is used ONLY as the `Authorization`/`apikey` header and is NEVER
placed in a response body, a log line, or a returned URL.

### 6.3 In-memory stub (`InMemoryObjectStore`) — fast suite + behavioral live suite

A `Map<string, { body: Buffer; contentType: string }>`. `putObject` stores;
`getSignedDownloadUrl` returns a synthetic `stub://<key>?exp=<ts>` URL + an
`expiresAt`; `getSignedUploadUrl` returns a synthetic `stub://upload/<key>?exp=<ts>`
URL + an `expiresAt` (implemented so the stub satisfies the full interface even
though no 9.7 route calls it, review finding 7); `deleteObject` removes;
`headObject` reports existence + size. No network. Shipped from the same `storage.ts` so both the fast suite and the
behavioral live suite inject the identical fake. It also exposes a test-only
`has(key)` / `size()` so a test can assert the blob was/wasn't written (proving the
partial-failure ordering, §8).

### 6.4 Injectable singleton (EXACTLY the `razorpay.ts` seam)

```ts
let singleton: ObjectStore | null = null;
export function getObjectStore(): ObjectStore {
  if (!singleton) singleton = new SupabaseStorageAdapter();
  return singleton;
}
export function setObjectStore(store: ObjectStore | null): void { singleton = store; }
```

Lazy construction (not at import) so a dev/test import never trips the production
guard and never requires the service-role key until a route actually stores or
signs. Routes call `getObjectStore()`; tests call `setObjectStore(new
InMemoryObjectStore())` in `beforeEach` and `setObjectStore(null)` in `afterEach`.
This is the SAME lifecycle as `getRazorpayGateway` / `setRazorpayGateway`.

### 6.5 Env (`apps/api/.env.example`)

Add, under a new "Supabase Storage (Phase 9.7 documents — SERVER-ONLY)" section,
mirroring the Razorpay server-only note (no real values):

```
# SUPABASE_URL              The project URL, e.g. https://<project-ref>.supabase.co
# SUPABASE_SERVICE_ROLE_KEY SERVER-ONLY. The service-role key — NEVER the anon key,
#                           NEVER sent to a client. Mints signed URLs + puts/deletes
#                           blobs. In production the app fails hard at startup if it
#                           (or SUPABASE_URL) is unset (mirrors JWT_SECRET/Razorpay);
#                           in dev/test a mock/absent value must not crash import.
# SUPABASE_STORAGE_BUCKET   Optional; defaults to "documents".
SUPABASE_URL="https://<project-ref>.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="your-supabase-service-role-key"
SUPABASE_STORAGE_BUCKET="documents"
```

No new DB secret is introduced; the storage secret is independent of
`DATABASE_URL` / `PRIVILEGED_DATABASE_URL`.

---

## 7. Tenant-prefixed storage key scheme

Every object key is `<institutionId>/<documentId>/<versionId>`. All three segments
are server-minted (the `institutionId` from the verified token ONLY — never
request input, matching the `requireModuleActive` hard-filter rule in
`authz-engine.ts`). Properties:

- Tenant-prefixed so a listing or a leaked single key cannot cross tenants.
- Immutable: a new version is a NEW `versionId` → a NEW key; prior objects are
  never overwritten (append-only in storage too). `x-upsert: false` on
  `putObject` makes an accidental key collision a hard error, not a silent
  overwrite.
- Deterministic from the version row, so purge deletes exactly the keys in the
  version chain.

The `storageKey` is persisted on the `DocumentVersion` row (unique per tenant) so
the download/purge paths read the stored key rather than recomputing it.

---

## 8. Upload flow + partial-failure ordering

Transport: encapsulated raw-body `Buffer` parser (the `razorpay-webhook.ts`
pattern, D-1) with `bodyLimit = MAX_UPLOAD_BYTES` (25 MiB); a larger body → 413.
The handler receives the raw bytes as a `Buffer`, reads `filename` + `contentType`
from validated request headers/query.

Ordering: **store the object FIRST, then commit the metadata row.** Steps:

1. Authorize: `authenticate` (top-level hook) + `requireModuleActive('documents')`
   + `requirePermission('documents.upload_own')`. Uploads are gated SOLELY by
   `documents.upload_own` (no staff upload key exists in the seven-key set —
   review finding 5; consistent with §14.2 and §15). For a new version of an
   EXISTING document, additionally enforce the ownership-or-grant + lifecycle rule
   (requester is the owner OR holds a live MANAGE-grant; document must be
   `ACTIVE`). ADMIN/DOCUMENT_MANAGER do NOT upload (they lack `documents.upload_own`
   by the self-key separation-of-duties precedent, §14.3).
2. Compute `checksumSha256 = sha256(buffer)` and `sizeBytes = buffer.length`
   server-side (never trust client-reported values).
3. Mint ids: `documentId` (new doc) or reuse; a fresh `versionId`; next `version`
   number (1 for a new doc; `max(version)+1` read inside the tenant tx for an
   existing doc). Build `storageKey = <institutionId>/<documentId>/<versionId>`.
4. `await getObjectStore().putObject({ key: storageKey, body, contentType })`. If
   this throws → 502 `{ error: "Storage write failed" }`; NOTHING was committed to
   the DB, so there is no orphaned row. (A rare orphaned BLOB with no row is
   harmless and is swept by a later reconciliation; `x-upsert:false` makes a retry
   with the same key idempotent-safe because the key embeds the unique versionId.)
5. `withTenant(institutionId, async (tx) => { ... })`: create the `Document` (new
   doc only) + the `DocumentVersion` row, then `update` the `Document` to set
   `currentVersionId = versionId` (and for an existing doc, re-read + guard that it
   is still `ACTIVE`). Write `recordAuditEvent({ action: 'documents.version.uploaded', ... }, tx)`.
6. If the tx FAILS after the object was stored → the blob is orphaned (no row
   references it). The handler issues a best-effort compensating
   `adapter.deleteObject(storageKey)` in a `catch`; if THAT also fails it is logged
   at WARN (not fatal — the blob is unreferenced and reclaimable by the retention
   sweep). The response is 500. This is the documented cleanup for the chosen
   ordering.

Why store-first: committing a metadata row that points at a not-yet-stored blob
would make `currentVersionId` reference a 404 blob — a download would then mint a
signed URL to nothing. Store-first guarantees that any committed version row's blob
exists; the only failure residue is an unreferenced blob, which is safe and
sweepable. (This mirrors the fees principle that nothing authoritative is written
until the external side-effect is known.)

---

## 9. Error handling (concrete, per fallible operation)

| Operation | Failure condition | Recoverable? | Caller receives | Logged |
|---|---|---|---|---|
| `putObject` | non-2xx / network | fatal for the request | 502 `Storage write failed` | ERROR (key, status; NEVER the key secret) |
| `getSignedDownloadUrl` | non-2xx / network | fatal for the request | 502 `Signed URL unavailable` | ERROR (key, status) |
| `deleteObject` (purge) | non-2xx / network | partial-recoverable | purge aborts, status stays `PURGE_PENDING`, 502 | ERROR (key) — retryable next sweep |
| `deleteObject` (upload compensating) | non-2xx | non-fatal | n/a (upload already 500) | WARN (orphaned key) |
| `headObject` | 404 | n/a | `{exists:false}` | none (expected) |
| upload size > 25 MiB | multipart limit | fatal | 413 `File too large` | INFO |
| checksum/size mismatch on re-head (smoke only) | integrity | fatal | 500 | ERROR |
| document not visible to requester | authz | n/a | **404** (not 403) for detail/download — not-public-by-default hides existence | INFO |
| missing permission | authz | n/a | 403 (via `requirePermission`) | INFO (engine) |
| module not active | authz | n/a | 403 `Module not active: documents` (via `requireModuleActive`) | INFO (engine) |
| illegal lifecycle transition | state guard | fatal | 409 `Illegal status transition` (handler map) / DB `restrict_violation` backstop | INFO |
| append-only UPDATE/DELETE attempt | DB trigger | fatal | surfaced as 500/`restrict_violation` (never reached via routes — no route mutates a ledger) | ERROR |

Ownership-visibility nuance: a requester who IS authorized to the module+permission
but is NOT owner/grantee/admin for a specific document gets **404** on
detail/download (existence-hiding), while a requester lacking the permission
entirely gets **403** from `requirePermission`. This is the not-public-by-default
contract and is explicitly tested.

`ObjectStoreError` is a small typed error the adapter throws (carrying `status`
and `op`) so the route maps storage failures to 502 deterministically and never
leaks the service-role key.

---

## 10. Input validation (per external input)

Zod schemas live in `packages/shared/src/validation.ts` (the house location;
`service-requests.ts` imports its `*Schema` from `@campusgate/shared`). Rules:

- **Upload (raw body + metadata headers/query)**: body (file bytes) REQUIRED and
  non-empty; `filename` required non-empty (≤ 255 chars); `contentType` required
  non-empty; bytes ≤ 25 MiB (413 on breach). `title` required non-empty (≤ 300);
  `description` optional (≤ 4000); `category` optional (≤ 120); `retentionPolicyId`
  optional (validated same-tenant in-handler). On failure → 400 with a field error
  map.
- **New version (existing doc)**: `documentId` path param (cuid); body + metadata
  as above. Document must exist same-tenant + be `ACTIVE` + caller
  owner/MANAGE/admin → else 404/403.
- **Create grant**: EXACTLY one of `granteeUserId` / `granteeDepartmentId`
  (XOR; both-or-neither → 400); `accessLevel ∈ {READ, MANAGE}`; grantee must exist
  same-tenant (in-handler lookup) → else 400. Duplicate LIVE grant → 409.
- **Revoke grant**: `grantId` path param; must be a LIVE grant on a document the
  caller may manage → else 404/403.
- **Retention policy**: `name` non-empty (≤ 120); `retentionDays` int ≥ 1 (≤
  36500); `category` optional. ADMIN/DOCUMENT_MANAGER only.
- **Lifecycle transition** (`archive`/`unarchive`/`purge-request`/`purge`): target
  status validated against the legal edge map (§12); illegal → 409.
- **List/report query**: optional `status`, `ownerUserId`, `category`,
  `page`/`pageSize` (bounded). Unknown query keys ignored.

Invariant ownership: the composite same-tenant FKs (DB layer) own cross-tenant
integrity; the handler owns the ownership-or-grant decision and the lifecycle legal
edges (handler map) with the DB column guard as the backstop — exactly the
service-requests split (handler `isLegalTransition` + DB
`service_request_status_guard`).

---

## 11. Authorization: the ownership-or-grant rule

A single pure helper `canAccessDocument(auth, doc, grants, level)` decides
record-level access, evaluated inside the tenant tx after the coarse
`requirePermission` + `requireModuleActive` guards. Rules (ordered):

1. ADMIN or DOCUMENT_MANAGER (holder of `documents.admin.view_all`) → full access
   (READ + MANAGE) to any document in the tenant.
2. `auth.userId === doc.ownerUserId` → full access (READ + MANAGE) to OWN doc.
3. A LIVE grant (`revokedAt IS NULL`) whose `granteeUserId === auth.userId`, OR
   whose `granteeDepartmentId === auth.user.departmentId`, with
   `accessLevel >= requested level` (MANAGE ⊇ READ) → that level. (The requester
   reaches this record-level check only after passing the coarse
   `documents.download`/`documents.view_own`/`documents.admin.view_all`
   `requirePermission` gate; `documents.download` is a genuine baseline key held
   by EVERY non-applicant authenticated tenant role (§14.3) precisely so that ANY
   same-tenant grantee — a user-grant holder OR a member of a granted department,
   whatever staff/student role they carry — is NEVER blocked at the coarse gate and
   `canAccessDocument` is the sole real gate — review finding A.)
4. Otherwise → NOT visible → **404** on detail/download, **403** on a manage/grant
   attempt.

Lifecycle gate on downloads: even an authorized requester is refused (403) if
`doc.status ∈ {PURGE_PENDING, PURGED}` (the bytes are gone or going). Download from
`ARCHIVED` is still allowed to owner/grantee/admin (soft-delete = hidden from the
default listing, not destroyed).

Revocation semantics (D-3): revoke sets `revokedAt`; the next
`getSignedDownloadUrl` request fails the grant check → no new URL. Already-minted
120-second URLs expire on their own; we neither track nor recall them.

---

## 12. Lifecycle (forward-only, column guard)

Legal edges (plus the no-op self transition), enforced by the handler map AND the
DB column guard `document_status_guard` (mirrors `service_request_status_guard`):

```
ACTIVE        -> ARCHIVED        (soft-delete / archive)
ACTIVE        -> PURGE_PENDING   (admin immediate purge request)
ARCHIVED      -> ACTIVE          (un-archive; reversible)
ARCHIVED      -> PURGE_PENDING   (retention expiry / purge request)
PURGE_PENDING -> PURGED          (blobs deleted via adapter, terminal)
```

`PURGED` is terminal (no outgoing edge). The guard also freezes identity columns
(`institutionId`, `ownerUserId`, `createdAt`) via `IS DISTINCT FROM` and forbids
`DELETE` unconditionally (`restrict_violation`) — byte-for-byte the service-
requests guard idiom. The purge handler: authorize (ADMIN/DOCUMENT_MANAGER +
`documents.retention.manage`), load every `DocumentVersion.storageKey`, call
`adapter.deleteObject(key)` for each (first failure → abort, stay `PURGE_PENDING`,
502, retryable), then in `withTenant` flip `status = PURGED` + audit
`documents.purged`. Metadata + version rows are RETAINED as a tombstone.

---

## 13. Migration: `packages/db/prisma/migrations/20270131000000_phase9_documents/migration.sql`

Hand-authored, frozen lettered a–j house style, newest reference the
service-requests migration. NEVER `prisma migrate dev`. STRICTLY ADDITIVE: only
CREATEs new objects + one additive catalogue seed; never edits a prior dir (all 22
stay byte-untouched); never touches `_prisma_migrations`; `campass_app` stays
NOSUPERUSER NOBYPASSRLS.

- **a. Enums**: `DocumentStatus`, `DocumentAccessLevel`, `DocumentAccessAction`.
- **b. Tables + PKs**: the six tables. Four mutable/guarded carry `updatedAt NOT
  NULL` (`document_retention_policies`, `documents`, `document_access_grants`; note
  `documents` is the column-guard table). TWO append-only are createdAt/uploadedAt-
  only, NO `updatedAt` (`document_versions`, `document_access_logs`). `sizeBytes
  BIGINT`.
- **c. Indexes/uniques**: `(id, institutionId)` unique on all six (anchors
  composite FKs); `(institutionId)` + per-query indexes (§5); business uniques:
  policies `(institutionId, name)`; versions `(institutionId, documentId,
  version)` and `(institutionId, storageKey)`; the two partial LIVE-grant uniques
  on `document_access_grants`.
- **d. Tenant-root FKs**: `institutionId -> institutions(id)` RESTRICT/CASCADE on
  all six.
- **e. Composite same-tenant FKs** (each carries `institutionId`; RESTRICT/CASCADE;
  MATCH SIMPLE for nullable columns): `documents.(institutionId, ownerUserId) ->
  users`; `documents.(institutionId, retentionPolicyId) ->
  document_retention_policies` (MATCH SIMPLE); `document_versions.(institutionId,
  documentId) -> documents`; `document_versions.(institutionId, uploadedByUserId)
  -> users`; `document_access_grants.(institutionId, documentId) -> documents`;
  `document_access_grants.(institutionId, granteeUserId) -> users` (MATCH SIMPLE);
  `document_access_grants.(institutionId, granteeDepartmentId) -> departments`
  (MATCH SIMPLE); `document_access_grants.(institutionId, grantedByUserId) ->
  users`; `document_access_logs.(institutionId, documentId) -> documents`;
  `document_access_logs.(institutionId, userId) -> users`. (`currentVersionId` and
  all `*ByUserId` recorded ids carry NO FK, per §5.)
- **f. CHECKs**: title/name/filename/contentType/storageKey non-empty;
  `retentionDays >= 1`; `sizeBytes >= 0`; `version >= 1`; `checksumSha256 ~
  '^[0-9a-f]{64}$'`; grant XOR (`(granteeUserId IS NOT NULL) <>
  (granteeDepartmentId IS NOT NULL)`).
- **g. RLS**: ENABLE + FORCE on all six. The four mutable/guarded
  (`document_retention_policies`, `documents`, `document_access_grants`) get the
  standard fail-closed nullif-guarded pair `{tenant_isolation_select,
  tenant_isolation_modify}`. The two append-only (`document_versions`,
  `document_access_logs`) get the INSERT-only pair `{tenant_isolation_select,
  <table>_tenant_insert}` (NO modify policy). `nullif(current_setting(
  'app.current_institution_id', true), '')` fails closed for unset AND empty.
  (Copy the exact `DO $$ ... FOREACH ...` block from the service-requests
  migration; `mutable_tables` = the three mutable/guarded, `append_only_tables` =
  the two ledgers.)
- **h. Triggers**: (h.1) two append-only `<table>_append_only()` plpgsql functions
  raising `restrict_violation`, bound `BEFORE UPDATE OR DELETE ... FOR EACH ROW`
  on `document_versions` and `document_access_logs` (the service-requests ledger
  idiom). (h.2) `document_status_guard` column guard on `documents` (BEFORE UPDATE
  OR DELETE): forbid DELETE; freeze identity cols; enforce the §12 legal-edge set;
  `restrict_violation` on breach.
- **i. `campass_app` GRANT refresh** (guarded `IF EXISTS pg_roles ... 'campass_app'`
  + idempotent): `SELECT, INSERT, UPDATE` on the three mutable/guarded
  (`document_retention_policies`, `documents`, `document_access_grants`) — NO
  DELETE (the guard forbids document DELETE; grants/policies are never hard-
  deleted, only revoked/updated). `SELECT, INSERT` + explicit `REVOKE UPDATE,
  DELETE` on the two append-only ledgers (the service-requests ledger precedent).
  Never grant BYPASSRLS.
- **j. Catalogue seed** (order: role row FIRST, then permissions, then
  role_permissions — the service-requests ordering so the DOCUMENT_MANAGER `, NULL)`
  tuple falls outside the sliced permission span the catalogue-sync parser reads):
  - `INSERT INTO "roles" (...) VALUES ('role_document_manager', 'DOCUMENT_MANAGER',
    'Document Manager', NULL) ON CONFLICT DO NOTHING;`
  - `INSERT INTO "permissions" (...) VALUES (...) ON CONFLICT ("key") DO NOTHING;`
    the SEVEN `documents.*` keys (§14), each `module = 'documents'`.
  - `INSERT INTO "role_permissions" (...) SELECT ... FROM (VALUES ...) AS
    m("roleKey","permKey") JOIN "roles" r ON r."key" = m."roleKey" AND
    r."institutionId" IS NULL JOIN "permissions" p ON p."key" = m."permKey" ON
    CONFLICT ("roleId", "permissionId") DO NOTHING;` — the **26 pairs** in §14.3:
    ADMIN×5, DOCUMENT_MANAGER×5, FACULTY×4, and `documents.download` for each of the
    12 remaining non-applicant tenant roles (STUDENT, ACCOUNTANT, LIBRARIAN, WARDEN,
    ADMISSION_OFFICER, HR_MANAGER, EMPLOYEE, TRANSPORT_MANAGER, INVENTORY_MANAGER,
    SERVICE_AGENT, GUARD, HOD) = 12 pairs. APPLICANT gets NO `documents.*` pair. The
    template-role predicate `r."institutionId" IS NULL` matches the platform
    template rows (all of these roles are seeded `institutionId NULL`), exactly the
    service-requests seed form.

Verification sequence (NEVER `migrate dev`): `prisma migrate diff
--from-schema-datasource` (only the composite-vs-single-FK cosmetic diff expected,
NO DROP on existing tables), `prisma migrate deploy`, `prisma migrate status` = up
to date. Add `"20270131000000_phase9_documents"` to `SEEDING_MIGRATION_DIRS` in
`apps/api/src/services/__tests__/catalogue-sync.test.ts`; catalogue-sync asserts
EXACT set-equality.

---

## 14. RBAC: `documents.*` keys, role map, DOCUMENT_MANAGER, audit keys

### 14.1 Module registry (`packages/shared/src/modules.ts`)

Add to `MODULES`:
`{ key: "documents", name: "Document Management", description: "Document management — metadata + object-storage blobs, versions, access grants, signed-URL downloads, access ledger, retention/purge lifecycle, reports (Phase 9.7)" }`.
Add `documents: []` to `MODULE_DEPENDENCIES` with the foundational-not-gated
comment (the Phase-9 precedent: prerequisites User/Department are foundational,
validated at operation time via composite FKs + in-handler lookups, not a gated
activation edge).

### 14.2 The SEVEN `documents.*` permission keys (`packages/shared/src/permissions.ts`, `module: "documents"`)

| key | who | meaning |
|---|---|---|
| `documents.upload_own` | owner self | Upload a new document + a new version of OWN docs |
| `documents.view_own` | owner self | List/view/download OWN docs + manage grants on OWN docs |
| `documents.download` | grantee baseline (EVERY non-applicant tenant role) | Genuine baseline-reachability key making the coarse gate a true no-op; the TRUE gate is the record-level `canAccessDocument` active-grant check. Bound to EVERY non-applicant authenticated tenant role (STUDENT, FACULTY, ACCOUNTANT, LIBRARIAN, WARDEN, ADMISSION_OFFICER, HR_MANAGER, EMPLOYEE, TRANSPORT_MANAGER, INVENTORY_MANAGER, SERVICE_AGENT, GUARD, HOD, ADMIN, DOCUMENT_MANAGER — NOT the external APPLICANT) so ANY same-tenant user who holds a live user-grant, OR is a member of a granted department (e.g. Finance staff = ACCOUNTANT), passes the coarse `requirePermission` and reaches `canAccessDocument` |
| `documents.grants.manage` | owner / admin | Grant/revoke access on a doc the caller owns, MANAGE-holds, or admins |
| `documents.admin.view_all` | admin | See ALL tenant documents + versions; run the aggregate report (inventory + access-log SUMMARY counts + retention/purge queue) + its XLSX export |
| `documents.retention.manage` | admin | Manage retention policies; archive/purge-request/purge any doc |
| `documents.audit.view` | admin | Read the per-document access-log DETAIL ledger (`GET /:id/access-log`) — the row-level mint ledger, distinct from the SUMMARY counts in the `admin.view_all` report (review finding 8) |

Rationale for the split: the owner self keys (`upload_own`, `view_own`) implement
"a document OWNER manages their own docs + grants via a self/owner key"; `download`
is the genuine baseline-reachability key (held by every non-applicant tenant role;
the actual visibility decision is still the record-level active-grant check);
`grants.manage` is delegated grant administration (owner OR MANAGE-grantee OR
admin); and the three admin keys (`admin.view_all`, `retention.manage`,
`audit.view`) are the cross-tenant DOCUMENT_MANAGER/ADMIN surface. ONE key prefix
`documents.*`.

### 14.3 DOCUMENT_MANAGER template role (additive, NOT the legacy enum)

Add a NEW additive platform template role `DOCUMENT_MANAGER` (the
ACCOUNTANT/LIBRARIAN/WARDEN/HR_MANAGER/TRANSPORT_MANAGER/INVENTORY_MANAGER/
SERVICE_AGENT precedent — do NOT extend the legacy role enum). It runs document
administration end-to-end within a tenant without institution-wide admin rights:

```
DOCUMENT_MANAGER: [
  "documents.download",        // baseline-reachability (held by every non-applicant tenant role)
  "documents.grants.manage",
  "documents.admin.view_all",
  "documents.retention.manage",
  "documents.audit.view",
]
```

`ROLE_PERMISSIONS` additions (lockstep with the migration `role_permissions`
seed, separation of duties):

- **ADMIN** is institution-wide. Consistent with the module-era precedent that
  ADMIN holds no module-gated `*.view_own` self key, ADMIN gets the five NON-self
  keys: `documents.download`, `documents.grants.manage`, `documents.admin.view_all`,
  `documents.retention.manage`, `documents.audit.view`. ADMIN does NOT get
  `documents.upload_own` / `documents.view_own` (those are the owner self-scope; an
  admin acts via `admin.view_all` + `grants.manage`, not by owning).
- **DOCUMENT_MANAGER** gets the four admin keys above PLUS the baseline
  `documents.download` (it is a tenant role and may itself be a grantee), i.e. five
  keys; it does NOT get the two owner self keys (`grants.manage` + `admin.view_all`
  already cover administering any grant and seeing all docs).
- **`documents.upload_own` / `documents.view_own`** bind to the role whose users
  own documents. Faculty own teaching materials, letters, and policy drafts, so the
  cleanest binding consistent with the self-key precedent is **FACULTY**: bind the
  two owner self keys + `documents.grants.manage` to FACULTY (a representative
  document-owning staff role); FACULTY also holds the baseline `documents.download`
  like every other tenant role.
- **`documents.download` is a GENUINE baseline-reachability key** (review finding
  A — the PREFERRED resolution). The not-public-by-default promise (FR-5, §11,
  AC-14) is that ANY same-tenant user who holds a LIVE grant — a user-grant, OR
  membership in a department-grant — can mint a signed URL. The brief's canonical
  example is "all of Finance can read this policy"; Finance staff carry the
  **ACCOUNTANT** role (verified in `ROLE_PERMISSIONS`, `permissions.ts`), and
  department membership is not confined to STUDENT/FACULTY/EMPLOYEE — a granted
  department can contain ANY staff/student role. Binding `documents.download` to
  only three roles (the iteration-2 attempt) therefore left the department-grant
  path DEAD for every other staff role (ACCOUNTANT, LIBRARIAN, WARDEN, HR_MANAGER,
  TRANSPORT_MANAGER, INVENTORY_MANAGER, SERVICE_AGENT, HOD, GUARD, ADMISSION_OFFICER)
  — they would be blocked at the coarse gate before `canAccessDocument` ever ran.
  The fix: `documents.download` is bound to **EVERY non-applicant authenticated
  tenant role** so the coarse `requirePermission('documents.download')` gate is a
  TRUE no-op and `canAccessDocument` (§11) is the SOLE real visibility gate. This
  does NOT make documents public: `download` carries no record-level authority
  whatsoever; a user with `documents.download` but NO owner/grant/admin
  relationship to a specific document still gets 404 (AC-14). The ONLY role
  excluded is **APPLICANT** — the external admissions applicant is not an internal
  tenant member who would ever receive an internal document grant; excluding it
  keeps the key scoped to real tenant users and keeps the SIS/admissions decoupling
  intact (no coupling is introduced; `download` is a this-module key only).
  Non-owning, non-admin roles (STUDENT, EMPLOYEE, GUARD, ACCOUNTANT, LIBRARIAN,
  WARDEN, ADMISSION_OFFICER, HR_MANAGER, TRANSPORT_MANAGER, INVENTORY_MANAGER,
  SERVICE_AGENT, HOD) receive ONLY `documents.download` from this module — they can
  download what they were granted, nothing else, and cannot own or administer
  documents.

> The precise role→key binding is the one product knob the planner may tune, but
> the SET must stay lockstep between `ROLE_PERMISSIONS` and the migration seed
> (catalogue-sync enforces exact set-equality). The concrete, internally-consistent
> binding this design commits to:
>
> - `ADMIN`: `documents.download`, `documents.grants.manage`,
>   `documents.admin.view_all`, `documents.retention.manage`,
>   `documents.audit.view` (5 keys)
> - `DOCUMENT_MANAGER`: `documents.download`, `documents.grants.manage`,
>   `documents.admin.view_all`, `documents.retention.manage`,
>   `documents.audit.view` (5 keys)
> - `FACULTY`: `documents.upload_own`, `documents.view_own`, `documents.download`,
>   `documents.grants.manage` (4 keys)
> - `STUDENT`, `ACCOUNTANT`, `LIBRARIAN`, `WARDEN`, `ADMISSION_OFFICER`,
>   `HR_MANAGER`, `EMPLOYEE`, `TRANSPORT_MANAGER`, `INVENTORY_MANAGER`,
>   `SERVICE_AGENT`, `GUARD`, `HOD`: `documents.download` ONLY (1 key each, 12
>   roles)
> - `APPLICANT`: NONE (external applicant is excluded from the baseline key)
>
> Separation of duties: the two owner self keys (`upload_own`, `view_own`) bind
> ONLY to FACULTY (the document-owning role), never to ADMIN/DOCUMENT_MANAGER;
> `grants.manage` is shared (owner delegates, admin administers) which is correct
> because the record-level `canAccessDocument` check (§11) still scopes WHICH
> documents each may act on. Every non-applicant tenant role holds the baseline
> `documents.download` — reachability for the grant path, never ownership or
> administration (review finding A). `canAccessDocument` is the real gate: a user
> with `documents.download` but no live grant still gets 404.

### 14.4 Audit keys (`packages/shared/src/audit-actions.ts`, `module: "documents"`)

No migration mirror (validated only in `recordAuditEvent`; the fees/exams/9.1–9.6
precedent). Past-tense keys; DENIED branches reuse the same key with
`result: "DENIED"`:

- `documents.document.created`
- `documents.version.uploaded`
- `documents.download_url.minted`
- `documents.grant.created`
- `documents.grant.revoked`
- `documents.retention_policy.upserted`
- `documents.document.archived`
- `documents.document.unarchived`
- `documents.document.purge_requested`
- `documents.purged`
- `documents.report.exported`

---

## 15. Routes + the permission × route × role × audit matrix

Routes live in `apps/api/src/routes/documents.ts`, registered in `server.ts`
(`app.register(documentsRoutes, { prefix: "/api/documents" })`, next to the
inventory/service-requests registrations). Every route carries the top-level
`authenticate` hook + `requireModuleActive('documents')` + a `requirePermission`,
then the record-level `canAccessDocument` where applicable. All reads/writes via
`withTenant`. Pure helpers (`canAccessDocument`, `isLegalDocTransition`,
`buildStorageKey`) exported for unit tests (the `service-requests.ts` pure-helper
precedent).

| Method & path | Permission (coarse) | Record-level | Roles | Audit |
|---|---|---|---|---|
| `POST /api/documents` (create doc + v1, multipart) | `documents.upload_own` | caller becomes owner | FACULTY | `documents.document.created` + `documents.version.uploaded` |
| `POST /api/documents/:id/versions` (new version) | `documents.upload_own` | owner or MANAGE-grantee + ACTIVE | FACULTY | `documents.version.uploaded` |
| `GET /api/documents` (list; `?mine`/`?all`) | `documents.view_own` OR `documents.admin.view_all` | own-scope vs tenant-scope | FACULTY / ADMIN / DOCUMENT_MANAGER | — (read) |
| `GET /api/documents/:id` (detail + versions + grants) | `documents.view_own` OR `documents.download` OR `documents.admin.view_all` | `canAccessDocument` READ → else 404 | any non-applicant tenant role (owner/grantee/admin) | — (read; NOT logged, review findings 1–2) |
| `POST /api/documents/:id/versions/:vid/download-url` (mint signed URL) | `documents.download` OR `documents.view_own` OR `documents.admin.view_all` | `canAccessDocument` READ + status ∉ {PURGE_PENDING,PURGED} → else 404/403 | any non-applicant tenant role (owner/grantee/admin) | `documents.download_url.minted` (+ access-log row) |
| `POST /api/documents/:id/grants` (grant) | `documents.grants.manage` | owner/MANAGE/admin → else 403 | FACULTY / ADMIN / DOCUMENT_MANAGER | `documents.grant.created` |
| `DELETE /api/documents/:id/grants/:grantId` (revoke) | `documents.grants.manage` | owner/MANAGE/admin → else 403 | FACULTY / ADMIN / DOCUMENT_MANAGER | `documents.grant.revoked` |
| `POST /api/documents/:id/archive` | `documents.retention.manage` | admin/manager | ADMIN / DOCUMENT_MANAGER | `documents.document.archived` |
| `POST /api/documents/:id/unarchive` | `documents.retention.manage` | admin/manager | ADMIN / DOCUMENT_MANAGER | `documents.document.unarchived` |
| `POST /api/documents/:id/purge-request` | `documents.retention.manage` | admin/manager | ADMIN / DOCUMENT_MANAGER | `documents.document.purge_requested` |
| `POST /api/documents/:id/purge` (delete blobs) | `documents.retention.manage` | admin/manager + status PURGE_PENDING | ADMIN / DOCUMENT_MANAGER | `documents.purged` |
| `GET /api/documents/retention-policies` / `POST` / `PATCH` | `documents.retention.manage` | — | ADMIN / DOCUMENT_MANAGER | `documents.retention_policy.upserted` |
| `GET /api/documents/report` (JSON: inventory + access-log summary + purge queue) | `documents.admin.view_all` | — | ADMIN / DOCUMENT_MANAGER | — (read) |
| `GET /api/documents/report/export` (XLSX via ExcelJS) | `documents.admin.view_all` | — | ADMIN / DOCUMENT_MANAGER | `documents.report.exported` |
| `GET /api/documents/:id/access-log` (ledger) | `documents.audit.view` | — | ADMIN / DOCUMENT_MANAGER | — (read) |

Not-public-by-default is enforced on `GET /:id` and the download-url route: a
caller with a view/download permission but no owner/grant/admin relationship to the
specific document receives **404** (existence-hiding), explicitly tested (§16).

Report vs ledger permission split (review finding 8): `documents.admin.view_all`
owns the AGGREGATE report (`GET /report` + `GET /report/export`), which includes
the access-log SUMMARY counts; `documents.audit.view` owns the per-document
access-log DETAIL ledger (`GET /:id/access-log`). The summary (counts) and the
detail (individual mint rows) are deliberately gated by different keys so an admin
can see roll-ups without holding the row-level ledger-read key, and vice versa.

---

## 16. Test plan

### 16.1 Fast suite (`npm test -w @campusgate/api`, must stay green; currently 651)

Fast tests mock `@campusgate/db` and inject the in-memory stub
(`setObjectStore(new InMemoryObjectStore())` in `beforeEach`, `setObjectStore(null)`
in `afterEach`); NO network, NO real DB.

- **`storage.unit.test.ts`**: `InMemoryObjectStore` behavior; `SupabaseStorageAdapter`
  constructor guard (throws in prod when URL/key unset; imports cleanly in test
  with absent values — mirrors the razorpay guard test); the injectable
  `get/setObjectStore` singleton lifecycle; key-building `buildStorageKey`.
- **`documents.unit.test.ts`**: pure `canAccessDocument` matrix (owner, user-grant,
  dept-grant, MANAGE⊇READ, revoked-grant denies, admin sees all, non-related →
  deny); `isLegalDocTransition` (every legal + illegal edge, PURGED terminal);
  sha256/size computation; the 404-vs-403 existence-hiding decision; upload
  partial-failure ordering with the stub asserting store-first + compensating
  delete on tx failure.
- **catalogue-sync** (`catalogue-sync.test.ts`): already set-equality; adding the
  seven keys + the ROLE_PERMISSIONS pairs (ADMIN×5, DOCUMENT_MANAGER×5, FACULTY×4,
  and `documents.download` for each of the 12 remaining non-applicant tenant roles
  = 26 new pairs) + the new `SEEDING_MIGRATION_DIRS` entry makes it pass; it fails
  the build on any drift.

### 16.2 Live-DB behavioral suite (`src/.../documents.behavioral.integration.test.ts`)

Added to `LIVE_DB_SUITES` in `apps/api/vitest.live-db-suites.ts`. Uses real
`withTenant` transactions but an INJECTED in-memory fake `ObjectStore` — NO real
network blob I/O. MUST pass IN ISOLATION. Many-round-trip behavioral tests carry a
raised timeout `{ timeout: 60000 }` (the free-tier pooler anti-flake rule);
multi-query `$transaction`s kept small.

Covers: upload v1 → version row + pointer + stub blob present; upload v2 → append
(v1 blob + row untouched, pointer advances); download-url mint only after authz +
access-log row written (`action = DOWNLOAD_URL_MINTED`, `versionId` NOT NULL);
grant to a NON-owner USER → that grantee can mint (the seeded user grantee holds a
**STUDENT** role — a non-owning, non-admin role whose only `documents.*` key is the
baseline `documents.download`, so the test exercises the real reachability
contract, not a hand-picked privileged role); grant to a DEPARTMENT → a
department-member grantee whose role is **ACCOUNTANT** (the brief's "all of Finance
can read this policy" case — a staff role that, under the resolved finding A,
holds `documents.download` purely as the baseline key) can mint; a same-tenant user
with `documents.download` but NO grant → 404 (proving the coarse key is
reachability-only and `canAccessDocument` is the sole real gate, review finding A);
an APPLICANT (no `documents.download`) → 403 at the coarse gate; revoke → next mint
denied; archive hides from default list but owner can still download; purge-request
blocks download; purge deletes stub blobs + flips PURGED (terminal; further
transition 409/guard); append-only proof that a ledger UPDATE/DELETE raises
`restrict_violation`; metadata view (`GET /:id`) writes NO access-log row (findings
1–2); report JSON shape.

### 16.3 Tenant-escape suite (every new table, NO real blob I/O)

Extend `tenant-escape.integration.test.ts` + `helpers/tenant-escape-setup.ts` to
seed ALL SIX new tables for tenants A and B and assert `campass_app` cannot read or
forge the other tenant's rows. Seeding (adminClient, RLS-bypass), child-safe order:
`document_retention_policies` → `documents` (ACTIVE, owner = seeded user) →
`document_versions` (storageKey is a STRING ONLY — `"<inst>/<doc>/<ver>"` — NO blob
upload) → `document_access_grants` (a user-grant on the seeded doc) →
`document_access_logs` (`action = DOWNLOAD_URL_MINTED`, `versionId` = the seeded
version id string — NOT NULL per the §5.2 schema, findings 1–2). The two append-only ledgers (`document_versions`,
`document_access_logs`) + the `documents` column guard forbid UPDATE/DELETE, so
teardown deletes them within a scoped `DISABLE TRIGGER` dance (the inventory /
service-requests precedent). The tenant-escape suite MUST NOT touch real object
storage — rows carry only the key string. New `SeededTenant` fields:
`documentRetentionPolicyId`, `documentId`, `documentVersionId`,
`documentAccessGrantId`, `documentAccessLogId`.

### 16.4 Gated real-Supabase-Storage smoke check

A SEPARATE minimal suite (e.g. `storage.smoke.integration.test.ts`, also listed in
`LIVE_DB_SUITES` or run on demand) that `describe.skipIf(!process.env.SUPABASE_URL
|| !process.env.SUPABASE_SERVICE_ROLE_KEY)` — skipped unless both env vars are
present. When enabled it drives the REAL `SupabaseStorageAdapter` end-to-end
against a real/faked bucket: `putObject` a tiny buffer under a unique
`smoke/<uuid>` key → `headObject` reports it exists with the right size →
`getSignedDownloadUrl` returns an absolute URL that `fetch`es back the identical
bytes (checksum match) → `deleteObject` → `headObject` reports gone. It never
prints the service-role key. This is the ONLY place the real network adapter runs.

---

## 17. Acceptance Criteria (specific, testable, numbered)

1. `packages/shared/src/modules.ts`: `MODULES` contains `{ key: "documents", ...
   }` and `MODULE_DEPENDENCIES.documents = []` with the foundational-not-gated
   comment. `MODULE_KEY_SET` includes `"documents"`.
2. `packages/shared/src/permissions.ts`: exactly the SEVEN `documents.*` keys
   (`module: "documents"`) exist; `ROLE_PERMISSIONS` gains `DOCUMENT_MANAGER` (five
   keys: `download` + the four admin keys), ADMIN (+five non-self keys incl.
   `download`), FACULTY (+four: `upload_own`, `view_own`, `download`,
   `grants.manage`), and `documents.download` ONLY for each of the 12 remaining
   non-applicant tenant roles (STUDENT, ACCOUNTANT, LIBRARIAN, WARDEN,
   ADMISSION_OFFICER, HR_MANAGER, EMPLOYEE, TRANSPORT_MANAGER, INVENTORY_MANAGER,
   SERVICE_AGENT, GUARD, HOD). APPLICANT gains NO `documents.*` key.
   `documents.download` is a genuine baseline-reachability key held by every
   non-applicant tenant role (review finding A); the seed is exactly 26 new
   `role_permissions` pairs.
3. `packages/shared/src/audit-actions.ts`: the eleven `documents.*` audit keys
   (§14.4) exist with `module: "documents"`.
4. `catalogue-sync.test.ts`: `SEEDING_MIGRATION_DIRS` includes
   `"20270131000000_phase9_documents"`; the set-equality tests pass (keys + pairs).
5. Migration dir `20270131000000_phase9_documents/migration.sql` exists in the
   lettered a–j style; `prisma migrate diff --from-schema-datasource` shows only
   the composite-vs-single-FK cosmetic diff (NO DROP); `prisma migrate deploy`
   succeeds; `prisma migrate status` = up to date; all 22 prior dirs byte-unchanged.
6. All six new tables have ENABLE + FORCE RLS; the four mutable/guarded carry the
   standard pair, the two append-only carry the INSERT-only pair; a cross-tenant
   read/forge via `campass_app` returns zero rows / is blocked (tenant-escape).
7. `document_versions` and `document_access_logs` reject UPDATE/DELETE with
   `restrict_violation` (append-only trigger); `documents` rejects DELETE and any
   illegal status transition and identity-column change (column guard).
8. `campass_app` has `SELECT,INSERT,UPDATE` on the three mutable/guarded and only
   `SELECT,INSERT` on the two ledgers (UPDATE/DELETE revoked); `campass_app` stays
   NOSUPERUSER NOBYPASSRLS.
9. `apps/api/src/services/documents/storage.ts` exports `ObjectStore`,
   `SupabaseStorageAdapter`, `InMemoryObjectStore`, `getObjectStore`,
   `setObjectStore` — mirroring `razorpay.ts`. No storage REST/SDK call exists
   outside this file (grep: routes contain no `fetch` to `/storage/v1/`).
10. Importing `storage.ts` in test/dev with `SUPABASE_*` unset does NOT throw;
    constructing `SupabaseStorageAdapter` with `NODE_ENV=production` and the key
    unset DOES throw (prod-guard parity with `razorpay.ts`).
11. `apps/api/.env.example` documents `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
    (server-only note), `SUPABASE_STORAGE_BUCKET` with no real values.
12. Upload stores the blob under `<institutionId>/<documentId>/<versionId>` BEFORE
    committing the version row; a `putObject` failure commits nothing; a tx failure
    after store triggers a compensating `deleteObject` (asserted via the stub).
13. Download mints a short-lived (≤120 s) signed URL ONLY after the
    permission+module+ownership-or-grant check, writes an access-log row, and never
    returns the service-role key or a public URL.
14. A requester who is neither owner nor active-grantee nor admin gets 404 on
    `GET /api/documents/:id` and on the download-url route (not-public-by-default),
    EVEN when they hold the coarse `documents.download` key — the record-level
    `canAccessDocument` check is the real gate. Because `documents.download` is held
    by EVERY non-applicant tenant role, a grantee of ANY role can mint: a user-grant
    holder (tested with a STUDENT grantee), and a member of a granted department
    whatever that member's role (tested with an ACCOUNTANT department member, the
    brief's "all of Finance" case) CAN mint. A revoked grant stops new mints; an
    APPLICANT (lacking `documents.download`) is blocked at the coarse gate with 403.
15. Purge deletes every version blob via `adapter.deleteObject`, flips `PURGED`
    (terminal), retains the metadata tombstone, and audits `documents.purged`; a
    `deleteObject` failure leaves status `PURGE_PENDING` and returns 502.
16. Fast suite (`npm test -w @campusgate/api`) stays green (≥ 651) with the new
    unit suites; each new/extended live suite passes IN ISOLATION; the tenant-escape
    suite touches NO real object storage; the gated real-Supabase smoke check runs
    only when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are present and
    round-trips a real object.
17. The staff report returns inventory + access-log summary + retention/purge
    queue as JSON; the XLSX export (ExcelJS) downloads and audits
    `documents.report.exported`.
18. The existing `StudentDocument` and `ApplicationDocument` tables and their
    migrations are NOT modified; there is no FK, import, or route coupling between
    this module and SIS/admissions.

---

## 18. Out of Scope

- Any frontend / client UI (backend only).
- Client-direct signed UPLOAD urls (D-1 chose server-receives-bytes;
  `getSignedUploadUrl` is a REQUIRED, implemented interface method but no 9.7
  route calls it — review finding 7).
- A real R2/S3 adapter (the seam makes it a future one-file addition; not built
  now).
- Full-text document content indexing/OCR, antivirus scanning, thumbnailing,
  previews.
- Automatic scheduled retention sweeps / cron (purge is operator-invoked via the
  route; `retainUntil` is stored and surfaced in the report's purge queue).
- Touching SIS `StudentDocument` / admissions `ApplicationDocument`.
- Pushing or deploying (work stays local on `main`).

---

## 19. Files touched (for the planner)

New:
- `apps/api/src/services/documents/storage.ts` (ObjectStore seam)
- `apps/api/src/routes/documents.ts`
- `packages/db/prisma/migrations/20270131000000_phase9_documents/migration.sql`
- fast unit suites `apps/api/src/.../documents.unit.test.ts`,
  `storage.unit.test.ts`; live `documents.behavioral.integration.test.ts`; gated
  `storage.smoke.integration.test.ts`

Edited (additive):
- `packages/db/prisma/schema.prisma` (six models + three enums, appended)
- `packages/shared/src/modules.ts`, `permissions.ts`, `audit-actions.ts`,
  `validation.ts`
- `apps/api/src/server.ts` (register `documentsRoutes`)
- `apps/api/.env.example` (Supabase Storage section)
- `apps/api/vitest.live-db-suites.ts` (new suite globs)
- `apps/api/src/services/__tests__/catalogue-sync.test.ts` (new
  `SEEDING_MIGRATION_DIRS` entry)
- `apps/api/src/routes/__tests__/tenant-escape.integration.test.ts` +
  `helpers/tenant-escape-setup.ts` (six new tables)

---

## 20. Responses to the design review

Every finding across both review iterations is ADDRESSED below; none is backlogged
or ignored. All resolutions keep the four product decisions (D-1..D-4) and the
brief's hard requirements (department grants, "any same-tenant user / department
member can mint", not-public-by-default, the seven-key set + DOCUMENT_MANAGER)
intact.

### 20.0 Iteration 2 → this revision (findings A, B)

Review source: `design-review.json` (verdict `CHANGES_REQUESTED`, iteration 2; 0
HIGH, 1 MEDIUM, 1 NIT; prior findings 1–8 all Closed/Unchanged). Both open
findings concern the iteration-2 resolution of finding 3.

- **Finding A [MEDIUM] — `documents.download` bound to only FACULTY/STUDENT/EMPLOYEE
  still contradicts the "ANY same-tenant user / department member can mint"
  promise.** ADDRESSED by the reviewer's PREFERRED option (a): `documents.download`
  is now a GENUINE baseline-reachability key held by EVERY non-applicant
  authenticated tenant role (STUDENT, FACULTY, ACCOUNTANT, LIBRARIAN, WARDEN,
  ADMISSION_OFFICER, HR_MANAGER, EMPLOYEE, TRANSPORT_MANAGER, INVENTORY_MANAGER,
  SERVICE_AGENT, GUARD, HOD, ADMIN, DOCUMENT_MANAGER), so the coarse
  `requirePermission('documents.download')` gate is a TRUE no-op and the
  record-level `canAccessDocument` check (§11) is the SOLE real visibility gate.
  The defect the reviewer identified — a department grant to Finance (ACCOUNTANT
  staff, verified against `ROLE_PERMISSIONS` in `permissions.ts`) being dead
  because ACCOUNTANT lacked the key — is now resolved: ANY department member, of
  ANY staff/student role, passes the coarse gate. APPLICANT (the external
  admissions applicant) is the ONLY role excluded, because it is not an internal
  tenant member who would ever receive an internal document grant; this keeps the
  SIS/admissions decoupling intact. Updated in lockstep: §11 rule 3, FR-5, AC-2,
  AC-14, §14.2 (the `documents.download` row + rationale), §14.3 (the committed
  binding block, now ADMIN×5 / DOCUMENT_MANAGER×5 / FACULTY×4 / 12 roles×1 =
  **26 pairs**), §13.j (the seed span + count), §15 (the two affected route-row
  role columns), §16.1 (catalogue-sync pair count), and §16.2 (the behavioral
  suite). The coarse binding and the record-level rule now agree exactly.

- **Finding B [NIT] — §16.2 department-member grantee test did not pin the
  member's role.** ADDRESSED by naming the seeded roles in §16.2: the user-grant
  grantee is a **STUDENT** (a non-owning, non-admin role whose only `documents.*`
  key is the baseline `documents.download`), and the department-member grantee is
  an **ACCOUNTANT** (the brief's "all of Finance" case). The suite now exercises the
  resolved promise — a grantee whose role holds ONLY the baseline key can mint —
  rather than a hand-picked privileged role. An APPLICANT negative case (403 at the
  coarse gate) is added to prove the one excluded role is genuinely excluded.

### 20.1 Iteration 1 → iteration 2 (findings 1–8)

Review source: `design-review.json` (verdict `CHANGES_REQUESTED`; 0 HIGH, 5
MEDIUM, 3 NIT) + `design-review.md`.

- **Finding 1 [MEDIUM] — `metadata_viewed` audit key used in §15 but absent from
  §14.4; AC-3 says "eleven".** ADDRESSED by CUTTING metadata-view logging from
  this slice (the reviewer's recommended option for a tight slice). §15's
  `GET /:id` audit cell is now `— (read; NOT logged)`; the §14.4 catalogue keeps
  exactly ELEVEN keys and AC-3's "eleven" is now correct and consistent. No
  dangling `?`.

- **Finding 2 [MEDIUM] — `DocumentAccessAction.METADATA_VIEWED` + nullable
  metadata-view row declared but never specified.** ADDRESSED by cutting:
  `DocumentAccessAction` now has ONE value (`DOWNLOAD_URL_MINTED`);
  `DocumentAccessLog.versionId` is NOT NULL (every ledger row is a mint against a
  concrete version); §5.2, FR-6, §15, §16.2, and §16.3 all state metadata views
  are not logged. A scope-decision note in §5.2 records how a future slice would
  re-add it. (Findings 1 + 2 are resolved together and consistently.)

- **Finding 3 [MEDIUM] — coarse `documents.download` only on ADMIN/FACULTY
  contradicts the grantee rule for non-staff grantees.** ADDRESSED by binding the
  grantee baseline key `documents.download` to the plausible grantee roles
  **FACULTY, STUDENT, and EMPLOYEE** (§14.2, §14.3, AC-2, the §13.j seed = 15
  pairs). `documents.download` is now explicitly a reachability-only coarse gate;
  the TRUE visibility gate remains the record-level `canAccessDocument` active-
  grant-or-owner-or-admin check (§11), so a STUDENT/EMPLOYEE with NO grant still
  gets 404 (AC-14). The §16.2 behavioral suite now seeds a NON-owner STUDENT/
  EMPLOYEE grantee and a department-member grantee and asserts both can mint while
  a grant-less download-holder gets 404. FR-5, §11 rule 3, AC-14 updated to match.
  This keeps the brief's "any same-tenant grantee / department member can mint"
  promise reachable WITHOUT making documents public.

- **Finding 4 [MEDIUM] — §15 "(+ADMIN via admin path)" on `POST /:id/versions`
  has no backing permission.** ADDRESSED by REMOVING the parenthetical; the row's
  role column is now `FACULTY` only and the record-level cell reads "owner or
  MANAGE-grantee + ACTIVE". ADMIN/DOCUMENT_MANAGER do not hold `documents.upload_own`
  (self-key separation of duties, §14.3) and therefore cannot upload — now stated
  explicitly and consistently in §8 step 1.

- **Finding 5 [MEDIUM] — §8 "(or a staff upload key)" references an undefined
  key.** ADDRESSED by DELETING the parenthetical from §8 step 1; uploads are gated
  SOLELY by `documents.upload_own`, consistent with §14.2 and §15. No undefined
  permission is referenced anywhere.

- **Finding 6 [NIT] — prod guard also throws on `SUPABASE_URL`, mis-described as
  "byte-for-byte".** ADDRESSED by rewording §6.2 to "mirrors the razorpay
  prod-guard SHAPE (throw only in production) … additionally guards `SUPABASE_URL`
  because the adapter is non-functional without it (a benign superset)". NFR-2 and
  AC-10 already said "mirror razorpay"/"prod-guard parity" (no change needed). The
  remaining "byte-for-byte" in §12 refers to the column-guard trigger idiom, which
  IS mirrored exactly, so it is left as-is.

- **Finding 7 [NIT] — `getSignedUploadUrl?` optional conflicts with "declared but
  unused" prose.** ADDRESSED by making `getSignedUploadUrl` a REQUIRED interface
  method implemented by both `SupabaseStorageAdapter` (`POST
  /storage/v1/object/upload/sign/{bucket}/{key}`) and the in-memory stub, with no
  9.7 route calling it. §6.1, §6.2, §6.3, D-1, and §18 updated so the swap-to-R2/S3
  contract is honest and no future caller faces an `undefined` method.

- **Finding 8 [NIT] — access-log summary vs detail ownership blurred between
  `admin.view_all` and `audit.view`.** ADDRESSED by stating explicitly in §14.2,
  FR-8, and a new §15 paragraph: `documents.admin.view_all` owns the AGGREGATE
  report (incl. access-log SUMMARY counts + XLSX export); `documents.audit.view`
  owns the per-document access-log DETAIL ledger (`GET /:id/access-log`). The two
  keys are deliberately distinct.
