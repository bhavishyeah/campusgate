# Implementation Plan — CAMPASS Phase 8 EXAMINATIONS SLICE 8.2 (backend only)

Source of truth: the APPROVED design at `.agents/tasks/phase8-exams-slice2/design.md`
(REV 2) and its approval `design-review.md` (0 HIGH, 0 MEDIUM, 4 NIT — all NITs
folded into the steps below). Work on branch `main` in `c:\campusgate` (no
worktree). Do NOT push/deploy.

This plan sequences the work faithfully from the design; it does not re-decide
the architecture. Each item leaves the repo buildable. Ordering is by dependency:
shared catalogues + schema + migration first (so Prisma Client + types exist),
then the service helper, then routes, then the harness + test edits last.

Build/test commands discovered during exploration (use these verbatim in verify
steps):
- Typecheck/build API: `npm run build -w @campusgate/api` (runs `prisma generate`
  then `tsc`).
- Fast suite (mocked, no DB): `npm test -w @campusgate/api` (≥ 484 tests today).
- Live-DB suite (in isolation): `npm run test:integration -w @campusgate/api`.
- Prisma (run from `packages/db`, NEVER `migrate dev`):
  `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma`
  (confirm NO DROP on an existing table — only the long-standing composite-vs-single-FK
  cosmetic diff), then `npx prisma migrate deploy`, then `npx prisma migrate status`
  (→ up to date). There is no npm script wrapper for these; invoke `npx prisma`
  directly with `--schema=prisma/schema.prisma`.

Confirmed facts grounding the plan (read from the real 8.1 sources):
- `ExaminationType` already has `SUPPLEMENTARY`; `ResultPublicationStatus` already
  has `SUPERSEDED`; `examinationTypeEnum` Zod enum already lists `"SUPPLEMENTARY"`.
  8.2 adds NO enum VALUES to those two; it adds ONE new enum `ReevalRequestStatus`.
- `exams.ts` publish route accepts `status APPROVED||PUBLISHED`, computes
  `nextVersion=(latest?.version??0)+1`, requires `reason` when `nextVersion>1`,
  re-grades + writes snapshots, does NOT flip prior version. `latestPublication`
  orders by `version desc` with NO status filter.
- `marks_records_guard` freezes only identity columns + DELETE; `marks` is
  mutable (the 8.1 correct route does `update({ marks, enteredByUserId })` + a
  `marksRecordHistory.create` with `actorMembershipId: request.auth?.membershipId ?? null`).
- Helpers in `exams.ts` to reuse: `actor`, `deny`/`isDeny`, `isUniqueViolation`,
  `isRestrictViolation`, `advisoryLock`, `advanceExamStatus`, `latestPublication`.
- RBAC today: 8 `exams.*` permission keys; ADMIN+HOD each hold the 6 management
  keys; FACULTY `exams.marks.enter`; STUDENT `exams.results.view_own`; 14 exam
  role_permission pairs seeded in shared + the 8.1 migration §j.
- `catalogue-sync.test.ts` `SEEDING_MIGRATION_DIRS` lists the 8.1 dir and parses
  the permissions span up to `ON CONFLICT` and the role_permissions span up to
  `AS m(`.
- Audit keys live only in `AUDIT_ACTIONS` (`audit-actions.ts`), validated in
  `recordAuditEvent` against `AUDIT_ACTION_KEY_SET`; no migration mirror, no pg enum.
- `tenant-escape-setup.ts`: `EXPECTED_POLICIES.result_publications =
  [tenant_isolation_select, result_publications_tenant_insert]`;
  `DEFAULT_POLICIES = [tenant_isolation_select, tenant_isolation_modify]`;
  `RLS_TABLES` already includes `result_publications`; the exams tables are seeded
  in the generic `seedTenant` loop and torn down in `cleanup` (examinations +
  marks_records with a scoped trigger-disable); counted in `countRemainingTestRows`.
- `apps/api/src/services/exams/` currently holds only `grading.ts` (no `reeval.ts` yet).

Across-file invariant the coder MUST keep byte-aligned (finding 8): the
`reeval_requests` FROZEN column set — `institutionId, examId, candidateId,
studentId, subjectId, sourcePublicationId, studentReason, requestedByUserId,
createdAt` — must match across the Prisma model (item 2), the migration CREATE
TABLE (item 1), and the guard body (item 1). Mutable set: `status, staffNote,
processedByUserId, outcomePublicationId, updatedAt`.

---

