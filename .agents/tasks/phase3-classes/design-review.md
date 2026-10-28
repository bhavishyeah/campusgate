# Phase 3 — Class & Course Management · Design Review (Revision 3)

Reviewed: `c:\campusgate\.agents\tasks\phase3-classes\design.md` (Revision 3).
Reviewer stance: fresh read, no production context. Claims in the design that assert
"the existing X does Y" were checked against live source before being accepted.

## Summary

This is a strong, self-standing design. The high-risk decisions the step asked me to
scrutinize — full tenancy checklist on every new table, a genuinely append-only
revision ledger, additive FACULTY identity, single-student-identity enrollment,
preserved faculty/timetable history, a pure 5-type conflict function with a clear
BLOCK/WARN split and a well-defined 409, calendar-derived out-of-hours, consistent
permission/audit keys with department scope, the diff→deploy migration with frozen
migrations/ledger untouched, Class/Course as institution-layer, and Phase-4 seams noted
not built — are all addressed and, where they make load-bearing claims about live code,
those claims verified true against source.

The previous review's six findings (2 MEDIUM, 4 NIT) are genuinely resolved in this
revision: the 9-table / 8-mutable count is now consistent, and the Phase-4
module-dependency hand-off is stated accurately against the live `missingDependencies`
engine rather than hand-waved.

I found **no HIGH or MEDIUM blocking findings**. A small number of NITs remain that the
coder should resolve in passing but that do not block implementation.

Verdict: **APPROVED**.

---

## Findings

1. **NIT — `ScheduleRevision.actorMembershipId`/`actorUserId` lack a stated FK/validation
   rule (§6.9).** The table stores `actorUserId String` (non-null) and
   `actorMembershipId String?` but §6.9/§6.10 do not say whether these get composite FKs.
   The live append-only precedents (`student_profile_history`,
   `academic_calendar_day_revisions`) both store `actorUserId String` with **no** FK to
   `users` (verified in schema.prisma — neither revision model declares an actor relation),
   exactly like `AuditEvent.actorUserId` which is single-column by design. **Fix:** state
   explicitly in §6.10 that `actorUserId`/`actorMembershipId` on `schedule_revisions` are
   recorded id columns with **no FK** (mirroring `student_profile_history`), so the coder
   does not invent a composite FK that would then need `(id, institutionId)` on a cross-
   tenant-capable actor. One sentence; no schema change.

2. **NIT — `DayOfWeek` enum ordinal is asserted in a comment but not enforced anywhere
   (§6.1, §8.2).** The design pins `SUN=0..SAT=6` via the TS `DOW_INDEX` map and aligns it
   to `getUTCDay()`. That is correct and deterministic in the pure function. But the
   Postgres enum `DayOfWeek { SUN MON ... SAT }` carries no numeric meaning in the DB, and
   `InstitutionConfig.workingDaysOfWeek` defaults to `[1,2,3,4,5,6]` (Mon–Sat, Sunday
   excluded) — verified in schema.prisma. The mapping only matters inside `DOW_INDEX`, so
   there is no live bug; the risk is a future contributor adding a DB-side weekday
   comparison with a different convention. **Fix:** add one line to §8.2 stating the
   ordinal convention lives **only** in `DOW_INDEX` (and `getUTCDay()`), and that no SQL
   compares `dayOfWeek` numerically — the enum is a label, integers live in the service.

3. **NIT — `workingDaysOfWeek` is `Json` in the DB; §8.1 types it `number[]` without
   noting the parse/guard (§8.1).** Verified: `InstitutionConfig.workingDaysOfWeek Json
   @default("[1,2,3,4,5,6]")`. The live `allowance-engine.ts` does not trust the raw JSON —
   it does `Array.isArray(...)`, `.map(Number)`, `.filter(Number.isInteger && 0..6)` and
   falls back to `[1..6]` if empty (verified, lines ~261–270). The design passes
   `workingDaysOfWeek: number[]` into the pure function but does not say the route must
   parse/guard the JSON the same way before handing it in. **Fix:** note in §8.1/§8.3 that
   the route coerces `InstitutionConfig.workingDaysOfWeek` to a validated `number[]`
   (reusing the allowance-engine guard shape) before building `ConflictContext`, so a
   malformed config cannot throw inside the pure function.

4. **NIT — dry-run endpoint `POST /api/classes/timetables/:id/check` has no permission key
   explicitly assigned (§8.3, §7).** The permission table (§7) grants
   `classes.timetable.manage` for create/edit/publish and `classes.view` for staff read.
   The dry-run "check conflicts for the whole timetable or a candidate slot" sits between
   the two. **Fix:** state which key gates `/check` — it should be
   `classes.timetable.manage` (it is part of the authoring flow and reveals nothing a
   manager cannot already see), not `classes.view`. One line in §7 or §8.3.

---

## Verified Assumptions (checked against live source)

