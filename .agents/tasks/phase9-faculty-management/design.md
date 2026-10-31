# CAMPASS Phase 9.1 — Faculty Management (backend only) — Requirements + Technical Design

Status: REVISION 1 — addresses design-review `CHANGES_REQUESTED` (1 HIGH, 3 MEDIUM, 5 NIT) from `design-review.json` / `design-review.md`. All nine findings resolved; responses recorded at the end of this document.
Base: HEAD `b5ceb94` on `origin/main` (Phase 8 complete + exams student-read hardening). Work directly on `main` in `c:\campusgate`. No push/deploy (orchestrator pushes after independent verification).

---

## PART A — REQUIREMENTS

### A.1 Summary

Faculty Management is the FIRST module of Phase 9 (Institutional operations). It is a **gated ("booster") module** layered on the shared foundation. It adds **academic** domain records that REFERENCE the single authoritative faculty identity (`FacultyProfile`, `packages/db/prisma/schema.prisma` `@@map("faculty_profiles")`) and the existing academic teaching assignments (`FacultyAssignment`, `@@map("faculty_assignments")`) — it never duplicates them. Scope: qualifications, workload (per academic term), teaching history (immutable ledger), and a consolidated faculty directory/profile read. It is strictly DISTINCT from HR (Phase 9.2 — contracts/leave/payroll/employee-attendance). No cross-module coupling (no auto-posting to fees/exams/etc.).

### A.2 Functional Requirements

1. **Qualifications.** Staff can create, update, and list `FacultyQualification` records for a faculty member: degree/certification name, issuing institution/board, field, year, and an OPTIONAL metadata string/URL document reference (NO file blobs — Document Management owns storage later). Tenant-owned, composite FK to `FacultyProfile`. Editable-with-audit.
2. **Workload.** The system persists a `FacultyWorkload` record per `(facultyId, academicTermId)` capturing allocated teaching hours (derived/reconciled from `FacultyAssignment` rows + `Subject.contactHoursPerWeek`) plus non-teaching hours (admin/research), a computed total, and validation against a configurable per-institution workload-policy max. Staff can create/update/recompute/list; over-allocation past the max is rejected unless explicitly overridden by staff with a recorded reason.
3. **Teaching History.** The system maintains an **append-only** `FacultyTeachingHistory` ledger capturing a faculty member's assignments over time (subject/section/term/role, start/end, lifecycle event) so the historical teaching record is queryable across terms even after `FacultyAssignment` rows are mutated or ended. History rows are written by the Faculty Management service on assignment lifecycle events (see A.3 assumption + Design §6).
4. **Faculty directory / profile extension.** Staff-scoped read endpoints return a faculty member's consolidated profile: identity from `FacultyProfile` + qualifications + current-term workload + teaching history. Additive-only `FacultyProfile` fields may be added if needed (Design §7 decides none are strictly required; `designation`/`joiningDate` are proposed as additive-nullable and gated behind the open question OQ-3).
5. **Self-service.** A faculty member (FACULTY role) can view their OWN consolidated profile, workload, and teaching history via a self-service permission key.
6. **RBAC + routes.** New routes under `/api/faculty`, each carrying `requireModuleActive("faculty_management")` + `requirePermission(...)`. Management keys bound to ADMIN + HOD; self-service key bound to FACULTY.
7. **Module registry.** A new module key `faculty_management` added to `MODULES` and `MODULE_DEPENDENCIES` (`packages/shared/src/modules.ts`).
8. **Audit.** Every mutation writes a `faculty_management.*` audit event via `recordAuditEvent` in the same transaction; deny branches record a DENIED audit then return the 4xx.

### A.3 Assumptions (explicit)

- **Teaching-history write path.** Written on BOTH assign and end lifecycle events, via a dedicated Faculty Management service function the assignment-mutating path calls. Because Phase 3 `classes` already owns assignment creation (`classes.faculty.assign`) and that code is NOT re-authored here, Phase 9.1 provides a **reconcile/backfill + forward-capture** write path: a `POST /api/faculty/:facultyId/teaching-history/reconcile` staff action snapshots current+ended assignments into the ledger, and Faculty Management's own assignment-touch endpoints (if any are added) append on write. See Design §6 and OQ-1.
- **Workload max semantics.** Default policy max is a per-institution configurable weekly-hours ceiling; exact default value and whether it is hard-blocking vs override-with-reason is flagged as OQ-2.
- **Permission-key prefix.** `faculty.*` is chosen as the single verbatim prefix for permissions and audit keys (rationale in Design §8).

### A.4 Non-Functional Requirements

- Multi-tenancy A2: `institutionId` + composite FKs on every new table; ENABLE+FORCE RLS with nullif-guarded fail-closed policies; `campass_app` stays NOSUPERUSER NOBYPASSRLS. All tenant reads/writes via `withTenant`.
- Migration workflow: hand-authored lettered a–j migration, no `prisma migrate dev`. Rule (not a bare count): **every pre-existing migration directory stays byte-identical** — currently 16 = the 15 the `20261213000000_phase8_exams_slice2` header names as frozen plus slice-2 itself (now also frozen). The new dir only ADDs files; it touches none of them.
- Fast suite (`npm test -w @campusgate/api`, currently 497) stays fully green; new live-DB behavioral suite added to `apps/api/vitest.live-db-suites.ts` and passes in isolation.
- Tenant-escape suite extended to cover every new table.

### A.5 Acceptance Criteria (testable, numbered)

1. `MODULES` in `packages/shared/src/modules.ts` contains `{ key: "faculty_management", name: "Faculty Management", description: ... }` and `MODULE_DEPENDENCIES.faculty_management === []`; module-system + catalogue-sync tests pass.
2. `prisma migrate status` reports up to date after `prisma migrate deploy` of the new dir; `prisma migrate diff --from-schema-datasource` shows only the long-standing composite-vs-single-FK cosmetic diff — NO DROP on existing tables.
3. Every new table has ENABLE+FORCE RLS, the correct policy set (standard modify pair, or append-only pair for the history table), and a `campass_app` GRANT; the tenant-escape meta-test (`RLS_TABLES`/`EXPECTED_POLICIES`) covers each.
4. `catalogue-sync.test.ts` passes with EXACT set-equality: the new `faculty.*` permission keys exist in both `ROLE_PERMISSIONS` (`packages/shared/src/permissions.ts`) and the migration's `permissions`/`role_permissions` spans. This requires a hand edit to the test file: the new dir string `"20261220000000_phase9_faculty_management"` MUST be appended to the **hardcoded `SEEDING_MIGRATION_DIRS` array** in `catalogue-sync.test.ts` (it ends today at `"20261213000000_phase8_exams_slice2"`; the array is NOT auto-discovered, so an un-appended dir leaves the new keys in `PERMISSION_KEYS` but absent from every parsed migration → set-equality FAILS). The migration's two seed blocks MUST follow the exact parser shapes in §B.3(j) (permissions block first, ending at the first `ON CONFLICT`; role_permissions block second, in the `FROM (VALUES …) AS m("roleKey","permKey")` form).
5. A `POST /api/faculty/:facultyId/qualifications` by ADMIN/HOD creates a qualification and writes `faculty.qualification.created`; a FACULTY caller is 403.
6. `FacultyWorkload` create/update rejects an allocation whose total exceeds the institution workload-policy max (unless overridden with reason) and writes the appropriate audit key.
7. An UPDATE or DELETE against `faculty_teaching_history` (even via the admin RLS-bypass client) raises `restrict_violation` (`...is append-only`).
8. A FACULTY caller reading `GET /api/faculty/me/profile` sees only their own consolidated profile; reading another faculty's `/api/faculty/:id/...` staff route without a management key is 403.
9. Cross-tenant reads/spoofed writes/foreign-parent inserts against every new table are denied in `tenant-escape.integration.test.ts`.
10. The new live-DB behavioral suite is listed in `vitest.live-db-suites.ts` and passes in isolation.

