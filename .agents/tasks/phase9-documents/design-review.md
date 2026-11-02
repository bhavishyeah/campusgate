# Design Review (iteration 3) — CAMPASS Phase 9.7 Document Management (backend only)

Reviewer: design-review subagent. This is a REVISION review. A prior review
exists (`design-review.md` / `design-review.json`, iteration 2, verdict
`CHANGES_REQUESTED`: 0 HIGH / 1 MEDIUM (finding A) / 1 NIT (finding B); the 8
original findings 1–8 were all Closed/Unchanged by iteration 2). Per the revision
protocol I re-checked the two still-open findings (A, B) against the new design,
marked each Closed or Unchanged, then reviewed what changed. §20.0 of the design
claims both are addressed; I verified those claims against the design text AND
against the REAL repo files — not against the design's own word.

Branch `main`, workspace `c:\campusgate`. Verdict is mechanical: HIGH + MEDIUM
count > 0 ⇒ CHANGES_REQUESTED; 0 ⇒ APPROVED.

---

## Re-check of the 2 open prior findings (A, B)

| # | Prior sev | Status | Note |
|---|---|---|---|
| A | MEDIUM | **Closed** | The design adopts the reviewer's PREFERRED option (a): `documents.download` is now a GENUINE baseline-reachability key bound to EVERY non-applicant authenticated tenant role. §11 rule 3, FR-5, AC-2, AC-14, §14.2, §14.3, §13.j, §15, §16.1, §16.2 all restated in lockstep. The department-grant path is now reachable for any staff/student role (the ACCOUNTANT "all of Finance" case works). Verified against the real `ROLE_PERMISSIONS`. |
| B | NIT | **Closed** | §16.2 now names the seeded roles: the user-grant grantee is a STUDENT (download-only role) and the department-member grantee is an ACCOUNTANT (the brief's "all of Finance" case); an APPLICANT 403 negative case is added. The test now exercises the resolved contract. |

Both remaining findings are genuinely Closed. The 8 earlier findings (1, 2, 4, 5,
6, 7, 8 Closed; 3 → A, now Closed) are all resolved. No finding was downgraded.

---

## Verification of the finding-A resolution against the real role catalogue

The entire blocker in iterations 1–2 was that the coarse `documents.download`
binding did not reach the full set of roles that `canAccessDocument` / FR-5 /
AC-14 promise can mint (any same-tenant user who holds a live user-grant, OR a
member of a granted department of ANY role). I re-derived the real tenant-role set
from `packages/shared/src/permissions.ts` `ROLE_PERMISSIONS` and checked the
design's committed binding against it.

Real roles in `ROLE_PERMISSIONS`: STUDENT, FACULTY, ACCOUNTANT, LIBRARIAN, WARDEN,
ADMISSION_OFFICER, APPLICANT, HR_MANAGER, EMPLOYEE, TRANSPORT_MANAGER,
INVENTORY_MANAGER, SERVICE_AGENT, GUARD, HOD, ADMIN, SUPER_ADMIN.

- SUPER_ADMIN is a platform (non-tenant) role holding only `platform.*` keys —
  correctly out of scope for a tenant document module.
- APPLICANT is the external admissions role (`["admissions.view_own"]`) — the
  design deliberately EXCLUDES it, with a sound rationale (an external applicant is
  not an internal tenant member who would ever receive an internal document grant;
  excluding it keeps the SIS/admissions decoupling intact).
- The 14 internal non-applicant tenant roles are STUDENT, FACULTY, ACCOUNTANT,
  LIBRARIAN, WARDEN, ADMISSION_OFFICER, HR_MANAGER, EMPLOYEE, TRANSPORT_MANAGER,
  INVENTORY_MANAGER, SERVICE_AGENT, GUARD, HOD, ADMIN.

The design binds `documents.download` to exactly those 14 existing roles PLUS the
new DOCUMENT_MANAGER (§14.2 list + §14.3 committed binding). The seed-pair
arithmetic is internally consistent:

- ADMIN ×5 (download + grants.manage + admin.view_all + retention.manage +
  audit.view)
- DOCUMENT_MANAGER ×5 (same five)
- FACULTY ×4 (upload_own + view_own + download + grants.manage)
- the remaining 12 non-applicant roles ×1 (download only)
- = 5 + 5 + 4 + 12 = **26 new `role_permissions` pairs** (matches §13.j, §14.3,
  AC-2, §16.1).

Because `documents.download` now reaches every role a grantee could be, the coarse
`requirePermission('documents.download')` gate is a true no-op and the
record-level `canAccessDocument` (§11) is the sole real visibility gate. The
previously-dead department-grant path (e.g. a WARDEN- or ACCOUNTANT-staffed
department) is now reachable. AC-14 and §16.2 correctly test a STUDENT user-grantee
and an ACCOUNTANT department-member. The internal contradiction prior finding
A/3 flagged is resolved, and the not-public-by-default promise still holds:
`documents.download` carries no record-level authority, so a holder with no
owner/grant/admin relationship still gets 404 (AC-14).

catalogue-sync (`catalogue-sync.test.ts`) asserts EXACT set-equality of the union
of migration-seeded `(roleKey, permKey)` pairs against `ROLE_PERMISSIONS`, so the
26-pair seed and the `ROLE_PERMISSIONS` additions MUST be transcribed in lockstep
(plus the `SEEDING_MIGRATION_DIRS` entry `20270131000000_phase9_documents`). This
is a build-failing guard; the design states it correctly (§13.j, §16.1, AC-4).

---

## Findings (this iteration)

None. No HIGH, MEDIUM, or NIT findings. The two open prior findings are Closed and
the revision introduced no new ambiguity, gap, unverified assumption, scope creep,
or internal conflict that I could identify against the repo.

---

## Verified Assumptions (checked against real repo files this iteration)

1. **Injectable seam mirrors `razorpay.ts` EXACTLY.** VERIFIED against
   `apps/api/src/services/fees/razorpay.ts`: a `RazorpaySdkLike` injectable
   interface; a `RazorpayGateway` class whose constructor reads env with an
   `isProd()` guard that throws ONLY in production and ONLY on the SECRETS
   (`keySecret`, `webhookSecret`) — never the public `keyId`; a lazy module-level
   `let singleton`; `getRazorpayGateway()` (constructs on first access);
   `setRazorpayGateway(gateway | null)`. The design's `ObjectStore` /
   `SupabaseStorageAdapter` / `getObjectStore` / `setObjectStore` /
   `setObjectStore(null)` lifecycle (§6.1–§6.4) mirror this exactly. Finding 6
   (iteration 1) is correctly resolved: §6.2 says "mirrors the razorpay prod-guard
   SHAPE" and documents the extra `SUPABASE_URL` guard as a benign superset — this
   is accurate (razorpay guards only the two secrets, never `keyId`; the adapter
   additionally guarding the non-secret URL is a superset, not a deviation).

2. **Server-only secret + prod-only guard + dev/test tolerate absent + lazy
   construction.** VERIFIED. `razorpay.ts` throws only when
   `NODE_ENV === "production"` and a required secret is unset; the lazy singleton
   avoids tripping the guard at import (comment: "Constructed on first access … so
   a dev/test import never trips the production secret guard"). NFR-2 / §6.2 / §6.4
   / AC-10 replicate this.

3. **`.env.example` server-only note shape.** VERIFIED against the Razorpay block
   in `apps/api/.env.example`: "NEVER leaves the server"; "In production the app
   fails hard at startup if KEY_SECRET / WEBHOOK_SECRET are unset (mirrors the
   JWT_SECRET guard); in dev/test a mock/absent secret must not crash"; placeholder
   values only. The design's §6.5 Supabase Storage note mirrors it (server-only,
   never the anon key, prod fail-hard, placeholders).

4. **Encapsulated raw-body parser precedent.** VERIFIED against
   `apps/api/src/routes/razorpay-webhook.ts`:
   `app.addContentTypeParser("application/json", { parseAs: "buffer" }, …)` inside
   the plugin, with the explicit note that content-type parsers are encapsulated
   and do not affect the default JSON parser on other routes. The design's
   `application/octet-stream` raw-body `Buffer` parser + `bodyLimit` (D-1, §8) is
   the same proven pattern and adds NO new dependency (`@fastify/multipart` is
   correctly stated as not added).

5. **Append-only trigger idiom + INSERT-only RLS pair + guarded idempotent GRANT
   refresh.** VERIFIED against
   `…/20270124000000_phase9_service_requests/migration.sql`: `<table>_append_only()`
   plpgsql raising `restrict_violation` on `BEFORE UPDATE OR DELETE … FOR EACH
   ROW`; the `DO $$ … FOREACH` RLS loop with `mutable_tables`
   (`tenant_isolation_select` + `tenant_isolation_modify`) and
   `append_only_tables` (`tenant_isolation_select` + `<table>_tenant_insert`, no
   modify); the guarded idempotent `campass_app` GRANT refresh
   (`SELECT,INSERT,UPDATE` on mutable; `SELECT,INSERT` + explicit `REVOKE
   UPDATE,DELETE` on ledgers); `campass_app` never granted BYPASSRLS. The design's
   §13 g/h/i map onto this exactly (`mutable_tables` = the three mutable/guarded;
   `append_only_tables` = the two ledgers).

6. **Forward-only column guard idiom.** VERIFIED against
   `service_request_status_guard`: forbids DELETE unconditionally, freezes identity
   columns via `IS DISTINCT FROM`, enforces an enumerated legal-edge set plus the
   no-op self transition, raising `restrict_violation`. The design's
   `document_status_guard` (§12) is the same shape for
   `ACTIVE→ARCHIVED→PURGE_PENDING→PURGED` + `ARCHIVED→ACTIVE`, terminal `PURGED`.

7. **Composite same-tenant FK anchoring + MATCH SIMPLE for nullables; pointer
   column with no FK.** VERIFIED. The service-requests migration uses `FOREIGN KEY
   (institutionId, x) REFERENCES parent(institutionId, id)` with `MATCH SIMPLE` for
   nullable assignee/department columns, anchored by `(id, institutionId)` unique
   on parents; nullable recorded ids (`actorUserId`, `createdByUserId`) carry no
   FK. The design's §5 / §13 e (grant FK to `departments(institutionId, id)` MATCH
   SIMPLE; nullable `retentionPolicyId`/`granteeUserId`/`granteeDepartmentId` MATCH
   SIMPLE; `currentVersionId` plain-nullable-no-FK pointer to avoid a circular
   composite FK) match the precedent.

