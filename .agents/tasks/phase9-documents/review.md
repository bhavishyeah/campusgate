# Object-storage-backed Document Management for CAMPASS Phase 9.7

Phase 9.7 adds the seventh and final Phase-9 module: a document store whose large
file blobs live in Supabase Storage while the relational DB holds only metadata
(filename, content type, size, sha256, ownership, a version chain, access grants,
retention state, and the tenant-prefixed storage key). All object-storage access
sits behind a small `ObjectStore` adapter interface with a `SupabaseStorageAdapter`
(raw Storage REST over `fetch`), an `InMemoryObjectStore` stub, and a
`getObjectStore`/`setObjectStore` injectable singleton that mirrors the Razorpay
gateway seam. Downloads are short-lived signed URLs minted only after a
not-public-by-default ownership-or-grant authorization check. Six new tenant-owned
tables carry the standard A2 isolation (composite FKs + ENABLE/FORCE RLS +
fail-closed policies), two of them append-only ledgers, with a forward-only
document lifecycle column guard. The migration is additive, lettered a–j, and the
22 prior frozen dirs are byte-untouched.

Watch for: nothing blocking. The implementation matches the approved design
closely — the seam mirrors `razorpay.ts` (confirmed), the service-role key is
server-only and prod-guarded (confirmed), download authorization precedes signed-URL
minting (confirmed), the catalogue-sync lockstep holds (confirmed), and tenant-escape
covers all six tables with no blob I/O (confirmed). A few informational notes below;
none change the verdict.

**Verdict**: APPROVED

## High-level view

The storage seam is a faithful clone of the Razorpay gateway: an `ObjectStore`
interface, a concrete `SupabaseStorageAdapter` whose constructor reads env with an
`isProd()` guard that throws only in production, a lazy module-level singleton, and
a `set*(x|null)` test seam. No `fetch` to `/storage/v1/` appears in the routes file;
every blob operation goes through `getObjectStore()`. A future R2/S3 swap is one new
class implementing the interface.

The service-role key is server-only: read from `SUPABASE_SERVICE_ROLE_KEY`, used only
as the `Authorization`/`apikey` header, never placed in a response body, a returned
URL, or a log line (the log shaper emits only `op`+`status`). Storage keys are
server-minted as `<institutionId>/<documentId>/<versionId>` with `institutionId`
taken from the verified token, never request input.

Authorization is not-public-by-default and record-level: `canAccessDocument` is the
sole real visibility gate, reached after a coarse `requirePermission`/`requireModuleActive`
pair. `documents.download` is a genuine baseline-reachability key bound to every
non-applicant tenant role so any user-grantee or department-grantee clears the coarse
gate; a holder with no owner/grant/admin relationship still gets 404. Signed URLs are
minted only after that check passes and only when status is not `PURGE_PENDING`/`PURGED`.

Upload ordering is store-object-first: bytes are written via `putObject` before the
metadata transaction commits, so a committed version row always points at a real blob;
a tx failure after the put triggers a best-effort compensating `deleteObject`, and the
only residue is an unreferenced-but-sweepable blob. Purge deletes every version blob
via the adapter first (first failure aborts, stays `PURGE_PENDING`, returns 502) then
flips to the terminal `PURGED`, retaining the metadata tombstone.

The migration is additive and house-style: three enums, six tables, composite
same-tenant FKs, CHECKs including the grant XOR and the 64-hex checksum, ENABLE/FORCE
RLS via the copied `DO $$ FOREACH` block (mutable pair for three tables, INSERT-only
pair for the two ledgers), two append-only triggers, the `document_status_guard`
column guard, a guarded idempotent `campass_app` grant refresh (no BYPASSRLS), and the
catalogue seed (DOCUMENT_MANAGER role + 7 permissions + 26 role_permissions pairs). The
shared catalogue, catalogue-sync `SEEDING_MIGRATION_DIRS`, tenant-escape suite (all six
tables + RLS meta-test, no blob I/O), the two fast unit suites, the live behavioral
suite (injected fake store), and the gated real-Supabase smoke check are all present and
registered. `StudentDocument`/`ApplicationDocument` are untouched; module deps are `[]`.

