# Implementation Plan — CAMPASS Phase 9.7 Document Management (backend only)

Source: the APPROVED design at `.agents/tasks/phase9-documents/design.md` (+ its
APPROVED iteration-3 review `design-review.md`, verdict APPROVED). This plan
sequences that design faithfully; it does not re-decide the architecture. Work
DIRECTLY on `main` in `c:\campusgate` (NO worktree). Do NOT push or deploy.

Decomposition decision: this slice is ONE cohesive backend module built in a
strict dependency chain (schema → migration → shared catalogues → storage seam →
routes → tests). The pieces are coupled by catalogue-sync EXACT set-equality (the
seven permission keys + 26 role pairs must match the migration byte-for-byte) and
by a single routes file + single storage service. It does NOT split into
independently shippable features, so it is written as one ordered plan; the
existing implement-and-review loop will execute it. (The workflow tail was NOT
restructured.)

Build/verify commands discovered in the repo (use these exact ones):
- Fast API suite (currently 651 green): `npm test -w @campusgate/api`
  (= `vitest run`, mocks `@campusgate/db`, offline).
- API typecheck/build: `npm run build -w @campusgate/api`
  (= `prisma generate` + `tsc`).
- Shared build: `npm run build -w @campusgate/shared` (if present) or rely on the
  api build which imports `@campusgate/shared`.
- Live-DB suites (serial, generous timeouts, each must pass IN ISOLATION):
  `npm run test:integration -w @campusgate/api`.
- Prisma migration workflow (run from `packages/db`, NEVER `migrate dev`):
  `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma`
  for the sanity diff, then `npx prisma migrate deploy`, then
  `npx prisma migrate status`. (Exact `migrate diff` arg form: confirm against
  `packages/db` prior usage; the REQUIRED checks are deploy succeeds + status
  "up to date" + only the cosmetic composite-vs-single-FK diff, NO DROP.)

Grounding notes the implementer must honor (verified against the repo):
- The injectable seam mirrors `apps/api/src/services/fees/razorpay.ts`: a
  `*SdkLike`/interface, a concrete class whose constructor reads env with an
  `isProd()` guard throwing ONLY in production, a lazy `let singleton`, a
  `get*()` accessor, and a `set*(x|null)` test seam.
- The raw-body transport mirrors `apps/api/src/routes/razorpay-webhook.ts`:
  `app.addContentTypeParser(<type>, { parseAs: "buffer" }, (_req, body, done) => done(null, body))`
  INSIDE the plugin (encapsulated; does not affect JSON routes).
- The migration house style is the lettered a–j block in
  `packages/db/prisma/migrations/20270124000000_phase9_service_requests/migration.sql`
  (copy the `DO $$ … FOREACH` RLS loop, the `<table>_append_only()` trigger, the
  `service_request_status_guard` column guard, the guarded idempotent
  `campass_app` GRANT refresh, and the role→permissions→role_permissions seed
  ordering verbatim in shape).
- The department-grant authorization check uses `request.auth.departmentScope`
  (the fresh-per-request department id on `RequestAuth` in
  `apps/api/src/middleware/auth.ts`) — there is NO `user.departmentId` on the
  auth object. `canAccessDocument` compares `grant.granteeDepartmentId ===
  auth.departmentScope`.
- `recordAuditEvent(input, tx)` is in `apps/api/src/services/audit.ts`; pass the
  `withTenant` tx for tenant actions. It THROWS on an unknown action key, so the
  eleven `documents.*` keys MUST be added to `audit-actions.ts` first.
- `requirePermission(key)` takes exactly ONE key; routes needing an OR of coarse
  keys use an inline dual gate (the service-requests `GET /types/:id/fields`
  precedent).
- `exceljs` is already a dependency of `@campusgate/api` (used in
  `service-requests.ts`); no new dependency is added anywhere in this slice.

---