### A.6 Out of Scope

- HR concerns: contracts, leave, payroll, employee-attendance, designations-as-employment (Phase 9.2).
- File/blob storage of qualification documents (Document Management module later — store metadata string/URL only).
- Creating/mutating `FacultyProfile` identity or `FacultyAssignment` academic-assignment lifecycle (owned by Phase 3 `classes` + admin user flows); Faculty Management references and aggregates them.
- Any auto-posting or cross-module side effects into fees/exams/attendance.
- Frontend / UI.

---

## PART B — TECHNICAL DESIGN

### B.0 Overview

Faculty Management adds four tenant-owned tables anchored on the existing `faculty_profiles(id, institutionId)` composite unique: `faculty_qualifications` (mutable, standard RLS pair + guarded-audit at the service layer), `faculty_workloads` (mutable, standard RLS pair, column-guard-free but recompute-audited), `faculty_workload_policies` (mutable per-institution config, standard pair), and `faculty_teaching_history` (strictly append-only — the immutable ledger, append-only RLS pair + unconditional-raise trigger). It wires one new gated module key, a `faculty.*` permission/audit family, and `/api/faculty` routes. The technology stack is **locked**: TypeScript + Fastify (`apps/api`), Prisma Client on PostgreSQL/Supabase (`packages/db`), Zod validation + the shared catalogues (`packages/shared`), ExcelJS only if an export is added (none in this slice). Every pattern below mirrors a named real file.

### B.1 Module-registry addition

Edit `packages/shared/src/modules.ts`:

- Append to `MODULES` (after `admissions`):
  ```ts
  { key: "faculty_management", name: "Faculty Management", description: "Academic faculty records — qualifications, workload, teaching history (Phase 9)" },
  ```
- Add to `MODULE_DEPENDENCIES`:
  ```ts
  // faculty_management is foundational-not-gated (the attendance/fees/admissions
  // precedent): only its own row must be ENTITLED->ACTIVE. Its real prerequisites
  // (FacultyProfile / User / Department) are FOUNDATIONAL data with NO ACTIVE
  // InstitutionModule row — a gated-module edge would PERMANENTLY block activation.
  // Those prerequisites are validated at operation time via composite FKs +
  // in-handler lookups, not by a gated-module activation edge.
  faculty_management: [],
  ```

**Rationale for `[]`:** `faculty_management` is foundational-not-gated, identical to the documented rule applied to **`attendance`, `fees`, and `admissions` — all three are `[]`** in this same file (verified: `packages/shared/src/modules.ts` `MODULE_DEPENDENCIES` carries the inline foundational-not-gated comment on each). `FacultyProfile`/`User`/`Department` are foundational data, not gated modules; they never carry an ACTIVE `InstitutionModule` row, so any dependency edge pointing at a would-be "faculty foundation module" would make `faculty_management` un-activatable.

**Counter-example, acknowledged (not a universal `[]` rule):** `examinations` in the SAME file has a NON-empty edge — `examinations: ["academic_sessions", "class_course", "student_enrollment"]` — and that is correct precisely BECAUSE its prerequisites ARE themselves gated modules that carry ACTIVE `InstitutionModule` rows. The distinguishing test is not "always `[]`" but "is the prerequisite a gated module?": if yes (exams' case) the edge is real and gated; if no — the prerequisite is foundational non-module data (faculty_management's case: FacultyProfile/User/Department) — the edge MUST be omitted or it permanently blocks activation. Do NOT read this rationale as license to change `examinations`; its edge is correct and frozen.

Prerequisite existence for `faculty_management` is enforced at operation time via composite FKs + in-handler `findFirst` lookups. Adding the key is additive; the module-system catalogue-sync + integration tests assert the registry and continue to pass.

### B.2 New Prisma models / tables

All four tables follow the A2 invariants proven across Phases 1–8: `institutionId` column, `@@unique([id, institutionId])` composite anchor, `@@index([institutionId])`, composite same-tenant FKs carrying `institutionId`, ENABLE+FORCE RLS, `campass_app` GRANT. Added to `packages/db/prisma/schema.prisma` and relation back-refs added to `FacultyProfile` (additive relation fields only — see §7).

#### B.2.1 `FacultyQualification` → `faculty_qualifications` (mutable, editable-with-audit)

```prisma
model FacultyQualification {
  id            String         @id @default(cuid())
  institutionId String
  institution   Institution    @relation(fields: [institutionId], references: [id])
  facultyId     String
  faculty       FacultyProfile @relation(fields: [facultyId], references: [id])
  kind          FacultyQualificationKind @default(DEGREE)
  title         String         // e.g. "M.Tech Computer Science"
  issuingBody   String?        // institution / board / university
  field         String?        // field of study / specialization
  year          Int?           // year awarded
  documentRef   String?        // metadata string/URL only — NO blob (Document Mgmt owns storage later)
  createdByUserId String       // recorded actor id, NO FK (the 8.1 createdByUserId precedent)
  createdAt     DateTime       @default(now())
  updatedAt     DateTime       @updatedAt

  @@unique([id, institutionId])
  @@index([institutionId])
  @@index([institutionId, facultyId])
  @@map("faculty_qualifications")
}

enum FacultyQualificationKind {
  DEGREE
  CERTIFICATION
  DIPLOMA
  OTHER
}
```
RLS: standard pair `{tenant_isolation_select, tenant_isolation_modify}`. Mutable; immutability is NOT enforced (legitimately editable); all edits audited at the service layer. GRANT `SELECT, INSERT, UPDATE, DELETE` (delete used for staff removal of an erroneous record — audited `faculty.qualification.deleted`).

#### B.2.2 `FacultyWorkloadPolicy` → `faculty_workload_policies` (mutable per-institution config)

One configurable row per institution (optionally per term — see OQ-2). Holds the workload-policy max.

```prisma
model FacultyWorkloadPolicy {
  id               String      @id @default(cuid())
  institutionId    String
  institution      Institution @relation(fields: [institutionId], references: [id])
  maxWeeklyHours   Int         // workload-policy max (teaching + non-teaching), per week
  updatedByUserId  String
  createdAt        DateTime    @default(now())
  updatedAt        DateTime    @updatedAt

  @@unique([institutionId])          // one policy per institution — DELIBERATE this-slice commitment (see note below), not a placeholder
  @@unique([id, institutionId])
  @@index([institutionId])
  @@map("faculty_workload_policies")
}
```
RLS: standard pair. GRANT `SELECT, INSERT, UPDATE` (no DELETE — config is upserted). Audited `faculty.workload_policy.updated`.

**`@@unique([institutionId])` is a deliberate this-slice commitment (resolves F9).** It fixes the policy at one row per institution NOW. If OQ-2 later resolves to a per-term or per-designation cap, widening it requires DROPPING and RECREATING this unique (and the business unique) — a **non-additive** schema change that contradicts this module's strictly-additive migration posture. That widening is therefore explicitly deferred with OQ-2 and must ship as its own later slice with its own migration; the narrow unique here is a conscious commitment, not a temporary placeholder the next slice can silently relax.

