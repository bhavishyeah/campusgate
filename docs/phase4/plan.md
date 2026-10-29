# CAMPASS Phase 4 — Attendance — Implementation Plan (BACKEND ONLY)

> Source of truth: the APPROVED design at `docs/phase4/design.md` (verdict APPROVED,
> 0 HIGH / 0 MEDIUM / 0 NIT in `docs/phase4/design-review.md`). This plan sequences that
> design faithfully; it does not re-decide the architecture. Scope is `apps/api` +
> `packages/db` + `packages/shared` — **no `apps/web`** (roadmap Option A deferral).
>
> Repo: `c:\campusgate` (Windows, PowerShell, Turborepo + npm workspaces), branch `main`,
> **no worktree**. Node ≥ 20. No new runtime dependency is introduced.
>
> **Build/test commands (discovered during exploration):**
> - Typecheck/build one package from its dir: `npm run build` (api runs `prisma generate` + `tsc`).
> - Whole repo: `npx turbo build` and `npx turbo lint` from `c:\campusgate`.
> - Unit tests (api): `cd apps/api && npx vitest run <path>` (vitest 4). `npm test` = `vitest run`.
> - Shared/db have no vitest suite; they are exercised by the api suites + the catalogue-sync meta-test.
> - Migrations: hand-authored, applied `prisma migrate diff` (read-only, DIRECT_URL) →
>   `prisma migrate deploy` → `prisma migrate status` from `packages/db` (NEVER `migrate dev`
>   against shared Supabase — `database.md` §6). The nine existing migration dirs are FROZEN.
> - Live DB verification + the `*.integration.test.ts` suites require live Supabase creds in
>   `apps/api/.env` (`DATABASE_URL` = campass_app, 6543) and `packages/db/.env`
>   (`DIRECT_URL` = postgres/owner, 5432). The escape/module-system/behavioral suites hit the live DB.
>
> **Ordering principle:** strict dependency chain — shared catalogues first (everything imports
> them), then schema + migration (routes and tests need the generated client + live tables), then
> module registration/seed, then routes, then seed sample data, then tests, then the clean
> build + full suite + live smoke. Each item leaves the codebase buildable.

---

# Implementation Plan

- [ ] 1. Add the five `attendance.*` permission keys + role mappings to the shared catalogue.
      Add to `PERMISSIONS` (module `"attendance"`): `attendance.view`, `attendance.mark`,
      `attendance.correct`, `attendance.export`, `attendance.view_own` (descriptions per design §5.1).
      Edit `ROLE_PERMISSIONS` in lockstep (design §5.2): `STUDENT += ["attendance.view_own"]`;
      `FACULTY += ["attendance.mark","attendance.view_own"]` (FACULTY currently holds only
      `["classes.view_own"]` — append, do not replace); `HOD += ["attendance.view",
      "attendance.correct","attendance.export"]`; `ADMIN += ["attendance.view","attendance.correct",
      "attendance.export"]`; `GUARD` and `SUPER_ADMIN` UNCHANGED (zero attendance pairs — the
      nine new `(role,key)` pairs in §5.2 total exactly nine). This is the matched pair of the
      migration seed in item 6; they must agree or catalogue-sync (item 15) fails.
      Files: `packages/shared/src/permissions.ts`
      Verify: `cd packages/shared && npx tsc --noEmit` compiles (then catalogue-sync runs in item 15).

- [ ] 2. Add the nine `attendance.*` audit-action keys to the shared audit catalogue.
      Append to `AUDIT_ACTIONS` (module `"attendance"`, all past-tense like the `classes.*` block):
      `attendance.session.opened`, `attendance.records.marked`, `attendance.session.submitted`,
      `attendance.session.finalized`, `attendance.correction.requested`,
      `attendance.correction.approved`, `attendance.correction.rejected`, `attendance.exported`,
      `attendance.low_attendance.alerted` (design §5.3). No pg enum / no migration mirror needed
      (validation is `AUDIT_ACTION_KEY_SET` only; `LegacyAuditAction` map is unchanged). The
      `AuditActionKey` union derives automatically, so `recordAuditEvent` calls in item 10 typecheck.
      Files: `packages/shared/src/audit-actions.ts`
      Verify: `cd packages/shared && npx tsc --noEmit` compiles.

- [ ] 3. Set `MODULE_DEPENDENCIES.attendance = []` (foundational-not-gated, design §4.2 Option a).
      Change the `attendance` edge from `["student_management","academic_sessions","class_course"]`
      to `[]` in `MODULE_DEPENDENCIES`. Leave `examinations` and `fees` edges untouched (they carry
      the re-pointed dependency-engine coverage in item 12). `MODULES` is unchanged (`attendance`
      key already present). This is the single cause of the item-12 test re-architecture.
      Files: `packages/shared/src/modules.ts`
      Verify: `cd apps/api && npx vitest run src/services/__tests__/modules.test.ts` — the generic
      acyclic/known-key/entry-per-key assertions stay green (emptying one edge list cannot break them).