- [ ] 1. Add the three enums + six models to the Prisma schema, appended AFTER the
      ServiceRequest block (house style per §5: `@id @default(cuid())`,
      `institutionId` + `institution Institution @relation`, `@@unique([id, institutionId])`,
      per-query `@@index`, `@@map` to snake_case, comments noting composite FKs /
      CHECKs / RLS / triggers live in raw SQL). Enums: `DocumentStatus`
      (ACTIVE/ARCHIVED/PURGE_PENDING/PURGED), `DocumentAccessLevel` (READ/MANAGE),
      `DocumentAccessAction` (DOWNLOAD_URL_MINTED only). Models: `DocumentRetentionPolicy`,
      `Document` (currentVersionId plain nullable String, NO FK),
      `DocumentVersion` (append-only, uploadedAt only, NO updatedAt, sizeBytes BigInt),
      `DocumentAccessGrant` (XOR grantee, revokedAt nullable),
      `DocumentAccessLog` (append-only, versionId NOT NULL). Wire the Prisma
      single-column back-relations on `Institution`/`User`/`Department` as the
      ServiceRequest models do (named relations where a model references `users`
      twice, e.g. owner vs uploadedBy vs grantedBy vs grantee vs log user).
      Files: `packages/db/prisma/schema.prisma`
      Verify: `npm run build -w @campusgate/api` runs `prisma generate` cleanly
      (schema parses, client types generate). Do NOT run `migrate dev`.

- [ ] 2. Hand-author the migration directory `20270131000000_phase9_documents`
      (next weekly +7d increment; 22 prior dirs stay byte-untouched) in the
      lettered a–j style, STRICTLY ADDITIVE (only CREATEs + one catalogue seed, no
      DROP, no `_prisma_migrations` edit, `campass_app` stays NOSUPERUSER
      NOBYPASSRLS). Sections: (a) three enums; (b) six tables + PKs — four
      mutable/guarded carry `updatedAt NOT NULL` (`document_retention_policies`,
      `documents`, `document_access_grants`), two append-only
      (`document_versions`, `document_access_logs`) are createdAt/uploadedAt-only,
      `sizeBytes BIGINT`; (c) `(id, institutionId)` unique on all six +
      `(institutionId)`/per-query indexes (§5) + business uniques (policies
      `(institutionId,name)`; versions `(institutionId,documentId,version)` and
      `(institutionId,storageKey)`; the two PARTIAL live-grant uniques on
      `document_access_grants` `WHERE … revokedAt IS NULL`); (d) tenant-root
      `institutionId -> institutions(id)` RESTRICT/CASCADE on all six; (e)
      composite same-tenant FKs per §13.e (MATCH SIMPLE on nullable
      retentionPolicyId/granteeUserId/granteeDepartmentId; NO FK on
      currentVersionId and all `*ByUserId` recorded ids); (f) CHECKs per §13.f
      incl. grant XOR `((granteeUserId IS NOT NULL) <> (granteeDepartmentId IS NOT NULL))`
      and `checksumSha256 ~ '^[0-9a-f]{64}$'`; (g) ENABLE+FORCE RLS via the copied
      `DO $$ … FOREACH` block (`mutable_tables` = the three mutable/guarded,
      `append_only_tables` = the two ledgers); (h) two `<table>_append_only()`
      triggers + the `document_status_guard` column guard enforcing the §12 legal
      edge set (ACTIVE→ARCHIVED, ACTIVE→PURGE_PENDING, ARCHIVED→ACTIVE,
      ARCHIVED→PURGE_PENDING, PURGE_PENDING→PURGED, + no-op self; freeze
      institutionId/ownerUserId/createdAt; forbid DELETE); (i) guarded idempotent
      `campass_app` GRANT refresh (SELECT,INSERT,UPDATE on the three
      mutable/guarded; SELECT,INSERT + explicit REVOKE UPDATE,DELETE on the two
      ledgers); (j) catalogue seed in order role-row → permissions → role_permissions:
      the `DOCUMENT_MANAGER` template role (`institutionId NULL`) FIRST, then the
      SEVEN `documents.*` permissions (module `documents`), then the 26
      role_permissions pairs (ADMIN×5, DOCUMENT_MANAGER×5, FACULTY×4, and
      `documents.download` for each of STUDENT/ACCOUNTANT/LIBRARIAN/WARDEN/
      ADMISSION_OFFICER/HR_MANAGER/EMPLOYEE/TRANSPORT_MANAGER/INVENTORY_MANAGER/
      SERVICE_AGENT/GUARD/HOD = 12) via `… AS m("roleKey","permKey") JOIN "roles" r ON r."key"=m."roleKey" AND r."institutionId" IS NULL JOIN "permissions" p … ON CONFLICT DO NOTHING`.
      Files: `packages/db/prisma/migrations/20270131000000_phase9_documents/migration.sql`
      Verify: from `packages/db`, `npx prisma migrate deploy` succeeds and
      `npx prisma migrate status` = up to date; `migrate diff` shows only the
      cosmetic composite-vs-single-FK diff with NO DROP on existing tables; all 22
      prior dirs unchanged (`git status` shows only the new dir added).
      (Depends on item 1 for the matching model shapes.)

