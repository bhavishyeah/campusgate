# CAMPASS Phase 3 — Class & Course Management · Implementation Plan

Derived from the APPROVED `design.md` (revision 3; `design-review.json` verdict APPROVED,
4 NITs all resolved in the design) and the live repo. Runs on `main`, no worktree, no push;
every step must leave the app buildable. The migration path is the proven hand-author →
`migrate diff` → `migrate deploy` → `migrate status` workflow against shared Supabase —
NEVER `migrate dev`, NEVER `db push`, NEVER touch `_prisma_migrations` or the 8 FROZEN
migration dirs.

Grounding facts (verified during exploration):
- Monorepo: npm workspaces + turbo (`package.json`). Build steps: `npm ci` (root);
  `npm run build -w @campusgate/shared` (tsc); `npm run db:generate -w @campusgate/db`
  (prisma generate); `npm run build -w @campusgate/api` (prisma generate + tsc);
  `npm run build` (turbo) at root.
- Tests: `npm test -w @campusgate/api` → `vitest run`, `fileParallelism:false`. Baseline
  304 green. Transient `FATAL: tenant/user ... not found` = Supabase auto-pause → retry.
- Migration + seed run as `postgres` over `DIRECT_URL` (session pooler 5432); runtime +
  escape `appClient` use `campass_app` over `DATABASE_URL` (txn pooler 6543).
- Latest migration dir: `20261027161616_phase2_sis`. House-style SQL sections a–j are in
  that dir's `migration.sql` — mirror them exactly.
- Parents all carry `@@unique([id, institutionId])` (verified: departments, users,
  student_profiles, programs, academic_sessions, academic_terms).
- Shared catalogues: `packages/shared/src/permissions.ts` (PERMISSIONS + ROLE_PERMISSIONS),
  `audit-actions.ts` (AUDIT_ACTIONS), `validation.ts` (Zod). catalogue-sync meta-test parses
  `INSERT INTO "permissions" … ON CONFLICT` and `INSERT INTO "role_permissions" … AS m(`;
  `SEEDING_MIGRATION_DIRS` in `catalogue-sync.test.ts` must list the new dir.
- Route pattern: `apps/api/src/routes/students.ts` (single `authenticate` preHandler;
  per-route `requirePermission`; `withTenant`; `recordAuditEvent(input, tx)`;
  `departmentScopeFilter`; 404-on-out-of-scope). Pure-logic service pattern:
  `student-sis.ts` / `calendar-service.ts`. Audit writer: `recordAuditEvent(input, tx?)`.
- `CalendarService.effectiveDayType(institutionId, date, tx, {departmentId?})` returns
  `AcademicDayType | null`. workingDaysOfWeek guard shape: `allowance-engine.ts`
  (`Array.isArray` → `.map(Number)` → filter 0..6 → fallback `[1..6]`).

---