- [ ] 4. Add the Zod request schemas for attendance to the shared validation module.
      Append to `packages/shared/src/validation.ts` (mirroring the Phase-3 `classes` block style),
      and export their inferred types at the bottom: `attendanceStatusEnum` =
      `z.enum(["PRESENT","ABSENT","LATE","EXCUSED"])`; `attendanceSessionStatusEnum` and
      `attendanceCorrectionReviewStatusEnum` if needed by responses;
      `openAttendanceSessionSchema` `{ scheduledClassId: string.min(1), date: z.coerce.date(),
      submissionDeadline?: z.coerce.date() }`; `markAttendanceRecordsSchema`
      `{ records: z.array({ studentId: string.min(1), status: attendanceStatusEnum }).min(1).max(1000) }`;
      `requestCorrectionSchema` `{ attendanceRecordId: string.min(1), requestedStatus:
      attendanceStatusEnum, reason: z.string().min(1).max(2000) }`; `reviewCorrectionSchema`
      `{ reviewNote?: z.string().max(2000) }`; `attendanceReportQuerySchema`
      `{ academicTermId: string.min(1) }` (required; used by `GET /me` and `GET /reports/section/:id`);
      `attendanceExportQuerySchema` `{ sectionId: string.min(1), academicTermId: string.min(1),
      format: z.enum(["csv","json"]).default("csv") }` (design §8.3/§8.5/§8.7/§11.1).
      Files: `packages/shared/src/validation.ts`
      Verify: `cd packages/shared && npx tsc --noEmit` compiles; `cd apps/api && npx vitest run
      src/services/__tests__/modules.test.ts src/services/__tests__/audit-actions.test.ts` still pass.

- [ ] 5. Add the four attendance Prisma models + enums + back-relations + the ScheduledClass unique.
      In `packages/db/prisma/schema.prisma` add enums `AttendanceSessionStatus
      {OPEN,SUBMITTED,FINALIZED}`, `AttendanceStatus {PRESENT,ABSENT,LATE,EXCUSED}`,
      `AttendanceCorrectionReviewStatus {PENDING,APPROVED,REJECTED}`,
      `AttendanceRecordHistoryChangeType {MARKED,CORRECTED}`; models `AttendanceSession`,
      `AttendanceRecord`, `AttendanceCorrection`, `AttendanceRecordHistory` exactly per design
      §3.2/§3.3/§3.4/§6.1 (every table: `institutionId` + `institution` relation,
      `@@unique([id, institutionId])`, `@@index([institutionId])` + the listed query indexes, the
      business uniques `AttendanceSession @@unique([scheduledClassId, date])` and `AttendanceRecord
      @@unique([attendanceSessionId, studentId])`, `@@map` to snake_case). Add the matching
      back-relation arrays to `Institution`, and the back-relation fields to `ScheduledClass`,
      `AcademicTerm`, `FacultyProfile`, `StudentProfile`, `AttendanceRecord` (history/corrections),
      `AttendanceSession` (records) so Prisma validates both sides. Add
      `@@unique([institutionId, id, academicTermId])` to `model ScheduledClass` (additive; the FK
      target for term integrity in item 7 — created in the Phase 4 migration, not by editing the
      frozen Phase 3 dir). Do NOT add Prisma `@relation` attributes for the composite/3-col FKs
      (those are hand-authored SQL in item 7) — the Prisma relations are the informational 2-col ones.
      Files: `packages/db/prisma/schema.prisma`
      Verify: `cd packages/db && npx prisma validate` passes, then `npx prisma generate` succeeds
      (the new delegates `attendanceSession` etc. exist on the client for items 10/11/13).