- [ ] 1. Hand-author the 8.2 migration `packages/db/prisma/migrations/20261213000000_phase8_exams_slice2/migration.sql` in the 8.1 a–j house style, with the non-additive operations appended as explicitly-labelled sections k/l/m (NIT-4). Do this FIRST so the DB objects exist before `prisma generate` runs in later builds. Mirror the 8.1 idioms exactly (DO-$$-guarded `pg_roles` GRANT, `nullif(current_setting('app.current_institution_id', true), '')` RLS, composite same-tenant FKs incl. `institutionId`, `BEFORE UPDATE OR DELETE ... FOR EACH ROW` triggers). Contents, in order:
      - a. `CREATE TYPE "ReevalRequestStatus" AS ENUM ('REQUESTED','UNDER_REVIEW','REMARKED','CLOSED','REJECTED');` (add NO value to `ExaminationType`/`ResultPublicationStatus`).
      - b. `CREATE TABLE "reeval_requests"` with columns exactly: `id, institutionId, examId, candidateId, studentId, subjectId, sourcePublicationId, status ReevalRequestStatus NOT NULL DEFAULT 'REQUESTED', studentReason, requestedByUserId, processedByUserId (nullable), staffNote (nullable), outcomePublicationId (nullable), createdAt DEFAULT CURRENT_TIMESTAMP, updatedAt TIMESTAMP(3) NOT NULL` + PK on `id`.
      - c. indexes: `(id, institutionId)` unique; `(institutionId)`, `(institutionId, examId)`, `(institutionId, studentId)`, `(institutionId, candidateId)`, `(institutionId, status)`; the partial unique `reeval_requests_open_unique ON ("institutionId","candidateId","subjectId") WHERE "status" IN ('REQUESTED','UNDER_REVIEW','REMARKED')` (design §6.2).
      - d. tenant-root FK `institutionId -> institutions(id) RESTRICT`.
      - e. composite same-tenant FKs: `(institutionId,examId)->examinations`, `(institutionId,candidateId)->candidates`, `(institutionId,studentId)->student_profiles`, `(institutionId,subjectId)->subjects`, `(institutionId,sourcePublicationId)->result_publications`, all `ON DELETE RESTRICT ON UPDATE CASCADE`. `requestedByUserId`/`processedByUserId`/`outcomePublicationId` carry NO FK (actor-id / cycle-avoidance precedent).
      - f. CHECK `char_length("studentReason") >= 1`.
      - g. RLS ENABLE+FORCE on `reeval_requests` with the standard pair `{tenant_isolation_select, tenant_isolation_modify}` (nullif-guarded, column-guard class carries modify).
      - h. `reeval_requests_guard()` trigger — verbatim from design §7.2: raise on DELETE; freeze the FROZEN set above; permit ONLY `REQUESTED→UNDER_REVIEW`, `UNDER_REVIEW→REMARKED`, `REMARKED→CLOSED`, `REQUESTED→REJECTED`, `UNDER_REVIEW→REJECTED`, plus the no-op self-transition; reject everything else with `restrict_violation`. Bind `BEFORE UPDATE OR DELETE ON "reeval_requests" FOR EACH ROW`.
      - i. guarded GRANT `SELECT, INSERT, UPDATE, DELETE ON "reeval_requests" TO "campass_app"` (inside the `pg_roles` existence `DO $$`; never BYPASSRLS).
      - j. catalogue seed: append to the `INSERT INTO "permissions" (...) VALUES ... ON CONFLICT ("key") DO NOTHING` the two rows `('perm_exams_reeval_request_own','exams.reeval.request_own','examinations',<desc>)` and `('perm_exams_reeval_manage','exams.reeval.manage','examinations',<desc>)`; and to the `INSERT INTO "role_permissions" ... FROM (VALUES ...) AS m("roleKey","permKey")` the three pairs `('STUDENT','exams.reeval.request_own')`, `('ADMIN','exams.reeval.manage')`, `('HOD','exams.reeval.manage')`. Keep the `INSERT INTO "permissions"` / `ON CONFLICT` and `INSERT INTO "role_permissions"` / `AS m(` markers intact (the catalogue-sync parser slices on them).
      - k. ALTER `examinations`: `ADD COLUMN "parentExaminationId" TEXT;` + `CREATE INDEX "examinations_institutionId_parentExaminationId_idx" ON "examinations"("institutionId","parentExaminationId");` + `ADD CONSTRAINT "examinations_parent_same_tenant_fkey" FOREIGN KEY ("institutionId","parentExaminationId") REFERENCES "examinations"("institutionId","id") ON DELETE RESTRICT ON UPDATE CASCADE;` (anchorable on the existing `(id,institutionId)` unique; nullable ADD COLUMN — no rewrite, no DROP).
      - l. `CREATE OR REPLACE FUNCTION "examinations_guard"()` re-authored from the 8.1 body with `parentExaminationId` ADDED to the frozen identity set (design §6.1); trigger binding unchanged (do NOT edit the frozen 8.1 dir).
      - m. `result_publications` backfill + trigger swap, in the EXACT order of design §7.1: (0) `ALTER TABLE "result_publications" DISABLE TRIGGER "result_publications_no_update_delete";` then the idempotent backfill `UPDATE ... SET status='SUPERSEDED' WHERE status='PUBLISHED' AND EXISTS (higher-version row for same (institutionId,examId))`; (1) `DROP TRIGGER IF EXISTS "result_publications_no_update_delete"` + `DROP FUNCTION IF EXISTS "result_publications_append_only"()`; (2) `CREATE OR REPLACE FUNCTION "result_publications_guard"()` + trigger (verbatim design §7.1: raise on DELETE; freeze every column except `status`; permit `status` change ONLY `PUBLISHED→SUPERSEDED` plus no-op); (3) `DROP POLICY IF EXISTS "result_publications_tenant_insert"` + `CREATE POLICY "tenant_isolation_modify" ... FOR ALL` (nullif-guarded USING+WITH CHECK), leave the SELECT policy; (4) guarded `GRANT UPDATE ON "result_publications" TO "campass_app"`. Leave `result_snapshots` + `marks_record_history` untouched.
      Files: `packages/db/prisma/migrations/20261213000000_phase8_exams_slice2/migration.sql` (new).
      Verify: after item 2's schema edits are in place, run (from `packages/db`) `npx prisma migrate deploy` then `npx prisma migrate status --schema=prisma/schema.prisma` → "up to date"; and `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma` → only the cosmetic composite-vs-single-FK diff, NO DROP on an existing table. Confirm the 15 prior migration dirs are byte-identical to HEAD (`git status --porcelain packages/db/prisma/migrations` shows only the new dir).