<details>
<summary>Issues (4)</summary>

1. **Upload metadata on headers/query, not multipart** (informational, confirmed) — deliberate per design D-1 to avoid adding `@fastify/multipart`; raw-body `Buffer` via the encapsulated `application/octet-stream` parser. No action; noted so a future client integrator knows metadata rides on `x-*` headers/query.
2. **`revokedByUserId` / `createdByUserId` / `versionId` carry no FK** (informational, confirmed) — recorded-id/pointer precedent from prior phases, justified in the design. No action.
3. **Behavioral suite signs every token with `role: "ADMIN"`** (possible, verify) — authorization is resolved from DB membership in `authenticate`, not the token role claim, so per-user assertions remain meaningful; this works only because the real auth path re-reads roles/permissions per request. No action, but worth keeping in mind if the token role claim ever gains authority.
4. **`headObject` size-integrity not re-verified after `putObject` in production path** (informational, confirmed) — the design confines checksum/size re-head to the smoke test only; the server computes sha256+size from the exact received bytes before storing, so the stored row is authoritative. No action.

</details>

<details>
<summary>Details</summary>

### Storage seam mirrors the Razorpay gateway exactly

`storage.ts` reproduces the `razorpay.ts` shape: the `ObjectStore` interface stands in
for `RazorpaySdkLike`, `SupabaseStorageAdapter` for `RazorpayGateway`, and the
`let singleton` + `getObjectStore()` + `setObjectStore(store|null)` trio matches
`getRazorpayGateway`/`setRazorpayGateway` line-for-line in lifecycle. The constructor
reads `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_STORAGE_BUCKET` with optional
overrides and an `isProd()` guard that throws only when `NODE_ENV === 'production'` and
a required value is unset — a benign superset of the razorpay secret-only guard (it also
guards `SUPABASE_URL`, justified because the adapter cannot form a request without it,
design review finding 6). Construction is lazy, so a dev/test import never trips the
guard. `getSignedUploadUrl` is a required method on the interface and implemented by both
the adapter and the stub even though no 9.7 route calls it (D-1), keeping the swap-to-R2/S3
contract honest. The routes file imports `getObjectStore`/`ObjectStoreError` and never
calls `fetch` against `/storage/v1/` — confirmed by reading the full routes file.

### Service-role key is server-only and never leaks

The key is read from env, held private on the adapter, and used only in `authHeaders()`
as `apikey` + `Authorization: Bearer`. It is never returned in a response (download routes
return only `{ url, expiresAt }` from the signed-URL result), never embedded in a storage
key, and never logged — `storageErr()` deliberately shapes an `ObjectStoreError` down to
`{ op, status }` and a generic error down to its message only. `.env.example` documents
all three vars under a SERVER-ONLY section with placeholder values and the prod-fail-hard
note mirroring JWT_SECRET/Razorpay. Storage keys are `<institutionId>/<documentId>/<versionId>`
with all three segments server-minted and `institutionId` taken from `request.user`, never
from input.

### Download authorization precedes signed-URL minting

`POST /:id/versions/:vid/download-url` runs the coarse OR-gate (`documents.download` /
`documents.view_own` / `documents.admin.view_all`), then inside the tenant tx loads the doc
+ grants and calls `canAccessDocument(..., "READ")`; a non-owner/non-grantee/non-admin gets
404 (existence-hiding), and `PURGE_PENDING`/`PURGED` status gets 403. Only after that does
it call `getSignedDownloadUrl(storageKey, 120)`, then write the append-only access-log row
+ audit event. The order is correct: no URL is minted for an unauthorized requester, and a
storage failure maps to 502 without writing the ledger row. The behavioral suite proves the
owner, user-grantee, and Finance-department-grantee (ACCOUNTANT) can all mint, a
`documents.download` holder with no grant gets 404, and an APPLICANT (no `documents.download`)
is stopped at the coarse gate with 403.

### canAccessDocument is the sole real visibility gate

