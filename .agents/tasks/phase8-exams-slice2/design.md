# CAMPASS Phase 8 — Examinations & Results, SLICE 8.2 (backend only)

Re-evaluation, supplementary exams, and cross-session student result history.
Combined requirements + technical design. Artifact directory:
`c:\campusgate\.agents\tasks\phase8-exams-slice2\`.

> Status: design-first (REV 2, post-review). This document changes NO code. It
> extends slice 8.1 (HEAD `bcd1cf5` on `origin/main`); work happens directly on
> `main` in `c:\campusgate` (no worktree). Do NOT push or deploy.
>
> This revision resolves the 2 HIGH + 5 MEDIUM + 1 NIT findings in
> `design-review.json` / `design-review.md`. The findings and the exact response
> to each are recorded in §16. The two structural changes vs REV 1 are:
> (1) the re-eval re-mark now uses a NEW dedicated `exams.reeval.manage`-gated
> re-mark route (REV 1's "reuse the MODERATION correct route / no new marks route"
> was proven infeasible because `examinations_guard` makes `PUBLISHED` terminal —
> there is no legal path back to `MODERATION`/`MARKS_OPEN`); and (2) the migration
> gains an idempotent one-time backfill that flips pre-existing non-max PUBLISHED
> versions to `SUPERSEDED` BEFORE the trigger swap, so the "max version is the
> sole PUBLISHED row" invariant holds for 8.1-era data too.

---

## 1. Summary

Slice 8.1 shipped the full exam DB foundation and operational routes: the
forward-only exam lifecycle, capacity-aware scheduling, candidate registration,
weighted assessments, faculty-scoped marks entry with append-only corrections,
moderation/approval, the deterministic grading engine
(`apps/api/src/services/exams/grading.ts`), and controlled append-only VERSIONED
result publication (`result_publications` + `result_snapshots`), publish being
MFA step-up gated. In 8.1 a "superseded" prior version is DERIVED
(`version < max(version)`); the `SUPERSEDED` enum variant is reserved and never
written, because `result_publications` carries an unconditional append-only
`no_update_delete` trigger.

Slice 8.2 completes Phase 8 with three capabilities, built strictly on top of
8.1's machinery (no duplication):

1. **Re-evaluation** — a student self-initiates a tracked, audited
   re-evaluation REQUEST against their own published result; staff process it
   through a forward-only lifecycle; a changed re-mark flows through the EXISTING
   controlled re-publication path (grading engine → new `ResultPublication`
   version + new `ResultSnapshot` rows), and the prior version is finally flipped
   to `SUPERSEDED`. This is where `SUPERSEDED` gets written for the first time,
   requiring the `result_publications` append-only trigger to be replaced by a
   column-guard that permits EXACTLY `PUBLISHED → SUPERSEDED`.
2. **Supplementary exams** — a linked `Examination` of type `SUPPLEMENTARY`
   (confirmed spelling, §4) that references its parent via a new nullable
   same-tenant self-FK `parentExaminationId`, reusing the ENTIRE 8.1 pipeline.
   Only candidate ELIGIBILITY (computed from the parent's latest published
   non-passing results) and the parent linkage are new.
3. **Student result history** — a consolidated, cross-session/cross-term read of
   a student's published results (latest published version per exam, regular +
   supplementary), from the frozen snapshots. Student self-view is
   PUBLISHED-ONLY and own-records-only; staff view sees full history including
   superseded. JSON endpoints plus an ExcelJS export (the `admin.ts` /
   `exams.ts` `results.xlsx` pattern).

This is **access-and-correctness-critical** (the exam analog of money-critical):
unpublished/superseded results must never leak to students; result integrity +
audit must hold; re-publication stays controlled (step-up + `exams.results.publish`).

No fees coupling in 8.2 (§10, deliberate deferral).

### 1.1 Confirmed facts (read from the real 8.1 sources)

- `packages/db/prisma/schema.prisma`: the enum is **`ExaminationType`** (NOT
  `ExamType`) and its supplementary value is **`SUPPLEMENTARY`**. The Zod enum
  `examinationTypeEnum` in `packages/shared/src/validation.ts` already lists
  `"SUPPLEMENTARY"`. **8.2 uses the literal `SUPPLEMENTARY`.**
- `ExaminationStatus { DRAFT SCHEDULED MARKS_OPEN MARKS_LOCKED MODERATION
  APPROVED PUBLISHED }`, forward-only via `examinations_guard`.
- `ResultPublicationStatus { PUBLISHED, SUPERSEDED }`; 8.1 writes `PUBLISHED`
  only; `SUPERSEDED` reserved for this slice.
- `result_publications` + `result_snapshots` are INSERT-only in 8.1 (append-only
  RLS pair `{tenant_isolation_select, <table>_tenant_insert}`, `REVOKE
  UPDATE,DELETE`, `<table>_no_update_delete` trigger). `result_snapshots` STAYS
  strictly append-only.
- The publish route (`apps/api/src/routes/exams.ts` `POST /:id/publish`) already
  computes `nextVersion` and, for a re-publication, accepts an exam whose status
  is `APPROVED` **or `PUBLISHED`** (verified: `if (exam.status !== "APPROVED" &&
  exam.status !== "PUBLISHED") return deny("exam not approved", 409)`), creates a
  new PUBLISHED version with a required `reason` when `nextVersion > 1`,
  re-grades from the CURRENT `marks_records` + the active grading scheme, and
  writes fresh snapshots — but does NOT flip the prior version (8.1 derives
  supersede as `version < max(version)`; it never writes `SUPERSEDED`). **8.2
  adds the supersede flip** to this existing route (§8.3).
- CRITICAL lifecycle fact (verified against the 8.1 `examinations_guard`, §h.1 of
  the 8.1 migration): the guard freezes a `PUBLISHED` exam's status
  (`IF OLD."status" = 'PUBLISHED' AND NEW."status" IS DISTINCT FROM OLD."status"
  THEN RAISE …`) and the forward-only table has no `PUBLISHED → *` edge. The two
  mark-mutation routes are both status-gated — `PUT /:id/marks` requires
  `MARKS_OPEN`, `POST /:id/marks/:recordId/correct` requires `MODERATION`. So a
  PUBLISHED exam (the only kind a re-eval can target) can NEVER legally return to
  `MARKS_OPEN`/`MODERATION`, and neither 8.1 route can change a mark on it.
  Therefore 8.2 MUST add a dedicated re-mark route; see §8.2a and finding-1
  resolution in §16. `marks_records_guard` (§h.2) only freezes identity columns
  (`institutionId, examId, assessmentId, candidateId, studentId`) and raises on
  DELETE — it already PERMITS a `marks` UPDATE, so the new re-mark route needs NO
  trigger change to `marks_records`; the status gate lives in the service.
- Grading engine `gradeSubject(assessments, marks, bands)` is pure integer/BigInt
  (round-half-up to `percentBps` via `(num+5000n)/10000n`, `isPassing`-authoritative
  banding). REUSE verbatim; never fork.
- `attendance-authz.ts` `resolveMarkingFaculty` + `assertFacultyAssigned`
  (FacultyProfile `status='ACTIVE'` gate) is reused by supplementary marks entry
  because supplementary marks go through the SAME 8.1 `PUT /:id/marks` route.
- Step-up seam: `requireStepUp("exams.results.publish")` + `/api/auth/mfa/verify`
  — reused verbatim for re-publication (the re-eval outcome goes through the
  existing publish route; no new step-up class).
- RBAC: ADMIN + HOD each hold the 6 management keys; FACULTY `exams.marks.enter`;
  STUDENT `exams.results.view_own` (14 pairs in `ROLE_PERMISSIONS` and the 8.1
  migration seed). Module key is `examinations`; permission/audit prefix `exams.*`.
  `MODULE_DEPENDENCIES.examinations` is left UNCHANGED (do not edit `modules.ts`).
- `catalogue-sync.test.ts` asserts exact set-equality of the union over
  `SEEDING_MIGRATION_DIRS` against `PERMISSION_KEYS` + `ROLE_PERMISSIONS`; the 8.1
  dir is already listed. New permission keys require: (a) `PERMISSIONS` +
  `ROLE_PERMISSIONS` edits in shared, (b) the new migration's `INSERT INTO
  "permissions" ... ON CONFLICT` span + `role_permissions FROM (VALUES ...) AS
  m("roleKey","permKey")` span, (c) adding the new migration dir to
  `SEEDING_MIGRATION_DIRS`.
- Audit action keys live in `packages/shared/src/audit-actions.ts`
  (`AUDIT_ACTIONS`); there is NO migration mirror and NO pg enum — validation is
  in `recordAuditEvent` against `AUDIT_ACTION_KEY_SET`. New `exams.*` audit keys
  are a shared-only edit.

---

## 2. Scope

### 2.1 In scope (functional requirements)

- **FR-1 Re-evaluation request model.** A new tenant-owned, forward-only,
  column-guarded table `reeval_requests` (model `ReevalRequest`) scoped to
  `(institutionId, examId, candidateId, studentId, subjectId)` with lifecycle
  `REQUESTED → UNDER_REVIEW → REMARKED → CLOSED` and the side exit
  `REQUESTED|UNDER_REVIEW → REJECTED`.
- **FR-2 Student self-service request.** STUDENT with the NEW
  `exams.reeval.request_own` permission creates a re-eval request against their
  OWN published result only. The target exam must have a latest PUBLISHED
  publication and a snapshot for this (student, subject).
- **FR-3 Staff processing.** ADMIN + HOD with the NEW `exams.reeval.manage`
  permission advance a request forward (`UNDER_REVIEW`, `REMARKED`, `CLOSED`) or
  `REJECTED`, with reason where required.
- **FR-4 Re-mark → controlled re-publication.** When processing a re-eval
  request produces a changed mark, the mark is corrected through a NEW dedicated
  re-mark route `POST /reeval/:id/remark` (`exams.reeval.manage`, §8.2a) — NOT
  the 8.1 `MARKS_OPEN`/`MODERATION` routes, which cannot run on a PUBLISHED exam
  (§1.1). The re-mark writes the corrected `marks_records` row + a
  `marks_record_history` `CORRECTED` row (reusing the append-only history table)
  only while the parent re-eval request is `UNDER_REVIEW`. The outcome is then
  published through the EXISTING `POST /:id/publish` route (grading engine →
  new version → new snapshots → prior version flipped to `SUPERSEDED`).
  Re-publication stays MFA step-up gated + `exams.results.publish`. The exam
  itself NEVER leaves `PUBLISHED` — the forward-only lifecycle is untouched.
- **FR-5 Supersede flip.** On a re-publication, the immediately-prior PUBLISHED
  version for `(institutionId, examId)` is set to `SUPERSEDED`. Only the
  `PUBLISHED → SUPERSEDED` status change is permitted on `result_publications`;
  every other column change and every DELETE stays forbidden; `result_snapshots`
  stays strictly append-only. Original snapshots are NEVER mutated.
- **FR-6 Supplementary linkage.** `Examination` gains a nullable self-FK
  `parentExaminationId` (composite same-tenant). A supplementary exam has
  `type = SUPPLEMENTARY` and a non-null `parentExaminationId`.
- **FR-7 Supplementary eligibility.** A staff endpoint
  (`exams.candidates.manage`) computes the eligible student set for a
  supplementary exam from the PARENT exam's latest PUBLISHED results: a student
  is eligible for a subject iff their latest published snapshot for that subject
  has `passed = false`. Registering a student who passed (or has no non-passing
  parent snapshot) is rejected.
- **FR-8 Supplementary pipeline reuse.** Supplementary schedules, assessments,
  marks entry (reusing `attendance-authz` + the ACTIVE gate), moderation,
  grading, and publication run through the EXACT 8.1 routes/engine — no new marks
  or publish route is added for the SUPPLEMENTARY flow (a supplementary exam runs
  the normal `DRAFT → … → PUBLISHED` lifecycle, so the 8.1 `MARKS_OPEN` /
  `MODERATION` routes apply unchanged). The NEW re-mark route (FR-4) is specific
  to re-evaluation of an already-PUBLISHED exam and is orthogonal to the
  supplementary flow.
- **FR-9 Student result history read model.** `GET /me/results/history`
  (`exams.results.view_own`): own records, PUBLISHED-only, latest published
  version per exam, cross-session/cross-term, deterministic ordering, values from
  snapshots (no recomputation).
- **FR-10 Staff result history read model.** `GET
  /students/:studentId/results/history` (`exams.results.view`): full history for
  any student in the tenant, INCLUDING superseded versions, deterministic
  ordering.
- **FR-11 History export.** `GET /students/:studentId/results/history.xlsx`
  (`exams.results.view`): ExcelJS transcript-style export of a student's result
  history (the `exams.ts` `results.xlsx` precedent); audited `exams.results.exported`.
- **FR-12 RBAC additions.** New permission `exams.reeval.request_own` bound to
  STUDENT; new permission `exams.reeval.manage` bound to ADMIN + HOD. Seeded in
  shared + the new migration; `catalogue-sync` extended.
- **FR-13 Audit additions.** New `exams.*` audit keys for the re-eval lifecycle
  and the supersede event (§8.4), added to `AUDIT_ACTIONS` only.

### 2.2 Out of scope / explicitly deferred

- **No fees coupling (§10).** 8.2 creates NO `StudentCharge`, imports NO fees
  service. Re-eval / supplementary fees, if any, are posted manually out-of-band
  via the existing fees module.
- **No new PUBLISH route.** Re-publication reuses the 8.1 `POST /:id/publish`
  verbatim (extended only with the supersede flip). Supplementary marking reuses
  the 8.1 `MARKS_OPEN`/`MODERATION` routes verbatim. A SINGLE new mark-mutation
  route (`POST /reeval/:id/remark`) is added ONLY for the re-eval-on-PUBLISHED
  case, because the 8.1 routes provably cannot run on a PUBLISHED exam (§1.1);
  this is a deliberate, reviewed deviation from REV 1's "no new marks route"
  (§16 finding 1).
- **No frontend.** Backend only.
- **No change to `MODULE_DEPENDENCIES.examinations` / `modules.ts`.**
- **No edit to any of the 15 frozen migration dirs** (byte-untouched), including
  the 8.1 dir.
- **No `prisma migrate dev`.** Hand-authored migration only.
- No reeval SLA/notifications, no automatic reeval→publish chaining (publish is a
  separate deliberate step-up-gated staff action).

### 2.3 Non-functional requirements

- **NFR-1 Tenant isolation (A2).** Every new table carries `institutionId` +
  `(id, institutionId)` composite unique + composite same-tenant FKs incl.
  `institutionId` + ENABLE+FORCE RLS with nullif-guarded fail-closed USING+WITH
  CHECK. `campass_app` stays NOSUPERUSER NOBYPASSRLS. All tenant reads/writes via
  `withTenant(institutionId, tx => ...)`.
- **NFR-2 Determinism.** Results always come from `gradeSubject` and the frozen
  snapshots; history reads never recompute. Deterministic ordering on every list.
- **NFR-3 Immutability/auditability.** `result_snapshots` and
  `marks_record_history` strictly append-only; `marks_records` identity-frozen +
  DELETE-forbidden (its `marks` column is legally mutable — the re-mark route
  uses this); `result_publications` immutable except the single
  `PUBLISHED → SUPERSEDED` flip; `reeval_requests` forward-only via column guard;
  every mutation audited `exams.*`. **Invariant: for every `(institutionId,
  examId)` at most ONE `result_publications` row is `PUBLISHED` and it is the
  max-version row.** 8.1 never wrote `SUPERSEDED`, so pre-existing exams with
  `version > 1` can have multiple PUBLISHED rows; the 8.2 migration's one-time
  idempotent backfill (§11 / finding 2) establishes this invariant before the
  column-guard trigger is installed, and the supersede flip (§8.3) preserves it
  thereafter.
- **NFR-4 Access control.** Students never see unpublished OR superseded versions
  — enforced at BOTH the query layer (a dedicated `latestPublishedPublication`
  helper that filters `status = 'PUBLISHED'` AND orders `version desc`, scoped to
  the caller's own `studentId`; NOT the 8.1 `latestPublication` which filters by
  max version only — finding 3) AND the permission layer (`view_own` vs `view`).
- **NFR-5 Testability in isolation.** The extended live-DB suites must pass IN
  ISOLATION (the Supabase free-tier pooler flakes on combined runs).

---

## 3. Acceptance criteria (numbered, testable)

1. `packages/db/prisma/schema.prisma` references `SUPPLEMENTARY` exactly as it
   exists in `ExaminationType`; no new enum value is introduced for supplementary.
2. A new migration dir `20261213000000_phase8_exams_slice2` exists in the
   a–j house style; the 15 prior dirs are byte-identical to HEAD.
3. `prisma migrate diff --from-schema-datasource` after apply shows only the
   long-standing composite-vs-single-FK cosmetic diff — NO DROP on any existing
   table; `prisma migrate status` says up to date.
4. The 8.2 migration (in this order) (a) runs the idempotent backfill flipping
   every non-max PUBLISHED `result_publications` row to `SUPERSEDED` per
   `(institutionId, examId)`; (b) drops the `result_publications_no_update_delete`
   trigger + its `result_publications_append_only` function; (c) creates a
   column-guard `result_publications_guard` that raises on DELETE, freezes every
   column except `status` (IS DISTINCT FROM), permits `status` to change ONLY
   `PUBLISHED → SUPERSEDED`, and rejects any other status change; (d) drops the
   `result_publications_tenant_insert` policy and creates `tenant_isolation_modify`
   (FOR ALL, covering INSERT + the one legal UPDATE under WITH CHECK); (e) GRANTs
   UPDATE to `campass_app` (SELECT+INSERT already granted in 8.1). The backfill
   runs BEFORE the trigger swap so the append-only trigger does not block it, and
   it emits NO per-row audit (it is a schema migration, not an app action).
   `result_snapshots` and `marks_record_history` triggers/grants/policies are
   unchanged.
5. After the backfill, the invariant "max version is the sole PUBLISHED row per
   `(institutionId, examId)`" holds for all existing data. A subsequent
   re-publication (version N+1 create) flips exactly the then-max PUBLISHED
   version N from `PUBLISHED` to `SUPERSEDED` and asserts the flip touched exactly
   one row (`flipped.count === 1`, else 409); any attempt to flip
   `SUPERSEDED → PUBLISHED`, mutate any other `result_publications` column, or
   DELETE a row is rejected by the column guard (surfaces as a 409).
6. Attempting UPDATE/DELETE on `result_snapshots` still fails (strictly
   append-only), proven by the extended escape/behavioral suite.
7. `reeval_requests` enforces forward-only transitions
   `REQUESTED→UNDER_REVIEW→REMARKED→CLOSED` and `REQUESTED|UNDER_REVIEW→REJECTED`
   via `reeval_requests_guard`; any illegal transition or DELETE is rejected
   (409); identity columns are frozen.
8. `POST /me/reeval` with `exams.reeval.request_own` creates a `REQUESTED` row
   ONLY for the caller's own student profile and ONLY when the target exam has a
   latest PUBLISHED snapshot for (caller, subject); otherwise 404/409 with a
   DENIED audit. A student may not create a request against another student's
   result (403/404, never leaks existence).
9. Re-eval staff transition endpoints require `exams.reeval.manage` (ADMIN + HOD
   only) + `requireModuleActive("examinations")`; FACULTY/STUDENT are 403.
9a. The re-mark route `POST /reeval/:id/remark` (`exams.reeval.manage`) changes a
   `marks_records` row + writes a `marks_record_history` `CORRECTED` row ONLY when
   the parent re-eval request is `UNDER_REVIEW` and the record belongs to the
   request's `(examId, candidateId)` scope; it runs on a `PUBLISHED` exam without
   changing the exam's status; an out-of-scope record, a non-`UNDER_REVIEW`
   request, or a marks-out-of-range value is rejected (404/409/400) with a DENIED
   audit; the `transitionReevalSchema` from/to legality is independent of this
   route. The exam's forward-only lifecycle is never mutated.
10. `parentExaminationId` is a nullable composite same-tenant self-FK; a
    supplementary exam cannot reference a parent in another tenant (composite FK
    backstop) and the service rejects a non-SUPPLEMENTARY exam carrying a parent
    link and a SUPPLEMENTARY exam missing one.
11. The supplementary-eligibility endpoint has ONE deterministic contract
    (finding 4): when the body omits `studentIds`, it registers the full computed
    non-passing set for the requested subjects; when `studentIds` is present it
    registers EXACTLY that set after asserting every id is eligible (has a
    non-passing latest-PUBLISHED parent snapshot for at least one requested
    subject), rejecting the whole request 409 + DENIED audit if any is ineligible.
    In both modes a student is registered once per supplementary exam (one
    `candidates` row), and the created candidates are normal `candidates` rows
    usable by the 8.1 pipeline.
12. `GET /me/results/history` returns the caller's own PUBLISHED-only history
    (latest PUBLISHED version per exam via `latestPublishedPublication`, regular +
    supplementary), deterministically ordered; never returns a superseded version
    or another student's row even if a bug left a superseded row at max version.
13. `GET /students/:studentId/results/history` (`exams.results.view`) returns the
    full history including superseded versions, deterministically ordered.
14. `GET /students/:studentId/results/history.xlsx` streams a valid XLSX and
    writes an `exams.results.exported` audit.
15. `PERMISSIONS` + `ROLE_PERMISSIONS` gain `exams.reeval.request_own` (STUDENT)
    and `exams.reeval.manage` (ADMIN, HOD); the 8.2 migration seeds the two
    permissions + the three role_permission pairs; `SEEDING_MIGRATION_DIRS` in
    `catalogue-sync.test.ts` includes the 8.2 dir; `catalogue-sync` set-equality
    passes.
16. New `exams.*` audit keys are present in `AUDIT_ACTIONS` and accepted by
    `recordAuditEvent`; keys are plural-consistent with the 8.1 family — the
    supersede key is `exams.results.superseded` (NOT singular `exams.result.*`,
    finding 5); no dead keys (every key is emitted by some route; the migration
    backfill emits none).
17. The tenant-escape harness is extended for `reeval_requests` (seeded in the
    generic loop as a column-guard table with its own teardown trigger-disable),
    `EXPECTED_POLICIES` has its `result_publications` entry REMOVED so it falls
    through to `DEFAULT_POLICIES` (the default `{tenant_isolation_select,
    tenant_isolation_modify}` pair), and `RLS_TABLES` includes `reeval_requests`.
    An integration assertion proves an UPDATE of a frozen `reeval_requests`
    column (e.g. `studentReason`) is rejected by the guard (finding 8). The suite
    passes IN ISOLATION.
18. `npm test -w @campusgate/api` stays green (fast/mocked, ≥ 484 + new fast
    tests); `exams-behavioral.integration` and `tenant-escape.integration` pass
    IN ISOLATION via `npm run test:integration -w @campusgate/api`.

---

## 4. Technology stack (locked)

Unchanged from the monorepo: TypeScript + Fastify API (`apps/api`), Prisma +
PostgreSQL on Supabase (`packages/db`), shared catalogues/validation in
`packages/shared` (Zod), ExcelJS for exports, Vitest for tests. Multi-tenancy via
RLS + `withTenant`. No new runtime dependency is introduced. The
`ExaminationType.SUPPLEMENTARY` enum value and `ResultPublicationStatus.SUPERSEDED`
enum value already exist — 8.2 adds NO enum values; it adds one enum
(`ReevalRequestStatus`), one table, one nullable column, one trigger swap, new
permissions, new audit keys, new read routes, and one new service module.

---

## 5. Overview of the design

8.2 is deliberately small-surface and additive. The DB work is one hand-authored
migration (`20261213000000_phase8_exams_slice2`) that: (a) creates the
`ReevalRequestStatus` enum; (b) creates the `reeval_requests` table with its
indexes, composite same-tenant FKs, CHECKs, RLS pair, column-guard trigger, and
GRANT; (c) adds the nullable `parentExaminationId` column + composite same-tenant
self-FK + index to `examinations`; (d) performs the `result_publications` trigger
swap (drop the append-only trigger, create the column-guard; add
`tenant_isolation_modify`; GRANT UPDATE); (e) seeds the two new permissions + the
three role_permission pairs. The schema.prisma is updated to mirror every object
with the raw-SQL-in-migration comment convention 8.1 established.

The API work adds one service module (`apps/api/src/services/exams/reeval.ts` for
the eligibility computation + reeval invariants) and new routes in the EXISTING
`apps/api/src/routes/exams.ts` plugin (so the `/api/exams` mount, the single
`authenticate` preHandler, the `actor`/`deny`/`isDeny`/`advisoryLock` helpers,
and the 8.1 `latestPublication` are reused for staff/internal paths; a NEW
sibling `latestPublishedPublication` — `status = 'PUBLISHED'`, `version desc` —
is added for all student-facing reads, finding 3). Re-publication is NOT
re-implemented: the
existing `POST /:id/publish` is extended with the supersede flip so EVERY
re-publication (reeval-driven or manual) supersedes correctly and consistently.

Every decision below is grounded in the 8.1 files read for this design.

---

## 6. Data model

### 6.1 `examinations.parentExaminationId` (new nullable column)

- Prisma: add to `model Examination`:
  ```prisma
  parentExaminationId String?
  parentExamination   Examination?  @relation("SupplementaryParent", fields: [parentExaminationId], references: [id])
  supplementaryChildren Examination[] @relation("SupplementaryParent")
  ```
  (Prisma single-column relation is cosmetic; the real guarantee is the composite
  same-tenant FK in raw SQL, matching the 8.1 composite-FK convention.)
- Migration (lettered, after the enum/table sections, in the "ALTER existing
  tables" span):
  ```sql
  ALTER TABLE "examinations" ADD COLUMN "parentExaminationId" TEXT;
  CREATE INDEX "examinations_institutionId_parentExaminationId_idx"
    ON "examinations"("institutionId", "parentExaminationId");
  ALTER TABLE "examinations"
    ADD CONSTRAINT "examinations_parent_same_tenant_fkey"
    FOREIGN KEY ("institutionId", "parentExaminationId")
    REFERENCES "examinations"("institutionId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
  ```
  The `(id, institutionId)` unique already exists on `examinations` (8.1 §c), so
  the composite self-FK is anchorable. This is strictly additive — ADD COLUMN
  nullable + ADD CONSTRAINT, NO table rewrite, NO DROP.
- **Invariant ownership.** The pairing rule (`type = SUPPLEMENTARY` ⇔
  `parentExaminationId IS NOT NULL`) cannot be a single-row CHECK cleanly across
  both directions without coupling `type` + null state; it is **service-owned**
  (the examinations_guard freezes `type` and `parentExaminationId` is set at
  create only — see below). The composite FK owns same-tenant integrity.
- **`examinations_guard` interaction.** The 8.1 guard freezes
  `institutionId, academicSessionId, academicTermId, programId, type,
  createdByUserId`. `parentExaminationId` is set at INSERT (not an UPDATE path) so
  it needs no guard change; to be safe and explicit, 8.2 **adds
  `parentExaminationId` to the frozen set** in a `CREATE OR REPLACE FUNCTION
  examinations_guard()` in the 8.2 migration (the function body is re-authored;
  the trigger binding is unchanged). This keeps the parent link immutable after
  create. Re-authoring a trigger FUNCTION (not editing the frozen 8.1 dir) is the
  documented, tested change — the same idiom as the `result_publications` swap.

### 6.2 `reeval_requests` (new table)

Column-guard class table (mutable row with a forward-only status + frozen
identity), mirroring `examinations`/`marks_records`.

```prisma
enum ReevalRequestStatus {
  REQUESTED
  UNDER_REVIEW
  REMARKED
  CLOSED
  REJECTED
}

model ReevalRequest {
  id                  String              @id @default(cuid())
  institutionId       String
  institution         Institution         @relation(fields: [institutionId], references: [id])
  examId              String
  exam                Examination         @relation(fields: [examId], references: [id])
  candidateId         String
  candidate           Candidate           @relation(fields: [candidateId], references: [id])
  studentId           String
  student             StudentProfile      @relation(fields: [studentId], references: [id])
  subjectId           String
  subject             Subject             @relation(fields: [subjectId], references: [id])
  // the published result the student is contesting (frozen provenance)
  sourcePublicationId String
  sourcePublication   ResultPublication   @relation(fields: [sourcePublicationId], references: [id])
  status              ReevalRequestStatus @default(REQUESTED)
  studentReason       String
  requestedByUserId   String              // recorded actor id (no FK) — the student user
  processedByUserId   String?             // recorded actor id (no FK) — staff
  staffNote           String?
  outcomePublicationId String?            // set when a REMARKED change is re-published (no FK; frozen provenance)
  createdAt           DateTime            @default(now())
  updatedAt           DateTime            @updatedAt

  @@unique([id, institutionId])
  @@index([institutionId])
  @@index([institutionId, examId])
  @@index([institutionId, studentId])
  @@index([institutionId, candidateId])
  @@index([institutionId, status])
  @@map("reeval_requests")
}
```

- **Columns in migration §b** with `updatedAt NOT NULL` (column-guard class).
- **§c uniques/indexes:** `(id, institutionId)`, plus a business rule: at most one
  OPEN request per `(institutionId, candidateId, subjectId)` where OPEN =
  `status IN (REQUESTED, UNDER_REVIEW, REMARKED)`. Expressed as a **partial
  unique index** (Prisma cannot express it, so raw SQL — the
  `candidates_schedule_seat_unique` precedent):
  ```sql
  CREATE UNIQUE INDEX "reeval_requests_open_unique"
    ON "reeval_requests"("institutionId", "candidateId", "subjectId")
    WHERE "status" IN ('REQUESTED','UNDER_REVIEW','REMARKED');
  ```
  This lets a student re-request after a CLOSED/REJECTED outcome but blocks
  duplicate open requests.
- **§d tenant-root FK:** `institutionId -> institutions(id) RESTRICT`.
- **§e composite same-tenant FKs:** `(institutionId, examId)->examinations`,
  `(institutionId, candidateId)->candidates`,
  `(institutionId, studentId)->student_profiles`,
  `(institutionId, subjectId)->subjects`,
  `(institutionId, sourcePublicationId)->result_publications`. `requestedByUserId`
  / `processedByUserId` / `outcomePublicationId` are recorded ids with no FK (the
  8.1 actor-id precedent; `outcomePublicationId` deliberately FK-free to avoid a
  cycle with the publication written after the request).
- **§f CHECKs:** `char_length("studentReason") >= 1`.
- **§g RLS:** standard fail-closed pair `{tenant_isolation_select,
  tenant_isolation_modify}` (column-guard class carries a modify policy — the
  `examinations`/`payment_transactions` rationale).
- **§h trigger `reeval_requests_guard`** (§7).
- **§i GRANT:** `GRANT SELECT, INSERT, UPDATE, DELETE ... TO campass_app` guarded
  by the `pg_roles` existence check (the guard enforces immutability at row
  level; DELETE is blocked by the trigger, so the broad GRANT is safe — the
  `examinations` precedent, which also GRANTs DELETE then blocks it in-trigger).

---

## 7. Triggers

### 7.1 `result_publications` trigger swap (the controlled supersede)

**Decision.** Replace the unconditional `result_publications_no_update_delete`
append-only trigger with a column-guard `result_publications_guard`, mirroring
`examinations_guard` / `payment_transactions_guard` / `student_charges_guard`.

**Ordering is load-bearing (finding 2).** 8.1 NEVER wrote `SUPERSEDED` and its
append-only trigger made UPDATE impossible, yet the 8.1 publish route already
supports re-publication (`nextVersion > 1` with a required `reason`). So in
production a single `(institutionId, examId)` may already have versions `1..N`
ALL carrying `status = 'PUBLISHED'`. Because the append-only trigger blocks any
UPDATE, the backfill cannot run while it is active. The migration therefore
performs, in this exact order: **(0) disable the append-only trigger, run the
idempotent backfill → (1) drop the append-only trigger + function → (2) create
the column guard → (3) swap the RLS policy + GRANT UPDATE**. This is the same
`ALTER TABLE … DISABLE TRIGGER` dance the escape harness uses for teardown on
guard tables. Concretely:

```sql
-- (0) one-time idempotent backfill: establish "max version is the sole PUBLISHED
-- row per (institutionId, examId)" for 8.1-era data. The append-only trigger
-- would block this UPDATE, so disable it for the span of the backfill, then drop
-- it. This runs session-level as the migration role; it emits NO app audit (it
-- is a schema migration, not a route action).
ALTER TABLE "result_publications" DISABLE TRIGGER "result_publications_no_update_delete";
UPDATE "result_publications" rp
   SET "status" = 'SUPERSEDED'
 WHERE rp."status" = 'PUBLISHED'
   AND EXISTS (
     SELECT 1 FROM "result_publications" rp2
      WHERE rp2."institutionId" = rp."institutionId"
        AND rp2."examId"        = rp."examId"
        AND rp2."version"       > rp."version"
   );
-- backfill is idempotent: re-running flips nothing once every non-max version is
-- already SUPERSEDED.

-- (1) drop the 8.1 append-only trigger + function (we re-enabled nothing; it is removed)
DROP TRIGGER IF EXISTS "result_publications_no_update_delete" ON "result_publications";
DROP FUNCTION IF EXISTS "result_publications_append_only"();

CREATE OR REPLACE FUNCTION "result_publications_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'result_publications is append-only'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- freeze every column except status (IS DISTINCT FROM handles nulls)
  IF NEW."id"                IS DISTINCT FROM OLD."id"
  OR NEW."institutionId"     IS DISTINCT FROM OLD."institutionId"
  OR NEW."examId"            IS DISTINCT FROM OLD."examId"
  OR NEW."version"           IS DISTINCT FROM OLD."version"
  OR NEW."gradingSchemeId"   IS DISTINCT FROM OLD."gradingSchemeId"
  OR NEW."publishedByUserId" IS DISTINCT FROM OLD."publishedByUserId"
  OR NEW."reason"            IS DISTINCT FROM OLD."reason"
  OR NEW."publishedAt"       IS DISTINCT FROM OLD."publishedAt"
  OR NEW."createdAt"         IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'immutable result_publications column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- status may change ONLY PUBLISHED -> SUPERSEDED (plus the no-op self transition)
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'PUBLISHED' AND NEW."status" = 'SUPERSEDED')
  THEN
    RAISE EXCEPTION 'illegal result_publications status transition: % -> %',
      OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER "result_publications_guard"
  BEFORE UPDATE OR DELETE ON "result_publications"
  FOR EACH ROW EXECUTE FUNCTION "result_publications_guard"();