- **Module-dependency engine (§3, §13, resolves prior Finding 2).** `missingDependencies`
  in `apps/api/src/services/module-system.ts` is
  `required.filter((dep) => rowsByKey.get(dep)?.state !== "ACTIVE")`. An **absent** row →
  `undefined !== "ACTIVE"` → reported missing. `MODULE_DEPENDENCIES.attendance =
  ["student_management","academic_sessions","class_course"]` (verified in
  `packages/shared/src/modules.ts`). So the design's statement — that with no
  `institution_module` row for `class_course`, Phase-4 `activate("attendance")` returns
  `DEPS_UNMET` under the live engine, and there is no force-activate path — is **exactly
  correct**. The module header confirms "deliberately NO force-activate path."
- **`class_course` is a declared-but-not-operational module key (§3).** `modules.ts`
  declares it in `MODULES` with description "(future)" and a `MODULE_DEPENDENCIES` entry of
  `[]`; it is not seeded as an entitlement. Matches the Phase 1/2 precedent.
- **Phase 1/2 are permission-gated, not module-gated (§3).** `routes/students.ts` registers
  with a single `authenticate` preHandler and `requirePermission("students.<x>")`, no
  `requireModuleActive`; its header comment states "foundational institution-layer data —
  gated by `requirePermission` ... ONLY, NEVER `requireModuleActive`." `permissions.ts`
  annotates `students.*` as "Foundational institution-layer data, permission-gated ONLY
  (never module-gated)." The foundational placement for Phase 3 is consistent.
- **`UserRole` has no `FACULTY` value (§5).** Verified: enum values are
  `STUDENT HOD GUARD ADMIN SUPER_ADMIN`. Faculty-as-additive (new `FacultyProfile` + new
  `FACULTY` template role, no enum change) is the correct additive path.
- **`HodProfile` shape the design parallels (§5, §6.6).** `HodProfile` has `userId String
  @unique`, `departmentId String` (non-null), `@@unique([id, institutionId])`,
  `@@index([institutionId])`. `FacultyProfile` mirrors it (with `departmentId String?`
  optional, which is a reasonable faculty-specific relaxation). A user can hold both
  profiles and both template roles — `InstitutionMembership` → `MembershipRole` supports
  multiple roles (verified), so HOD-and-faculty is genuinely supported with one identity.
- **`Role.key` is string-keyed and open (§5).** `Role` has `@@unique([key, institutionId])`
  with nullable `institutionId` (template rows are `institutionId = NULL`). Adding a
  `FACULTY` template role is data, not an enum migration. The authenticate resolver reads
  whatever roles a membership holds (`roleKeys = ...membership.roles.map(mr => mr.role.key)`
  — verified in `middleware/auth.ts`), so a FACULTY role flows into `request.auth.roles`
  with no middleware change.
- **`request.auth.roles` are role KEYS (§7.1).** Verified: built from `mr.role.key`,
  deduped+sorted. The scope helper's `roles.includes("HOD") && !roles.includes("ADMIN")`
  checks are correct against this shape. `request.auth.departmentScope` and
  `request.auth.membershipId` exist and are populated from the membership each request.
- **`students.ts departmentScopeFilter` behaves as described (§7.1, resolves prior Finding
  3).** It returns a **direct** `{ departmentId: scope }` fragment and relies on
  `StudentProfile.departmentId` (a real non-null column — verified). The design correctly
  does **not** reuse it verbatim (Phase-3 tables have no `departmentId` except
  `FacultyProfile`) and instead defines a per-`kind` relation-filter helper. The relation
  hops it uses (`program.departmentId`, `course.program.departmentId`,
  `classSection.program.departmentId`) are all backed by real FKs/columns:
  `Program.departmentId` exists and `Program` carries `@@unique([id, institutionId])`.
- **`CalendarService.effectiveDayType` signature + contract (§8).** Verified:
  `effectiveDayType(institutionId, date, db, opts?)` returns `AcademicDayType | null`,
  "returns null when no explicit entry exists (the caller falls back to its own weekday
  rule)" and "does NOT decide working vs not — only the dayType." The design's rule —
  calendar only *describes* the day, the timetable module decides out-of-hours is a WARN —
  honors this boundary exactly.
- **`AcademicDayType` values (§8.2.1).** Verified: `WORKING_DAY HOLIDAY WEEKEND EXAM_DAY
  VACATION SPECIAL_WORKING_DAY INSTITUTION_EVENT`. The design's working/non-working split
  (HOLIDAY/WEEKEND/VACATION ⇒ non-working; the rest ⇒ working) covers every value.
- **`getDay()` precedent + deliberate `getUTCDay()` divergence (§8.2).** Verified:
  `allowance-engine.ts` uses `date.getDay()` on locally-constructed `Date`s and
  `workingDaysOfWeek.has(...)`. The design's switch to `getUTCDay()` for date-only ISO
  strings is the correct, deterministic choice and is explicitly flagged as a documented
  divergence — not an unnoticed inconsistency.