- [ ] 2. Mirror every migration object in `packages/db/prisma/schema.prisma` with the raw-SQL-in-migration comment convention (so Prisma Client gains the model/field; the composite FKs/triggers/RLS stay raw-SQL-only). Add: the `enum ReevalRequestStatus {...}`; the `model ReevalRequest {...}` exactly per design §6.2 (single-column Prisma relations to `Institution`/`Examination`/`Candidate`/`StudentProfile`/`Subject`/`ResultPublication`; `@@unique([id, institutionId])` + the five `@@index` lines; `@@map("reeval_requests")`); on `model Examination` add `parentExaminationId String?`, `parentExamination Examination? @relation("SupplementaryParent", fields: [parentExaminationId], references: [id])`, and `supplementaryChildren Examination[] @relation("SupplementaryParent")`; add the back-relation `reevalRequests ReevalRequest[]` to `Institution` (line ~316), `Examination` (~2562), `Candidate` (~2666), `StudentProfile` (~513), `Subject` (~1309), and `ResultPublication` (~2784, named back-relation for `sourcePublication`). Keep the partial unique index out of Prisma (raw SQL only) — add a comment noting it.
      Files: `packages/db/prisma/schema.prisma`.
      Verify: `npm run build -w @campusgate/api` (runs `prisma generate` + `tsc`) succeeds — Prisma Client typechecks with `tx.reevalRequest.*` and `Examination.parentExaminationId` available.

- [ ] 3. Add the two permission keys to `packages/shared/src/permissions.ts`: in `PERMISSIONS`, next to the `exams.*` block, `exams.reeval.request_own` (module `examinations`, STUDENT self-service re-eval request) and `exams.reeval.manage` (module `examinations`, staff re-eval processing + re-mark). In `ROLE_PERMISSIONS`, add `"exams.reeval.request_own"` to `STUDENT` and `"exams.reeval.manage"` to BOTH `ADMIN` and `HOD`. Do NOT grant either to FACULTY. (Count goes 8→10 exam keys, 14→17 exam pairs.)
      Files: `packages/shared/src/permissions.ts`.
      Verify: `npm run build -w @campusgate/api` compiles (shared is a workspace dep). Full set-equality is asserted in item 10.