- [ ] 3. Add the shared-package catalogue entries so `@campusgate/shared` carries
      the module key, the seven permission keys + role map, and the eleven audit
      keys. In `modules.ts`: add `{ key: "documents", name: "Document Management",
      description: "…(Phase 9.7)" }` to `MODULES` and `documents: []` to
      `MODULE_DEPENDENCIES` with the foundational-not-gated comment
      (`MODULE_KEY_SET` auto-includes it). In `permissions.ts`: add the seven
      `documents.*` `PermissionDef`s (module `documents`) per §14.2 and update
      `ROLE_PERMISSIONS` per §14.3 — add the new `DOCUMENT_MANAGER` key (five
      keys: download + grants.manage + admin.view_all + retention.manage +
      audit.view), add the four FACULTY keys (upload_own, view_own, download,
      grants.manage), add the five ADMIN keys (download + the four admin keys; NOT
      the owner self keys), and add `documents.download` ONLY to the 12 remaining
      non-applicant roles (STUDENT, ACCOUNTANT, LIBRARIAN, WARDEN,
      ADMISSION_OFFICER, HR_MANAGER, EMPLOYEE, TRANSPORT_MANAGER,
      INVENTORY_MANAGER, SERVICE_AGENT, GUARD, HOD); APPLICANT gets NONE. This is
      exactly 26 new (role, key) pairs matching the migration seed. In
      `audit-actions.ts`: add the eleven `documents.*` past-tense keys (module
      `documents`) per §14.4.
      Files: `packages/shared/src/modules.ts`, `packages/shared/src/permissions.ts`,
      `packages/shared/src/audit-actions.ts`
      Verify: `npm run build -w @campusgate/api` typechecks (shared compiles and
      the `ModuleKey`/`PermissionKey` unions include the new keys). Full
      set-equality is asserted by catalogue-sync in item 8.

- [ ] 4. Register `20270131000000_phase9_documents` in the catalogue-sync
      `SEEDING_MIGRATION_DIRS` array (append as the newest entry, after
      `20270124000000_phase9_service_requests`).
      Files: `apps/api/src/services/__tests__/catalogue-sync.test.ts`
      Verify: `npm test -w @campusgate/api -- catalogue-sync` — the keys +
      (role,permission) pair set-equality tests pass (proves items 2 and 3 agree
      byte-for-byte). (Depends on items 2 and 3.)

- [ ] 5. Add the Zod validation schemas for every external input to
      `packages/shared/src/validation.ts` (the house location; routes import
      `*Schema` from `@campusgate/shared`). Per §10: upload metadata
      (`title` ≤300 non-empty, `description` ≤4000 optional, `category` ≤120
      optional, `filename` ≤255 non-empty, `contentType` non-empty, optional
      `retentionPolicyId`), new-version params, create-grant (XOR
      granteeUserId/granteeDepartmentId, accessLevel READ|MANAGE), revoke params,
      retention-policy (name ≤120, retentionDays int 1..36500, optional category),
      lifecycle transition targets, and the list/report query (optional status,
      ownerUserId, category, bounded page/pageSize). Export the inferred types.
      Files: `packages/shared/src/validation.ts`
      Verify: `npm run build -w @campusgate/api` typechecks.