```

RLS + GRANT changes to let `campass_app` perform the one legal UPDATE under RLS:

```sql
-- add the modify policy (it previously had only SELECT + *_tenant_insert)
DROP POLICY IF EXISTS "result_publications_tenant_insert" ON "result_publications"; -- replaced by the modify policy (which covers INSERT via FOR ALL)
CREATE POLICY "tenant_isolation_modify" ON "result_publications" FOR ALL
  USING ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''))
  WITH CHECK ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));
-- SELECT policy stays as-is.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT UPDATE ON "result_publications" TO "campass_app";  -- SELECT, INSERT already granted in 8.1
  END IF;
END $$;
```

> Note on the policy change (finding 7): 8.1 gave `result_publications` the
> append-only RLS pair `{tenant_isolation_select,
> result_publications_tenant_insert}`. Because the column guard now enforces
> immutability at the row level (exactly like `payment_transactions`), the
> correct end state is the DEFAULT pair `{tenant_isolation_select,
> tenant_isolation_modify}`. The migration therefore drops the INSERT-only policy
> and creates `tenant_isolation_modify` (FOR ALL). Three things are asserted
> explicitly so the implementer does not miss them:
>
> 1. **INSERT still passes.** The 8.1 publish route INSERTs into
>    `result_publications` with `institutionId` always equal to the tenant GUC, so
>    the new `FOR ALL` policy's `WITH CHECK ("institutionId" = nullif(
>    current_setting('app.current_institution_id', true), ''))` is satisfied on
>    every INSERT — the publish path is unaffected by the policy swap.
> 2. **Only one other reference to the dropped policy NAME exists.** The literal
>    `result_publications_tenant_insert` appears only in the escape harness's
>    `EXPECTED_POLICIES` (verified against the 8.1 sources). The migration removes
>    that `result_publications` entry from `EXPECTED_POLICIES` in lockstep so it
>    falls through to `DEFAULT_POLICIES` (§11 / §13). No app code or other test
>    references the policy name.
> 3. **The policy/trigger swap is INVISIBLE to `prisma migrate diff`.** Prisma
>    does not model RLS policies or triggers, so dropping a policy/trigger and
>    creating new ones produces NO schema diff. AC#3's "NO DROP on any existing
>    table" therefore stays satisfied — the only diff expected is the long-standing
>    composite-vs-single-FK cosmetic one from the new `parentExaminationId` self-FK
>    and the `reeval_requests` composite FKs. Call this out so a reader does not
>    expect the swap to appear in the diff.

`result_snapshots` and `marks_record_history` are **NOT touched** — they keep
their append-only trigger, append-only RLS pair, and `REVOKE UPDATE,DELETE`.

**Failure mode.** The guard raises `restrict_violation` on any forbidden write.
The route (reusing the 8.1 `isRestrictViolation` helper) maps it to a **409**.
This is a fatal, non-recoverable write error — it means a code path tried an
illegal publication mutation; it is logged at the route (Fastify request log)
and surfaced as 409 with a generic message (no internal detail leaked).

### 7.2 `reeval_requests_guard` (forward-only lifecycle)

```sql
CREATE OR REPLACE FUNCTION "reeval_requests_guard"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reeval_requests is append-only'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- immutable identity / provenance columns
  IF NEW."institutionId"       IS DISTINCT FROM OLD."institutionId"
  OR NEW."examId"              IS DISTINCT FROM OLD."examId"
  OR NEW."candidateId"         IS DISTINCT FROM OLD."candidateId"
  OR NEW."studentId"           IS DISTINCT FROM OLD."studentId"
  OR NEW."subjectId"           IS DISTINCT FROM OLD."subjectId"
  OR NEW."sourcePublicationId" IS DISTINCT FROM OLD."sourcePublicationId"
  OR NEW."studentReason"       IS DISTINCT FROM OLD."studentReason"
  OR NEW."requestedByUserId"   IS DISTINCT FROM OLD."requestedByUserId"
  OR NEW."createdAt"           IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'immutable reeval_requests column changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- forward-only transitions (plus no-op self transition)
  IF NOT (
       (OLD."status" = 'REQUESTED'    AND NEW."status" = 'UNDER_REVIEW')
    OR (OLD."status" = 'UNDER_REVIEW' AND NEW."status" = 'REMARKED')
    OR (OLD."status" = 'REMARKED'     AND NEW."status" = 'CLOSED')
    OR (OLD."status" = 'REQUESTED'    AND NEW."status" = 'REJECTED')
    OR (OLD."status" = 'UNDER_REVIEW' AND NEW."status" = 'REJECTED')
    OR (OLD."status" = NEW."status"))
  THEN
    RAISE EXCEPTION 'illegal reeval_requests status transition: % -> %',
      OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER "reeval_requests_guard"
  BEFORE UPDATE OR DELETE ON "reeval_requests"
  FOR EACH ROW EXECUTE FUNCTION "reeval_requests_guard"();