- [ ] 6. Hand-author the NEW migration dir `20261101000000_phase4_attendance/migration.sql`.
      Create the dir + `migration.sql` in the Phase-3 house style (sections a–j; model the file on
      `20261028000000_phase3_classes/migration.sql`). Header must state: CREATE-only + seed-only,
      the nine FROZEN dirs are never edited, `_prisma_migrations` untouched, campass_app stays
      NOSUPERUSER NOBYPASSRLS. Timestamp `20261101000000` sorts after `20261028000000`.
      Sections:
      (a) `CREATE TYPE` the four enums.
      (b) `CREATE TABLE` `attendance_sessions`, `attendance_records`, `attendance_corrections`
      (createdAt DEFAULT CURRENT_TIMESTAMP, updatedAt NOT NULL) and `attendance_record_history`
      (createdAt only, no updatedAt) + PKs.
      (c) Indexes: each `(id, institutionId)` unique; business uniques
      `attendance_sessions(scheduledClassId, date)` and `attendance_records(attendanceSessionId,
      studentId)`; every `(institutionId)` index + the §3 query indexes; the ADDITIVE
      `scheduled_classes(institutionId, id, academicTermId)` UNIQUE; the partial unique
      `attendance_corrections_one_pending ON (institutionId, attendanceRecordId) WHERE
      "reviewStatus" = 'PENDING'`.
      (d) Tenant-root FKs `institutionId → institutions(id) ON DELETE RESTRICT ON UPDATE CASCADE`
      on all four.
      (e) Composite same-tenant FKs (all RESTRICT/CASCADE): `attendance_sessions` three-column
      `(institutionId, scheduledClassId, academicTermId) → scheduled_classes(institutionId, id,
      academicTermId)` + `(institutionId, markedByFacultyId) → faculty_profiles(institutionId, id)`;
      `attendance_records` `(institutionId, attendanceSessionId) → attendance_sessions(institutionId,
      id)` + `(institutionId, studentId) → student_profiles(institutionId, id)`;
      `attendance_corrections` `(institutionId, attendanceRecordId) → attendance_records(institutionId,
      id)`; `attendance_record_history` `(institutionId, attendanceRecordId) →
      attendance_records(institutionId, id)`. `requestedByUserId`/`reviewedByUserId`/`actorUserId`/
      `correctionId` are recorded-id columns with NO FK.
      (f) CHECK: `attendance_corrections` `char_length("reason") >= 1`.
      (g) RLS ENABLE+FORCE on all four: standard nullif-guarded pair
      `{tenant_isolation_select, tenant_isolation_modify}` on the three mutable tables; append-only
      pair `{tenant_isolation_select, attendance_record_history_tenant_insert}` on
      `attendance_record_history` (verbatim house style from design §10).
      (h) `CREATE OR REPLACE FUNCTION "attendance_record_history_append_only"()` (RAISE EXCEPTION,
      ERRCODE `restrict_violation`) + `CREATE TRIGGER "attendance_record_history_no_update_delete"
      BEFORE UPDATE OR DELETE ... FOR EACH ROW`.
      (i) Guarded GRANT refresh inside `IF EXISTS (... rolname='campass_app')`: full
      SELECT/INSERT/UPDATE/DELETE on the three mutable tables; `GRANT SELECT, INSERT` + `REVOKE
      UPDATE, DELETE` on `attendance_record_history`. Never BYPASSRLS.
      (j) Catalogue seed: `INSERT INTO "permissions"` the five keys, then `INSERT INTO
      "role_permissions" SELECT ... FROM (VALUES ...) AS m("roleKey","permKey") JOIN "roles" r ...
      JOIN "permissions" p ...` for exactly the nine pairs in §5.2, with `ON CONFLICT ... DO NOTHING`
      and the SAME markers the Phase-3 block uses (so the catalogue-sync parser carves it out). The
      FACULTY template role already exists (seeded by phase3) — do NOT re-insert it.
      Files: `packages/db/prisma/migrations/20261101000000_phase4_attendance/migration.sql`
      Verify (item 16 runs the live apply): statically, `cd packages/db && npx prisma migrate diff
      --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma`
      is NOT the check; instead confirm the SQL parses by eye against the Phase-3 template and that
      every object name is unique. The authoritative verify is item 16 step 1–2 (diff → deploy → status).

- [ ] 7. Register the new migration dir with the catalogue-sync meta-test.
      Add `"20261101000000_phase4_attendance"` to `SEEDING_MIGRATION_DIRS` in
      `catalogue-sync.test.ts` (it seeds catalogue rows — `database.md` rule). Without this the
      union set-equality in item 15 would be missing the nine new pairs and fail.
      Files: `apps/api/src/services/__tests__/catalogue-sync.test.ts`
      Verify: deferred to item 15 (catalogue-sync passes once items 1 + 6 + 7 agree).

- [ ] 8. Create the pure attendance-policy helper (rate + threshold + settings).
      New `apps/api/src/services/attendance-policy.ts`: `attendancePolicy(settings: unknown):
      { presentStatuses: AttendanceStatus[]; lowAttendanceThresholdPercent: number;
      allowSelfCorrectionBeforeFinalize: boolean }` with the design §3.5 defaults
      (`["PRESENT","LATE"]`, `75`, `true`) when a key is absent/invalid; and
      `attendanceRate(records: { status: AttendanceStatus }[], policy): number | null` computing
      numerator = `status ∈ presentStatuses`, denominator = `status != EXCUSED`,
      `rate = denominator === 0 ? null : (numerator/denominator)*100` (design §8.6). Pure, no I/O.
      This is the ONE shared rate definition used by `GET /me`, the section report, and the alert.
      Files: `apps/api/src/services/attendance-policy.ts`
      Verify: `cd apps/api && npx tsc --noEmit` compiles (unit tests added in item 11).

- [ ] 9. Create the faculty-scope authz helper service.
      New `apps/api/src/services/attendance-authz.ts` exporting `resolveMarkingFaculty(tx,
      institutionId, userId)` (returns `{ facultyId }` for an ACTIVE `FacultyProfile` else null),
      `assertFacultyAssigned(tx, institutionId, facultyId, scheduled)` (fast path
      `scheduled.facultyId === facultyId`; else ACTIVE `FacultyAssignment` matching subject + term
      + section-or-null), and `dayOfWeekToIndex(day: DayOfWeek): number` (SUN=0..SAT=6, matching JS
      `getUTCDay()`), exactly per design §7.2/§8.3. Uses `Prisma.TransactionClient` typed from
      `@campusgate/db`. These run inside the request `withTenant` tx (RLS-scoped).
      Files: `apps/api/src/services/attendance-authz.ts`
      Verify: `cd apps/api && npx tsc --noEmit` compiles (unit test of the pure fast path in item 11).