#### B.2.3 `FacultyWorkload` → `faculty_workloads` (mutable, recompute-audited)

Persisted record per `(facultyId, academicTermId)` (WORKLOAD MODEL DECISION — see §4).

```prisma
model FacultyWorkload {
  id                   String         @id @default(cuid())
  institutionId        String
  institution          Institution    @relation(fields: [institutionId], references: [id])
  facultyId            String
  faculty              FacultyProfile @relation(fields: [facultyId], references: [id])
  academicTermId       String
  academicTerm         AcademicTerm   @relation(fields: [academicTermId], references: [id])
  teachingHours        Int            // derived from ACTIVE FacultyAssignment + Subject.contactHoursPerWeek
  nonTeachingHours     Int            @default(0) // admin/research etc. (staff-entered)
  totalHours           Int            // computed = teaching + nonTeaching (persisted for query + audit)
  overAllocated        Boolean        @default(false) // total > policy max
  overrideReason       String?        // set when staff deliberately exceed the max
  lastReconciledAt     DateTime?      // when teachingHours was last derived from assignments
  updatedByUserId      String
  createdAt            DateTime       @default(now())
  updatedAt            DateTime       @updatedAt

  @@unique([institutionId, facultyId, academicTermId]) // one workload row per faculty per term
  @@unique([id, institutionId])
  @@index([institutionId])
  @@index([institutionId, facultyId])
  @@index([institutionId, academicTermId])
  @@map("faculty_workloads")
}
```
RLS: standard pair. GRANT `SELECT, INSERT, UPDATE` (no hard DELETE — a workload row for a term is retained). A DB `CHECK (totalHours = teachingHours + nonTeachingHours)` and `CHECK (teachingHours >= 0 AND nonTeachingHours >= 0)` back the service invariant (the 8.x CHECK precedent). Over-allocation semantics in §4.

#### B.2.4 `FacultyTeachingHistory` → `faculty_teaching_history` (STRICTLY append-only ledger)

```prisma
model FacultyTeachingHistory {
  id             String         @id @default(cuid())
  institutionId  String
  institution    Institution    @relation(fields: [institutionId], references: [id])
  facultyId      String
  faculty        FacultyProfile @relation(fields: [facultyId], references: [id])
  subjectId      String
  subject        Subject        @relation(fields: [subjectId], references: [id])
  classSectionId String?
  classSection   ClassSection?  @relation(fields: [classSectionId], references: [id])
  academicTermId String
  academicTerm   AcademicTerm   @relation(fields: [academicTermId], references: [id])
  sourceAssignmentId String?    // recorded id of the FacultyAssignment this row snapshots, NO FK (assignment is mutable; cycle/mutation-decoupling — the reeval outcomePublicationId precedent)
  role           FacultyAssignmentRole
  changeType     FacultyTeachingHistoryChangeType // ASSIGNED | ENDED
  effectiveAt    DateTime       // assignedAt (ASSIGNED) or endedAt (ENDED)
  recordedByUserId String
  createdAt      DateTime       @default(now())

  @@unique([id, institutionId])
  @@index([institutionId])
  @@index([institutionId, facultyId])
  @@index([institutionId, facultyId, academicTermId])
  @@map("faculty_teaching_history")
}

enum FacultyTeachingHistoryChangeType {
  ASSIGNED
  ENDED
}
```
Note: NO `updatedAt` (append-only class — mirrors `marks_record_history` / `result_snapshots` which have `createdAt` only). RLS: append-only pair `{tenant_isolation_select, faculty_teaching_history_tenant_insert}` with NO modify policy. Trigger idiom in §6.

### B.3 Migration (hand-authored, lettered a–j)

New dir: `packages/db/prisma/migrations/20261220000000_phase9_faculty_management/migration.sql`. Mirrors the frozen house style of the newest reference `20261213000000_phase8_exams_slice2` (and the strictly-additive `20261206000000_phase8_exams_slice1` for the append-only idioms). **Strictly additive** — only CREATEs new objects + one additive catalogue seed + (conditionally, per OQ-3) two additive-nullable `ALTER TABLE "faculty_profiles" ADD COLUMN`. It NEVER edits any pre-existing migration directory (the rule, not a bare number: every prior dir stays byte-identical — currently 16 = the 15 named as frozen in the slice-2 header plus slice-2 itself), never touches `_prisma_migrations`, and `campass_app` stays NOSUPERUSER NOBYPASSRLS.

Section ordering (mirrors exams slice-1/slice-2):
- **a.** `CREATE TYPE` the three new enums: `FacultyQualificationKind`, `FacultyTeachingHistoryChangeType` (no new workload enum needed).
- **b.** `CREATE TABLE` the four tables + PKs. `faculty_teaching_history` has `createdAt` only (append-only class); the three mutable tables carry `updatedAt TIMESTAMP(3) NOT NULL`.
- **c.** `(id, institutionId)` unique + `(institutionId)`/query indexes + the business uniques (`faculty_workloads` `(institutionId, facultyId, academicTermId)`, `faculty_workload_policies` `(institutionId)`).
- **d.** tenant-root `institutionId -> institutions(id)` RESTRICT on all four.
- **e.** composite same-tenant FKs (each carries `institutionId`): qualification/workload/history → `faculty_profiles(institutionId, id)`; workload/history → `academic_terms(institutionId, id)`; history → `subjects(institutionId, id)` + nullable `class_sections(institutionId, id)`. All `ON DELETE RESTRICT ON UPDATE CASCADE`.
- **f.** CHECKs: `faculty_workloads` `totalHours = teachingHours + nonTeachingHours`, non-negative hours; `faculty_workload_policies` `maxWeeklyHours > 0`; `faculty_qualifications` `char_length(title) >= 1`.
- **g.** ENABLE+FORCE RLS. The three mutable tables get the standard fail-closed nullif-guarded pair `{tenant_isolation_select, tenant_isolation_modify}`; `faculty_teaching_history` gets the append-only pair `{tenant_isolation_select, faculty_teaching_history_tenant_insert}` (SELECT + INSERT-only, NO modify) — the `marks_record_history` precedent. All policies use `nullif(current_setting('app.current_institution_id', true), '')`.
- **h.** Trigger: `faculty_teaching_history_append_only()` + `BEFORE UPDATE OR DELETE` trigger (unconditional raise). The three mutable tables carry NO trigger (legitimately editable; immutability is not an invariant there). Idiom mirrored verbatim from `marks_record_history_append_only()` in `20261206000000_phase8_exams_slice1/migration.sql` (§6).
- **i.** guarded + idempotent `campass_app` GRANT refresh. Mutable tables: `SELECT, INSERT, UPDATE` (+ `DELETE` on `faculty_qualifications`). `faculty_teaching_history`: `SELECT, INSERT` only (the append-only INSERT-only GRANT — `marks_record_history` precedent). Never BYPASSRLS.
- **j.** Catalogue seed — **EXACT shapes the `catalogue-sync.test.ts` parser requires** (prescriptive; the parser is brittle in two ways I verified by reading the test). The parser's `slice(sql, start, end)` throws `end marker not found` if the end marker is absent, and both extractors key off the FIRST occurrence of their end marker:
  1. **Permissions block FIRST.** `extractPermissionKeys` slices from `INSERT INTO "permissions"` to the **first `ON CONFLICT`** after it and treats every `('…','KEY',` tuple in that span as a permission row. Therefore the permissions INSERT MUST come before the role_permissions INSERT, MUST be the single form
     ```sql
     INSERT INTO "permissions" ("id","key","module","description") VALUES
       ('<cuid>','faculty.qualifications.manage','faculty_management','...'),
       ... (all 5 faculty.* keys) ...
     ON CONFLICT ("key") DO NOTHING;
     ```
     and MUST contain NO earlier `ON CONFLICT` between the `INSERT INTO "permissions"` marker and the real end of its VALUES list (the first `ON CONFLICT` is the hard end-marker). Each row's 2nd single-quoted literal is the key the parser reads.
  2. **role_permissions block SECOND, in the `FROM (VALUES …) AS m(…)` form — mandatory.** `extractRolePermissionPairs` slices from `INSERT INTO "role_permissions"` to the **first `AS m(`** and matches every `('X','Y')` pair in that span (SQL comments stripped first). The INSERT therefore MUST use the join-over-VALUES form so the `AS m(` end-marker exists, or `slice()` throws:
     ```sql
     INSERT INTO "role_permissions" ("id","roleId","permissionId")
     SELECT gen_random_uuid(), r."id", p."id"
     FROM (VALUES
       ('ADMIN','faculty.qualifications.manage'),
       ('ADMIN','faculty.workload.manage'),
       ... (every ADMIN/HOD/FACULTY → faculty.* pair from §B.8) ...
     ) AS m("roleKey","permKey")
     JOIN "roles" r ON r."key" = m."roleKey"
     JOIN "permissions" p ON p."key" = m."permKey"
     ON CONFLICT DO NOTHING;
     ```
     The `('ROLE','key')` pair tuples MUST appear BEFORE the `AS m(` token (they do, inside `(VALUES …)`), and the `faculty.view_own → FACULTY` self-service pair is included here. A plain `VALUES … ON CONFLICT` form (no `AS m(`) is FORBIDDEN — it makes the end-marker unfindable.