```

Terminal states `CLOSED` and `REJECTED` are frozen (no outgoing legal
transition). `REMARKED → CLOSED` is the normal close after the re-publication;
`REMARKED → REJECTED` is intentionally NOT allowed (once remarked, the outcome is
closed, not rejected). `staffNote`, `processedByUserId`, `outcomePublicationId`
are mutable (set during processing) and NOT frozen.

**Frozen-column alignment (finding 8).** The frozen set in this trigger
(`institutionId, examId, candidateId, studentId, subjectId, sourcePublicationId,
studentReason, requestedByUserId, createdAt`) MUST stay byte-aligned across three
places: the Prisma `ReevalRequest` model (§6.2), the migration's `CREATE TABLE`
columns, and this guard body. A drift (e.g. forgetting `studentReason`) would
silently allow mutation of a column the design intends to freeze. The behavioral
suite asserts an UPDATE of `studentReason` is rejected with a 409 to catch such
drift (§13). The mutable set is exactly `status, staffNote, processedByUserId,
outcomePublicationId, updatedAt`.

---

## 8. API surface

All new routes are added to the EXISTING `apps/api/src/routes/exams.ts` plugin
(mounted `/api/exams`). Every route carries `requireModuleActive("examinations")`
in addition to `requirePermission(...)`; every handler runs inside
`withTenant(institutionId, tx => ...)` with `institutionId` from `request.user`;
every mutation writes an `exams.*` audit via `recordAuditEvent` in the same tx;
deny branches record a DENIED audit then RETURN a 4xx from the callback (never
throw) — the 8.1 `deny`/`isDeny` idiom. New Zod schemas go in
`packages/shared/src/validation.ts` next to the 8.1 exam schemas.

### 8.1 Re-evaluation — student self-service

- `POST /me/reeval` — `requirePermission("exams.reeval.request_own")`.
  Body (new `createReevalRequestSchema`): `{ examId, subjectId, reason }`
  (`reason`: 1..500). Handler:
  1. resolve the caller's `StudentProfile` (`userId`, `institutionId`); if none →
     404 `{ error: "no student profile" }`.
  2. `latestPublishedPublication(tx, institutionId, examId)` (the NEW helper that
     filters `status = 'PUBLISHED'` AND orders `version desc` — finding 3; NOT the
     8.1 `latestPublication` which only takes max version); if none → 404
     `{ error: "no published result" }` (unpublished/superseded is invisible —
     same wording as `/me/results/:examId`).
  3. find the caller's candidate row for the exam; find the snapshot for
     `(resultPublicationId = latest.id, studentId = own, subjectId)`; if none → 404
     (student has no result for that subject — never reveal another student's data).
  4. the partial-unique open-request index blocks a duplicate open request →
     unique-violation mapped to 409 `{ error: "a re-evaluation request is already open" }`.
  5. INSERT `reeval_requests` row `status=REQUESTED`, `sourcePublicationId =
     latest.id`, `studentReason = reason`, `requestedByUserId = userId`; audit
     `exams.reeval.requested` SUCCESS.
- `GET /me/reeval` — `requirePermission("exams.reeval.request_own")`: the
  caller's own requests, deterministically ordered `createdAt desc, id asc`.

### 8.2 Re-evaluation — staff processing

- `GET /reeval` — `requirePermission("exams.reeval.manage")`: list tenant
  requests, filterable by `status`/`examId` via query (`listReevalQuerySchema`),
  ordered `createdAt asc, id asc`.
- `POST /reeval/:id/transition` — `requirePermission("exams.reeval.manage")`.
  Body (`transitionReevalSchema`): `{ to: "UNDER_REVIEW"|"REMARKED"|"CLOSED"|"REJECTED",
  note?, outcomePublicationId? }`. Handler (finding 6 — the legality decision is
  made in the service BEFORE the write, not left to the trigger backstop alone):
  1. inside the tx, SELECT the current request `{ status: from, examId,
     institutionId }`; if not found → 404.
  2. consult the pure `reevalTransitionLegal(from, to)` helper in `reeval.ts`
     (the SINGLE source of truth, unit-tested, mirroring `reeval_requests_guard`).
     The legal edge set is exactly:
     `REQUESTED→UNDER_REVIEW`, `UNDER_REVIEW→REMARKED`, `REMARKED→CLOSED`,
     `REQUESTED→REJECTED`, `UNDER_REVIEW→REJECTED`. Any other `(from,to)` → 409
     `{ error: "illegal re-evaluation transition" }` (BEFORE any write).
  3. body rules: `to === "REJECTED"` requires `note` (1..500) else 400;
     `outcomePublicationId` is permitted ONLY when `to === "REMARKED"` else 400.
  4. when `outcomePublicationId` is present, validate it with
     `tx.resultPublication.findFirst({ where: { id: outcomePublicationId,
     institutionId, examId } })`; if it does not exist / belongs to another exam
     or tenant → 404 `{ error: "outcome publication not found" }` (RLS already
     scopes the read; a cross-tenant id simply returns null → 404).
  5. apply the advance with an optimistic `updateMany where:{ id, institutionId,
     status: from }` (the `advanceExamStatus` idiom). **`count === 0 ⇒ 409`**
     `{ error: "re-evaluation request changed concurrently" }` — the row moved
     out from under us between the SELECT and the UPDATE. `reeval_requests_guard`
     remains the hard DB backstop (a `restrict_violation` → 409), but legality is
     already enforced in step 2 so the trigger should never fire in normal flow.
  6. on success set `processedByUserId = userId`, `staffNote = note ?? existing`,
     and `outcomePublicationId` when supplied; audit `exams.reeval.transitioned`
     SUCCESS with `{ from, to }` metadata.

#### 8.2a Re-mark on a PUBLISHED exam (NEW route — finding 1)

The 8.1 mark routes cannot run on a PUBLISHED exam (§1.1). A re-eval that
produces a changed mark therefore needs a dedicated, tightly-scoped route:

- `POST /reeval/:id/remark` — `requirePermission("exams.reeval.manage")` +
  `requireModuleActive("examinations")`.
  Body (`remarkReevalSchema`): `{ marksRecordId, marks, reason }` (`marks`
  integer ≥ 0; `reason` 1..500 required — a re-mark is always reasoned). Handler,
  all inside `withTenant`:
  1. SELECT the request `{ status, examId, candidateId, institutionId }`; if not
     found → 404. If `status !== "UNDER_REVIEW"` → 409 `{ error: "request not
     under review" }` (re-marking is legal ONLY during active review; this is the
     service-owned status gate that replaces the 8.1 `MARKS_OPEN`/`MODERATION`
     gate for this path).
  2. load the `marks_records` row by `{ id: marksRecordId, institutionId,
     examId: request.examId, candidateId: request.candidateId }`; if not found →
     404 `{ error: "marks record not found for this request" }` (scopes the
     mutation to the contested candidate — a staff user cannot re-mark an
     arbitrary record under cover of a request).
  3. load the record's assessment `maxMarks`; if `marks < 0 || marks > maxMarks`
     → 400 `{ error: "marks out of range" }` + DENIED audit.
  4. `tx.marksRecord.update({ where: { id }, data: { marks, enteredByUserId:
     userId } })` — permitted by `marks_records_guard` (it freezes only identity
     columns, never `marks`); then `tx.marksRecordHistory.create({ data: {
     changeType: "CORRECTED", previousMarks, newMarks: marks, actorUserId: userId,
     reason, … } })` (the append-only history table, reused verbatim).
  5. audit `exams.reeval.remarked` SUCCESS with `{ marksRecordId, previousMarks,
     newMarks }`. The exam's status is NOT touched — it stays `PUBLISHED`.