- [ ] 6. Create the ObjectStore seam `storage.ts` mirroring `razorpay.ts` EXACTLY
      (§6): export the `ObjectStore` interface (putObject, getSignedDownloadUrl,
      getSignedUploadUrl REQUIRED, deleteObject, headObject) + the input/result
      types + a typed `ObjectStoreError` (carries `status`, `op`); the
      `SupabaseStorageAdapter` class (constructor reads SUPABASE_URL /
      SUPABASE_SERVICE_ROLE_KEY / SUPABASE_STORAGE_BUCKET with overrides, `isProd()`
      guard throwing only in production when URL or key unset; raw `fetch` to the
      Storage REST endpoints in §6.2 with `Authorization: Bearer <key>` + `apikey`
      header, `x-upsert:false` on put; service-role key never logged/returned; map
      non-2xx to `ObjectStoreError`); the `InMemoryObjectStore` stub (Map-backed,
      synthetic `stub://` URLs, test-only `has(key)`/`size()`); and the lazy
      singleton `let singleton` + `getObjectStore()` + `setObjectStore(store|null)`.
      Construction is lazy (not at import) so a dev/test import with SUPABASE_*
      unset never throws.
      Files: `apps/api/src/services/documents/storage.ts`
      Verify: `npm run build -w @campusgate/api` typechecks. Behavioral coverage
      is item 9's `storage.unit.test.ts`.