- [ ] 1. Hand-author the new migration `packages/db/prisma/migrations/<timestamp>_phase3_classes/migration.sql` and add the 9 tenant-owned tables to the Prisma schema.
      Create a new timestamped dir (after `20261027161616_phase2_sis`) and write `migration.sql`
      by hand in the phase2_sis house style, sections a–j (design §11): (a) `CREATE TYPE` the
      new enums (§6.1: ClassSectionStatus, EnrollmentStatus, FacultyStatus,
      FacultyAssignmentRole, FacultyAssignmentStatus, TimetableStatus, ScheduledClassStatus,
      DayOfWeek, ScheduleRevisionChangeType); (b) `CREATE TABLE` the 9 tables — `courses`,
      `subjects`, `class_sections`, `class_enrollments`, `faculty_profiles`,
      `faculty_assignments`, `timetables`, `scheduled_classes` (8 mutable) + `schedule_revisions`
      (1 append-only); (c) unique indexes — each table's `(id, institutionId)`, the business
      uniques (`courses(institutionId,code)`, `subjects(institutionId,code)`,
      `class_sections(institutionId,programId,academicSessionId,academicTermId,label)`,
      `class_enrollments(classSectionId,studentId)`, `faculty_profiles(userId)`), plus every
      `@@index([institutionId])` and the query indexes in §6; (d) tenant-root FKs
      `institutionId → institutions(id)` RESTRICT on all 9; (e) composite same-tenant FKs per
      §6.10 (RESTRICT/SET NULL exactly as tabled); (f) CHECK constraints on `scheduled_classes`
      (`startTime>=0 AND startTime<1440`, `endTime>0 AND endTime<=1440`, `startTime<endTime`,
      `((dayOfWeek IS NULL) <> (date IS NULL))`); (g) RLS ENABLE+FORCE on all 9 — standard
      nullif-guarded `{tenant_isolation_select, tenant_isolation_modify}` pair on the 8 mutable
      tables, append-only `{tenant_isolation_select, schedule_revisions_tenant_insert}` (NO
      modify policy) on `schedule_revisions`; (h) append-only function + `BEFORE UPDATE OR
      DELETE` trigger on `schedule_revisions` (raises `restrict_violation`), copied from the
      `student_profile_history` precedent; (i) guarded `IF EXISTS pg_roles` `campass_app` GRANT
      refresh — full DML on the 8 mutable tables, `GRANT SELECT,INSERT` + `REVOKE UPDATE,DELETE`
      on `schedule_revisions`; (j) seed the 7 `classes.*` permissions + `role_permissions` pairs
      — emit the new `FACULTY` `roles` INSERT (`(id,key,name,institutionId) VALUES (…, 'FACULTY',
      'Faculty', NULL) ON CONFLICT DO NOTHING`) BEFORE the `INSERT INTO "permissions"` block
      (catalogue-sync parser safety, §11j). Mirror the 9 models + enums into
      `packages/db/prisma/schema.prisma` (Prisma relations/scalars; RLS/FK/trigger/CHECK live
      only in SQL), reusing `ProgramStatus` for `Course`/`Subject.status` (§6.2), with
      `actorUserId`/`actorMembershipId` on `schedule_revisions` as recorded id columns with NO FK
      (§6.10 NIT-1). Verify DDL read-only, apply, confirm.
      Files: `packages/db/prisma/migrations/<timestamp>_phase3_classes/migration.sql`,
      `packages/db/prisma/schema.prisma`
      Verify: from `packages/db`, `npx prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-migrations prisma/migrations --exit-code` reports no drift between schema and migrations (read-only); `npx prisma migrate deploy` applies cleanly; `npx prisma migrate status` shows "Database schema is up to date", the new dir applied, the 8 prior dirs untouched, no ledger duplicates; `npm run db:generate -w @campusgate/db` succeeds.

- [ ] 2. Register the `classes.*` permission catalogue and `FACULTY` template role in `packages/shared`, and the `classes.*` audit keys.
      Add the 7 keys (`classes.courses.manage`, `classes.sections.manage`, `classes.enroll`,
      `classes.faculty.assign`, `classes.timetable.manage`, `classes.view`, `classes.view_own`)
      to `PERMISSIONS` (module `"classes"`, §7) and wire `ROLE_PERMISSIONS`: ADMIN = all 7;
      HOD = all 7 (scope enforced in-route, §7.1); FACULTY = `classes.view_own` ONLY (§7/A4);
      STUDENT = add `classes.view_own`. Add `TEMPLATE_ROLE_NAMES["FACULTY"]="Faculty"` wherever
      the seed resolves template-role display names (seed.ts `TEMPLATE_ROLE_NAMES`). Add the
      past-tense `classes.*` audit-action keys to `AUDIT_ACTIONS` in `audit-actions.ts` exactly
      as listed in §9 (module `"classes"`). These shared edits MUST match the migration seed from
      step 1 in lockstep (catalogue-sync set-equality).
      Files: `packages/shared/src/permissions.ts`, `packages/shared/src/audit-actions.ts`,
      `packages/db/src/seed.ts` (TEMPLATE_ROLE_NAMES only)
      Verify: `npm run build -w @campusgate/shared` (tsc) passes; `npm test -w @campusgate/api -- catalogue-sync` passes (permission keys + role_permission pairs union == shared), once step 6's `SEEDING_MIGRATION_DIRS` edit is in place — run after step 6 if ordering requires.