8. **`MODULE_DEPENDENCIES` foundational-not-gated precedent.** VERIFIED against
   `packages/shared/src/modules.ts`: every Phase-9 module
   (`faculty_management`, `hr_management`, `hostel`, `transport`, `inventory`,
   `service_requests`) is `[]` with the foundational-not-gated comment.
   `documents: []` (§14.1, AC-1) matches; `MODULE_KEY_SET` is derived from
   `MODULES`, so adding the `documents` entry auto-includes `"documents"`.

9. **catalogue-sync set-equality + `SEEDING_MIGRATION_DIRS` + seed ordering.**
   VERIFIED against `catalogue-sync.test.ts`: it unions the `permissions` keys and
   `role_permissions` (roleKey, permKey) pairs across `SEEDING_MIGRATION_DIRS`
   (parsing the permissions block between `INSERT INTO "permissions"` and `ON
   CONFLICT`, and the pairs between `INSERT INTO "role_permissions"` and `AS m(`),
   stripping SQL comments, and asserts EXACT set-equality against `PERMISSION_KEYS`
   / `ROLE_PERMISSIONS`, plus a no-dangling-key check. The service-requests seed
   confirms the role row is inserted BEFORE the permissions block (so its `, NULL)`
   tuple falls outside the sliced permission span) and the pairs are seeded via
   `VALUES (...) AS m("roleKey","permKey") JOIN "roles" … institutionId IS NULL`.
   §13.j specifies exactly this form. NOTE: the 26-pair seed + `ROLE_PERMISSIONS`
   additions + the new `SEEDING_MIGRATION_DIRS` entry must be transcribed in
   lockstep or the build fails — the design states this correctly.