The pure helper implements the ordered rules: admin/DOCUMENT_MANAGER (via
`documents.admin.view_all`) first, then owner, then a live grant (`revokedAt IS NULL`)
matching `granteeUserId === userId` or `granteeDepartmentId === departmentScope` with
`accessLevel >= requested` (MANAGE ⊇ READ), else deny. The department branch correctly
uses `request.auth.departmentScope` (the fresh-per-request value on `RequestAuth`), not a
token `departmentId`, and a null `departmentScope` never matches a department grant. The
unit suite exercises the full matrix including revoked-denies and null-scope; the design's
baseline-reachability rationale for binding `documents.download` to every non-applicant
role (so the coarse gate is a true no-op) is realized in both `permissions.ts` and the
migration seed.

### Upload store-first ordering and compensating cleanup

Both upload routes compute sha256 + size server-side from the received `Buffer`, mint the
version id + storage key, call `putObject` (a failure → 502, nothing committed), then open
the tenant tx to create the row(s) and advance `currentVersionId`. A tx failure triggers a
best-effort `deleteObject` on the orphaned key, logged at WARN if it also fails — the design's
documented residue (an unreferenced, sweepable blob). The new-version route additionally
authorizes + computes the next version number in a read-only pre-tx pass (owner or live
MANAGE-grantee, status ACTIVE), re-guards ACTIVE inside the commit tx, and deletes the blob
if the doc went stale between the two. The InMemoryObjectStore's `x-upsert:false` parity (a
duplicate key throws) matches the adapter, and the version id embedded in the key makes a
real collision effectively unreachable.

### Append-only ledgers and the forward-only lifecycle guard

`document_versions` and `document_access_logs` each get a `<table>_append_only()` trigger
raising `restrict_violation` on BEFORE UPDATE OR DELETE, plus the INSERT-only RLS pair and a
`SELECT,INSERT` grant with an explicit `REVOKE UPDATE, DELETE` for `campass_app` — the
owner-binding trigger covers what the grant cannot. `documents` carries the
`document_status_guard` column guard enforcing exactly the §12 legal edge set
(ACTIVE→ARCHIVED, ACTIVE→PURGE_PENDING, ARCHIVED→ACTIVE, ARCHIVED→PURGE_PENDING,
PURGE_PENDING→PURGED, + no-op self), freezing identity columns, and forbidding DELETE, with
PURGED terminal because it is not a legal source state. The handler's `isLegalDocTransition`
map mirrors the guard, giving a 409 at the handler with the DB `restrict_violation` as a
backstop. The behavioral suite proves a ledger UPDATE/DELETE raises `restrict_violation` and
that a post-PURGED transition is blocked.

### Multi-tenancy A2 on every new table

Every table carries `institutionId`, a `(id, institutionId)` composite unique anchoring the
same-tenant FKs, `(institutionId)` + per-query indexes, and ENABLE+FORCE RLS via the copied
`DO $$ FOREACH` block — the three mutable/guarded tables get the standard
`tenant_isolation_select`/`tenant_isolation_modify` pair with the `nullif(current_setting(...),
'')` fail-closed guard, the two ledgers get the select + insert-only pair. Composite
same-tenant FKs carry `institutionId` with MATCH SIMPLE on the nullable `retentionPolicyId`,
`granteeUserId`, `granteeDepartmentId`; `currentVersionId` and the `*ByUserId`/`versionId`
recorded ids carry no FK per the design. The grant XOR CHECK, the 64-hex checksum CHECK, and
the two partial live-grant unique indexes (WHERE `revokedAt IS NULL`) are all present. All
route I/O runs inside `withTenant(institutionId, ...)`; the only `privilegedPrisma` use is the
module-active guard's existing point lookup in `authz-engine.ts`, not this module.

### Migration additivity and catalogue lockstep

The commit touches only the new `20270131000000_phase9_documents` dir under
`packages/db/prisma/migrations` (git show --stat confirms one file, 495 insertions); the 22
prior dirs are byte-untouched. The recorded `migrate diff` shows only the cosmetic
composite-vs-single-FK churn with 0 DropTable and no DROP on existing tables, and the
diff/deploy/status workflow was used (not `migrate dev`). The shared catalogue adds the
`documents` module (deps `[]`, foundational-not-gated), the seven `documents.*` permissions,
the DOCUMENT_MANAGER template role, the eleven audit keys, and exactly the 26
role_permissions pairs that the migration seed emits — ADMIN×5, DOCUMENT_MANAGER×5, FACULTY×4,
and `documents.download` for the twelve remaining non-applicant roles, APPLICANT excluded.
`SEEDING_MIGRATION_DIRS` gains the new dir so catalogue-sync's set-equality assertion covers it.