- [ ] 10. Implement the attendance routes module and register it in the server.
      New `apps/api/src/routes/attendance.ts` (`attendanceRoutes`), registered in
      `apps/api/src/server.ts` at prefix `/api/attendance` (import + `app.register`). Mirror the
      `classes.ts` house pattern exactly: single top-level `authenticate` preHandler; per-route
      `requirePermission(key)` AND `requireModuleActive("attendance")`; every handler body in
      `withTenant(institutionId, tx => ...)` with `institutionId` from `request.user` only; a local
      `actor(request)` helper (`actorUserId=request.user.userId`, `actorRoleKey=request.auth?.roles[0]
      ?? request.user.role`, `actorMembershipId=request.auth?.membershipId ?? null`,
      `requestRef=request.id`); a local `attendanceDepartmentScopeFilter(request, kind)` returning
      `{ scheduledClass: { classSection: { program: { departmentId: scope } } } }` for a scoped HOD
      (and `{}` for ADMIN/non-HOD), modeled on `classesDepartmentScopeFilter`; out-of-scope row → 404.
      Routes per design §8.4 (all Zod-validate with the item-4 schemas, `400` = `error.flatten()`):
      - `POST /sessions` (`attendance.mark`): resolve marking faculty (§7.3 step 1, 403 `not a
        faculty member` with records-then-return DENIED audit — do NOT throw, let the withTenant
        callback return normally so the audit commits, design §7.3/NIT-1); load `ScheduledClass` by
        id tenant-filtered (404); `assertFacultyAssigned` false → DENIED audit +403 `not assigned to
        this class`; `status=CANCELLED` → 409 `scheduled class cancelled`; date-vs-recurrence check
        (`dayOfWeek` set → `date.getUTCDay()===dayOfWeekToIndex`; else `date` one-off equals
        `ScheduledClass.date` at UTC midnight; both-null → 409) → 409 `date does not match scheduled
        class`; insert OPEN session (unique `(scheduledClassId,date)` → 409 `session already exists`);
        snapshot one `AttendanceRecord` per `ClassEnrollment.status=ENROLLED` default `ABSENT` + one
        `AttendanceRecordHistory` `MARKED` row each (actorMembershipId populated); audit
        `attendance.session.opened`. (Calendar day-type is NOT consulted — design §8.3/§13.)
      - `GET /sessions` (`attendance.view`/`attendance.mark`) + `GET /sessions/:id` — list/detail,
        dept-scoped; faculty sees own-marked.
      - `PATCH /sessions/:id/records` (`attendance.mark`): owner re-assert (§7.3 step 4); refuse if
        FINALIZED (409 `session finalized`); update existing records by `(attendanceSessionId,
        studentId)` only — unmatched pair → 409 `student not in this session`; append a `MARKED`
        history row per change; audit `attendance.records.marked`.
      - `POST /sessions/:id/submit` (OPEN→SUBMITTED, `submittedAt`; audit submitted) and
        `POST /sessions/:id/finalize` (SUBMITTED→FINALIZED, `finalizedAt`; audit finalized) —
        both `attendance.mark`. Finalize commits, THEN runs the post-commit low-attendance alert
        (item below).
      - `POST /corrections` (`attendance.mark`): faculty on a FINALIZED record of a session they
        marked; read live status as `priorStatus`; `requestedStatus===priorStatus` → 400 `no change
        requested`; existing PENDING → 409 `a correction is already pending for this record`;
        non-FINALIZED session → 409; create PENDING; audit `attendance.correction.requested`.
      - `POST /corrections/:id/approve` (`attendance.correct`, HOD dept-scoped): load PENDING
        correction + record + session (assert FINALIZED); re-read live status, `!== priorStatus` →
        409 `record changed since request`; write `AttendanceRecordHistory` CORRECTED (previous=live,
        new=requestedStatus, correctionId, actor); update record `status` ONLY (do NOT touch
        `markedAt`); flip correction APPROVED (`reviewedByUserId`,`reviewedAt`,`reviewNote`); audit
        `attendance.correction.approved`.
      - `POST /corrections/:id/reject` (`attendance.correct`): flip REJECTED; record untouched; no
        history row; audit `attendance.correction.rejected`.
      - `GET /corrections` (`attendance.correct`/`attendance.view`) — list, dept-scoped.
      - `GET /me` (`attendance.view_own`): required `academicTermId` query; resolve caller's
        `StudentProfile`; return own records (filter `studentId=own`) + `attendanceRate` over the
        FINALIZED-only domain for the term.
      - `GET /reports/section/:sectionId` (`attendance.view`, dept-scoped): required `academicTermId`
        query; per-student rate + low-attendance list over the same FINALIZED-only domain.
      - `GET /export` (`attendance.export`, dept-scoped → 404 out-of-scope): row-per-(student,
        session) columns `studentEnrollmentId,studentName,sectionCode,subjectCode,sessionDate,
        sessionStatus,attendanceStatus,markedAt`; `format` csv|json; audit `attendance.exported`
        (`resourceType="AttendanceExport"`, metadata `{sectionId,academicTermId,format,rowCount}`)
        in-tx before streaming.
      Low-attendance alert (finalize, design §8.6): AFTER the finalize tx commits, compute each
      affected student's `priorRate`/`postRate` (fresh short read `withTenant`); for each downward
      crossing (`postRate!=null && postRate<threshold && (priorRate==null || priorRate>=threshold)`),
      run a fresh short `withTenant(institutionId, tx => { await notifyUser(studentUserId, payload,
      tx); await recordAuditEvent("attendance.low_attendance.alerted", tx); })` — pass `tx` to BOTH
      (never base prisma); wrap each student in try/catch logging `request.log.warn` on failure so a
      notify failure never rolls back the committed finalize.
      Files: `apps/api/src/routes/attendance.ts`, `apps/api/src/server.ts`
      Verify: `cd apps/api && npm run build` (prisma generate + tsc) compiles with the new route wired.