- [ ] 3. Add the Zod request schemas for every Phase-3 create/update body in `packages/shared/src/validation.ts`.
      One schema per body per §10: course, subject, class-section, enrollment, faculty-profile,
      faculty-assignment (incl. optional `replacesAssignmentId`), scheduled-class
      create/update (with the `dayOfWeek` XOR `date` `.refine`, `startTime<endTime`, minute
      bounds `[0,1440]`), timetable create + publish. Field limits/optionality exactly as §10.
      Files: `packages/shared/src/validation.ts`
      Verify: `npm run build -w @campusgate/shared` passes; `npm run build -w @campusgate/api` typechecks against the new exported schema types.

- [ ] 4. Create the pure conflict-detection function `apps/api/src/services/timetable-conflict.ts` with full unit tests.
      Implement `detectTimetableConflicts(ctx: ConflictContext): ConflictReport` DB-free (§8):
      `DOW_INDEX` + `weekdayOf` using `getUTCDay()` (§8.2); same-day-axis overlap
      (`a.start<b.end && b.start<a.end`); the 5 checks with BLOCK/WARN per §8.2.1 (INVALID_PERIOD
      BLOCK, FACULTY_DOUBLE_BOOKED BLOCK, ROOM_DOUBLE_BOOKED BLOCK, SECTION_SELF_CONFLICT BLOCK,
      OUT_OF_HOURS WARN); recurring out-of-hours = `workingDaysOfWeek` only, one-off = explicit
      `effectiveDayType` wins else weekday fallback; CANCELLED ignored; exclude edited slot's own
      id. Add `apps/api/src/services/__tests__/timetable-conflict.test.ts` covering EACH type,
      BLOCK-vs-WARN, touching-not-overlapping boundary (`a.end==b.start` ⇒ none),
      recurring-vs-one-off day-axis match, `getUTCDay` determinism, CANCELLED-ignored,
      self-exclude, and the working-day split by slot kind.
      Files: `apps/api/src/services/timetable-conflict.ts`,
      `apps/api/src/services/__tests__/timetable-conflict.test.ts`
      Verify: `npm test -w @campusgate/api -- timetable-conflict` — all new unit tests pass.

- [ ] 5. Create the enrollment + faculty-assignment pure decision services with unit tests.
      Add `apps/api/src/services/class-enrollment.ts` (duplicate-enrollment decision; no second
      StudentProfile — reference the shared one) and `apps/api/src/services/faculty-assignment.ts`
      (soft-transition decision: substitute/reassign ENDS the current ACTIVE row + INSERTs a new
      one + emits a `FACULTY_REASSIGNED` revision; `facultyId/subjectId/classSectionId/
      academicTermId/role` immutable after insert — §6.7 invariant). DB-free, mirroring
      `student-sis.ts`. Add `__tests__/class-enrollment.test.ts` and
      `__tests__/faculty-assignment.test.ts` (preserve-history: prior rows retained on swap).
      Files: `apps/api/src/services/class-enrollment.ts`,
      `apps/api/src/services/faculty-assignment.ts`, their two `__tests__/*.test.ts`
      Verify: `npm test -w @campusgate/api -- class-enrollment faculty-assignment` — all pass.

