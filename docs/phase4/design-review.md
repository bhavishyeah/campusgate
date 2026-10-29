# Phase 4 Attendance — Design Review (revision iteration 3)

**Reviewed document:** `c:\campusgate\docs\phase4\design.md`
**Prior review:** `design-review.json` / `design-review.md` (iteration 2) — verdict
CHANGES_REQUESTED, 0 HIGH + 1 MEDIUM + 3 NIT.
**This review is a revision re-check:** each prior finding is re-checked against the new
design and marked Closed or Unchanged, then the changed material is reviewed fresh and
grounded against the authoritative specs and the actual repo source.

**Verdict: APPROVED** — 0 HIGH, 0 MEDIUM, 0 NIT. (The verdict is mechanical: any HIGH or
MEDIUM blocks; zero HIGH/MEDIUM approves.)

---

## Part A — Re-check of the iteration-2 findings

The design is a revision whose §15.1 responds point-by-point to the iteration-2 review
(1 MEDIUM + 3 NIT). Each is re-checked below against the new design text and the real
source.

| Iteration-2 finding | Status | Evidence |
|---|---|---|
| **MEDIUM-1** — post-commit low-attendance notify sets no tenant RLS context; `notifyUser(studentUserId, payload)` without a `tx` defaults to base `prisma` (no GUC) and the tenant-owned `notification.create` + alert-audit fail closed | **CLOSED** | §8.6 step 2 now wraps the per-student notify **and** its `attendance.low_attendance.alerted` audit in a **fresh short `withTenant(institutionId, tx => …)`** (a second transaction separate from the committed finalize tx) and passes that `tx` to **both** `notifyUser(s.studentUserId, …, tx)` and `recordAuditEvent(…, tx)`. A concrete code snippet is included, and the text states the base-`prisma` default is never used for these tenant-owned writes and that the §11.2 crossing test depends on this wiring. Verified against `apps/api/src/services/notifications.ts`: `notifyUser(userId, payload, db: Prisma.TransactionClient = prisma)` does a tenant-owned `notification.create`, and its own doc comment mandates the `withTenant` tx — the design's fix exactly matches the contract. |
| **NIT-1** — `GET /me` module-gating consequence (403 on own read, incl. historical finalized data, when `attendance` SUSPENDED) unstated | **CLOSED** | §8.5 now states `GET /me` carries `requireModuleActive("attendance")` like every operational route, so a SUSPENDED module returns 403 on the student's own read including historical finalized data, framed as intended gated-module behavior (the `campus_movement` precedent), not a data-loss path (records return on reactivation). |
| **NIT-2** — correction-apply overwrites `AttendanceRecord.markedAt`, erasing the original mark time from the live row | **CLOSED (recommended option a taken)** | §8.2 now updates **`status` only** and explicitly does **not** bump `markedAt`; §3.3 defines `markedAt` as the immutable original mark time, with the correction's when/who tracked on the `AttendanceRecordHistory` `CORRECTED` row (`createdAt` + `correctionId` + `actorMembershipId`) and on `AttendanceCorrection.reviewedAt`. §8.2 and §3.3 agree. |
| **NIT-3** — report / `GET /me` rate domain + term-scoping input unspecified; only the alert path pinned the FINALIZED-only domain | **CLOSED** | §8.5 (`GET /me`) and §8.4 (`GET /reports/section/:sectionId`) now both use the **same** pure `attendanceRate(records, policy)` helper over the **same FINALIZED-only domain** as §8.6 (OPEN/SUBMITTED provisional marks excluded; numerator = `status ∈ presentStatuses`; denominator = `status != EXCUSED`), each taking a **required `academicTermId` query param** matching `GET /export`. One helper, one domain, referenced from all three places — so dashboard rate, section report, and the alert threshold agree by construction. |

All 4 iteration-2 findings are **Closed**. None is Unchanged. (The 13 iteration-1
findings were already Closed in iteration 2 and remain so — the material backing them is
unchanged in this revision.)

---

## Part B — Fresh review of the changed material