- [ ] 11. Add the unit tests for the pure helpers.
      New `apps/api/src/services/__tests__/attendance-policy.test.ts`: cover `attendanceRate` across
      present/absent/late/excused mixes (EXCUSED excluded from numerator AND denominator), the
      denominator-zero → null case, the threshold downward-crossing predicate, and settings override
      vs defaults (design §8.6/§11.2). New `attendance-authz.test.ts`: cover the pure fast-path of
      `assertFacultyAssigned` (`scheduled.facultyId===facultyId` → true without a DB) and
      `dayOfWeekToIndex` (SUN=0..SAT=6). No DB; pure vitest.
      Files: `apps/api/src/services/__tests__/attendance-policy.test.ts`,
      `apps/api/src/services/__tests__/attendance-authz.test.ts`
      Verify: `cd apps/api && npx vitest run src/services/__tests__/attendance-policy.test.ts
      src/services/__tests__/attendance-authz.test.ts` — all pass.

- [ ] 12. Re-architect the module-system dependency exemplar tests off `attendance`.
      Because item 3 empties `MODULE_DEPENDENCIES.attendance`, the four `attendance`-wired
      assertions in `module-system.integration.test.ts` must move to `examinations`
      (`["academic_sessions","class_course","student_enrollment"]`) and `fees`
      (`["student_management"]`) per design §4.2.1: (1) `missingDependencies` exemplar → use
      `examinations` with one dep ACTIVE; (2) the DEPS_UNMET-blocked-until-ACTIVE activation chain →
      `examinations` + its three deps; (3)/(4) `affectedDependents` + the suspend-warning/audit-scalar
      persistence → use `fees` as the `student_management` dependent (or `examinations` on
      `academic_sessions`) so the asserted sets no longer contain `attendance`. Also add to
      `modules.test.ts` the two positive assertions from §4.2.1: `MODULE_DEPENDENCIES.attendance`
      equals `[]`, and `examinations` still declares its three edges. Keep the existing generic
      `modules.test.ts` assertions unchanged.
      Files: `apps/api/src/services/__tests__/module-system.integration.test.ts`,
      `apps/api/src/services/__tests__/modules.test.ts`
      Verify: `cd apps/api && npx vitest run src/services/__tests__/modules.test.ts` passes offline;
      the integration re-architecture is confirmed live in item 16 (needs Supabase).

- [ ] 13. Seed the DEMO attendance module ACTIVE + a sample session/records.
      In `packages/db/src/seed.ts`, after the Phase-3 timetable/slot block: add an idempotent
      `institutionModule.upsert` for `(institution.id, "attendance")` → `state: "ACTIVE"`,
      `entitledAt`/`activatedAt` now (mirrors the existing `campus_movement` upsert). Then create a
      sample `AttendanceSession` keyed on `@@unique([scheduledClassId, date])` (resolve the seeded
      Mon CS101 `ScheduledClass` via `findFirst`, pick a `date` at UTC midnight whose weekday is MON
      to satisfy the recurrence rule), in FINALIZED state with `finalizedAt`, and a couple of
      `AttendanceRecord`s (e.g. the seeded BCA student ENROLLED in `section`) with a `MARKED`
      `AttendanceRecordHistory` row each — all find-first/upsert so re-runs never duplicate. Add a
      console line. (No correction/history-UPDATE is seeded — the history table is append-only.)
      Files: `packages/db/src/seed.ts`
      Verify: `cd packages/db && npx tsc --noEmit` compiles; the live seed run is exercised in item 16 step 4.

- [ ] 14. Extend the tenant-escape suite for the new tables (setup helper + integration spec).
      In `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts`: seed the three MUTABLE
      attendance tables per tenant (A/B) via `adminClient`, child-safe order after the existing
      `scheduledClass`/`classEnrollment` seed — one `AttendanceSession` (against the seeded
      `scheduledClassId`+`academicTermId`, a MON date, `markedByFacultyId=facultyProfileId`), one
      `AttendanceRecord` (the seeded `studentProfileId`), one `AttendanceCorrection` (PENDING on that
      record); add their deterministic IDs to `SeededTenant` + the return; add the three table names
      to `RLS_TABLES`; add them to `countRemainingTestRows` (sequential) and to `cleanup` child-first
      (corrections → records → sessions, BEFORE the scheduled_classes/enrollments/students deletes).
      Add `attendance_record_history` to `RLS_TABLES` and to `EXPECTED_POLICIES`
      (`["tenant_isolation_select","attendance_record_history_tenant_insert"]`) — do NOT seed it in
      the generic loop (append-only; the trigger blocks shared teardown — the
      `schedule_revisions`/`student_profile_history` precedent). In
      `tenant-escape.integration.test.ts`: add read-escape / spoofed-tenant-write /
      foreign-parent-write / buggy-query (forgets tenant filter → RLS returns only A) cases for the
      three mutable tables, the self-contained append-only case for `attendance_record_history`
      (insert OK, cross-tenant SELECT empty, UPDATE/DELETE denied — within a scoped trigger-disable
      cleanup like the `schedule_revisions` 3ff case), and add `attendance_record_history` to the
      no-modify-policy meta-assertion loop.
      Files: `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts`,
      `apps/api/src/routes/__tests__/tenant-escape.integration.test.ts`
      Verify (live, item 16): `cd apps/api && npx vitest run src/routes/__tests__/tenant-escape.integration.test.ts`
      — all cases pass and `countRemainingTestRows()` is 0 after cleanup.