The re-eval request remains a tracking + authorization + audit wrapper; the
re-mark route is the one place it is permitted to mutate a mark, and only within
its own `(examId, candidateId)` scope while `UNDER_REVIEW`. The staff then
advances the request to `REMARKED` (§8.2) and re-publishes (§8.3). Separation of
duties is preserved: the re-mark needs `exams.reeval.manage`; the re-publish
additionally needs `exams.results.publish` + MFA step-up.

### 8.3 Re-publication (extend the existing publish route — the supersede flip)

`POST /:id/publish` keeps its preHandler ordering `[requirePermission(
"exams.results.publish"), requireStepUp("exams.results.publish"),
requireModuleActive(gate)]` verbatim. The ONLY change: after creating version
`nextVersion` (when `nextVersion > 1`), flip the immediately-prior PUBLISHED
version to `SUPERSEDED` within the SAME transaction, still under the
`advisoryLock(exampub:${institutionId}:${examId})` the route already takes:

```ts
if (nextVersion > 1) {
  const priorVersion = nextVersion - 1;
  // Post-backfill (finding 2), the prior (= then-max) version is the sole
  // PUBLISHED row for the scope; flip exactly it to SUPERSEDED.
  const flipped = await tx.resultPublication.updateMany({
    where: { institutionId, examId, version: priorVersion, status: "PUBLISHED" },
    data: { status: "SUPERSEDED" },
  });
  // priorVersion must have been the single PUBLISHED row; 0 ⇒ concurrent/illegal state
  if (flipped.count !== 1) return deny("prior version not in PUBLISHED state", 409);
}
```