The changed sections in this revision are §3.3, §8.2, §8.4 (reports row + dept-scope),
§8.5, and §8.6. Each was reviewed fresh and verified against source. No new HIGH, MEDIUM,
or NIT finding arises.

- **§8.6 post-commit alert wiring** — verified feasible and correct against the real
  `notifyUser` signature and the `recordAuditEvent(input, tx?)` signature / `AuditInput`
  shape (`action: AuditActionKey`, `result`, `actorUserId`, `actorRoleKey` required,
  `resourceType`, `resourceId?`, `metadata?`). The snippet's field set is valid. The
  at-most-once best-effort try/catch around a per-student short `withTenant` tx is a sound
  decoupling: a notify failure rolls back only that student's `notification` + alert-audit,
  never the already-committed finalize. `actorUserId` / `actorRoleKey` are the finalizing
  faculty's, available on `request` after commit — acceptable.
- **§8.2 / §3.3 `markedAt` immutability** — internally consistent; the live row keeps a
  truthful original-mark timestamp while the correction when/who is fully recorded on the
  append-only history row and the correction row. No contradiction remains.
- **§8.5 / §8.4 shared rate domain** — the single `attendanceRate(records, policy)` helper
  over one FINALIZED-only domain, plus required `academicTermId`, removes the prior
  cross-section inconsistency risk. The §8.4 `attendanceDepartmentScopeFilter` relation path
  (`attendanceSession → scheduledClass → classSection → program.departmentId`) is feasible:
  verified `ClassSection → Program` and `Program.departmentId` (non-null) exist in
  `schema.prisma`, mirroring the live `classesDepartmentScopeFilter` precedent.

### Specific items the task asked to confirm are resolved

1. **Module-dependency decision — RESOLVED, consistent with Phase 1/2/3.** §4.2 chooses
   Option (a): `MODULE_DEPENDENCIES.attendance = []`; attendance's own row must be
   ENTITLED→ACTIVE; foundational class/student/session prerequisites validated at operation
   time. Verified `missingDependencies` in `module-system.ts` treats an absent/non-ACTIVE
   row as UNMET (`rowsByKey.get(dep)?.state !== "ACTIVE"`) — exactly the permanent-block
   trap (foundational data has no `InstitutionModule` rows) the choice avoids. Verified the
   `classes`/`students` catalogue comments state "Foundational institution-layer data …
   permission-gated ONLY (never module-gated)", so Option (a) is the consistent stance.
   §4.2.1 correctly recognizes that emptying the edge set is a **test re-architecture**, not
   an expectation bump: I confirmed the four exemplar `it(...)` assertions in
   `module-system.integration.test.ts` are hard-wired to attendance's three edges
   (`missingDependencies("attendance", …)` ⇒ `["academic_sessions","class_course"]`;
   `activation is BLOCKED … DEPS_UNMET` ⇒ `["academic_sessions","class_course","student_management"]`;
   `affectedDependents("student_management", …)` ⇒ `["attendance","fees"]` in two tests), and
   that `examinations: ["academic_sessions","class_course","student_enrollment"]` and
   `fees: ["student_management"]` exist in `modules.ts` to carry the re-pointed coverage.
2. **Finalized-record immutability + audited correction BY CONSTRUCTION — RESOLVED.** §6
   uses a dedicated append-only `AttendanceRecordHistory` (INSERT-only RLS +
   `REVOKE UPDATE, DELETE` + `BEFORE UPDATE OR DELETE` RAISE trigger, the verified
   `schedule_revisions` house style) with typed `previousStatus`/`newStatus`,
   `correctionId`, non-null `actorUserId`, and `actorMembershipId` populated on real paths.
   Before/after + actor are permanently recorded; the finalize→correct state machine forces
   every FINALIZED-record change through the approve path that writes the history row in the
   same transaction.
3. **Real faculty-scoped marking authz + 403 — RESOLVED.** §7 implements an in-handler
   `assertFacultyAssigned` reading `FacultyAssignment` (ACTIVE, matching subject+term and
   section-or-null) under RLS, with the `ScheduledClass.facultyId` fast path, returning 403
   `not assigned to this class` (with a records-then-returns DENIED audit) on an unassigned
   class. Verified the `FacultyAssignment` / `FacultyProfile` / `ScheduledClass` shapes make
   the query valid, and that in-handler record-level scope is the live precedent
   (`classesDepartmentScopeFilter`, GatePass).
