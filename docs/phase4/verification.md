# CAMPASS Phase 4 — Attendance — Verification Evidence (BACKEND ONLY)

This file records the exact commands run to verify Phase 4 and their results, so a
reviewer can read the evidence without re-running. Scope: `apps/api` +
`packages/db` + `packages/shared` (no `apps/web`, per roadmap Option A).

## Migration (hand-authored, never `migrate dev`/`reset`)

New dir: `packages/db/prisma/migrations/20261101000000_phase4_attendance/migration.sql`
(CREATE-only + catalogue seed; the 9 prior dirs and the `_prisma_migrations`
ledger were not edited).

- Pre-flight — `npx prisma migrate status` (packages/db): reported 10 migration
  dirs found, the 9 prior applied, `20261101000000_phase4_attendance` the only
  pending one, no drift, no sibling claiming an earlier slot.
- Read-only DDL confirm — `npx prisma migrate diff --from-schema-datasource
  prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`:
  showed the four new enums (`AttendanceSessionStatus`, `AttendanceStatus`,
  `AttendanceCorrectionReviewStatus`, `AttendanceRecordHistoryChangeType`), the
  four new tables (`attendance_sessions`, `attendance_records`,
  `attendance_corrections`, `attendance_record_history`) with their indexes +
  tenant-root/composite FKs, and the one additive
  `scheduled_classes(institutionId, id, academicTermId)` UNIQUE. (The diff also
  lists DropForeignKey/AddForeignKey churn for the pre-existing composite FKs on
  the frozen tables — that is Prisma's known non-modeling of hand-authored
  composite/3-col FKs; the hand-authored migration does NOT drop any existing FK,
  it only CREATEs the new objects.)
- Apply — `npx prisma migrate deploy`: "Applying migration
  `20261101000000_phase4_attendance`" → "All migrations have been successfully
  applied."
- Post-apply — `npx prisma migrate status`: "Database schema is up to date!"
  (10 dirs, no duplicates, the 9 frozen dirs unchanged).

## DB smoke checks (database.md §6)

- campass_app role flags — `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE
  rolname = 'campass_app'` → `rolsuper: false, rolbypassrls: false` (unchanged;
  never granted BYPASSRLS).
- Fail-closed — a `count(*)` on `attendance_sessions` as campass_app with NO
  tenant GUC set → `0` rows.
- Append-only — as campass_app under a tenant GUC, `UPDATE` and `DELETE` of
  `attendance_record_history` both rejected (`permission denied` via the REVOKE
  layer; the BEFORE UPDATE/DELETE trigger is the second backstop). Both blocked.

## Seed (`npx tsx packages/db/src/seed.ts`)

Ran clean. New Phase-4 lines confirmed:
- "attendance module entitled + activated for demo tenant" (DEMO `attendance`
  `InstitutionModule` row = ACTIVE).
- "Sample FINALIZED AttendanceSession (Mon CS101) + BCA student PRESENT created"
  (sample session + record landed against the Phase-3 seeded section/enrollment/
  faculty/scheduled class; the student marked PRESENT).

## Clean build (MANDATORY)

- `npm ci` at repo root: "added 786 packages … audited 791 packages" (clean
  install). One transient Prisma engine CDN `ECONNRESET` occurred during a
  subsequent `prisma generate`; retried per the plan and it succeeded.
- `cd packages/shared && npx tsc`: exit 0 (no errors).
- `npx prisma generate --schema=packages/db/prisma/schema.prisma`: "Generated
  Prisma Client (v6.19.3)".
- `cd apps/api && npx tsc`: exit 0 (no errors).
- `npm run build` (turbo, all 4 packages): "Tasks: 3 successful, 3 total"
  (@campusgate/shared, @campusgate/api, @campusgate/web all built; @campusgate/db
  has no build task).

## Tests (`cd apps/api && npx vitest run`, fileParallelism=false)

Full suite: **43 test files passed, 412 tests passed, 0 failed.** Includes the new
Phase-4 suites and the full Phase 1/2/3 + GatePass/campus-movement + module-system
+ escape + catalogue-sync regression.

New Phase-4 coverage:
- Unit (no DB): `attendance-policy.test.ts` (rate across PRESENT/ABSENT/LATE/
  EXCUSED, EXCUSED excluded from numerator AND denominator, denominator-zero →
  null, threshold downward-crossing predicate, settings override vs defaults);
  `attendance-authz.test.ts` (the pure `assertFacultyAssigned` fast path + the
  `dayOfWeekToIndex` SUN=0..SAT=6 map).
- Routes wiring (mocked db): `attendance-routes.integration.test.ts` — permission
  gating per role, `requireModuleActive("attendance")` → 403 when the module is
  not ACTIVE (incl. `GET /me` on historical data, HOD report), faculty-scope 403 +
  DENIED audit for an unassigned class, date-mismatch 409, CANCELLED-class 409,
  no-op correction 400, Zod 400, HOD approve applies + CORRECTED history + audit,
  stale-approve 409.
- Behavioral (live DB, real routes + real auth):
  `attendance-behavioral.integration.test.ts` — full lifecycle open→mark→submit→
  finalize with records + append-only history persisted; unassigned-faculty 403 +
  DENIED audit; correction workflow (request → HOD approve rewrites record +
  CORRECTED history + audit; PENDING-uniqueness 409; reject leaves record
  untouched, no history row); finalized immutability (mark on FINALIZED → 409;
  direct history UPDATE denied); student own-read isolation + rate; low-attendance
  notification + alert audit on the downward crossing; term-integrity via the
  three-column FK.
- Escape suite extended (`tenant-escape.integration.test.ts`): the three mutable
  attendance tables get read-escape / spoofed-write / foreign-parent / buggy-query
  / three-GUC fail-closed cases; `attendance_record_history` has the self-contained
  append-only case (insert OK, cross-tenant SELECT empty, UPDATE/DELETE denied) and
  is in the RLS-forced + no-modify-policy meta-assertion; the three-column
  session↔class↔term FK rejects a tampered `academicTermId`.
- Meta: `catalogue-sync.test.ts` green (the Phase-4 dir seeds exactly the nine new
  `(role, key)` pairs, union set-equal to `ROLE_PERMISSIONS`); `modules.test.ts`
  asserts `MODULE_DEPENDENCIES.attendance === []` and examinations keeps its three
  edges; `module-system.integration.test.ts` re-architected so the dependency
  state-machine exemplar now rides `examinations` (multi-dep) + `academic_sessions`
  (reverse-edge/suspend).