- [ ] 6. Build the `classes.ts` route surface, the student/faculty "my schedule" reads, register in `server.ts`, and add the new migration dir to `SEEDING_MIGRATION_DIRS`.
      Create `apps/api/src/routes/classes.ts` (prefix `/api/classes`, single `authenticate`
      preHandler, per-route `requirePermission`, NO `requireModuleActive` — §3). Handlers (§4):
      CRUD courses/subjects/sections; enroll/unenroll (capacity check inside tx, A9; references
      shared StudentProfile); assign/reassign/substitute faculty WITH history (soft transition +
      `FACULTY_REASSIGNED` revision via `faculty-assignment.ts`); create/publish timetable with
      conflict validation (409 + `ConflictReport` on blocking; publish hard-blocks per A7);
      `POST /timetables/:id/check` dry-run gated by `classes.timetable.manage` (§8.3 NIT-4);
      cancel scheduled class; revise a published timetable (writes a `ScheduleRevision` row, §6.9
      per-changeType column contract). Add the `classesDepartmentScopeFilter(request, kind)`
      relation-filter helper (§7.1) and 404-on-out-of-scope for HOD. Coerce
      `InstitutionConfig.workingDaysOfWeek` to a validated `number[]` (allowance-engine guard
      shape) before building `ConflictContext` (§8.1 NIT-3). Every mutation writes a `classes.*`
      `AuditEvent` via `recordAuditEvent(input, tx)` in the same `withTenant` transaction. Add
      read-only "my schedule" endpoints (own-scoped, `classes.view_own`): to `student.ts`
      (student's enrolled-section timetable) and a faculty surface (teaching schedule by
      `facultyId`). Register `classesRoutes` in `server.ts` at `/api/classes`. Add
      `"<timestamp>_phase3_classes"` to `SEEDING_MIGRATION_DIRS` in `catalogue-sync.test.ts`.
      Files: `apps/api/src/routes/classes.ts`, `apps/api/src/routes/student.ts`,
      `apps/api/src/server.ts`, `apps/api/src/services/__tests__/catalogue-sync.test.ts`
      Verify: `npm run build -w @campusgate/api` typechecks; `npm test -w @campusgate/api -- catalogue-sync` passes (shared ↔ migration seed set-equality with the new dir).

- [ ] 7. Add route-integration tests (mocked Prisma) for the classes surface.
      Following the `academics-routes.integration.test.ts` precedent: permission gating per role
      (ADMIN manage; HOD manage within scope; FACULTY/STUDENT view_own only, mutate ⇒ 403); the
      409 conflict envelope on a double-booked slot; the success-plus-warnings envelope on an
      out-of-hours slot; cross-tenant read ⇒ 404; the `recordAuditEvent` call shape on mutations.
      Files: `apps/api/src/routes/__tests__/classes-routes.integration.test.ts`
      Verify: `npm test -w @campusgate/api -- classes-routes` — all pass.

- [ ] 8. Extend the cross-tenant escape suite to every new tenant-owned table.
      In `tenant-escape-setup.ts`: add the 9 tables to `RLS_TABLES`; add `schedule_revisions` to
      `EXPECTED_POLICIES` as the append-only pair `["tenant_isolation_select",
      "schedule_revisions_tenant_insert"]` (the 8 mutable tables fall through to
      `DEFAULT_POLICIES`); seed one `ESCAPE_TEST_` row per mutable table for A and B (child-safe
      order: course→subject; section; faculty_profile; faculty_assignment; timetable;
      scheduled_class; enrollment referencing the already-seeded studentProfile) and extend
      `cleanup()` + `countRemainingTestRows()` child-first per the RESTRICT FKs; EXCLUDE
      `schedule_revisions` from the generic seed/cleanup loop (trigger blocks UPDATE/DELETE even
      for adminClient). In `tenant-escape.integration.test.ts`: add read-escape, spoofed-write,
      foreign-parent-write, buggy-query backstop, three-GUC-state fail-closed, and RLS
      enabled+forced+policies meta assertions for the 8 mutable tables; add the self-contained
      `schedule_revisions` case (privileged INSERT of one row; cross-tenant SELECT empty; UPDATE
      and DELETE both raise `restrict_violation`; meta-assert ENABLE+FORCE + exact policy pair).
      Files: `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts`,
      `apps/api/src/routes/__tests__/tenant-escape.integration.test.ts`
      Verify: `npm test -w @campusgate/api -- tenant-escape` — all escape assertions pass (needs the step-1 migration applied).