4. **Full tenancy checklist for every new table — RESOLVED.** §9 applies the §8 checklist
   to all four tables: non-null `institutionId`, composite FKs including `institutionId`
   (incl. the three-column session↔class↔term FK), `(id, institutionId)` uniques, ENABLE +
   FORCE RLS with nullif-guarded fail-closed policies (append-only pair for history),
   `withTenant` access, `@@index([institutionId])`, and escape-suite extension incl. the
   deliberately-buggy-query and append-only cases.
5. **No GatePass/movement coupling — RESOLVED.** §13 asserts no FK/table/import ties
   attendance to gate/pass code; the `attendance.*` permission and audit namespaces are
   disjoint from `campus_movement.*`.
6. **Migration NEW dir via diff+deploy; frozen dirs + ledger untouched; catalogue-sync +
   SEEDING_MIGRATION_DIRS — RESOLVED.** §10 hand-authors a new
   `20261101000000_phase4_attendance` dir (diff → deploy → status), adds the additive
   `scheduled_classes (institutionId, id, academicTermId)` UNIQUE in the Phase 4 dir (not by
   editing the frozen Phase 3 dir), seeds exactly the nine `(role, key)` pairs, and adds the
   new dir to `SEEDING_MIGRATION_DIRS`. Verified catalogue-sync enforces union set-equality
   of `PERMISSION_KEYS` + `ROLE_PERMISSIONS` against the parsed seed blocks.
7. **Correction initiator + reviewer scoping — RESOLVED, unambiguous.** §8.1: faculty may
   request on their own FINALIZED sessions; students read-only (no `attendance.correct` /
   no dispute permission in Phase 4); reviewer is HOD (department-scoped) or ADMIN
   (whole-tenant); separation of duties (FACULTY lacks `attendance.correct`). No-op rejected
   (400), one-PENDING-per-record (partial unique, 409), optimistic re-check on approve (409).
8. **Backend-only scope + deferred frontend — RESOLVED.** The header and §13 scope the work
   to `apps/api` + `packages/db` + `packages/shared`, explicitly defer `apps/web` per
   roadmap Option A, and satisfy the DoD at the API + test + DB-verification level.

---

## Verified assumptions (checked against source, confirmed correct)

1. `notifyUser(userId, payload, db: Prisma.TransactionClient = prisma)` performs a
   tenant-owned `notification.create` and its doc comment mandates the `withTenant` tx —
   the §8.6 fix (pass `tx`) is exactly right (`apps/api/src/services/notifications.ts`).
2. `recordAuditEvent(input, tx?)` and `AuditInput` (`action: AuditActionKey`, `result`,
   `actorUserId`, required `actorRoleKey`, `institutionId?`, `actorMembershipId?`,
   `resourceType`, `resourceId?`, `metadata?`) match the §8.6 snippet and §5.3
   (`apps/api/src/services/audit.ts`). The new `attendance.*` audit keys must be added to
   `audit-actions.ts` for the code to typecheck — the design states this in §5.3.
3. `MODULE_DEPENDENCIES` is `attendance: ["student_management","academic_sessions","class_course"]`,
   `examinations: ["academic_sessions","class_course","student_enrollment"]`,
   `fees: ["student_management"]` — the exact graph the §4.2.1 re-architecture relies on
   (`packages/shared/src/modules.ts`).
4. The four exemplar `it(...)` assertions in `module-system.integration.test.ts` are
   hard-wired to attendance's three edges with the exact expected sets §4.2.1 cites, so the
   re-architecture (not an expectation bump) is genuinely required.
5. `missingDependencies` treats an absent row as UNMET (`!== "ACTIVE"`); `affectedDependents`
   returns ACTIVE+SUSPENDED dependents — matches §4 and §4.2.1 (`module-system.ts`).