- **k (conditional, OQ-3).** Additive `ALTER TABLE "faculty_profiles" ADD COLUMN "designation" TEXT; ADD COLUMN "joiningDate" TIMESTAMP(3);` — nullable, no rewrite, no DROP, no trigger. Only if OQ-3 resolves to add fields.

After authoring: `prisma migrate diff --from-schema-datasource` (expect only the long-standing composite-vs-single-FK cosmetic diff, NO DROP on existing tables), then `prisma migrate deploy`, then `prisma migrate status` must say up to date. NEVER `prisma migrate dev`.

### B.4 WORKLOAD MODEL DECISION — Option (a), persisted record

**Chosen: Option (a)** — a persisted `FacultyWorkload` record per `(faculty, academicTerm)` with allocated teaching hours + non-teaching hours + computed total, a configurable per-institution workload-policy max (`faculty_workload_policies.maxWeeklyHours`), and over-allocation validation.

**Rationale.** Option (b) (pure read/aggregation over `FacultyAssignment` + a non-teaching table) cannot represent an approved/reconciled snapshot, cannot record an explicit over-allocation override + reason, and cannot cheaply answer "what was this faculty's sanctioned load last term" without re-deriving from mutable assignments. A persisted, audited record adds real value: it is the staff-approvable artifact, it carries the override decision, and it is stable against later assignment mutation. The teaching-hours figure is still DERIVED (not hand-typed) so it stays truthful.

**Teaching-hours derivation (counting unit + role handling — specified, not left open).** `teachingHours` is computed in the service by summing `Subject.contactHoursPerWeek` (field confirmed present: `subjects.contactHoursPerWeek Int?`) over the faculty's ACTIVE `FacultyAssignment` rows for that term (reusing the `attendance-authz.ts` ACTIVE-faculty + ACTIVE-assignment scoping idiom — see §5), with these EXACT rules:

- **Counting unit = one row per DISTINCT `(subjectId, classSectionId)` ACTIVE assignment, counting each section separately.** The real schema permits multiple ACTIVE `FacultyAssignment` rows for the same `(facultyId, subjectId, academicTermId)` differing only by `classSectionId` — this is proven by `assertFacultyAssigned` in `apps/api/src/services/attendance-authz.ts`, which matches `OR: [{ classSectionId }, { classSectionId: null }]`, so section-specific and section-less assignments legitimately coexist. Teaching the same subject to two sections IS two teaching loads, so each distinct `(subjectId, classSectionId)` row contributes its subject's `contactHoursPerWeek` once. A section-less assignment (`classSectionId = null`) counts as one `(subjectId, null)` unit. (The `DISTINCT` guard only collapses exact `(subjectId, classSectionId)` duplicate rows, which the business uniques should already prevent; it is a defensive de-dup, not a merge of different sections.)
- **Role handling: only `role = PRIMARY` counts toward sanctioned teaching load; `SUBSTITUTE` and `ASSISTANT` are EXCLUDED.** The real `FacultyAssignmentRole` enum has THREE values (`PRIMARY`, `SUBSTITUTE`, `ASSISTANT` — confirmed in `schema.prisma`). A SUBSTITUTE covering a class and an ASSISTANT supporting a primary instructor do not each carry the subject's full sanctioned contact load, so summing them would overstate the figure. Excluded assignments are surfaced separately as `excludedAssignmentIds` (with their role) in the response so staff can see what was omitted and why. If a later slice needs sanctioned-load rules for SUBSTITUTE/ASSISTANT (e.g. fractional weighting), that is deferred as OQ-5 — this slice counts PRIMARY only.
- **Null contact hours.** An included (PRIMARY) assignment whose `Subject.contactHoursPerWeek` is null contributes 0 and its `subjectId` is surfaced in the response as `unestimatedSubjectIds` so staff know the figure is partial.

`nonTeachingHours` is staff-entered. `totalHours = teachingHours + nonTeachingHours` (DB CHECK-backed).

**Over-allocation / policy-max semantics.** On create/update/recompute, the service reads `faculty_workload_policies.maxWeeklyHours` for the tenant (in-handler lookup; absence → treated as "no configured cap" → `overAllocated=false`, and a `faculty.workload.uncapped` note in the response — NOT a block). If `totalHours > maxWeeklyHours`: default behavior is **reject with 422** UNLESS the request carries `override: true` + a non-empty `overrideReason`, in which case the row is written with `overAllocated=true` + the reason and an audit event `faculty.workload.overallocated`. (Hard-block-vs-override default and whether the cap is per-term is OQ-2.)

### B.5 TEACHING-HISTORY write path

**Written on BOTH assign and end** (`changeType ASSIGNED` at assign time, `ENDED` at end time), via a single Faculty Management service function `appendTeachingHistory(tx, {facultyId, assignment, changeType})`, always inside the request `withTenant` transaction.

Because Phase 3 `classes` owns `FacultyAssignment` creation/ending (`classes.faculty.assign`) and that code is NOT re-authored in this slice, Phase 9.1 captures history via:

1. **Reconcile endpoint (primary path this slice):** `POST /api/faculty/:facultyId/teaching-history/reconcile` (staff, `faculty.teaching_history.manage`). The service reads the faculty's `FacultyAssignment` rows for the tenant, and for each one that is not already represented in the ledger, appends an `ASSIGNED` row (`effectiveAt = assignment.assignedAt`); for each ENDED assignment (`status = ENDED` / `endedAt` set) not yet represented as `ENDED`, appends an `ENDED` row (`effectiveAt = assignment.endedAt`). Idempotent: dedup is on `(facultyId, sourceAssignmentId, changeType)` checked before insert (the ledger has no unique on that tuple by design — append-only — so dedup is a service-layer pre-check, mirroring the reeval idempotent-backfill style). `sourceAssignmentId` records the assignment id with NO FK (the assignment is mutable; decoupling mirrors `reeval_requests.outcomePublicationId`).
2. **Forward capture:** if Faculty Management later gains its own assignment-touch endpoints, they call `appendTeachingHistory` on write. Not in this slice (no assignment mutation here — see Out of Scope).

This keeps the ledger truthful without forking Phase 3 assignment ownership. Cross-term queryability is served from the ledger directly. (Whether reconcile should also be invoked opportunistically from the directory read is OQ-1.)

**Append-only trigger idiom** — mirrored verbatim from `marks_record_history_append_only()` in `packages/db/prisma/migrations/20261206000000_phase8_exams_slice1/migration.sql`:

```sql
CREATE OR REPLACE FUNCTION "faculty_teaching_history_append_only"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'faculty_teaching_history is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "faculty_teaching_history_no_update_delete"
  BEFORE UPDATE OR DELETE ON "faculty_teaching_history"
  FOR EACH ROW EXECUTE FUNCTION "faculty_teaching_history_append_only"();
```
The service reuses the `isRestrictViolation(err)` detector idiom from `apps/api/src/routes/exams.ts` (matches `restrict_violation` / `illegal` / `append-only` in the raw error message) but maps this backstop to **`500 { error: "append-only violation" }`** — NOT the 409 the exams routes return. This is a deliberate divergence: in `exams.ts` the `restrict_violation` 409 signals an illegal-but-reachable status transition the caller could retry correctly, whereas here NO legal UPDATE/DELETE path to `faculty_teaching_history` exists at all, so hitting the trigger means a code defect, which is a 500 (logged at ERROR). §B.10 states the same 500.

### B.6 FacultyProfile field additions (additive) + Phase-3-invariant safety

**Decision: NONE are strictly required for this slice.** The consolidated directory read composes identity from the EXISTING `FacultyProfile` columns (`name`, `departmentId`, `status`, timestamps) plus the three new tables. `designation` and `joiningDate` are the only candidates and both lean toward HR; to keep the Faculty/HR boundary clean (§9) they are deferred and flagged as OQ-3.

If OQ-3 resolves to add them, they are added **additively** via migration section (k): `ADD COLUMN "designation" TEXT NULL; ADD COLUMN "joiningDate" TIMESTAMP(3) NULL;` — nullable, defaulted-absent, no table rewrite, no DROP, no new trigger on `faculty_profiles`. **Phase-3-invariant safety:** `faculty_profiles` carries no append-only/column-guard trigger today, the `userId @unique` one-profile-per-user invariant and the `(id, institutionId)` anchor are untouched, and existing faculty tests read specific columns (not `SELECT *` assertions on the full column set), so nullable additive columns cannot break them. The additive-column pattern is exactly the proven FEAT-003 `student_profiles` generalization (`status` + nullable session/term/program links added additively) and exams slice-2 `examinations.parentExaminationId`.

### B.7 FACULTY / HR BOUNDARY

**Faculty Management (9.1) = academic.** Qualifications, per-term teaching + non-teaching workload, teaching history, and the academic consolidated-profile read. It references `FacultyProfile` identity and `FacultyAssignment` academic assignments; it never models employment.

**HR (9.2, next module) = employment.** Contracts, leave, payroll, employee-attendance, and employment attributes (employment type, salary, reporting line). If an employment-flavored attribute (e.g. `designation` as a contractual title, `joiningDate` as date-of-employment) is needed, it belongs to HR, which is why §6 defers them.

The boundary is enforced structurally: Faculty Management tables carry no money/contract/leave columns, and there is NO cross-module write (no auto-posting to fees/exams/HR). The two modules share only the foundational `FacultyProfile` identity via composite FK.

### B.8 Permission-key prefix (chosen verbatim) + catalogues

**Chosen prefix: `faculty.*`** (used verbatim for BOTH permissions and audit keys). Rationale: the established precedent is that the permission/audit KEY prefix tracks the DOMAIN name, not the module registry key, and may be shorter (exams: module key `examinations`, key prefix `exams.*`; fees: key prefix `fees.*`). `faculty.*` is the natural domain prefix, is shorter/cleaner than `faculty_management.*`, and does not collide with any existing key family. The MODULE registry key remains `faculty_management` (snake, matches `student_management`/`campus_movement`), gating is `requireModuleActive("faculty_management")`, and permission/audit keys are `faculty.*`.

**New permission keys** (added to `PERMISSIONS` in `packages/shared/src/permissions.ts`, `module: "faculty_management"`, and to `ROLE_PERMISSIONS`):

| key | description |
|---|---|
| `faculty.qualifications.manage` | Create/update/delete + list faculty qualifications (staff) |
| `faculty.workload.manage` | Create/update/recompute workload + manage workload policy (staff) |
| `faculty.teaching_history.manage` | Reconcile/append + read teaching history (staff) |
| `faculty.directory.view` | Read any faculty member's consolidated academic profile (staff) |
| `faculty.view_own` | Faculty self-service read of OWN profile/workload/history/qualifications |

**ROLE_PERMISSIONS additions:**
- `ADMIN`: + `faculty.qualifications.manage`, `faculty.workload.manage`, `faculty.teaching_history.manage`, `faculty.directory.view`.
- `HOD`: + `faculty.qualifications.manage`, `faculty.workload.manage`, `faculty.teaching_history.manage`, `faculty.directory.view`. (HOD owns academic supervision — the exams `exams.reeval.manage` ADMIN+HOD precedent. No new role invented; see §8 rationale below.)
- `FACULTY`: + `faculty.view_own`.

Separation of duties: FACULTY never gets any `.manage`/`.directory.view` staff key; staff roles never get `faculty.view_own` (it is the SELF scope, meaningless for non-faculty staff and kept STUDENT/own-style separate — the `exams.results.view_own` precedent).

**No new role.** The brief's HOD/coordinator need is satisfied by binding management keys to the existing ADMIN + HOD template roles (HOD = academic supervision), exactly as `exams.*` management binds to ADMIN+HOD. Inventing a faculty-coordinator role is unjustified here (no distinct duty-separation requirement), and the additive-role mechanism (ACCOUNTANT/LIBRARIAN/ADMISSION_OFFICER) is reserved for genuinely new personas. This is an explicit decision, revisitable if OQ-4 surfaces a real coordinator persona.

**New audit action keys** (added to `AUDIT_ACTIONS` in `packages/shared/src/audit-actions.ts`, `module: "examinations"`→ here `module: "faculty_management"`; NO migration mirror — audit keys are validated only in `recordAuditEvent`, confirmed by the file header):

`faculty.qualification.created`, `faculty.qualification.updated`, `faculty.qualification.deleted`, `faculty.workload.recomputed`, `faculty.workload.updated`, `faculty.workload.overallocated`, `faculty.workload_policy.updated`, `faculty.teaching_history.reconciled`.