- [ ] 4. Add the four audit keys to `packages/shared/src/audit-actions.ts` in the `exams.*` block of `AUDIT_ACTIONS`: `exams.reeval.requested`, `exams.reeval.transitioned`, `exams.reeval.remarked`, `exams.results.superseded` (plural `results`, finding 5), each `module: "examinations"` with a description from design §8.6. No migration mirror, no pg enum, no legacy-map entry (those are only for the 28 legacy enum values).
      Files: `packages/shared/src/audit-actions.ts`.
      Verify: `npm run build -w @campusgate/api` compiles; the `AuditActionKey` union now includes the four keys (used by item 8 routes).

- [ ] 5. Add the new Zod schemas to `packages/shared/src/validation.ts` next to the 8.1 exam schemas, plus their inferred-type exports (design §9). Extend `createExaminationSchema` with `parentExaminationId: cuidLikeString.optional()`. Add: `createReevalRequestSchema` `{ examId: cuidLikeString, subjectId: cuidLikeString, reason: z.string().min(1).max(500) }`; `transitionReevalSchema` `{ to: z.enum(["UNDER_REVIEW","REMARKED","CLOSED","REJECTED"]), note: z.string().min(1).max(500).optional(), outcomePublicationId: cuidLikeString.optional() }` with `.refine` requiring `note` when `to==="REJECTED"` and rejecting `outcomePublicationId` unless `to==="REMARKED"`; `remarkReevalSchema` `{ marksRecordId: cuidLikeString, marks: z.number().int().min(0), reason: z.string().min(1).max(500) }`; `listReevalQuerySchema` `{ status: ReevalRequestStatus-enum optional, examId: cuidLikeString optional }`; `registerSupplementaryCandidatesSchema` `{ subjectIds: z.array(cuidLikeString).min(1).max(1000), studentIds: z.array(cuidLikeString).max(5000).optional() }`. Add matching `export type ...Input = z.infer<...>` lines.
      Files: `packages/shared/src/validation.ts`.
      Verify: `npm run build -w @campusgate/api` compiles.

- [ ] 6. Create the re-eval service module `apps/api/src/services/exams/reeval.ts` with three pure/DB helpers used by the routes (design §8.2/§8.4/§13): (a) `reevalTransitionLegal(from, to): boolean` — the single source of truth mirroring `reeval_requests_guard` (legal edges: `REQUESTED→UNDER_REVIEW`, `UNDER_REVIEW→REMARKED`, `REMARKED→CLOSED`, `REQUESTED→REJECTED`, `UNDER_REVIEW→REJECTED`); (b) `assertSupplementaryLinkage(tx, institutionId, { type, parentExaminationId }): Promise<{ message: string } | null>` — returns a deny message when `type==="SUPPLEMENTARY"` and `parentExaminationId` is absent or does not resolve to a same-tenant examination, or when `type!=="SUPPLEMENTARY"` and `parentExaminationId` is present; else null; (c) `computeSupplementaryEligible(snapshots): Set<string>` — pure: given parent latest-PUBLISHED snapshots filtered to the requested subjects with `passed=false`, return the distinct eligible `studentId` set. Keep (a) and (c) DB-free so they are unit-testable (item 9).
      Files: `apps/api/src/services/exams/reeval.ts` (new).
      Verify: `npm run build -w @campusgate/api` compiles.

- [ ] 7. In `apps/api/src/routes/exams.ts`, add the student-facing helper `latestPublishedPublication(tx, institutionId, examId)` (filters `status: "PUBLISHED"`, `orderBy version desc` — finding 3) ALONGSIDE the existing `latestPublication` (keep the latter for staff/internal reads). Modify the existing `POST /` create handler (NIT-1): after the session/term/program `findFirst` checks and before `tx.examination.create`, call `assertSupplementaryLinkage(tx, institutionId, { type: data.type, parentExaminationId: data.parentExaminationId })`; on a non-null deny, record a DENIED `exams.examination.created` audit and `return deny(message, 400)`; add `parentExaminationId: data.parentExaminationId ?? null` to the `create` data.
      Files: `apps/api/src/routes/exams.ts`.
      Verify: `npm run build -w @campusgate/api` compiles. Behavioral coverage in item 11.