- [ ] 15. Add the attendance behavioral + route integration suites.
      New `apps/api/src/routes/__tests__/attendance-behavioral.integration.test.ts` and
      `attendance-routes.integration.test.ts` (self-contained under a distinct prefix, seed + teardown
      their own tenant via `adminClient`, import `withTenant`/clients from the escape-setup helper so
      `DATABASE_URL` is pinned to campass_app). Cover, per design §11.2: full lifecycle (open → mark →
      submit → finalize); faculty-scope 403 (faculty posts an unassigned `scheduledClassId` → denied +
      DENIED audit written); correction workflow (request → HOD approve → record rewritten + CORRECTED
      history row present + audit; reject leaves record untouched, no history row); finalized
      immutability (mark on FINALIZED → 409; direct UPDATE of `attendance_record_history` blocked);
      module-inactive rejection (suspend `attendance` → every operational route 403, incl. `GET /me`
      on historical data); student own-read isolation; low-attendance notification on the downward
      crossing + NOT re-emitted on a later finalize below threshold; no-op correction 400;
      PENDING-uniqueness 409; stale-approve 409; date-mismatch 409; CANCELLED-class 409; term-integrity
      (a tampered `academicTermId` on session insert rejected by the 3-col FK).
      Files: `apps/api/src/routes/__tests__/attendance-behavioral.integration.test.ts`,
      `apps/api/src/routes/__tests__/attendance-routes.integration.test.ts`
      Verify (live, item 16): `cd apps/api && npx vitest run src/routes/__tests__/attendance-behavioral.integration.test.ts
      src/routes/__tests__/attendance-routes.integration.test.ts` — all pass; and
      `cd apps/api && npx vitest run src/services/__tests__/catalogue-sync.test.ts` — union set-equality
      green (confirms items 1 + 6 + 7 agree).

- [ ] 16. Apply the migration live, run the full suite, and perform the DB smoke checks.
      This is the end-to-end verification gate (design §11.3; needs live Supabase creds).
      Step 0 (pre-flight): `cd packages/db && npx prisma migrate status` → "up to date" with the nine
      frozen dirs, no drift; confirm no sibling dir claims a slot before `20261101000000` (bump the
      timestamp if one exists).
      Step 1: `npx prisma migrate diff --from-url "$env:DIRECT_URL" --to-schema-datamodel
      prisma/schema.prisma` (read-only) shows exactly the four new tables + four enums + constraints
      + the one additive `scheduled_classes(institutionId, id, academicTermId)` UNIQUE — no other
      drift against the frozen nine.
      Step 2: `npx prisma migrate deploy` applies `20261101000000_phase4_attendance`; `npx prisma
      migrate status` → "up to date", nine frozen dirs unchanged.
      Step 3: `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='campass_app'` → both false.
      Step 4: run the seed (`cd packages/db && npx tsx src/seed.ts`); confirm DEMO `attendance` row
      ACTIVE + the sample session/records present.
      Step 5: append-only proof — as campass_app, `UPDATE attendance_record_history ...` and
      `DELETE ...` both raise `restrict_violation`.
      Step 6: fail-closed proof — a query with the GUC unset returns zero attendance rows.
      Step 7: clean build + full suite: from `c:\campusgate`, `npm ci` then `npx turbo build` green;
      `cd apps/api && npx vitest run` green across unit + all integration suites, INCLUDING the
      regression suites (academics/SIS/classes behavioral + regression, GatePass/campus-movement,
      module-system, escape, catalogue-sync). Fix any failure before declaring done.
      Files: none (verification only; may fix forward into the files above if a check fails).
      Verify: every step above reports its expected outcome; `npx vitest run` in `apps/api` is fully green.

---

## Digest

The coder works from this Digest and opens a file only to edit it. Every block below was read
during exploration; signatures and anchors are quoted from the live files.

### `packages/shared/src/permissions.ts` (item 1)
- `PERMISSIONS` is `[...] as const satisfies readonly PermissionDef[]`. The `classes.*` block ends
  with `{ key: "classes.view_own", module: "classes", ... }` immediately before the `// platform.*`
  comment — insert the five `attendance.*` objects as a new `// attendance.*` block there (keep the
  `as const satisfies` tail intact).
- `ROLE_PERMISSIONS: Record<string, readonly PermissionKey[]>`. Current arrays:
  `STUDENT` ends `"classes.view_own"`; `FACULTY: ["classes.view_own"]`; `HOD` ends `"classes.view_own"`;
  `ADMIN` ends with the `campus_movement.*` tail; `GUARD`/`SUPER_ADMIN` unchanged. Append the nine
  pairs (design §5.2) to STUDENT/FACULTY/HOD/ADMIN only.
- Test that covers it: `apps/api/src/services/__tests__/catalogue-sync.test.ts` (union set-equality
  vs the migration seed) — passes only when item 6's seed block adds exactly the matching nine pairs.