10. **Migration dir name / next timestamp / 22 prior dirs / additive.** VERIFIED
    by listing `packages/db/prisma/migrations`: exactly 22 dirs, newest
    `20270124000000_phase9_service_requests`. Phase-9 dirs step by 7 days (…0110,
    0117, 0124), so `20270131000000_phase9_documents` (§13, AC-5) is the correct
    next weekly increment and sorts last. The lettered a–j house style is real
    (the service-requests migration opens with the a–j ordering comment).
    Additive-only (no DROP, prior dirs byte-untouched) matches the house rule.

11. **`StudentDocument` / `ApplicationDocument` untouched + separate.** VERIFIED:
    `model StudentDocument` at `schema.prisma:615` and `model ApplicationDocument`
    at `schema.prisma:2009` are distinct SIS/admissions tables. The design's six
    new tables add no FK/import/route coupling to them (§1, §18, AC-18). The design
    citations (`schema.prisma:615` / `:2009`) are accurate.

12. **`LIVE_DB_SUITES` extension pattern.** VERIFIED against
    `apps/api/vitest.live-db-suites.ts`: one glob per real-DB suite + the explicit
    "add your new real-DB suite here" rule, split out of the default fast run. The
    design's new `documents.behavioral.integration.test.ts` and gated
    `storage.smoke.integration.test.ts` (§16.2/§16.4, §19) follow it, and the
    gated smoke suite's `describe.skipIf(!SUPABASE_URL || !SERVICE_ROLE_KEY)` keeps
    the default + integration runs free of real network blob I/O.