### B.9 Routes + permission×route×role×audit-key matrix

Registered at `/api/faculty` (new `apps/api/src/routes/faculty.ts`, wired in `server.ts` like `examsRoutes`). House pattern mirrored from `exams.ts`: single top-level `authenticate` preHandler; per-route `[requirePermission(key), requireModuleActive("faculty_management")]`; every handler inside `withTenant(institutionId, tx => ...)` with `institutionId` from `request.user` (never input); every mutation writes a `faculty.*` audit in the same tx; deny branches record a DENIED audit then RETURN the 4xx (the `Deny`/`isDeny` idiom). Zod schemas added to `packages/shared`.

| # | Method + Route | Permission | Module gate | Roles (template) | Audit key(s) | Scope / notes |
|---|---|---|---|---|---|---|
| 1 | `POST /api/faculty/:facultyId/qualifications` | `faculty.qualifications.manage` | `faculty_management` | ADMIN, HOD | `faculty.qualification.created` | in-handler lookup asserts `FacultyProfile` exists in tenant |
| 2 | `PATCH /api/faculty/:facultyId/qualifications/:id` | `faculty.qualifications.manage` | `faculty_management` | ADMIN, HOD | `faculty.qualification.updated` | editable-with-audit |
| 3 | `DELETE /api/faculty/:facultyId/qualifications/:id` | `faculty.qualifications.manage` | `faculty_management` | ADMIN, HOD | `faculty.qualification.deleted` | staff removal of erroneous record |
| 4 | `GET /api/faculty/:facultyId/qualifications` | `faculty.directory.view` | `faculty_management` | ADMIN, HOD | — (read) | list |
| 5 | `PUT /api/faculty/workload-policy` | `faculty.workload.manage` | `faculty_management` | ADMIN, HOD | `faculty.workload_policy.updated` | upsert the one per-institution policy |
| 6 | `GET /api/faculty/workload-policy` | `faculty.workload.manage` | `faculty_management` | ADMIN, HOD | — (read) | |
| 7 | `POST /api/faculty/:facultyId/workload/:academicTermId/recompute` | `faculty.workload.manage` | `faculty_management` | ADMIN, HOD | `faculty.workload.recomputed` (+ `faculty.workload.overallocated` if over cap) | derives teachingHours from ACTIVE assignments + `Subject.contactHoursPerWeek` |
| 8 | `PATCH /api/faculty/:facultyId/workload/:academicTermId` | `faculty.workload.manage` | `faculty_management` | ADMIN, HOD | `faculty.workload.updated` (+ `faculty.workload.overallocated`) | set nonTeachingHours / override |
| 9 | `GET /api/faculty/:facultyId/workload` | `faculty.directory.view` | `faculty_management` | ADMIN, HOD | — (read) | all terms |
| 10 | `POST /api/faculty/:facultyId/teaching-history/reconcile` | `faculty.teaching_history.manage` | `faculty_management` | ADMIN, HOD | `faculty.teaching_history.reconciled` | append-only; idempotent (§6) |
| 11 | `GET /api/faculty/:facultyId/teaching-history` | `faculty.directory.view` | `faculty_management` | ADMIN, HOD | — (read) | cross-term ledger |
| 12 | `GET /api/faculty/:facultyId/profile` | `faculty.directory.view` | `faculty_management` | ADMIN, HOD | — (read) | consolidated: identity + qualifications + current-term workload (incl. read-only `policyMaxWeeklyHours`) + history |
| 13 | `GET /api/faculty/me/profile` | `faculty.view_own` | `faculty_management` | FACULTY | — (read) | SELF scope: resolves caller's ACTIVE `FacultyProfile` via the `attendance-authz.ts` `resolveMarkingFaculty` idiom; 403 if caller is not a faculty member; workload block includes read-only `policyMaxWeeklyHours` |

Self-service enforcement (routes 13): the handler resolves the caller's own `FacultyProfile` from `request.user.userId` inside `withTenant` (reusing `resolveMarkingFaculty(tx, institutionId, userId)` from `apps/api/src/services/attendance-authz.ts`), and NEVER accepts a `:facultyId` path param — so a FACULTY caller can only ever read their own record. This mirrors the `exams.results.view_own` self-scope precedent.