- [ ] 8. In `apps/api/src/routes/exams.ts`, add the new re-eval/supplementary/history routes and the supersede flip, all reusing the existing `actor`/`deny`/`isDeny`/`isUniqueViolation`/`isRestrictViolation`/`advisoryLock`/`advanceExamStatus` helpers, every route carrying `requireModuleActive("examinations")` + `requirePermission(...)`, every handler inside `withTenant`, every mutation + deny writing an `exams.*` audit in-tx (design §8.1–8.5, §8.7 matrix). NO fees import. Specifically:
      - `POST /me/reeval` (`exams.reeval.request_own`): resolve own `StudentProfile` (404 if none); `latestPublishedPublication` (404 "no published result"); find own candidate row + the snapshot for `(resultPublicationId=latest.id, studentId=own, subjectId)` (404 if none — never reveal another student's data); INSERT `REQUESTED` with `sourcePublicationId=latest.id, studentReason=reason, requestedByUserId=userId`; map the partial-unique P2002 → 409 "a re-evaluation request is already open"; audit `exams.reeval.requested`.
      - `GET /me/reeval` (`exams.reeval.request_own`): own requests, `orderBy createdAt desc, id asc`.
      - `GET /reeval` (`exams.reeval.manage`): tenant requests filtered by `listReevalQuerySchema` (`status`/`examId`), `orderBy createdAt asc, id asc`.
      - `POST /reeval/:id/transition` (`exams.reeval.manage`): SELECT current `{status:from, examId, institutionId}` (404 if missing); `reevalTransitionLegal(from,to)` → 409 "illegal re-evaluation transition" BEFORE any write; body rules (note required for REJECTED → 400; `outcomePublicationId` only when `to==="REMARKED"` → 400); validate `outcomePublicationId` via `tx.resultPublication.findFirst({ id, institutionId, examId })` (404 on miss); optimistic `updateMany where:{ id, institutionId, status: from }` with `count===0 ⇒ 409` "re-evaluation request changed concurrently"; set `processedByUserId`, `staffNote`, `outcomePublicationId` as supplied; audit `exams.reeval.transitioned` `{from,to}`. Map `isRestrictViolation` → 409 backstop.
      - `POST /reeval/:id/remark` (`exams.reeval.manage`, §8.2a): SELECT request `{status, examId, candidateId, institutionId}` (404); `status!=="UNDER_REVIEW"` → 409 "request not under review"; load `marks_records` by `{ id: marksRecordId, institutionId, examId: request.examId, candidateId: request.candidateId }` (404 "marks record not found for this request"); load the assessment `maxMarks`, `marks<0||marks>maxMarks` → 400 "marks out of range" + DENIED audit; `tx.marksRecord.update({ where:{id}, data:{ marks, enteredByUserId: userId } })`; `tx.marksRecordHistory.create({ data:{ institutionId, marksRecordId, changeType:"CORRECTED", previousMarks, newMarks: marks, actorUserId: userId, actorMembershipId: request.auth?.membershipId ?? null, reason } })` (NIT-3 — spell out `actorMembershipId`); audit `exams.reeval.remarked` `{marksRecordId, previousMarks, newMarks}`. Exam status is NOT touched.
      - Supersede flip inside the EXISTING `POST /:id/publish` (design §8.3): after the new version header + snapshots are written and BEFORE returning, when `nextVersion>1`, `const flipped = await tx.resultPublication.updateMany({ where:{ institutionId, examId, version: nextVersion-1, status:"PUBLISHED" }, data:{ status:"SUPERSEDED" } })`; `if (flipped.count !== 1) return deny("prior version not in PUBLISHED state", 409)`; emit `exams.results.superseded` SUCCESS with `resourceType:"ResultPublication"`, `resourceId: publication.id` (the new header) and metadata `{ supersededVersion: nextVersion-1, byVersion: nextVersion }` (NIT-2 — pin resourceId to the new header). Keep the existing `exams.results.published` audit + preHandler ordering + advisory lock unchanged.
      - `POST /:id/candidates/supplementary` (`exams.candidates.manage`, §8.4, finding 4): load the exam (409 if not `SUPPLEMENTARY` or no `parentExaminationId`); `latestPublishedPublication(parentExaminationId)` (409 "parent results not published"); read parent snapshots under that publication with `subjectId IN subjectIds AND passed=false` → `computeSupplementaryEligible` → eligible set; target = `studentIds ?? [...eligible]`; if `studentIds` present assert `studentIds ⊆ eligible` else 409 "one or more students are not eligible" + DENIED audit (atomic, never partial); for each target without an existing candidate row create `{ institutionId, examId, studentId }` skipping P2002; audit `exams.candidate.registered` (reuse 8.1 key) with `{ supplementaryOf: parentExaminationId, eligibleCount, registeredCount }`.
      - `GET /me/results/history` (`exams.results.view_own`, §8.5): own `StudentProfile`; own candidate rows → distinct examIds; per exam `latestPublishedPublication` + its own snapshots; shape per design §8.5; `orderBy publishedAt desc, examId asc`, subjects `subjectId asc`; PUBLISHED-only, own-only.
      - `GET /students/:studentId/results/history` (`exams.results.view`): named same-tenant student; ALL versions per exam tagged `status`, `orderBy examId asc, version desc` (includes superseded).
      - `GET /students/:studentId/results/history.xlsx` (`exams.results.view`): ExcelJS workbook (the existing `results.xlsx` precedent in this file — reuse the `ExcelJS.Workbook()`/`addWorksheet`/`writeBuffer`/Content-Disposition pattern) with one "Transcript" sheet (columns Exam/Type/Session/Term/Subject/Percent/Grade/Grade Points/Passed/Version/Status); audit `exams.results.exported`.
      Files: `apps/api/src/routes/exams.ts`.
      Verify: `npm run build -w @campusgate/api` compiles. End-to-end behavior proven in item 11.

- [ ] 9. Add the fast (mocked, no-DB) unit tests for the pure helpers + schemas, extending the ≥484-green suite (design §13). Cover: `reevalTransitionLegal` — every legal edge true, a representative illegal set (e.g. `REQUESTED→REMARKED`, `REMARKED→REJECTED`, `CLOSED→*`, `REJECTED→*`, backward edges) false; `computeSupplementaryEligible` — distinct non-passing union across subjects, empty when all passed; the new Zod schemas accept valid shapes and reject the `.refine` violations (`REJECTED` without `note`; `outcomePublicationId` with `to!=="REMARKED"`). Place beside the existing exam/shared unit tests (match the directory of the current fast exam/validation tests).
      Files: `apps/api/src/services/exams/__tests__/reeval.test.ts` (new) and/or a shared validation test file following the existing fast-test layout.
      Verify: `npm test -w @campusgate/api` → all fast tests pass (count ≥ 484 + the new tests).

- [ ] 10. Update the catalogue-sync meta-test `apps/api/src/services/__tests__/catalogue-sync.test.ts`: append `"20261213000000_phase8_exams_slice2"` to `SEEDING_MIGRATION_DIRS`. (The permission + role_permission spans in the 8.2 migration from item 1.j are what make set-equality hold against the shared edits from item 3.)
      Files: `apps/api/src/services/__tests__/catalogue-sync.test.ts`.
      Verify: `npm test -w @campusgate/api` → the catalogue-sync set-equality tests pass (10 exam permission keys, 17 exam role_permission pairs reconcile across shared + the unioned migration seeds; no dangling/drift).

- [ ] 11. Extend the live-DB behavioral suite `apps/api/src/routes/__tests__/exams-behavioral.integration.test.ts` (self-contained `EXAM_TEST_` prefix; must pass IN ISOLATION — NFR-5) to prove each acceptance item (design §13, AC list): end-to-end re-eval (request → `UNDER_REVIEW` → `POST /reeval/:id/remark` mutates a mark on the PUBLISHED exam → `REMARKED` → `POST /:id/publish` creates version N+1 and flips prior to `SUPERSEDED` → student `/me/results/history` sees ONLY the latest; staff history shows both); the re-mark route rejects an out-of-scope record and a non-`UNDER_REVIEW` request and out-of-range marks; the backfill establishes the single-PUBLISHED invariant for a pre-seeded multi-version exam and the supersede `flipped.count===1` holds; the `result_publications_guard` (legal `PUBLISHED→SUPERSEDED` succeeds; `SUPERSEDED→PUBLISHED`, any other column mutation, and DELETE all → 409); `result_snapshots` still strictly append-only; transition legality (`count===0 ⇒ 409`, illegal `(from,to)` → 409, `outcomePublicationId` scope → 404); supplementary linkage (non-SUPPLEMENTARY with a parent and SUPPLEMENTARY without one both rejected) + the single registration contract (omitted vs allowlist, atomic 409 on an ineligible id) + a supplementary exam running the 8.1 pipeline; both history read models (own PUBLISHED-only via `latestPublishedPublication` vs staff incl. superseded); and the `.xlsx` export streams a valid workbook + writes `exams.results.exported`. Also assert staff-only gating (FACULTY/STUDENT → 403 on `exams.reeval.manage` routes).
      Files: `apps/api/src/routes/__tests__/exams-behavioral.integration.test.ts`.
      Verify: `npm run test:integration -w @campusgate/api` run for this suite in isolation → all new + existing cases pass.

- [ ] 12. Extend the tenant-escape harness `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` (design §13/§17): seed a `reeval_requests` row in `seedTenant` as a column-guard-class table (child of the already-seeded examination/candidate/student/subject + a seeded `result_publications` row for `sourcePublicationId` — note: `result_publications` is INSERT-only, so seed it via adminClient; the reeval row's teardown uses a scoped `DISABLE TRIGGER "reeval_requests_guard"` dance mirroring the `examinations`/`marks_records` teardown); add its id to `SeededTenant`, the return object, `cleanup` (delete before `candidates`/`examinations`, triggers disabled), and `countRemainingTestRows`. Add `"reeval_requests"` to `RLS_TABLES`. REMOVE the `result_publications` entry from `EXPECTED_POLICIES` so it falls through to `DEFAULT_POLICIES` (the swap replaced `result_publications_tenant_insert` with `tenant_isolation_modify`); do NOT add a `reeval_requests` entry (it uses the default pair). Then extend the escape integration suite (the file that imports this helper) with: cross-tenant read/spoofed-write/foreign-parent isolation on `reeval_requests` and on the new `examinations.parentExaminationId` link, and an assertion that an UPDATE of a FROZEN column (`studentReason`) is rejected by `reeval_requests_guard` (409) (finding 8).
      Files: `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` and the tenant-escape integration spec that consumes it.
      Verify: `npm run test:integration -w @campusgate/api` run for the tenant-escape suite in isolation → the RLS meta-test (policy-name sets incl. `result_publications` now = `DEFAULT_POLICIES`, `reeval_requests` RLS enabled + default pair) and the new escape/guard assertions pass; teardown leaves zero `ESCAPE_TEST_` rows.

- [ ] 13. Final full-gate verification. Confirm no fees import was introduced in any touched file; the 15 frozen migration dirs are byte-untouched; `prisma migrate status` is up to date.
      Files: none (verification only).
      Verify: `npm run build -w @campusgate/api` clean; `npm test -w @campusgate/api` green (≥ 484 + new fast tests); `npm run test:integration -w @campusgate/api` — `exams-behavioral.integration` and `tenant-escape.integration` each pass IN ISOLATION; `grep` for a fees import in `exams.ts`/`reeval.ts` returns nothing; `git status --porcelain packages/db/prisma/migrations` shows only the new `20261213000000_phase8_exams_slice2` dir.

---

## Digest

Files touched, the block to change, the test that covers it, and what was
verified. The coder edits only these spans; everything else is raw-SQL-in-migration.

### `packages/db/prisma/migrations/20261213000000_phase8_exams_slice2/migration.sql` (NEW)
- The whole file. Sections a–j mirror the 8.1 dir for the new `reeval_requests`
  table + `ReevalRequestStatus` enum + the two-permission / three-pair catalogue
  seed (same `INSERT INTO "permissions" ... ON CONFLICT` and `INSERT INTO
  "role_permissions" ... AS m(` marker shapes the catalogue-sync parser expects).
  Sections k (ALTER `examinations` + parent self-FK + index), l (re-authored
  `examinations_guard` freezing `parentExaminationId`), m (the `result_publications`
  DISABLE-trigger → idempotent backfill → DROP append-only trigger/function →
  CREATE `result_publications_guard` → DROP `result_publications_tenant_insert` +
  CREATE `tenant_isolation_modify` → GRANT UPDATE) are appended as explicitly
  non-additive. Backfill + swap SQL is quoted verbatim in design §7.1; the
  reeval guard in §7.2.
- Covered by: `catalogue-sync.test.ts` (seed spans), `tenant-escape.integration`
  (RLS/policy/guard), `exams-behavioral.integration` (backfill + supersede guard).
- Verified today: `npx prisma migrate deploy` applies; `migrate status` up to
  date; `migrate diff` shows only the cosmetic composite-FK diff, NO DROP; 15
  frozen dirs byte-identical.

### `packages/db/prisma/schema.prisma`
- Add `enum ReevalRequestStatus`, `model ReevalRequest` (design §6.2 shape), the
  `parentExaminationId` field + `SupplementaryParent` self-relation on
  `Examination` (~2540–2577), and `reevalRequests ReevalRequest[]` back-relations
  on `Institution` (~316), `Examination` (~2562), `Candidate` (~2666),
  `StudentProfile` (~513), `Subject` (~1309), plus the named `sourcePublication`
  back-relation on `ResultPublication` (~2784).
- Covered by: the API build (`prisma generate` + `tsc`); routes use `tx.reevalRequest.*`.
- Verified today: `npm run build -w @campusgate/api` succeeds.

### `packages/shared/src/permissions.ts`
- `PERMISSIONS`: +`exams.reeval.request_own`, +`exams.reeval.manage` (module
  `examinations`). `ROLE_PERMISSIONS`: STUDENT +`request_own`; ADMIN +`manage`;
  HOD +`manage`.
- Covered by: `catalogue-sync.test.ts` set-equality (item 10).
- Verified today: `npm test -w @campusgate/api` catalogue-sync green.

### `packages/shared/src/audit-actions.ts`
- `AUDIT_ACTIONS` `exams.*` block: +`exams.reeval.requested`,
  +`exams.reeval.transitioned`, +`exams.reeval.remarked`,
  +`exams.results.superseded`.
- Covered by: `exams-behavioral.integration` (every key emitted by a route;
  `recordAuditEvent` accepts them).
- Verified today: `npm run build` compiles (union type extended).

### `packages/shared/src/validation.ts`
- Extend `createExaminationSchema` (`parentExaminationId?`); add
  `createReevalRequestSchema`, `transitionReevalSchema` (+`.refine` rules),
  `remarkReevalSchema`, `listReevalQuerySchema`,
  `registerSupplementaryCandidatesSchema` + inferred-type exports.
- Covered by: the fast schema unit tests (item 9).
- Verified today: `npm test -w @campusgate/api` green.

### `apps/api/src/services/exams/reeval.ts` (NEW)
- `reevalTransitionLegal(from,to)`, `assertSupplementaryLinkage(tx, …)`,
  `computeSupplementaryEligible(snapshots)`.
- Covered by: `apps/api/src/services/exams/__tests__/reeval.test.ts` (item 9) +
  `exams-behavioral.integration` (linkage/eligibility).
- Verified today: `npm run build` + `npm test` green.

### `apps/api/src/routes/exams.ts`
- Add `latestPublishedPublication` helper beside `latestPublication`. Modify the
  existing `POST /` create (linkage check + persist `parentExaminationId`). Add
  `POST /me/reeval`, `GET /me/reeval`, `GET /reeval`, `POST /reeval/:id/transition`,
  `POST /reeval/:id/remark`, `POST /:id/candidates/supplementary`,
  `GET /me/results/history`, `GET /students/:studentId/results/history`,
  `GET /students/:studentId/results/history.xlsx`. Add the supersede flip +
  `exams.results.superseded` audit inside the existing `POST /:id/publish`
  (resourceId = new header; metadata `{supersededVersion, byVersion}`). Reuse
  `actor`/`deny`/`isDeny`/`isUniqueViolation`/`isRestrictViolation`/`advisoryLock`.
  NO fees import.
- Covered by: `exams-behavioral.integration` (item 11) for every route + the flip;
  staff-only 403 gating.
- Verified today: `npm run build` compiles; integration suite passes in isolation.

### `apps/api/src/services/exams/__tests__/reeval.test.ts` (NEW) + fast schema test
- Pure-helper + Zod-schema cases (item 9).
- Verified today: `npm test -w @campusgate/api` green.

### `apps/api/src/services/__tests__/catalogue-sync.test.ts`
- `SEEDING_MIGRATION_DIRS` += `"20261213000000_phase8_exams_slice2"`.
- Covered by: its own set-equality assertions.
- Verified today: `npm test -w @campusgate/api` green.

### `apps/api/src/routes/__tests__/exams-behavioral.integration.test.ts`
- New cases per item 11 (AC-by-AC).
- Verified today: `npm run test:integration -w @campusgate/api` (this suite, in
  isolation) green.

### `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` + the tenant-escape spec
- Seed/return/cleanup/count `reeval_requests` (column-guard-class teardown dance +
  a seeded `result_publications` parent for `sourcePublicationId`); `RLS_TABLES`
  += `reeval_requests`; REMOVE the `result_publications` entry from
  `EXPECTED_POLICIES`; new escape + frozen-column-guard assertions in the spec.
- Verified today: `npm run test:integration -w @campusgate/api` (tenant-escape, in
  isolation) green; teardown leaves zero `ESCAPE_TEST_` rows.

### What I verified about the baseline (pre-change)
- `npm test -w @campusgate/api` is the fast gate (≥ 484 tests today).
- `npm run test:integration -w @campusgate/api` runs the live-DB suites; each
  must be run IN ISOLATION (free-tier pooler flakes on combined runs).
- `exams.ts` publish route, `latestPublication`, the `deny`/`actor` helpers,
  `marks_records_guard` permitting a `marks` UPDATE, and the 8.1 migration's
  append-only `result_publications` trigger were all read and confirmed as the
  design states; the coder should re-open each file only to edit the spans above.