### Test coverage

The two fast unit suites cover the `canAccessDocument` matrix, `isLegalDocTransition`
(every legal/illegal edge + PURGED terminal), `buildStorageKey`/`sha256Hex`, the Zod schemas
(including the grant XOR), the InMemoryObjectStore behavior, the adapter prod-guard (throws in
production, constructs cleanly in test), and the singleton lifecycle. The live behavioral suite
(injected fake store, 60s timeouts) covers upload v1/v2, mint-after-authz + ledger row,
user-grantee, department-grantee, no-grant→404, applicant→403, revoke→404, archive, the full
purge lifecycle, append-only enforcement, metadata-view-not-logged, not-public→404, and the
report shape. Tenant-escape adds all six tables to `RLS_TABLES` plus the ledgers' append-only
`EXPECTED_POLICIES`, seeds them with `storageKey` as a string only (no blob I/O), and tears them
down via the scoped DISABLE TRIGGER dance. The gated smoke check is the only real-network path
and `describe.skipIf`s cleanly without the env vars.

Not tested (acceptable): the real Supabase REST endpoint shapes are only exercised by the gated
smoke check, which skips in CI without credentials — the one unverifiable-at-design-time item,
confined there by design.

### Build verification

`npm run build -w @campusgate/api` (prisma generate + tsc) completed with exit code 0 — the
schema parses, the client generates, and the new routes/storage/validation TypeScript compiles.
The fast-suite (678) and live-suite isolation results are taken from the recorded commit message
per the review brief and were not re-run.

</details>

<details>
<summary>File map</summary>

- `packages/db/prisma/schema.prisma` — three enums + six models appended after the service-requests block, house style.
- `packages/db/prisma/migrations/20270131000000_phase9_documents/migration.sql` — new additive lettered a–j migration (enums, tables, composite FKs, CHECKs, RLS, triggers, grant refresh, catalogue seed).
- `apps/api/src/services/documents/storage.ts` — ObjectStore interface, SupabaseStorageAdapter, InMemoryObjectStore, ObjectStoreError, get/setObjectStore seam.
- `apps/api/src/routes/documents.ts` — the `/api/documents` module (18 routes) + exported pure helpers (canAccessDocument, isLegalDocTransition, buildStorageKey, sha256Hex).
- `apps/api/src/server.ts` — registers documentsRoutes at `/api/documents`.
- `packages/shared/src/modules.ts` — `documents` module registry + `documents: []` dependency.
- `packages/shared/src/permissions.ts` — seven `documents.*` keys + DOCUMENT_MANAGER role + 26 role_permissions bindings.
- `packages/shared/src/audit-actions.ts` — eleven `documents.*` audit keys.
- `packages/shared/src/validation.ts` — Zod schemas for upload/version/grant/policy/list.
- `apps/api/.env.example` — SERVER-ONLY Supabase Storage section (3 vars, placeholders).
- `apps/api/src/services/__tests__/catalogue-sync.test.ts` — new dir added to SEEDING_MIGRATION_DIRS.
- `apps/api/vitest.live-db-suites.ts` — registers the behavioral + smoke suites.
- `apps/api/src/services/documents/__tests__/storage.unit.test.ts` — fast seam unit suite.
- `apps/api/src/routes/__tests__/documents.unit.test.ts` — fast helper/schema unit suite.
- `apps/api/src/routes/__tests__/documents.behavioral.integration.test.ts` — live behavioral suite (injected fake store).
- `apps/api/src/services/documents/__tests__/storage.smoke.integration.test.ts` — gated real-Supabase smoke check.
- `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` + `tenant-escape.integration.test.ts` — six new tables seeded + escape/RLS-meta cases, no blob I/O.
- `apps/api/src/routes/__tests__/hr-routes.integration.test.ts` — minor incidental change (9 lines).

Full diff: `git -C c:\campusgate show 8fab8c1`.

</details>