6. `classes`/`students` are foundational, permission-gated only, no `InstitutionModule`
   rows ("permission-gated ONLY (never module-gated)" catalogue comment) — Option (a) is
   consistent (`packages/shared/src/permissions.ts`).
7. `FACULTY` currently holds only `["classes.view_own"]`, so appending `attendance.mark` +
   `attendance.view_own` is additive (`permissions.ts`).
8. `ScheduledClass` carries nullable `dayOfWeek`, nullable `date`, `status`
   `ScheduledClassStatus {SCHEDULED, CANCELLED}`, `facultyId`, `subjectId`, `classSectionId`,
   `academicTermId`, and only `@@unique([id, institutionId])` today; `DayOfWeek` is
   `SUN,MON,TUE,WED,THU,FRI,SAT` (consistent with the §8.3 `getUTCDay()` SUN=0 mapping);
   the additive 3-col unique is a genuine superset key (`schema.prisma`).
9. `FacultyAssignment` has `facultyId, subjectId, classSectionId?(nullable), academicTermId,
   status FacultyAssignmentStatus{ACTIVE,ENDED}`; `FacultyProfile` has `userId @unique,
   institutionId, status FacultyStatus{ACTIVE,INACTIVE}` — the §7 helper queries are valid.
10. `ClassEnrollment.status EnrollmentStatus{ENROLLED,DROPPED,COMPLETED}`, and
    `ClassSection → Program → departmentId (non-null)` — the §8.3 ENROLLED snapshot and the
    §8.4 `attendanceDepartmentScopeFilter` relation path are feasible (`schema.prisma`).
11. The append-only house style (function + `BEFORE UPDATE OR DELETE` trigger +
    `GRANT SELECT,INSERT` / `REVOKE UPDATE,DELETE` + ENABLE/FORCE RLS +
    `tenant_isolation_select` + `*_tenant_insert`) exists as §6/§10 mirror it (Phase 3
    migration + `tenant-escape-setup.ts`), per tenancy.md §5 / database.md §4.
12. catalogue-sync enforces union set-equality of `PERMISSION_KEYS` + `ROLE_PERMISSIONS`
    against parsed seed blocks over `SEEDING_MIGRATION_DIRS`, parsing permission keys +
    role pairs only (not audit keys) — the §5.3 "audit keys need no migration mirror" claim
    and the §10j seed-lockstep requirement are correct
    (`apps/api/src/services/__tests__/catalogue-sync.test.ts`).
13. `classes.ts` uses `actorRoleKey: request.auth?.roles[0] ?? request.user.role`,
    `classesDepartmentScopeFilter`, and `withTenant(institutionId, tx => …)` — the exact
    precedents the design mirrors in §5.3, §8.4, and the route contract.
14. architecture.md §5.4 confirms attendance requires Student Management + Academic Sessions
    + Class/Course and that activation is blocked until deps are ACTIVE — the design's
    Option (a) correctly reconciles this with the no-`InstitutionModule`-rows reality of
    foundational data.
15. roadmap.md Option A (backend-first) and the Phase 4 scope (correction workflow,
    faculty-only marking of assigned classes, finalized immutability via audited correction,
    attendance ≠ gate-pass) match the design's scope and non-couplings.

## Unverified / wrong assumptions

None. Every load-bearing claim in the changed material was verified against the actual
source files listed above. The one remaining implementation obligation that is a claim
rather than existing code — adding the new `attendance.*` audit keys to
`audit-actions.ts` so the `recordAuditEvent` calls typecheck — is explicitly stated by
the design (§5.3) and is a build-time requirement, not a design gap.

---

## Verdict rationale (mechanical)

- HIGH: 0
- MEDIUM: 0
- NIT: 0

0 HIGH + 0 MEDIUM ⇒ **APPROVED.** All four iteration-2 findings are genuinely resolved by
construction (tenant-tx notify wiring, stated module-gating consequence, immutable
`markedAt`, one shared FINALIZED-only rate domain), and a fresh review of the changed
material against the real repo source surfaced no new HIGH, MEDIUM, or NIT issue. The
design stands on its own and is ready for implementation.