- [ ] 9. Add the Phase-3 behavioral integration suite.
      Self-contained `CLASS_TEST_` prefix (seeds + tears down its own rows, academics-behavioral
      precedent): build a small timetable; assert a double-booked faculty and a double-booked
      room are rejected (409/blocking); publish a change and assert a `schedule_revisions` row is
      written and that UPDATE/DELETE on it is refused (append-only); a faculty reassignment
      preserves the prior assignment row (preserve-history) and writes a `FACULTY_REASSIGNED`
      revision; a student and a faculty read only their own schedule; enrollment references the
      shared `StudentProfile` (no second student row created).
      Files: `apps/api/src/routes/__tests__/classes-behavioral.integration.test.ts`
      Verify: `npm test -w @campusgate/api -- classes-behavioral` — all pass.

- [ ] 10. Extend `packages/db/src/seed.ts` with the Phase-3 demo data.
      Append after the existing SIS linking block (idempotent, keyed on business uniques, runs on
      DIRECT_URL): one Course `BCA-S1-CORE` under the BCA program; one Subject
      `CS101 Data Structures` (4 credits, 4 contact hrs); one ClassSection (BCA + 2026-2027 +
      Semester 1, label `A`, capacity 60, ACTIVE); one ClassEnrollment of the seeded student
      `BCA2024001` (ENROLLED, referencing the shared StudentProfile); one pure-faculty User
      (`role = GUARD` inert value, §15/A3) with a FacultyProfile (dept BCA) + FACULTY template
      role on its membership + a PRIMARY FacultyAssignment (CS101, section A, Semester 1); one
      PUBLISHED Timetable with a conflict-free ScheduledClass set (Mon/Wed 540–600, room R-101).
      No ScheduleRevision rows seeded (append-only). The FACULTY template role +
      role_permissions are picked up idempotently by `seedRbacCatalogue` from
      `@campusgate/shared`. Only extend `SEEDING_MIGRATION_DIRS`-style constants if a seed
      constant tracks catalogue dirs (none here — catalogue-sync owns that list, done in step 6).
      Files: `packages/db/src/seed.ts`
      Verify: `npm run db:seed -w @campusgate/db` runs clean twice in a row (idempotent, no
      duplicate rows); the second run reports no new inserts for the Phase-3 rows.

- [ ] 11. Full clean build check + live smoke test.
      Clean build (design §12 gate): from repo root `npm ci`; `npm run build -w @campusgate/shared`;
      `npm run db:generate -w @campusgate/db`; `npm run build -w @campusgate/api`;
      `npm run build` (turbo). Full test run `npm test -w @campusgate/api` (vitest, single run,
      `fileParallelism:false`) — all suites green including the 304 baseline + the new Phase-3
      suites; GatePass/allowance + Phase-1/Phase-2 regression unchanged. Live smoke test
      (`migrate status` already green from step 1): start the API against the live DB, log in as
      `admin@demo.edu`, create a course/subject/section, enroll the demo student, create +
      publish a timetable, trigger a 409 by double-booking a room/faculty, revise a published
      slot and confirm a `schedule_revisions` row appears, and confirm the demo faculty + student
      each see their own schedule.
      Files: none (verification only)
      Verify: all build commands exit 0; `npm test -w @campusgate/api` reports every suite
      passing; the live smoke sequence returns the expected 201/200/409 responses and a visible
      revision row.

---

Notes / assumptions carried from the design (implemented as stated unless the reviewer
directs otherwise): A1 foundational placement (no `requireModuleActive`, no `modules.ts`
edit); A2 single `courseId` per subject; A3 pinned legacy `User.role` for faculty; A4 FACULTY
= `classes.view_own` only; A5 HOD department scope via relation filters; A6 same-term conflict
scope; A7 publish hard-blocks on blocking conflicts; A8 room is free-text; A9 soft capacity
overshoot (no row lock), duplicate enrollment DB-enforced. The 4 design-review NITs are already
folded into the design and are honored in steps 1 (NIT-1 recorded-id columns), 4 (NIT-2 DOW in
service only), 6 (NIT-3 workingDaysOfWeek coercion, NIT-4 `/check` permission).