- The `flipped.count === 1` assertion is correct ONLY because the migration
  backfill (finding 2) already collapsed any 8.1-era multi-PUBLISHED exam to a
  single max-version PUBLISHED row. Without the backfill, a legacy exam's older
  PUBLISHED rows would remain PUBLISHED after this flip (the bug finding 2
  identified). With it, the invariant holds and `count` is always exactly 1 on a
  re-publication.
- Ordering: the flip happens AFTER the new header + snapshots are written, so a
  grading failure (`GradingError` → 409) aborts the whole tx and NO supersede
  occurs. Because the route already holds the advisory lock, there is never a
  window where two PUBLISHED versions coexist across a commit boundary.
- The column guard permits exactly this `PUBLISHED → SUPERSEDED` write; any other
  attempt (e.g. a double flip, or flipping a non-prior version) raises
  `restrict_violation` → 409.
- Audit: in addition to the existing `exams.results.published`, emit
  `exams.results.superseded` SUCCESS (plural, finding 5 — consistent with the 8.1
  `exams.results.published` / `exams.results.exported` family) for the flipped
  prior version with metadata `{ supersededVersion: priorVersion, byVersion:
  nextVersion }`. The migration backfill (finding 2) emits NO audit — it is a
  schema migration, not a route action, so this key is NOT dead and is emitted on
  every runtime supersede flip.
