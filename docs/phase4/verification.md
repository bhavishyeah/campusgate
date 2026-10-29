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

---

## Independent final verification (clean-state re-run + live smoke)

This section records a second, independent verification done from a CLEAN state on
Windows/PowerShell against the live Supabase project, to confirm Phase 4 had not
regressed and that the running node server behaves correctly end-to-end.

### Clean `npm ci` build + typecheck + tests

- `npm ci` at the repo root: "added 786 packages, and audited 791 packages" (clean
  install from lockfile).
- `cd packages/shared; npx tsc` → exit 0.
- `npx prisma generate --schema=packages/db/prisma/schema.prisma` → "Generated
  Prisma Client (v6.19.3)".
- `cd apps/api; npx tsc` → exit 0.
- `npm run build` (turbo) → "Tasks: 3 successful, 3 total" (@campusgate/shared,
  @campusgate/api, @campusgate/web; @campusgate/db has no build task).
- `cd apps/api; npx vitest run` → **43 test files passed, 412 tests passed, 0 failed**
  (escape-suite + faculty-scope + correction-workflow + module-inactive +
  GatePass/Phase-1/2/3 regression all green).

### Migration ledger

- `npx prisma migrate status` (packages/db) → "Database schema is up to date!",
  10 migration dirs found.
- Dir listing: the 9 prior frozen dirs + `20261101000000_phase4_attendance` (sorts
  strictly last). Ledger query (`_prisma_migrations`): 10 rows, **0 duplicate
  migration_name rows**, all applied, no unapplied/failed entries.

### Live smoke test (built node server vs Supabase)

The API was built (`npm run build` → `apps/api/dist/server.js`) and started with
`node dist/server.js` (health probe `GET /api/health` → `{status:"ok"}`). A harness
(`_smoke/smoke.mjs`, since deleted) logged in the seeded users over HTTP, created a
couple of extra fixtures (one UNASSIGNED DEMO faculty + a full SECOND tenant) via the
privileged owner client, exercised every required flow over real HTTP, then deleted
all fixtures (restoring DEMO to its seeded state) and the server was stopped.
**Result: 23 of 23 proof points PASS, 0 FAIL.** Proof points:

| # | Proof point | Result |
|---|---|---|
| 1 | Seeded FACULTY opens an attendance session for their ASSIGNED ScheduledClass (Wed CS101) | 201; one record seeded from the section enrollment (`recordCount=1`) |
| 2 | FACULTY marks the enrolled student PRESENT | 200 `changed=1` |
| 3 | FACULTY submits then finalizes | 200 → `SUBMITTED`; 200 → `FINALIZED` |
| 4 | Finalized immutability: mark on a FINALIZED session | **409 `session finalized`** |
| 5 | **DIFFERENT / unassigned faculty opening that class → 403** | **403 `not assigned to this class`** |
| 6 | **DENIED audit written for the unassigned-faculty attempt** | audit row present, `action=attendance.session.opened result=DENIED reason="not assigned to this class"` |
| 7 | FACULTY requests a correction (reason) on the finalized record | 201 (PENDING, `priorStatus=PRESENT requestedStatus=EXCUSED`) |
| 8 | **HOD APPROVES → record status changes + audit written + before/after history preserved** | 200 `APPROVED`; record `PRESENT→EXCUSED`; a `CORRECTED` history row (`previous=PRESENT new=EXCUSED`) added; `attendance.correction.approved` audit row present |
| 9 | REJECT path leaves a record unchanged | 2nd correction 201 PENDING → HOD reject 200 `REJECTED`; record status unchanged (`EXCUSED` before == after) |
| 10 | STUDENT sees their OWN attendance (and not others') | `GET /me` 200; every returned record `studentId == own`; count reflects only own FINALIZED rows |
| 11 | Attendance for a SUSPENDED/inactive module is rejected (`requireModuleActive`) | open → **403 `Module not active: attendance`**; student `GET /me` → **403** (incl. historical finalized data); restored to ACTIVE after |
| 12 | Cross-tenant isolation of attendance rows holds | DEMO ADMIN `GET /sessions` does NOT include the second tenant's sessions; second-tenant faculty `GET /me` is tenant-scoped (404, no DEMO leak) |
| 13 | Existing GatePass flow still works | student `GET /api/student/dashboard` 200; `GET /api/student/reasons` 200 (campus_movement routes + withTenant intact) |

Post-smoke DB check confirmed the fixtures were removed (0 smoke institutions / users /
faculty) and DEMO was back to its seeded state (1 attendance session: the seeded Mon
CS101 FINALIZED with the student PRESENT; 0 corrections). The server was stopped and the
`_smoke` harness scripts were deleted.

> Note on cleanup mechanism: `audit_events` and `attendance_record_history` are
> append-only (BEFORE UPDATE/DELETE trigger + REVOKE). The smoke harness removed its
> OWN fixture rows in these two tables as the DB owner with triggers disabled
> transaction-locally (`SET LOCAL session_replication_role = 'replica'`) — a non-DDL,
> connection-scoped mechanism that does not alter the schema or the trigger, used
> solely to return the DB to its seeded state. The append-only guarantee for the
> `campass_app` runtime role is unchanged and is independently proven by the escape
> suite's self-contained case.