**Policy cap is surfaced read-only in both profile reads (resolves F2's `overAllocated`-is-uninterpretable gap).** Both `GET /:facultyId/profile` (route 12) and `GET /me/profile` (route 13) include, inside each workload entry of the payload, a read-only field `policyMaxWeeklyHours: number | null` — the institution's effective `faculty_workload_policies.maxWeeklyHours` (or `null` when no policy row is configured, i.e. uncapped). It is resolved server-side with a single in-handler lookup and requires NO extra permission (neither `faculty.workload.manage` nor a policy-read key): it is a derived read-only projection, not the editable policy view. This is what makes the co-located `overAllocated: boolean` flag interpretable for every reader — critically the self-service FACULTY caller, who has only `faculty.view_own` and no path to `GET /workload-policy`. The EDITABLE policy view (`GET /workload-policy`, route 6) stays on `faculty.workload.manage`; only the scalar cap is echoed into the profile payloads. The same `policyMaxWeeklyHours` scalar is included in the per-faculty `GET /:facultyId/workload` list (route 9) response so that `faculty.directory.view`-only readers can likewise interpret `overAllocated` without needing `faculty.workload.manage`.

### B.10 Error handling (concrete, per fallible operation)

- **Faculty not found / wrong tenant** (routes 1–12): in-handler `tx.facultyProfile.findFirst({ where: { id: facultyId, institutionId } })` → if null, record DENIED audit, return `404 { error: "faculty not found" }`. Recoverable (caller error). Logged at info.
- **Caller not a faculty member** (route 13): `resolveMarkingFaculty` returns null → `403 { error: "not a faculty member" }`. Recoverable. Logged at info.
- **Composite-FK violation** (foreign-tenant subject/section/term on reconcile or workload): Prisma P2003 / RLS WITH CHECK failure → return `409 { error: "cross-tenant or missing parent" }`. Recoverable. Logged at info; this is also the tenant-escape safety net.
- **Unique violation** (`faculty_workloads (institutionId, facultyId, academicTermId)` on duplicate create; `faculty_workload_policies (institutionId)` on duplicate insert): P2002 → the workload create path is an upsert/`updateMany`-guarded create so a race resolves to update; policy is an upsert. If a true unique collision surfaces, return `409 { error: "already exists" }`. Recoverable.
- **Qualification delete of a non-existent / cross-tenant record** (route 3): the delete uses `tx.facultyQualification.deleteMany({ where: { id, institutionId, facultyId } })` (scoped triply so a foreign-tenant or wrong-faculty id matches 0 rows under RLS). If the returned `count === 0`: record a DENIED audit and return `404 { error: "qualification not found" }` — NOT a silent 200. Recoverable (caller error). Logged at info. (`deleteMany` is used rather than `delete` precisely so a 0-row match is a count, not a Prisma P2025 throw.)
- **Over-allocation without override** (routes 7/8): `totalHours > maxWeeklyHours` and no `override` → record no write, return `422 { error: "workload exceeds policy max", maxWeeklyHours, totalHours }`. Recoverable. Logged at info.
- **Append-only trigger backstop** (`faculty_teaching_history` UPDATE/DELETE): never reached by a legal path (no UPDATE/DELETE route exists); if reached (bug), the `isRestrictViolation` detector reused from `exams.ts` maps it to `500 { error: "append-only violation" }`, logged at ERROR (indicates a code defect). Fatal/unrecoverable for the request. NOTE: this deliberately differs from the exams routes' 409 for `restrict_violation` — there the trigger backstops a reachable illegal status transition (retryable → 409); here there is no legal mutation path, so it is a server defect → 500. §B.5 states the same.
- **Module not active**: `requireModuleActive` returns `403 { error: "Module not active: faculty_management" }`; on state-read failure it fails CLOSED with `500` (existing `authz-engine.ts` behavior — unchanged).
- **Missing permission**: `requirePermission` returns `403` (existing behavior).
- **DB unreachable / unexpected**: handler lets the error propagate to Fastify's error handler → `500`; the `withTenant` tx rolls back so no partial write. Logged at ERROR.

### B.11 Input validation (per external input, Zod in `packages/shared`)

- `createFacultyQualificationSchema`: `title` required string min length 1 max 200; `kind` optional enum (default DEGREE); `issuingBody`/`field` optional string max 200; `year` optional int 1900..currentYear+1; `documentRef` optional string max 2048 (URL/metadata only — no upload). On failure → 400 from Fastify/Zod.
- `patchFacultyQualificationSchema`: all fields optional, at least one present (Zod `.refine`). **No-op audit behavior (resolves F8):** a PATCH that passes validation and successfully writes ALWAYS records `faculty.qualification.updated` (route 2), even when every supplied value equals its current value (a semantic no-op). The audit records the staff ACTION, not a field-level diff — mirroring the exams/fees convention of auditing the attempt/write rather than computing a change-set. The handler does not short-circuit no-op writes.
- `putWorkloadPolicySchema`: `maxWeeklyHours` required int 1..168 (hours/week sanity). On failure → 400.
- `patchFacultyWorkloadSchema`: `nonTeachingHours` optional int 0..168; `override` optional boolean; `overrideReason` optional string min 1 max 500 — required when `override === true` (refine). On failure → 400/422.
- Path params (`facultyId`, `academicTermId`, `id`): non-empty cuid-shaped strings; term/subject/section existence validated by composite FK + in-handler lookup, not trusted from input.

### B.12 Invariant ownership (per significant invariant)

- **One authoritative faculty identity** (one `FacultyProfile` per user): owned by Phase 3 schema (`userId @unique`); Faculty Management only references it. Not re-enforced here.
- **Teaching-history immutability**: owned by the DB trigger `faculty_teaching_history_no_update_delete` (DB layer) — the authoritative enforcement, same as `marks_record_history`. The service never issues UPDATE/DELETE on it.
- **Workload total = teaching + non-teaching**: owned by the DB CHECK constraint (DB layer), with the service computing and writing consistent values. DB is authoritative so a buggy service write cannot corrupt the invariant.
- **Workload ≤ policy max (unless overridden)**: owned by the SERVICE layer (requires reading config + override intent — not expressible as a single-row CHECK). The `overAllocated` flag + `overrideReason` persist the decision for audit.
- **Tenant isolation**: owned by RLS policies + composite FKs (DB layer); the service always runs in `withTenant`.

### B.13 Testability

- **Fast/mocked (`npm test -w @campusgate/api`)**: Zod schema unit tests; the workload teaching-hours derivation + over-allocation decision as a PURE function (extract `computeWorkload(assignments, subjects, nonTeachingHours, policyMax, override)` into `apps/api/src/services/faculty/workload.ts`, unit-tested with no DB — the `exams/grading.ts` `gradeSubject` precedent). Each `assignment` input element MUST carry `{ subjectId, classSectionId, role, status }` so the pure function can apply the §B.4 counting rules: de-dup on distinct `(subjectId, classSectionId)`, count each section separately, filter `status === "ACTIVE"`, and INCLUDE only `role === "PRIMARY"` (returning `teachingHours`, `unestimatedSubjectIds`, `excludedAssignmentIds`, `overAllocated`). Unit tests MUST cover: two sections of one subject (= two loads), a section-less + section-specific pair of the same subject, a SUBSTITUTE/ASSISTANT excluded, and a null-`contactHoursPerWeek` subject surfaced as unestimated; the teaching-history dedup/reconcile planning as a pure function. Catalogue-sync + modules-registry assertions run in the fast suite.
- **Live-DB integration (`npm run test:integration -w @campusgate/api`)**: a new `faculty-behavioral.integration.test.ts` exercising real `withTenant` create/read flows, the append-only trigger (UPDATE/DELETE rejected), the over-allocation path, and self-service scoping. Added to `LIVE_DB_SUITES` in `apps/api/vitest.live-db-suites.ts`; MUST pass in isolation (Supabase free-tier pooler flake).
- **Tenant-escape (`tenant-escape.integration.test.ts` + `helpers/tenant-escape-setup.ts`)**: extend `SeededTenant` with `facultyQualificationId`, `facultyWorkloadPolicyId`, `facultyWorkloadId` (seeded via adminClient, standard pair) and add `faculty_teaching_history` as a self-contained append-only case (seeded via adminClient, torn down within a scoped `DISABLE TRIGGER "faculty_teaching_history_no_update_delete"` dance child-first — the `marks_record_history` precedent). Add all four tables to `RLS_TABLES`; add `faculty_teaching_history` to `EXPECTED_POLICIES` (`{tenant_isolation_select, faculty_teaching_history_tenant_insert}`); the three mutable tables fall through to `DEFAULT_POLICIES`.

A design note: the hard-to-test part would be coupling workload derivation to the DB; extracting the pure `computeWorkload` keeps the core logic unit-testable, which is why §B.2.3/§B.13 persist the computed total rather than computing it inside the query.

### B.14 Files touched (reference)

- `packages/shared/src/modules.ts` — new module key + dependency edge.
- `packages/shared/src/permissions.ts` — 5 new `faculty.*` permissions + ROLE_PERMISSIONS bindings.
- `packages/shared/src/audit-actions.ts` — 8 new `faculty.*` audit keys.
- `packages/shared/src/` (schema barrel) — new Zod schemas (`createFacultyQualificationSchema`, etc.).
- `packages/db/prisma/schema.prisma` — 4 models + 2 enums + additive `FacultyProfile` relation back-refs (+ conditional additive columns per OQ-3).
- `packages/db/prisma/migrations/20261220000000_phase9_faculty_management/migration.sql` — new hand-authored migration.
- `apps/api/src/routes/faculty.ts` — new routes (mirrors `exams.ts`).
- `apps/api/src/services/faculty/workload.ts` — pure `computeWorkload`.
- `apps/api/src/services/faculty/teaching-history.ts` — pure reconcile planner + `appendTeachingHistory`.
- `apps/api/src/server.ts` — register `facultyRoutes` under `/api/faculty`.
- `apps/api/src/services/attendance-authz.ts` — REUSED (`resolveMarkingFaculty`); extended only if a shared ACTIVE-assignment aggregation helper is warranted (otherwise untouched).
- `apps/api/src/services/__tests__/catalogue-sync.test.ts` — add the new dir to `SEEDING_MIGRATION_DIRS`.
- `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` + `tenant-escape.integration.test.ts` — extend harness + `RLS_TABLES`/`EXPECTED_POLICIES`.
- `apps/api/vitest.live-db-suites.ts` — add `faculty-behavioral.integration.test.ts`.

### B.15 Open questions (genuine product decisions, not resolvable from the brief)

- **OQ-1 (teaching-history trigger point):** This slice adds no assignment-mutation endpoint, so history is captured via the staff `reconcile` endpoint. Should reconcile also run opportunistically (lazily) when the directory/profile read is served, or stay an explicit staff action only? Default taken: explicit staff action only (no hidden writes on a read path).
- **OQ-2 (workload-policy-max semantics):** (i) Default `maxWeeklyHours` value — none assumed; the policy row must be configured before capping applies (absent → uncapped, non-blocking). (ii) Is the cap per-institution (chosen default) or per-term/per-designation? (iii) Is over-allocation a hard block or override-with-reason? Default taken: override-with-reason (422 without override). Needs product confirmation.
- **OQ-3 (`FacultyProfile` additive fields):** `designation`/`joiningDate` are deferred to HR to keep the boundary clean (§6/§9). Confirm they are NOT needed as academic attributes in 9.1. If an academic (non-employment) designation is required, add it additively via migration section (k).
- **OQ-4 (faculty-coordinator role):** Management keys bind to ADMIN+HOD (no new role). Confirm no distinct faculty-coordinator persona with duty-separation from HOD is required; if one is, add it via the additive roles catalogue (ACCOUNTANT/LIBRARIAN precedent), not the legacy enum.
- **OQ-5 (SUBSTITUTE/ASSISTANT workload weighting):** This slice counts ONLY `role = PRIMARY` toward `teachingHours` and surfaces excluded SUBSTITUTE/ASSISTANT assignments as `excludedAssignmentIds` (§B.4). Confirm whether a later slice should attribute a fractional sanctioned load to SUBSTITUTE (e.g. temporary cover) or ASSISTANT (e.g. lab support) roles; if so, the pure `computeWorkload` gains a per-role weight map. Default taken: PRIMARY-only, no weighting.

---

## Responses to design-review findings (Revision 1)

Review verdict: `CHANGES_REQUESTED`. All nine findings ADDRESSED (none backlogged, none ignored). Each resolution was re-verified against the real files before writing.

- **F1 (HIGH — §B.1 rationale factually wrong about `examinations`): ADDRESSED.** Verified against `packages/shared/src/modules.ts`: `attendance: []`, `fees: []`, `admissions: []` (all carry the foundational-not-gated inline comment), but `examinations: ["academic_sessions","class_course","student_enrollment"]` is a real non-empty edge. Rewrote §B.1 "Rationale for `[]`" to cite ONLY attendance/fees/admissions as the `[]` precedent and added an explicit "Counter-example, acknowledged" paragraph stating the distinguishing test — *is the prerequisite itself a gated module?* — and warning the author NOT to "fix" `examinations` (its edge is correct and frozen). `faculty_management: []` decision unchanged (it was already correct).
- **F2 (MEDIUM — policy cap not surfaced to profile readers, `overAllocated` uninterpretable): ADDRESSED.** Added an explicit paragraph to §B.9 stating that routes 12 (`GET /:facultyId/profile`) and 13 (`GET /me/profile`) include a read-only `policyMaxWeeklyHours: number | null` in each workload block, resolved server-side with NO extra permission, so `overAllocated` is interpretable by the self-service FACULTY caller (who has only `faculty.view_own`). Also surfaced the same scalar in route 9's response for `faculty.directory.view`-only readers. The editable policy view (route 6) stays on `faculty.workload.manage`. Updated the route-table notes for 9/12/13.
- **F3 (MEDIUM — teaching-hours double-counts across sections; role handling unspecified): ADDRESSED.** Verified `FacultyAssignmentRole` has THREE values (`PRIMARY`/`SUBSTITUTE`/`ASSISTANT`) in `schema.prisma`, and that `attendance-authz.ts` `assertFacultyAssigned` uses `OR: [{classSectionId},{classSectionId:null}]` (section-specific + section-less coexist). Rewrote §B.4 "Teaching-hours derivation" to specify: counting unit = one row per DISTINCT `(subjectId, classSectionId)` ACTIVE assignment (sections counted separately, two sections = two loads); ONLY `role = PRIMARY` counts (SUBSTITUTE/ASSISTANT excluded and surfaced as `excludedAssignmentIds`); null `contactHoursPerWeek` → 0 + `unestimatedSubjectIds`. Updated the pure `computeWorkload` signature in §B.13 to take `{subjectId, classSectionId, role, status}` per assignment with mandated unit tests, and added OQ-5 for future SUBSTITUTE/ASSISTANT weighting.
- **F4 (MEDIUM — catalogue-sync parser end-markers are strict): ADDRESSED.** Verified by reading `catalogue-sync.test.ts`: `extractPermissionKeys` slices to the first `ON CONFLICT`; `extractRolePermissionPairs` slices to the first `AS m(` (throws `end marker not found` if absent); `SEEDING_MIGRATION_DIRS` is a hardcoded array ending at `20261213000000_phase8_exams_slice2`. Rewrote §B.3(j) to be prescriptive with concrete SQL skeletons — permissions block FIRST ending at `ON CONFLICT ("key") DO NOTHING` with no earlier `ON CONFLICT`; role_permissions block SECOND in the mandatory `FROM (VALUES …) AS m("roleKey","permKey")` join form (plain-VALUES form FORBIDDEN). Restated in Acceptance Criterion 4 that the new dir must be hand-appended to the hardcoded `SEEDING_MIGRATION_DIRS`.
- **F5 (NIT — restrict_violation code 409 vs 500 inconsistent): ADDRESSED.** Verified `exams.ts` `isRestrictViolation` maps to 409 at every call site. Chose **500** for the teaching-history append-only backstop (no legal UPDATE/DELETE path exists → a hit means a code defect). Made §B.5 say 500 and added the explicit rationale for the deliberate divergence from exams' 409; §B.10 already said 500 and now cross-references §B.5.
- **F6 (NIT — "16 frozen dirs" stated without derivation): ADDRESSED.** Replaced the bare number in both §A.4 and §B.3 with the RULE ("every pre-existing migration directory stays byte-identical") plus the derivation (currently 16 = the 15 the slice-2 header names as frozen plus slice-2 itself).
- **F7 (NIT — no error-handling entry for qualification delete of a missing/cross-tenant row): ADDRESSED.** Added a §B.10 entry: delete uses `deleteMany({ where: { id, institutionId, facultyId } })`; `count === 0` → DENIED audit + `404 { error: "qualification not found" }` (not a silent 200); `deleteMany` chosen so a 0-row match is a count, not a P2025 throw.
- **F8 (NIT — no-op PATCH audit behavior unstated): ADDRESSED.** Added a sentence to §B.11 (`patchFacultyQualificationSchema`): a successful PATCH ALWAYS records `faculty.qualification.updated` (route 2) even on a semantic no-op; audit records the staff action, not a diff (exams/fees convention).
- **F9 (NIT — `@@unique([institutionId])` vs OQ-2 per-term openness is non-additive): ADDRESSED.** Annotated the `@@unique([institutionId])` line in §B.2.2 as a deliberate this-slice commitment and added a note that widening to per-term/per-designation later requires DROP+RECREATE of the unique — a non-additive change explicitly deferred with OQ-2 to its own later slice, not something the next slice may silently relax.