- **Audit catalogue conventions (§9).** Verified in `audit-actions.ts`: there is NO pg
  enum and NO seeded rows for audit actions, validation lives only in `recordAuditEvent`,
  and keys are past-tense (`campus_movement.pass.requested`, `...approved`). Adding
  past-tense `classes.*` keys needs no migration mirror — correct. `recordAuditEvent(input,
  tx?)` accepts an optional `Prisma.TransactionClient` (verified), so the atomic in-tx
  audit write the design specifies is supported.
- **catalogue-sync parser behavior (§7, §11j).** Verified in `catalogue-sync.test.ts`:
  `extractPermissionKeys` slices `INSERT INTO "permissions"` → first `ON CONFLICT`;
  `extractRolePermissionPairs` slices `INSERT INTO "role_permissions"` → `AS m(` and matches
  two-literal `('X','Y')` tuples; `SEEDING_MIGRATION_DIRS` must be edited to add the new
  migration; the union is set-equality-checked against `PERMISSION_KEYS` +
  `ROLE_PERMISSIONS`. The design's §11j rule (emit the 4-column `INSERT INTO "roles"`
  FACULTY row BEFORE the permissions block so its `, NULL)` tuple falls outside both sliced
  spans, and add the dir to `SEEDING_MIGRATION_DIRS`, and update `ROLE_PERMISSIONS` in
  lockstep) is correct and necessary. The FACULTY = `{classes.view_own}` single answer
  (resolves prior Finding 6) means the pair-set equality cannot be tripped.
- **Append-only escape-suite precedent (§12).** Verified in
  `tenant-escape-setup.ts`: `RLS_TABLES` lists `student_profile_history` /
  `academic_calendar_day_revisions`; `EXPECTED_POLICIES` gives them the
  `["tenant_isolation_select","<table>_tenant_insert"]` pair (NO modify policy); both are
  deliberately excluded from the generic seed/cleanup loop "because the BEFORE UPDATE OR
  DELETE trigger blocks even adminClient." The design's plan to add `schedule_revisions`
  the same way (append-only pair, self-contained case, excluded from the generic loop) is
  an exact match to the live pattern.
- **Frozen migrations / ledger (§11).** The migration plan CREATEs only new objects + adds
  the FACULTY role/permission seed, never ALTERs a Phase-0/1/2 table and never touches
  `_prisma_migrations`; `campass_app` stays NOSUPERUSER NOBYPASSRLS. Consistent with
  context.md §2/§3 and the diff→deploy rule. (The frozen SQL files themselves were not
  re-read line-by-line this review; the stated intent is to leave them untouched, which the
  escape-suite + catalogue-sync meta-tests enforce.)
- **Single student identity (§6.5).** `ClassEnrollment.studentId` → `student_profiles
  (institutionId, id)` composite FK, ON DELETE RESTRICT, with `@@unique([classSectionId,
  studentId])` for no-duplicate. `StudentProfile` carries `@@unique([id, institutionId])`
  (verified), so the composite FK is valid and enrollment references the authoritative
  Phase-2 record — no second student row. Correct.
- **History preservation (§6.7, §6.9).** Faculty reassignment is end-current-row-and-insert
  (soft `ACTIVE→ENDED` + `endedAt`), never an in-place `facultyId` overwrite, plus an
  append-only `ScheduleRevision`; the revision ledger is DB-enforced append-only (INSERT-
  only RLS + REVOKE UPDATE,DELETE + BEFORE UPDATE OR DELETE trigger). This matches the
  roadmap non-negotiable and the live append-only precedents.

## Unverified / Wrong Assumptions

- **No design claim was found to be factually wrong against source.** Every "the existing X
  does Y" claim I could trace resolved true (enumerated above). The previously-flagged wrong
  claim (that the live engine treats an absent `class_course` row as a satisfied dependency)
  has been removed and replaced with the correct behavior in this revision.
- **Not independently verified (stated, not load-bearing on a false premise):**
  - The exact SQL inside the 8 FROZEN migration files was not re-read line-by-line; the
    design commits to not editing them and the meta-tests (catalogue-sync, RLS presence,
    escape suite) are the enforcement. Accepted as low-risk given the enforcement net.
  - The 304-test green baseline (context.md §8) was not re-run as part of this review; it is
    a precondition the implementation step will re-establish.
  - `request.auth.departmentScope` carries a **department id** that matches
    `Program.departmentId` values (assumption A5). The column exists and is populated from
    `InstitutionMembership.departmentScope` (verified), but that the seeded/real scope value
    is a department **id** (not a code) is a data convention the design asserts and reuses
    from Phase 1; it is consistent with how `students.ts` uses it directly as
    `{ departmentId: scope }`, so it is treated as verified-by-precedent rather than
    independently re-proven.

---

## Verdict rationale

HIGH findings: 0. MEDIUM findings: 0. NIT findings: 4. Blocking count (HIGH+MEDIUM) = 0
⇒ **APPROVED**. The four NITs are polish the coder should fold in but none changes the
schema, the security posture, or the migration/tenancy approach.