- [ ] 7. Add the Supabase Storage env block to `.env.example` under a new
      "Supabase Storage (Phase 9.7 documents — SERVER-ONLY)" section (§6.5):
      `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (server-only note mirroring the
      Razorpay/JWT_SECRET prod-fail-hard wording), `SUPABASE_STORAGE_BUCKET`
      (default "documents"); placeholder values only, no real secrets.
      Files: `apps/api/.env.example`
      Verify: open the file and confirm the three vars + the server-only note are
      present with placeholders (no build step). (Independent of items 1–6.)

- [ ] 8. Create the documents routes file and register it. Implement
      `documentsRoutes` at prefix `/api/documents` with a top-level `authenticate`
      hook, per-route `requirePermission(key)` + `requireModuleActive('documents')`,
      the encapsulated `application/octet-stream` raw-body `Buffer` parser +
      `bodyLimit = MAX_UPLOAD_BYTES (25*1024*1024)` for the two upload routes, and
      every read/write inside `withTenant(institutionId, tx => …)` with
      institutionId from `request.auth`. Export the pure helpers for unit tests:
      `canAccessDocument(auth, doc, grants, level)` (§11 ordered rules using
      `auth.departmentScope` for the department-grant branch; 404 vs 403 split),
      `isLegalDocTransition(from, to)` (§12 edges + PURGED terminal), and
      `buildStorageKey(institutionId, documentId, versionId)`. Implement all
      routes in the §15 matrix: create doc+v1 and new-version (store-object-first
      ordering per §8 with compensating `deleteObject` on tx failure, 502 on put
      failure, sha256+size computed server-side), list, detail (`GET /:id`, NOT
      logged), download-url mint (authorize → refuse if status ∈
      {PURGE_PENDING,PURGED} → `getSignedDownloadUrl` TTL 120s → write
      `DocumentAccessLog` row + audit), grant/revoke, archive/unarchive/
      purge-request/purge (purge deletes every version blob then flips PURGED,
      retains tombstone, 502+stay PURGE_PENDING on delete failure), retention
      policies CRUD, the aggregate report JSON + XLSX export (ExcelJS, gated
      `documents.admin.view_all`), and the per-document access-log ledger (gated
      `documents.audit.view`). All object-storage access goes through
      `getObjectStore()` — NO `fetch` to `/storage/v1/` in this file. Record the
      `documents.*` audit keys via `recordAuditEvent(…, tx)`; deny branches use
      404 for existence-hiding on detail/download. Register in `server.ts`:
      `import { documentsRoutes } from "./routes/documents.js";` and
      `await app.register(documentsRoutes, { prefix: "/api/documents" });` next to
      the inventory/service-requests registrations.
      Files: `apps/api/src/routes/documents.ts`, `apps/api/src/server.ts`
      Verify: `npm run build -w @campusgate/api` typechecks and compiles. Route
      behavior is covered by items 9 and 10.
      (Depends on items 1, 3, 5, 6.)

- [ ] 9. Add the two fast unit suites (mock `@campusgate/db`; inject
      `setObjectStore(new InMemoryObjectStore())` in `beforeEach`,
      `setObjectStore(null)` in `afterEach`; NO network, NO real DB). §16.1:
      `storage.unit.test.ts` — InMemoryObjectStore behavior, the
      `SupabaseStorageAdapter` constructor guard (throws when
      `NODE_ENV=production` and URL/key unset; imports/constructs cleanly in test
      with absent values), the get/set singleton lifecycle, and `buildStorageKey`.
      `documents.unit.test.ts` — the `canAccessDocument` matrix (owner, user-grant,
      dept-grant via departmentScope, MANAGE⊇READ, revoked-grant denies, admin all,
      unrelated→deny), `isLegalDocTransition` (every legal + illegal edge, PURGED
      terminal), sha256/size, the 404-vs-403 existence-hiding decision, and the
      upload store-first ordering + compensating-delete-on-tx-failure asserted via
      the stub's `has()`.
      Files: `apps/api/src/services/documents/__tests__/storage.unit.test.ts`,
      `apps/api/src/routes/__tests__/documents.unit.test.ts`
      (match the repo's existing `__tests__` layout for each module)
      Verify: `npm test -w @campusgate/api` — fast suite stays green and the count
      rises above 651 (the two new suites pass). (Depends on items 6 and 8.)

- [ ] 10. Add the live-DB behavioral suite and register it. Create
      `documents.behavioral.integration.test.ts` using real `withTenant`
      transactions but an INJECTED `InMemoryObjectStore` (no real network blob
      I/O), many-round-trip cases carrying `{ timeout: 60000 }`. Cover §16.2:
      upload v1 (version row + pointer + stub blob present), upload v2 (append,
      v1 untouched, pointer advances), download-url mint only after authz +
      access-log row (`action=DOWNLOAD_URL_MINTED`, versionId NOT NULL), a
      NON-owner STUDENT user-grantee can mint, an ACCOUNTANT department-member
      (dept grant) can mint, a `documents.download` holder with NO grant → 404, an
      APPLICANT → 403 at the coarse gate, revoke → next mint denied, archive hides
      from default list but owner still downloads, purge-request blocks download,
      purge deletes stub blobs + flips PURGED (further transition 409/guard), a
      ledger UPDATE/DELETE raises `restrict_violation`, metadata view writes NO
      access-log row, and the report JSON shape. Add its glob to `LIVE_DB_SUITES`.
      Files: `apps/api/src/routes/__tests__/documents.behavioral.integration.test.ts`
      (or the module's integration-test location), `apps/api/vitest.live-db-suites.ts`
      Verify: `npm run test:integration -w @campusgate/api` — the suite passes IN
      ISOLATION. (Depends on items 2, 8; requires the migration deployed via item 2.)

- [ ] 11. Extend the tenant-escape suite to cover all six new tables with NO real
      blob I/O (§16.3). Add the five new `SeededTenant` fields
      (`documentRetentionPolicyId`, `documentId`, `documentVersionId`,
      `documentAccessGrantId`, `documentAccessLogId`) and seed via `adminClient`
      in child-safe order: retention policy → document (ACTIVE, owner = seeded
      user) → version (storageKey is a STRING ONLY `"<inst>/<doc>/<ver>"`, no
      upload) → user-grant → access-log row (`DOWNLOAD_URL_MINTED`, versionId =
      the seeded version-id string). Teardown deletes the two append-only ledgers
      + the `documents` column-guard table within a scoped `DISABLE TRIGGER` dance
      (the inventory/service-requests precedent). Add the cross-tenant
      read/spoofed-write assertions for each table in
      `tenant-escape.integration.test.ts`.
      Files: `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts`,
      `apps/api/src/routes/__tests__/tenant-escape.integration.test.ts`
      Verify: `npm run test:integration -w @campusgate/api -- tenant-escape` —
      passes IN ISOLATION; touches NO object storage. (Depends on item 2.)

- [ ] 12. Add the gated real-Supabase-Storage smoke check (§16.4): a separate
      minimal suite that `describe.skipIf(!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)`
      and, when enabled, drives the REAL `SupabaseStorageAdapter` end-to-end
      (putObject a tiny buffer under `smoke/<uuid>` → headObject exists with right
      size → getSignedDownloadUrl returns an absolute URL that fetches back the
      identical bytes → deleteObject → headObject reports gone), never printing the
      service-role key. Register its glob in `LIVE_DB_SUITES`. This is the ONLY
      place the real network adapter runs and the place the external Supabase REST
      endpoint shapes (the one unverifiable-at-design-time item) are confirmed.
      Files: `apps/api/src/services/documents/__tests__/storage.smoke.integration.test.ts`,
      `apps/api/vitest.live-db-suites.ts`
      Verify: `npm run test:integration -w @campusgate/api -- storage.smoke`
      SKIPS cleanly when the two env vars are absent (the default + integration
      runs stay free of real blob I/O); it round-trips a real object only when both
      are present. (Depends on item 6.)

- [ ] 13. Final integration pass: run the full fast suite and the full
      integration run, confirm no regression and the new work is green.
      Verify: `npm run build -w @campusgate/api` (clean typecheck/compile);
      `npm test -w @campusgate/api` (fast suite green, count ≥ 651 + the two new
      unit suites); `npm run test:integration -w @campusgate/api` (behavioral +
      tenant-escape pass; storage.smoke skips without env). Confirm `git status`
      shows only additive changes and the 22 prior migration dirs unchanged.

## Digest

Per-file: the block to change, the covering test, and what was verified. The
coder opens a file only to edit it and works from this Digest.

### `packages/db/prisma/schema.prisma` (item 1)
- Block: append AFTER the `ServiceRequest*` models/enums (the `@@map("service_request_feedback")`
  model ends ~line 4280; the ServiceRequest enums follow). Add three enums
  (`DocumentStatus`, `DocumentAccessLevel`, `DocumentAccessAction`) and six models
  (`DocumentRetentionPolicy`, `Document`, `DocumentVersion`, `DocumentAccessGrant`,
  `DocumentAccessLog`) in the exact ServiceRequest house style — single-column
  relations for client typing, composite FKs/CHECKs/RLS/triggers noted as raw SQL.
  Add the back-relation fields on `Institution` (line-anchored by its existing
  ServiceRequest relations), `User` (model at `schema.prisma:387`; needs named
  relations: owner, uploadedBy, grantedBy, grantee, access-log user), and
  `Department` (model at `schema.prisma:362`; grantee-department relation).
- Covering test: `npm run build -w @campusgate/api` (prisma generate parses it);
  behavioral proof via items 10/11.
- Verified today: `StudentDocument` (`schema.prisma:615`) and
  `ApplicationDocument` (`schema.prisma:2009`) are separate SIS/admissions tables
  and are NOT touched. The `ServiceRequest` block (`schema.prisma:4197+`) is the
  live model-style reference.

### `packages/db/prisma/migrations/20270131000000_phase9_documents/migration.sql` (item 2, NEW)
- Block: the full a–j lettered migration (see item 2). Mirror the shape of
  `20270124000000_phase9_service_requests/migration.sql` verbatim: its
  `DO $$ … FOREACH` RLS loop (mutable vs append-only arrays), its
  `<table>_append_only()` trigger + `service_request_status_guard` column guard,
  its guarded idempotent `campass_app` GRANT refresh, and its role→permissions→
  role_permissions seed ordering (`AS m("roleKey","permKey") JOIN "roles" … institutionId IS NULL`).
- Covering test: `apps/api/src/services/__tests__/catalogue-sync.test.ts`
  (set-equality after item 4); tenant-escape (item 11) + behavioral (item 10)
  against the deployed migration.
- Verified today: the migrations dir reference migration opens with the a–j
  ordering comment; its RLS loop, append-only trigger, column guard, GRANT
  refresh, and seed block are the exact idioms to copy. 22 prior dirs exist;
  `20270131000000` is the correct +7d increment and sorts last. NEVER
  `migrate dev`.

### `packages/shared/src/modules.ts` (item 3)
- Block: add the `documents` entry to the `MODULES` array (end of the array,
  after `service_requests`) and `documents: []` (foundational-not-gated comment)
  to `MODULE_DEPENDENCIES`. `MODULE_KEY_SET` derives from `MODULES` — no other
  edit.
- Covering test: `npm run build -w @campusgate/api` typecheck;
  `requireModuleActive('documents')` exercised by item 10.
- Verified today: every Phase-9 module is `[]`; `MODULE_KEYS`/`MODULE_KEY_SET`
  are computed from `MODULES`.

### `packages/shared/src/permissions.ts` (item 3)
- Block: add the seven `documents.*` `PermissionDef`s to the `PERMISSIONS` array
  (after the `service_requests.*` block, before `platform.*`). In
  `ROLE_PERMISSIONS`: add a new `DOCUMENT_MANAGER` key (5 keys), append the
  documents keys to `FACULTY` (4) and `ADMIN` (5), and append `documents.download`
  to each of STUDENT, ACCOUNTANT, LIBRARIAN, WARDEN, ADMISSION_OFFICER,
  HR_MANAGER, EMPLOYEE, TRANSPORT_MANAGER, INVENTORY_MANAGER, SERVICE_AGENT,
  GUARD, HOD (12). APPLICANT/SUPER_ADMIN unchanged. Net: 26 new (role,key) pairs.
- Covering test: `catalogue-sync.test.ts` set-equality (item 4) — fails the build
  on any drift from the migration seed.
- Verified today: the full `ROLE_PERMISSIONS` map and all 14 non-applicant tenant
  roles + the additive-template-role precedent (ACCOUNTANT/WARDEN/… are
  `institutionId NULL` template roles) are present as the design states.

### `packages/shared/src/audit-actions.ts` (item 3)
- Block: add the eleven `documents.*` `{key, module:"documents", description}`
  tuples (past-tense) as a new group at the end of the `AUDIT_ACTIONS` array,
  after the existing `service_requests.*` group (which ends at
  `service_requests.feedback.submitted`). No migration mirror.
- Covering test: `recordAuditEvent` throws on unknown keys, so item 8's routes +
  item 10 behavioral exercise every key.
- Verified today: `AUDIT_ACTIONS` entries are `{key, module, description}`;
  `recordAuditEvent` validates against `AUDIT_ACTION_KEY_SET`.

### `apps/api/src/services/__tests__/catalogue-sync.test.ts` (item 4)
- Block: append `"20270131000000_phase9_documents"` to the `SEEDING_MIGRATION_DIRS`
  array (currently ends at `20270124000000_phase9_service_requests`).
- Covering test: this file is the test — `npm test -w @campusgate/api -- catalogue-sync`.
- Verified today: the parser slices `INSERT INTO "permissions" … ON CONFLICT` for
  keys and `INSERT INTO "role_permissions" … AS m(` for pairs (role row before
  permissions block keeps its `, NULL)` tuple out of the permission span);
  asserts EXACT set-equality against `PERMISSION_KEYS` + `ROLE_PERMISSIONS`.

### `packages/shared/src/validation.ts` (item 5)
- Block: add the documents Zod schemas (§10) + inferred types. Follow the
  existing `*Schema` export convention that `service-requests.ts` imports from
  `@campusgate/shared`.
- Covering test: `npm run build -w @campusgate/api` typecheck; route behavior
  (items 9/10).
- Verified today: `service-requests.ts` imports its schemas from
  `@campusgate/shared` (validation.ts is the house location).

### `apps/api/src/services/documents/storage.ts` (item 6, NEW)
- Block: `ObjectStore` interface + input/result types + `ObjectStoreError`;
  `SupabaseStorageAdapter`; `InMemoryObjectStore`; lazy `getObjectStore()` /
  `setObjectStore()`. Signatures per §6.1–§6.4.
- Covering test: `apps/api/src/services/documents/__tests__/storage.unit.test.ts`
  (item 9) + the gated `storage.smoke.integration.test.ts` (item 12).
- Verified today: `razorpay.ts` is the exact template — `RazorpaySdkLike`
  interface, `RazorpayGateway` with `isProd()` guard throwing only in production
  on the secrets, lazy `let singleton`, `getRazorpayGateway()`,
  `setRazorpayGateway(x|null)`.

### `apps/api/.env.example` (item 7)
- Block: add a new "Supabase Storage (Phase 9.7 documents — SERVER-ONLY)" section
  with the three vars + placeholders, after the Razorpay block.
- Covering test: none (config); visual check.
- Verified today (from design-review): the Razorpay block in `.env.example` is
  the server-only-note template (prod fail-hard, placeholders only).

### `apps/api/src/routes/documents.ts` (item 8, NEW) + `apps/api/src/server.ts` (item 8)
- `documents.ts` block: the `documentsRoutes` plugin + exported pure helpers
  (`canAccessDocument`, `isLegalDocTransition`, `buildStorageKey`) + the §15 route
  table. `server.ts` block: add the import near the other route imports (lines
  18–23) and `await app.register(documentsRoutes, { prefix: "/api/documents" });`
  next to the inventory/service-requests registrations (lines 68–69).
- Covering test: `documents.unit.test.ts` (helpers; item 9) +
  `documents.behavioral.integration.test.ts` (routes; item 10).
- Verified today: `service-requests.ts` is the route template — top-level
  `authenticate`, per-route `[requirePermission(key), requireModuleActive(key)]`,
  inline dual gate where one route needs an OR, `withTenant(institutionId, tx)`
  with institutionId from the token, deny-branch audit-then-return (never throw),
  exported pure helpers, `exceljs` already imported for XLSX. `requirePermission`
  takes exactly one key; `recordAuditEvent(input, tx)` is the audit writer. The
  raw-body parser pattern is in `razorpay-webhook.ts`. The auth object exposes
  `departmentScope` (NOT `departmentId`) for the dept-grant check.

### `apps/api/src/services/documents/__tests__/storage.unit.test.ts` + `apps/api/src/routes/__tests__/documents.unit.test.ts` (item 9, NEW)
- Block: the two fast suites (§16.1). Mock `@campusgate/db`; inject the in-memory
  stub in `beforeEach`, reset in `afterEach`.
- Covering test: themselves — `npm test -w @campusgate/api`.
- Verified today: the fast suite is `vitest run` and must stay green (651 today).

### `apps/api/src/routes/__tests__/documents.behavioral.integration.test.ts` (item 10, NEW) + `apps/api/vitest.live-db-suites.ts` (item 10)
- Block: the behavioral suite (§16.2) with an injected `InMemoryObjectStore` and
  `{ timeout: 60000 }` on many-round-trip cases; add its glob to `LIVE_DB_SUITES`.
- Covering test: itself — `npm run test:integration -w @campusgate/api`.
- Verified today: `LIVE_DB_SUITES` lists one glob per real-DB suite with the
  "add your new real-DB suite here" rule; integration run is serial with generous
  timeouts; each suite must pass in isolation.

### `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` + `apps/api/src/routes/__tests__/tenant-escape.integration.test.ts` (item 11)
- Block: add five `SeededTenant` fields + the child-safe seed (adminClient,
  storageKey as a plain string, no blob I/O) + the scoped `DISABLE TRIGGER`
  teardown for the two ledgers and the `documents` guard table; add the
  cross-tenant read/spoofed-write assertions.
- Covering test: itself — `npm run test:integration -w @campusgate/api -- tenant-escape`.
- Verified today: the setup helper's service-requests block is the exact
  precedent (three mutable/guarded + two append-only ledgers, trigger-disable
  teardown dance); the suite is the only api test hitting the live DB and must
  touch NO object storage here.

### `apps/api/src/services/documents/__tests__/storage.smoke.integration.test.ts` (item 12, NEW) + `apps/api/vitest.live-db-suites.ts` (item 12)
- Block: the `describe.skipIf(...)` real-adapter round-trip (§16.4); add its glob
  to `LIVE_DB_SUITES`.
- Covering test: itself — skips without env, round-trips with env.
- Verified today: the gated smoke check is the only place the real network
  adapter runs and the designated place to confirm the external Supabase REST
  endpoint shapes (the one design-time-unverifiable item flagged by the review).

### What was verified for the whole plan
- Build command: `npm run build -w @campusgate/api` = `prisma generate` + `tsc`.
- Fast test command: `npm test -w @campusgate/api` = `vitest run` (651 green today,
  offline, mocks `@campusgate/db`).
- Integration command: `npm run test:integration -w @campusgate/api` (serial,
  live DB, each suite isolated).
- Migration workflow: run from `packages/db`; `prisma migrate deploy` +
  `prisma migrate status`; NEVER `migrate dev`; additive-only; 22 prior dirs
  frozen; `campass_app` stays NOSUPERUSER NOBYPASSRLS.
- `exceljs` is already an `@campusgate/api` dependency; NO new dependency is added
  (raw `fetch` for Supabase per D-4; raw-body parser per D-1).