13. **Staff role scoping (the datum finding A turned on).** VERIFIED against
    `ROLE_PERMISSIONS`: each additive staff template role (ACCOUNTANT, LIBRARIAN,
    WARDEN, HR_MANAGER, TRANSPORT_MANAGER, INVENTORY_MANAGER, SERVICE_AGENT) holds
    only its own module's keys, and `EMPLOYEE: ["hr.view_own"]` is narrowly scoped.
    This is precisely why finding A's option (a) — binding `documents.download` to
    EVERY non-applicant role — is the correct fix: the department-grant path is
    otherwise dead for these roles. The design now does this.

14. **audit-actions catalogue shape (no migration mirror).** VERIFIED against
    `packages/shared/src/audit-actions.ts`: entries are `{ key, module,
    description }` tuples, past-tense, grouped per module; there is no migration
    mirror (unlike permissions). The design's eleven `documents.*` audit keys
    (§14.4, AC-3) fit this shape; §14.4 lists exactly eleven and AC-3 says
    "eleven" — consistent (created, version.uploaded, download_url.minted,
    grant.created, grant.revoked, retention_policy.upserted, document.archived,
    document.unarchived, document.purge_requested, purged, report.exported).

---

## Unverified / Wrong Assumptions

1. **UNVERIFIABLE AT DESIGN TIME — Supabase Storage REST endpoint shapes (D-4,
   §6.2).** The design commits to specific REST paths (`POST
   /storage/v1/object/{bucket}/{key}` upload with `x-upsert:false`; `POST
   /storage/v1/object/sign/{bucket}/{key}` body `{expiresIn}` returning
   `signedURL`; `POST /storage/v1/object/upload/sign/{bucket}/{key}` for the signed
   upload; `DELETE /storage/v1/object/{bucket}/{key}`; `GET
   /storage/v1/object/info/{bucket}/{key}` for head). These are external to the
   repo and cannot be verified against any file here. They are plausible and match
   Supabase Storage's documented surface, and §16.4's gated smoke check is
   explicitly the place that proves them end-to-end, so this is NOT a blocker — but
   the implementer MUST confirm the exact paths, the auth header pairing
   (`Authorization: Bearer <serviceRoleKey>` AND `apikey: <serviceRoleKey>`), and
   the sign-response field name (`signedURL` vs `signedUrl`) against the live
   bucket before relying on them. (Unchanged from iteration 2; still not a
   blocker.)

No internally-inconsistent assumptions remain. The iteration-2 self-contradiction
("ANY same-tenant user / department member can mint" vs the three-role binding) is
resolved: the committed `documents.download` binding now covers every non-applicant
tenant role, matching the authorization rule and the ACs.

---

## Verdict

Prior open findings re-checked: A (MEDIUM) → **Closed**; B (NIT) → **Closed**.
All earlier findings (1–8, with 3 → A) are now resolved.

HIGH findings: 0
MEDIUM findings: 0
NIT findings: 0

MEDIUM + HIGH = 0 ⇒ **APPROVED**.

The revision resolves the last blocker cleanly by the reviewer's preferred option:
`documents.download` is promoted to a genuine baseline-reachability key held by
every non-applicant tenant role (14 existing + DOCUMENT_MANAGER), so the coarse
gate is a true no-op and the record-level `canAccessDocument` check is the sole
real visibility gate — making the department-grant path (incl. the brief's "all of
Finance" ACCOUNTANT case) reachable while preserving not-public-by-default (a
download-key holder with no grant still gets 404). The seed arithmetic (26 pairs),
the §16.2 test seeds (STUDENT user-grantee, ACCOUNTANT department-member, APPLICANT
403), and every cited section are consistent.

All structural house-pattern claims are VERIFIED true against the repo: the
injectable `ObjectStore` seam mirrors `razorpay.ts` exactly; the server-only
prod-guarded secret handling mirrors the Razorpay/JWT_SECRET pattern; the
append-only trigger + INSERT-only RLS pair + forward-only column guard + guarded
idempotent GRANT refresh mirror the service-requests migration; the next migration
timestamp (`20270131000000_phase9_documents`) is the correct +7d increment over 22
untouched prior dirs; the dependency-free raw-body transport mirrors
`razorpay-webhook.ts`; `exceljs` is already a dependency; `MODULE_DEPENDENCIES`
foundational-not-gated `[]` matches every Phase-9 module; catalogue-sync
set-equality + seed ordering is honored; and `StudentDocument` /
`ApplicationDocument` are separate and untouched.

The only remaining item is an implementation-time confirmation of the external
Supabase Storage REST surface, which the design correctly routes to the gated
smoke check and is not a blocker.