### `packages/shared/src/audit-actions.ts` (item 2)
- `AUDIT_ACTIONS = [ ... ] as const satisfies readonly AuditActionDef[]`; last entry is
  `{ key: "classes.scheduled_class.cancelled", ... }`. Append the nine `attendance.*` objects before
  the closing `]`. `AuditActionKey` + `AUDIT_ACTION_KEY_SET` derive automatically. Do NOT touch
  `LegacyAuditAction`/`LEGACY_AUDIT_ACTION_MAP` (no new pg enum).
- Test: `apps/api/src/services/__tests__/audit-actions.test.ts` (keys well-formed); `recordAuditEvent`
  in `audit.ts` validates against `AUDIT_ACTION_KEY_SET`.

### `packages/shared/src/modules.ts` (item 3)
- `MODULE_DEPENDENCIES.attendance` currently `["student_management","academic_sessions","class_course"]`
  → change to `[]`. `examinations`/`fees` edges unchanged. `MODULES` unchanged.
- Test: `apps/api/src/services/__tests__/modules.test.ts` (generic graph assertions stay green;
  item 12 adds the positive `attendance === []` + `examinations` assertions).

### `packages/shared/src/validation.ts` (item 4)
- File ends with the Phase-3 `classes` schemas then a `// ─── TYPES ───` block of `export type ... =
  z.infer<...>`. Add the attendance schemas as a new `// ─── ATTENDANCE (Phase 4) ───` block before
  the TYPES section, and their `export type` lines in the TYPES block. Use `z.coerce.date()` for
  `date`/`submissionDeadline`; `z.enum([...])` for status; `.min(1)`/`.max(...)` bounds; `.default("csv")`
  for export format (the `listStudentsQuerySchema` + `scheduledClassObject` precedents show the style).
- Test: compiled by `tsc`; exercised indirectly by item 15 route suites.

### `packages/db/prisma/schema.prisma` (item 5)
- `model Institution` back-relation list (around L256–276) ends with `scheduleRevisions
  ScheduleRevision[]` before `@@map("institutions")` — append `attendanceSessions`,
  `attendanceRecords`, `attendanceCorrections`, `attendanceRecordHistory`.
- `model ScheduledClass` (L1362) currently has only `@@unique([id, institutionId])` + four indexes
  before `@@map("scheduled_classes")` — add `@@unique([institutionId, id, academicTermId])` and an
  `attendanceSessions AttendanceSession[]` back-relation.
- `model FacultyProfile` (L1295): add `attendanceSessions AttendanceSession[]`.
- `model StudentProfile` (L425): has `classEnrollments ClassEnrollment[]` — add `attendanceRecords
  AttendanceRecord[]`.
- `model AcademicTerm` (L860): add `attendanceSessions AttendanceSession[]`.
- Add the four new models + four enums (shapes verbatim from design §3.1–3.4, §6.1). Enums
  `ScheduledClassStatus {SCHEDULED,CANCELLED}`, `DayOfWeek {SUN..SAT}`, `EnrollmentStatus
  {ENROLLED,DROPPED,COMPLETED}`, `FacultyStatus {ACTIVE,INACTIVE}`, `FacultyAssignmentStatus
  {ACTIVE,ENDED}` already exist (confirmed in Phase-3 migration) and are reused.
- Verified: `prisma validate` + `prisma generate` must succeed (the api build runs `prisma generate`).

### `packages/db/prisma/migrations/20261101000000_phase4_attendance/migration.sql` (item 6, NEW)
- Model section-for-section on `20261028000000_phase3_classes/migration.sql` (read in full): DO-block
  RLS loop over a `mutable_tables` array + a separate append-only block; the
  `schedule_revisions_append_only()` function + `BEFORE UPDATE OR DELETE` trigger; the guarded
  `IF EXISTS (... rolname='campass_app')` GRANT/REVOKE block; the seed block using
  `FROM (VALUES (...)) AS m("roleKey","permKey") JOIN "roles" r ON r."key"=m."roleKey" AND
  r."institutionId" IS NULL JOIN "permissions" p ON p."key"=m."permKey" ON CONFLICT (...) DO NOTHING`.
- Catalogue-sync parser (read in `catalogue-sync.test.ts`): slices `INSERT INTO "permissions"` →
  `ON CONFLICT`, and `INSERT INTO "role_permissions"` → `AS m(`. Keep those exact markers; emit no
  FACULTY `roles` INSERT (it already exists) and no stray VALUES comment inside those slices.

### `apps/api/src/services/__tests__/catalogue-sync.test.ts` (item 7)
- `SEEDING_MIGRATION_DIRS` array (ends `"20261028000000_phase3_classes"`) — append
  `"20261101000000_phase4_attendance"`.

### `apps/api/src/services/attendance-policy.ts` (item 8, NEW) + `attendance-authz.ts` (item 9, NEW)
- Import `Prisma`/types from `@campusgate/db`; `AttendanceStatus`/`DayOfWeek` are generated enum types
  on `@prisma/client` re-exported by `@campusgate/db` (`export * from "@prisma/client"` in db/index.ts).
- `assertFacultyAssigned` query mirrors the §7.2 snippet: `tx.facultyAssignment.findFirst({ where:{
  institutionId, facultyId, subjectId, academicTermId, status:"ACTIVE", OR:[{classSectionId},
  {classSectionId:null}] }, select:{id:true} })`. `FacultyAssignment` fields confirmed in schema L1316.