- This makes supersede correct for BOTH reeval-driven and plain manual
  re-publications — a single code path, consistent with 8.1's "single source of
  truth" principle.

### 8.4 Supplementary exams

- Create path reuses the EXISTING `POST /` examination create. `createExaminationSchema`
  gains an optional `parentExaminationId` (cuid-like). Service rule
  (`reeval.ts` helper `assertSupplementaryLinkage`): if `type === "SUPPLEMENTARY"`
  then `parentExaminationId` is REQUIRED and must resolve to a same-tenant
  non-supplementary (or any) existing examination; if `type !== "SUPPLEMENTARY"`
  then `parentExaminationId` must be absent. Violations → 400 with a DENIED audit.
- `POST /:id/candidates/supplementary` — `requirePermission("exams.candidates.manage")`.
  Body (`registerSupplementaryCandidatesSchema`): `{ subjectIds: string[] (min 1),
  studentIds?: string[] }`. **ONE deterministic contract (finding 4):**
  - The endpoint ALWAYS computes the eligible set from the parent: a student is
    eligible iff, for at least one requested subject, their latest-PUBLISHED
    parent snapshot has `passed = false`.
  - If `studentIds` is **omitted**, the endpoint registers the FULL computed
    eligible set.
  - If `studentIds` is **present**, the endpoint registers EXACTLY that set, but
    first asserts every id is eligible; if ANY requested id is not eligible
    (passed, or has no non-passing parent snapshot for any requested subject), the
    WHOLE request is rejected `409 { error: "one or more students are not
    eligible" }` + a DENIED audit (reject atomically, never partially register).
    The allowlist thus NARROWS the computed set to exactly the named, validated
    students — it never widens it or coexists with a second full-compute pass.
  - Per-subject behaviour: a registered student becomes a `candidates` row for the
    supplementary exam (candidates are exam-scoped, not subject-scoped — the 8.1
    `candidates` table has no subjectId). The supplementary exam's assessments
    (created later via the 8.1 route) define which subjects it covers; a student
    registered here sits every subject the supplementary is configured with. The
    `subjectIds` in the body scope the ELIGIBILITY computation (which failures
    qualify a student), not a per-subject candidate row.

  Handler:
  1. load the supplementary exam; if not `SUPPLEMENTARY` or no `parentExaminationId`
     → 409.
  2. `latestPublishedPublication(tx, institutionId, parentExaminationId)` (the
     status-filtered helper, finding 3); if none → 409
     `{ error: "parent results not published" }`.
  3. read the parent's snapshots under that publication with `subjectId IN
     subjectIds AND passed = false`; the eligible student set is the DISTINCT union
     of their `studentId`s.
  4. resolve the target set: `studentIds ?? [...eligible]`; if `studentIds` is
     present, assert `studentIds ⊆ eligible` (else the atomic 409 above).
  5. for each target student without an existing `candidates` row for THIS
     supplementary exam, create one (the normal 8.1 table) — the exact creation
     shape of `POST /:id/candidates` `{ institutionId, examId, studentId }`; the
     `candidates_examId_studentId_key` unique makes a re-send idempotent (skip on
     P2002, mirroring the 8.1 register route).
  6. audit `exams.candidate.registered` (reuse the 8.1 key — these are ordinary
     candidate registrations) with metadata `{ supplementaryOf: parentExaminationId,
     eligibleCount, registeredCount }`.
- Everything after registration (schedules, assessments, marks via `PUT
  /:id/marks` with the `attendance-authz` ACTIVE gate, moderation, publish) uses
  the 8.1 routes unchanged.

### 8.5 Student result history

- `GET /me/results/history` — `requirePermission("exams.results.view_own")`.
  Resolve own `StudentProfile`; gather the student's candidate rows → distinct
  `examId`s; for each, `latestPublishedPublication` (status-filtered, finding 3)
  then its own snapshots; shape:
  `{ history: [{ examId, examName, examType, academicSessionId, academicTermId,
  parentExaminationId, version, publishedAt, subjects: [{ subjectId, percentBps,
  gradeLabel, gradePoints, passed }] }] }`, ordered `publishedAt desc, examId asc`,
  subjects `subjectId asc`. PUBLISHED-only, own-only — no superseded ever.
- `GET /students/:studentId/results/history` — `requirePermission("exams.results.view")`.
  Same shape but for the named student (validated same-tenant) and INCLUDING
  superseded versions (`includeSuperseded` defaults true for staff): returns an
  array of versions per exam, each tagged `status: PUBLISHED|SUPERSEDED`,
  ordered `examId asc, version desc`.
- `GET /students/:studentId/results/history.xlsx` — `requirePermission("exams.results.view")`.
  ExcelJS workbook (the `exams.ts` `results.xlsx` precedent): one sheet
  "Transcript" with columns Exam / Type / Session / Term / Subject / Percent /
  Grade / Grade Points / Passed / Version / Status. Audited `exams.results.exported`.

### 8.6 Audit keys (added to `AUDIT_ACTIONS` only)

| key | module | description |
|-----|--------|-------------|
| `exams.reeval.requested` | examinations | Student requested re-evaluation of a published result |
| `exams.reeval.transitioned` | examinations | Re-evaluation request advanced ({from,to}) incl. REJECTED |
| `exams.reeval.remarked` | examinations | A marks_records row re-marked under an UNDER_REVIEW re-eval request (CORRECTED history row) |
| `exams.results.superseded` | examinations | Prior published version flipped to SUPERSEDED on re-publication |

Four new keys. Naming follows the 8.1 families exactly: the re-eval keys are the
new `exams.reeval.*` family; the supersede key is `exams.results.superseded`
(PLURAL `results`, matching `exams.results.published` / `exams.results.exported`
— finding 5), NOT a singular `exams.result.*`. `exams.candidate.registered`
(supplementary) and `exams.results.exported` (history export) reuse 8.1 keys —
consistent with 8.1's no-dead-keys rule. Every new key is emitted by exactly the
route named in §8.7 (no dead keys); the migration backfill emits none. No
migration mirror is needed for audit keys (validated only in `recordAuditEvent`
against `AUDIT_ACTION_KEY_SET`).

### 8.7 Lifecycle × route × permission × audit-key matrix

| # | Operation | Route | Actor / permission | Module gate | Step-up | Status effect | Audit key(s) |
|---|-----------|-------|--------------------|-------------|---------|---------------|--------------|
| 1 | Request re-eval | `POST /api/exams/me/reeval` | STUDENT / `exams.reeval.request_own` | ✓ | — | create `REQUESTED` | `exams.reeval.requested` |
| 2 | List own reeval | `GET /api/exams/me/reeval` | STUDENT / `exams.reeval.request_own` | ✓ | — | read | — |
| 3 | List reeval (staff) | `GET /api/exams/reeval` | ADMIN+HOD / `exams.reeval.manage` | ✓ | — | read | — |
| 4 | Start review | `POST /api/exams/reeval/:id/transition` to `UNDER_REVIEW` | ADMIN+HOD / `exams.reeval.manage` | ✓ | — | `REQUESTED→UNDER_REVIEW` | `exams.reeval.transitioned` |
| 5 | Record re-mark done | same, to `REMARKED` | ADMIN+HOD / `exams.reeval.manage` | ✓ | — | `UNDER_REVIEW→REMARKED` | `exams.reeval.transitioned` |
| 6 | Close | same, to `CLOSED` | ADMIN+HOD / `exams.reeval.manage` | ✓ | — | `REMARKED→CLOSED` | `exams.reeval.transitioned` |
| 7 | Reject | same, to `REJECTED` (reason req.) | ADMIN+HOD / `exams.reeval.manage` | ✓ | — | `REQUESTED\|UNDER_REVIEW→REJECTED` | `exams.reeval.transitioned` |
| 8 | Re-mark under re-eval (PUBLISHED exam) | `POST /api/exams/reeval/:id/remark` (NEW) | ADMIN+HOD / `exams.reeval.manage` | ✓ | — | marks_records updated + CORRECTED history; exam stays PUBLISHED | `exams.reeval.remarked` |
| 9 | Re-publish (supersede) | `POST /api/exams/:id/publish` (8.1 + flip) | ADMIN+HOD / `exams.results.publish` | ✓ | ✓ | new version PUBLISHED; prior → `SUPERSEDED` | `exams.results.published`, `exams.results.superseded` |
| 10 | Create supplementary exam | `POST /api/exams/` (8.1 + parent link) | ADMIN+HOD / `exams.manage` | ✓ | — | create `DRAFT` SUPPLEMENTARY | `exams.examination.created` |
| 11 | Register supplementary candidates | `POST /api/exams/:id/candidates/supplementary` | ADMIN+HOD / `exams.candidates.manage` | ✓ | — | create candidates | `exams.candidate.registered` |
| 12 | Supplementary marks/moderate/publish | 8.1 routes, unchanged | per 8.1 | ✓ | publish only | per 8.1 | per 8.1 |
| 13 | Own result history | `GET /api/exams/me/results/history` | STUDENT / `exams.results.view_own` | ✓ | — | read (PUBLISHED-only, own) | — |
| 14 | Staff result history | `GET /api/exams/students/:studentId/results/history` | ADMIN+HOD / `exams.results.view` | ✓ | — | read (incl. superseded) | — |
| 15 | History export | `GET /api/exams/students/:studentId/results/history.xlsx` | ADMIN+HOD / `exams.results.view` | ✓ | — | read/export | `exams.results.exported` |

---

## 9. Input validation (per external input)

- `createReevalRequestSchema` (`POST /me/reeval`): `examId` cuid-like 1..64
  (required), `subjectId` cuid-like (required), `reason` string 1..500 (required).
  `institutionId`/`studentId` NEVER from the body. On failure → 400
  `{ error: flatten() }` (the 8.1 pattern).
- `transitionReevalSchema` (`POST /reeval/:id/transition`): `to` enum of the four
  non-REQUESTED statuses (required); `note` string 1..500 (required when
  `to === "REJECTED"`, optional otherwise, enforced by `.refine`);
  `outcomePublicationId` cuid-like optional, additionally `.refine`-rejected
  unless `to === "REMARKED"`. `:id` from the path. Zod validates SHAPE only; the
  `(from,to)` legality, the `count===0 ⇒ 409`, and the `outcomePublicationId`
  existence/scope check are service-owned (§8.2, finding 6) because they need the
  current DB row.
- `remarkReevalSchema` (`POST /reeval/:id/remark`, NEW — finding 1): `marksRecordId`
  cuid-like (required), `marks` int ≥ 0 (required; the upper bound is the
  cross-table `maxMarks` check done in the service, mirroring the 8.1 correct
  route), `reason` string 1..500 (required). `:id` from the path.
- `listReevalQuerySchema` (`GET /reeval`): `status` optional enum,
  `examId` optional cuid-like. Unknown query params ignored.
- `registerSupplementaryCandidatesSchema`: `subjectIds` array of cuid-like, min 1,
  max 1000 (the allocate/register bound precedent); optional `studentIds`
  allowlist array (max 5000). Per the single contract (§8.4, finding 4): when
  `studentIds` is present the service registers exactly that set after asserting
  every id is eligible (atomic 409 if any is not); when absent it registers the
  full computed eligible set. Zod validates shape; eligibility is service-owned.
- `createExaminationSchema` extension: optional `parentExaminationId` cuid-like;
  cross-field rule enforced in the service (not Zod) because it depends on `type`
  + a DB existence check.
- Path `:studentId` / `:examId`: treated as opaque ids; existence + same-tenant
  checked in-handler; a non-existent id yields 404 (never leaks cross-tenant
  existence because RLS already scopes the read).

Validation failure is always a recoverable 400/404/409 returned to the caller;
nothing is logged beyond the Fastify access log except DENIED audits for
authorization/eligibility failures (recorded in-tx, the 8.1 idiom).

---

## 10. No fees coupling (deliberate deferral)

8.2 posts NO `StudentCharge` and imports NO fees service. Re-evaluation and
supplementary fees, when a tenant charges them, are posted manually out-of-band
through the existing fees module (Phase 7). Rationale: keep exams self-contained,
avoid a cross-module write dependency and a second money-critical surface inside
this slice, and preserve the clean separation the 8.1 design established. This is
revisitable in a later slice if automatic fee posting is wanted.

---

## 11. Multi-tenancy, RLS, migration workflow

- `reeval_requests` follows A2 fully: `institutionId`, `(id, institutionId)`
  composite unique, composite same-tenant FKs incl. `institutionId`, ENABLE+FORCE
  RLS, standard fail-closed nullif-guarded pair. `campass_app` GRANT refresh under
  the `pg_roles` guard; never BYPASSRLS.
- `result_publications` moves from the append-only pair to the default modify pair
  (§7.1) because immutability is now a column guard, exactly like
  `payment_transactions` / `refunds`.
- **Migration workflow:** hand-author `20261213000000_phase8_exams_slice2` in the
  frozen lettered a–j house style mirroring the 8.1 dir. NEVER `prisma migrate
  dev`. After writing: `prisma migrate diff --from-schema-datasource` (expect ONLY
  the long-standing composite-vs-single-FK cosmetic diff, NO DROP on existing
  tables), `prisma migrate deploy`, `prisma migrate status` → up to date. The 15
  frozen dirs stay byte-untouched.
- **Catalogue-sync:** add `exams.reeval.request_own` + `exams.reeval.manage` to
  `PERMISSIONS` (module `examinations`) and `ROLE_PERMISSIONS` (STUDENT gets
  `request_own`; ADMIN + HOD get `manage`); mirror the two permission rows in the
  migration's `INSERT INTO "permissions" ... ON CONFLICT` span and the three pairs
  in the `role_permissions FROM (VALUES ...) AS m("roleKey","permKey")` span; add
  the 8.2 dir to `SEEDING_MIGRATION_DIRS` in `catalogue-sync.test.ts`. Set-equality
  then holds (new count: 10 permission keys, 17 role_permission pairs across the
  exams family).

---

## 12. Edge cases

- **Re-request after rejection/closure.** Allowed — the partial unique only blocks
  OPEN requests; a CLOSED/REJECTED request leaves the slot free.
- **Student requests on a superseded result.** The request always targets
  `latestPublishedPublication` (the current PUBLISHED, max-version row). A student
  cannot address a superseded version (it is invisible to them).
  `sourcePublicationId` freezes which version was contested for audit provenance.
- **8.1-era exam with multiple PUBLISHED versions (finding 2).** The migration
  backfill flips all but the max version to SUPERSEDED before the column guard is
  installed; after it, the "single PUBLISHED max row" invariant holds and the
  supersede flip's `count === 1` assertion is always satisfied. Re-running the
  migration's backfill is a no-op (idempotent).
- **Re-mark outside an active review (finding 1).** `POST /reeval/:id/remark`
  only mutates marks while the parent request is `UNDER_REVIEW` and only within
  the request's `(examId, candidateId)` scope; a record for another candidate, or
  a request already `REMARKED`/`CLOSED`/`REJECTED`, is rejected. The exam stays
  `PUBLISHED` throughout — the forward-only lifecycle is never violated.
- **Re-publish with no mark change.** Still creates a new version + supersedes the
  prior (the staff decision to re-publish is itself the control); the new snapshots
  may be identical in values. This matches 8.1's versioning model.
- **Supplementary with unpublished parent.** 409 — eligibility is undefined until
  the parent is published.
- **Supplementary student who has no candidate row in the parent.** Not eligible
  (no parent snapshot exists for them); excluded.
- **Concurrent re-publications.** Serialized by the existing advisory lock
  `exampub:${institutionId}:${examId}`; the `flipped.count !== 1` check + the
  column guard close any race to exactly one PUBLISHED version.
- **Attempt to flip a non-adjacent / already-superseded version.** The column
  guard rejects any non-`PUBLISHED→SUPERSEDED` write (`SUPERSEDED→SUPERSEDED`
  no-op is allowed and harmless; `SUPERSEDED→PUBLISHED` is rejected).
- **examinations_guard & the parent link.** `parentExaminationId` is frozen after
  create by the re-authored guard; an attempt to attach/detach a parent later → 409.
- **Cross-tenant studentId in the staff history route.** RLS scopes the read; a
  foreign studentId returns empty/404, never another tenant's rows.

---

## 13. Testability

- **Unit (fast, mocked — `npm test`):** the eligibility set computation
  (`reeval.ts` pure helper given parent snapshots → eligible studentIds), the
  `assertSupplementaryLinkage` rule, the reeval transition legality table (mirrors
  the trigger), and the Zod schemas. No DB. These extend the 484-green fast suite.
- **Integration (live DB, in isolation — `npm run test:integration`):**
  - `exams-behavioral.integration`: end-to-end reeval (request → `UNDER_REVIEW`
    → `POST /reeval/:id/remark` changes a mark on the PUBLISHED exam → `REMARKED`
    → `POST /:id/publish` re-publishes + flips prior to SUPERSEDED → student
    `/me/results/history` sees ONLY the latest; both versions survive in staff
    history). Plus: the re-mark route rejects an out-of-scope record and a
    non-`UNDER_REVIEW` request (finding 1); the backfill establishes the single
    PUBLISHED invariant for a pre-seeded multi-version exam (finding 2); the
    supersede column guard (legal flip succeeds; `SUPERSEDED→PUBLISHED`, other
    column mutations, and DELETE all 409); `result_snapshots` still strictly
    append-only; the transition legality (`count===0 ⇒ 409`, illegal `(from,to)`
    → 409, `outcomePublicationId` scope check — finding 6); supplementary
    eligibility + the single registration contract (omitted vs allowlist, atomic
    409 on an ineligible id — finding 4) + full pipeline; and the two history
    read models (own `latestPublishedPublication` PUBLISHED-only vs staff incl.
    superseded — finding 3).
  - `tenant-escape.integration`: extend the harness (§11) for `reeval_requests`
    (seed in the column-guard class, teardown trigger-disable dance mirroring
    `examinations`/`marks_records`), REMOVE the `result_publications` entry from
    `EXPECTED_POLICIES` so it falls through to `DEFAULT_POLICIES` (the default
    modify pair) and `reeval_requests` is absent (default pair), add
    `reeval_requests` to `RLS_TABLES`. Prove cross-tenant read/spoofed-write/
    foreign-parent isolation on `reeval_requests` and the new
    `examinations.parentExaminationId` link, and assert an UPDATE of a frozen
    `reeval_requests` column (`studentReason`) is rejected by the guard
    (finding 8).
- **Isolation requirement (NFR-5):** each extended live suite must pass IN
  ISOLATION (the free-tier pooler flakes on combined runs). The harness's
  `withRetry` + sequential counting already accommodate this.
- A design note: the supersede flip is hard to unit-test in pure isolation (it is
  a DB write under RLS + trigger), so it is covered by the behavioral integration
  suite; the transition legality is unit-tested in pure form to catch table drift
  early. This split is intentional and keeps the fast suite fast.

---

## 14. Files touched (implementation map — for the build step)

- `packages/db/prisma/schema.prisma`: add `ReevalRequestStatus` enum + `ReevalRequest`
  model; add `parentExaminationId` + self relation to `Examination`; add
  back-relations on `Examination`/`Candidate`/`StudentProfile`/`Subject`/
  `ResultPublication`/`Institution`; raw-SQL-in-migration comments per the 8.1
  convention.
- `packages/db/prisma/migrations/20261213000000_phase8_exams_slice2/migration.sql`:
  the hand-authored a–j migration (enum, table, indexes incl. partial unique, FKs,
  CHECKs, RLS, `reeval_requests_guard`, the `result_publications` trigger swap +
  policy/GRANT change, the re-authored `examinations_guard`, the catalogue seed).
- `packages/shared/src/permissions.ts`: `PERMISSIONS` + `ROLE_PERMISSIONS` additions.
- `packages/shared/src/audit-actions.ts`: FOUR new `exams.*` keys
  (`exams.reeval.requested`, `exams.reeval.transitioned`, `exams.reeval.remarked`,
  `exams.results.superseded`).
- `packages/shared/src/validation.ts`: new reeval/supplementary schemas
  (`createReevalRequestSchema`, `transitionReevalSchema`, `remarkReevalSchema`,
  `listReevalQuerySchema`, `registerSupplementaryCandidatesSchema`) + the
  `createExaminationSchema` optional `parentExaminationId`.
- `apps/api/src/services/exams/reeval.ts`: eligibility computation,
  `assertSupplementaryLinkage`, the pure `reevalTransitionLegal(from,to)` helper
  (unit-tested, the single source of truth mirroring `reeval_requests_guard`).
- `apps/api/src/routes/exams.ts`: new reeval routes (`/me/reeval` GET/POST,
  `/reeval` GET, `/reeval/:id/transition` POST, `/reeval/:id/remark` POST),
  supplementary registration, history read + export routes; the supersede flip
  inside `POST /:id/publish`; the NEW `latestPublishedPublication` helper
  (status-filtered) for student reads alongside the existing `latestPublication`.
- `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts`: harness
  extension (§13); `apps/api/src/services/__tests__/catalogue-sync.test.ts`:
  `SEEDING_MIGRATION_DIRS` += the 8.2 dir.
- New/extended tests: fast reeval/eligibility unit tests;
  `exams-behavioral.integration` cases; `tenant-escape.integration` cases.

---

## 15. Open assumptions (flagged for review)

- **A1.** The re-eval request is a tracking/authorization wrapper; the re-mark is
  a distinct `exams.reeval.manage` step (`POST /reeval/:id/remark`) and the
  re-publication a distinct `exams.results.publish` + step-up step. The slice does
  NOT auto-chain remark→publish; this keeps step-up on publish and separation of
  duties intact (the re-mark needs only `exams.reeval.manage`; the money-grade
  publish additionally needs `exams.results.publish` + MFA). If a single fused
  endpoint were intended it would move the step-up gate onto the reeval flow —
  retained as a deliberate design choice, not a gap.
- **A2 (RESOLVED, finding 4).** The supplementary-registration contract is now
  single and deterministic (§8.4): omit `studentIds` ⇒ register the full computed
  eligible set; supply `studentIds` ⇒ register exactly that set after an atomic
  eligibility assertion. No dual-mode ambiguity remains.
- **A3.** History "latest published version per exam" uses `latestPublishedPublication`
  (`status = 'PUBLISHED'`, `version desc`) for the student view and so is immune
  to a stray superseded row at max version (finding 3). Staff history returns all
  versions per exam tagged by status via a direct `findMany`
  (`includeSuperseded` defaults true for staff, forced false for students).
- **A4.** `result_publications` policy change (append-only pair → default modify
  pair) is required for the legal UPDATE under RLS and matches the
  `payment_transactions` precedent; the escape `EXPECTED_POLICIES` must be updated
  in lockstep or the RLS meta-test fails. Called out so the reviewer verifies the
  harness edit lands with the migration (confirmed by finding 7 — this is the
  only other reference to the dropped policy name).

---

## 16. Response to the design review (REV 1 → REV 2)

The review (`design-review.json` / `design-review.md`, verdict CHANGES_REQUESTED,
2 HIGH + 5 MEDIUM + 1 NIT) was validated against the real 8.1 sources read for
this revision (`exams.ts`, the 8.1 `migration.sql`, `audit-actions.ts`,
`catalogue-sync.test.ts`). Every finding is ADDRESSED; none is backlogged or
dismissed. The two findings I verified most carefully — because they change the
buildable shape of the slice — are HIGH 1 and HIGH 2.

### Finding 1 (HIGH) — re-mark path infeasible on a PUBLISHED exam — ADDRESSED

Confirmed against the real routes: `POST /:id/marks/:recordId/correct` requires
`exam.status === "MODERATION"` and `PUT /:id/marks` requires `"MARKS_OPEN"`;
`examinations_guard` (8.1 §h.1) freezes a PUBLISHED exam's status and the
forward-only table has no `PUBLISHED → *` edge. REV 1's "reuse the moderation
path / no new marks route" was therefore un-buildable.

**Resolution: Option B (new scoped re-mark route), chosen over Option A.** I
rejected Option A (adding a `PUBLISHED → MODERATION`/`REMARKING` backward edge to
`examinations_guard`) because it would weaken the single most important integrity
invariant of the whole exams subsystem — the strictly forward-only, PUBLISHED-is-
terminal lifecycle — and would require re-authoring BOTH `examinations_guard`
(to permit a backward status edge) and reasoning about re-opening marks on a
live-published exam, widening the blast radius far beyond re-eval. Option B adds
ONE new route `POST /reeval/:id/remark` (`exams.reeval.manage`, §8.2a) that
mutates `marks_records.marks` + writes a `CORRECTED` `marks_record_history` row
ONLY while a parent re-eval request is `UNDER_REVIEW` and ONLY within that
request's `(examId, candidateId)` scope, leaving the exam `PUBLISHED` throughout.
`marks_records_guard` already permits a `marks` UPDATE (it freezes only identity
columns), so NO trigger change is needed. REV 1's "no new marks route" constraint
is explicitly dropped and the drop is recorded in §2.2, FR-4, FR-8. Full
validation, audit key (`exams.reeval.remarked`), and marks-history semantics are
in §8.2a and AC#9a.

### Finding 2 (HIGH) — prior versions all PUBLISHED; no backfill — ADDRESSED

Confirmed: 8.1 never writes `SUPERSEDED` and its publish route supports
re-publication, so legacy exams can carry multiple PUBLISHED rows. Added a
one-time idempotent backfill to the migration (§7.1 step 0), ordered
**disable append-only trigger → backfill non-max PUBLISHED → SUPERSEDED → drop
trigger → create column guard → swap policy/GRANT**. The backfill emits no audit.
This establishes NFR-3's "single PUBLISHED max row" invariant for 8.1-era data so
the supersede flip's `count === 1` assertion (§8.3) and AC#5 hold. Documented in
NFR-3, §7.1, §11, §12, AC#4, AC#5.

### Finding 3 (MEDIUM) — latestPublication has no status filter — ADDRESSED

Added a dedicated `latestPublishedPublication(tx, institutionId, examId)` helper
filtering `status = 'PUBLISHED'` AND `orderBy version desc`, used for ALL
student-facing reads (`POST /me/reeval` step 2, `GET /me/results/history`, the
supplementary parent-eligibility read). The 8.1 `latestPublication` (max version
only) is retained for staff/internal paths where status tagging is explicit.
Documented in NFR-4, §5-equivalent (§14 helper list), §8.1, §8.4, §8.5, AC#12.

### Finding 4 (MEDIUM) — supplementary registration dual-mode ambiguity — ADDRESSED

Collapsed to ONE contract (§8.4, AC#11): omit `studentIds` ⇒ register the full
computed eligible set; supply `studentIds` ⇒ register exactly that set after an
atomic all-or-nothing eligibility assertion (409 + DENIED audit if any id is
ineligible). Per-subject behaviour clarified: candidates are exam-scoped (the
8.1 `candidates` table has no `subjectId`), `subjectIds` scopes the eligibility
computation, and the candidate row shape is exactly the 8.1 `{ institutionId,
examId, studentId }` with idempotent P2002 skip. A2 marked RESOLVED.

### Finding 5 (MEDIUM) — audit key naming — ADDRESSED

Renamed the supersede key to `exams.results.superseded` (plural, consistent with
`exams.results.published` / `exams.results.exported`). Confirmed it is emitted on
every runtime supersede flip in the publish route and that the migration backfill
emits no audit (so the key is not dead). Documented in §8.3, §8.6, AC#16.

### Finding 6 (MEDIUM) — transition legality + outcomePublicationId — ADDRESSED

§8.2 now specifies: a pure `reevalTransitionLegal(from,to)` helper in `reeval.ts`
(the single source of truth, mirroring the guard) rejecting illegal `(from,to)`
with 409 BEFORE the write; `from` read via a fresh SELECT inside the tx;
`count === 0` from the optimistic `updateMany ⇒ 409` (concurrent change);
`outcomePublicationId` validated via `resultPublication.findFirst({ id,
institutionId, examId })` with a 404 on miss, and permitted only when
`to === "REMARKED"`. Documented in §8.2, §9, AC (transition row of §8.7).

### Finding 7 (MEDIUM) — RLS policy swap confirmations — ADDRESSED

§7.1 now asserts explicitly: (a) the 8.1 INSERT path still satisfies the new
`FOR ALL` policy's `WITH CHECK` (institutionId is always the tenant GUC);
(b) the dropped policy name `result_publications_tenant_insert` is referenced
only in the escape harness `EXPECTED_POLICIES`, updated in lockstep; (c) the
policy/trigger swap is invisible to `prisma migrate diff` (Prisma models neither
RLS nor triggers), so AC#3's "NO DROP on any existing table" still holds.

### Finding 8 (NIT) — keep reeval guard frozen-columns aligned — ADDRESSED

§7.2 (frozen-column alignment note) requires the frozen set to stay byte-aligned
across the Prisma model, the migration columns, and the guard body, and §13 /
AC#17 add a behavioral assertion that an UPDATE of `studentReason` is rejected.