- `resolveMarkingFaculty`: `tx.facultyProfile.findFirst({ where:{ userId, institutionId,
  status:"ACTIVE" }, select:{id:true} })` (`FacultyProfile.userId @unique`, schema L1295).

### `apps/api/src/routes/attendance.ts` (item 10, NEW) + `apps/api/src/server.ts`
- Copy the `classes.ts` scaffolding: `import { withTenant, type Prisma } from "@campusgate/db"`,
  Zod schemas from `@campusgate/shared`, `authenticate`, `requirePermission`, `requireModuleActive`,
  `recordAuditEvent`, `notifyUser`. `actor(request)` + `attendanceDepartmentScopeFilter(request,kind)`
  modeled on `classes.ts` L47–100. `requireModuleActive(moduleKey)` + `requirePermission(key)` signatures
  confirmed in `authz-engine.ts`. `recordAuditEvent(input, tx)` + `AuditInput` fields confirmed in
  `audit.ts`. `notifyUser(userId, payload, db=prisma)` confirmed in `notifications.ts` (pass `tx`).
- `server.ts`: add `import { attendanceRoutes } from "./routes/attendance.js";` and
  `await app.register(attendanceRoutes, { prefix: "/api/attendance" });` alongside the existing
  `classesRoutes` registration.
- DENIED-audit deny branches must RETURN `reply.status(403)` from a normally-returning `withTenant`
  callback (never `throw`) so the audit commits (design §7.3/NIT-1; GatePass precedent).

### `apps/api/src/services/__tests__/attendance-policy.test.ts` + `attendance-authz.test.ts` (item 11, NEW)
- Plain vitest (`describe/it/expect`), no DB — the `allowance-engine.property.test.ts` /
  `faculty-assignment.test.ts` precedent for pure-helper suites.

### `apps/api/src/services/__tests__/module-system.integration.test.ts` + `modules.test.ts` (item 12)
- The four attendance-wired `it(...)` names are listed in design §4.2.1 (re-point to `examinations`
  and `fees`/`academic_sessions`). `seedModule(instId, moduleKey, state)` + `clearModules()` helpers
  already exist in the integration file; the graph values (`examinations`, `fees`) are present in
  `modules.ts` (confirmed). `modules.test.ts` currently has no attendance-specific assertion — add
  the two positive ones from §4.2.1.

### `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` + `tenant-escape.integration.test.ts` (item 14)
- `SeededTenant` interface + `seedTenant` + `cleanup` + `countRemainingTestRows` + `RLS_TABLES` +
  `EXPECTED_POLICIES` + `DEFAULT_POLICIES` are the exact extension points (all read in full). Follow
  the FEAT-004 Phase-3 comments/pattern: mutable tables seeded + counted + cleaned child-first;
  the append-only `attendance_record_history` goes into `RLS_TABLES` + `EXPECTED_POLICIES` only,
  NOT the generic seed/count/cleanup, mirroring `schedule_revisions`.
- Integration spec: the `3ff. schedule_revisions APPEND-ONLY (self-contained ...)` case (L846) is the
  template for the `attendance_record_history` case (scoped `DISABLE TRIGGER` cleanup). The RLS
  meta-test (case ~6) loops `RLS_TABLES` vs `EXPECTED_POLICIES`/`DEFAULT_POLICIES` + a no-modify-policy
  list — add `attendance_record_history` to that no-modify list.

### `apps/api/src/routes/__tests__/attendance-behavioral.integration.test.ts` + `attendance-routes.integration.test.ts` (item 15, NEW)
- Model on `classes-behavioral.integration.test.ts` / `classes-routes.integration.test.ts` and
  `module-system.integration.test.ts` (import `appClient`/`adminClient`/`withTenant`/`disconnect`
  from the escape-setup helper; self-contained distinct prefix; own seed/teardown; audit-events
  teardown uses the `ALTER TABLE ... DISABLE TRIGGER "audit_events_no_update_delete"` pattern already
  in the module-system suite if it writes audit rows).

### `packages/db/src/seed.ts` (item 13)
- The `campus_movement` `institutionModule.upsert` block (L319) is the template for the `attendance`
  upsert. The seeded `ScheduledClass` (MON/WED CS101, L670–700), `section`, `subject`, `term1`, and the
  demo BCA student are the anchors for the sample session/records; `facultyProfile` (L601) is the marker.

### Build / test commands verified
- `cd apps/api && npm run build` = `prisma generate (schema=../../packages/db/prisma/schema.prisma) && tsc`.
- `cd apps/api && npx vitest run [path]` (vitest 4); `npm test` = `vitest run`.
- `cd packages/db && npx prisma validate | generate | migrate diff | migrate deploy | migrate status`;
  `npx tsx src/seed.ts`.
- Repo-wide: `npm ci` + `npx turbo build` + `npx turbo lint` from `c:\campusgate`.
- **Tests passing today (baseline, offline-capable):** `modules.test.ts`, `audit-actions.test.ts`,
  `catalogue-sync.test.ts`, the pure `faculty-assignment.test.ts`/`allowance-*`/`calendar-service.test.ts`
  unit suites. The `*.integration.test.ts` suites (escape, module-system, academics/SIS/classes
  behavioral+routes) require live Supabase creds and are the regression set to keep green in item 16.
