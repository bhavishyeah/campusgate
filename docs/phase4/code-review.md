# CAMPASS Phase 4 — Attendance — Code Review

**Commit reviewed:** `b3031b4` on `main` — feat(attendance): implement Phase 4 attendance (backend)
**Scope:** `apps/api` + `packages/db` + `packages/shared` (backend-only, per roadmap Option A)
**Verdict:** APPROVED — 0 blocking findings.

This review checked the diff against the approved design (`docs/phase4/design.md`), the
plan (`docs/phase4/plan.md`), and the authoritative spec (`docs/roadmap.md` Phase 4 +
phase-completion gate). Recorded verification evidence (`docs/phase4/verification.md` +
the commit message) was read rather than re-run, per instructions.

---

## Verification evidence (read, not re-run)

`verification.md` records the full gate and it is internally consistent with the diff:

- **Migration hygiene:** one NEW dir `20261101000000_phase4_attendance` applied via
  `migrate status` (pre-flight) → `migrate diff` (read-only DDL confirm) → `migrate
  deploy` → `migrate status` (up to date, 10 dirs). The 9 frozen dirs and
  `_prisma_migrations` ledger untouched; no `migrate dev`/`reset`. Confirmed by the
  migration file header + the git stat (only the new dir added under `migrations/`).
- **campass_app role flags:** `rolsuper=false, rolbypassrls=false` (never BYPASSRLS).
- **DB smoke:** fail-closed count=0 with GUC unset; append-only UPDATE/DELETE on
  `attendance_record_history` both denied.
- **Clean build:** `npm ci` → `packages/shared tsc` → `prisma generate` → `apps/api tsc`
  → `npm run build` (turbo 3/3) all green (one transient Prisma CDN ECONNRESET retried).
- **Full suite:** `apps/api vitest run` → 43 files, **412 tests passed, 0 failed**
  (370-ish baseline + new Phase-4 unit/route/behavioral/escape + the module-system
  re-architecture + catalogue-sync). Evidence is present and complete; no missing-required
  verification.

---

## Critical invariants — verified BY CONSTRUCTION

### 1. Faculty-scoped marking (unassigned → 403) — ENFORCED
`attendance.ts` `POST /sessions` resolves the caller's ACTIVE `FacultyProfile`
(`resolveMarkingFaculty`), loads the tenant-filtered `ScheduledClass`, then calls
`assertFacultyAssigned` (`attendance-authz.ts`): fast path `scheduled.facultyId ===
facultyId`, else an ACTIVE `FacultyAssignment` on the same subject+term+(section or
section-less). A false result writes a `DENIED` audit and **returns** 403 (records-then-
returns inside the committed `withTenant` tx, so the DENIED row persists). The
mark/submit/finalize/correction handlers additionally re-assert
`session.markedByFacultyId === facultyId`. Proven at the route-contract level
(`attendance-routes.integration.test.ts` "UNASSIGNED class: 403 + DENIED audit") and
live (`attendance-behavioral.integration.test.ts` "faculty-scope … 403 + DENIED audit",
`facultyUser2` assigned elsewhere posting `scheduledClassA` → 403 + persisted DENIED
audit row asserted via `adminClient`).

### 2. Finalized-record immutability + audited correction — ENFORCED
- Mark/submit refuse once `session.status === "FINALIZED"` (409 `session finalized`).
- The only post-finalize write path is `POST /corrections/:id/approve`, which in one
  `withTenant` tx: re-reads the live record (asserts session FINALIZED), optimistic-
  concurrency re-check (`record.status !== correction.priorStatus` → 409 `record changed
  since request`), writes a `CORRECTED` `AttendanceRecordHistory` row (previous=live,
  new=requestedStatus, correctionId, actor), updates `status` ONLY (never `markedAt`),
  flips the correction to APPROVED, and writes `attendance.correction.approved`.
- Reject flips to REJECTED, record untouched, no history row, audit
  `attendance.correction.rejected`.
- History immutability is DB-enforced: `attendance_record_history` has INSERT-only RLS +
  `REVOKE UPDATE, DELETE FROM campass_app` + `BEFORE UPDATE OR DELETE` trigger
  (`restrict_violation`). Proven live ("correction workflow: request → HOD approve
  rewrites record + CORRECTED history + audit; reject leaves it untouched" and "finalized
  immutability … append-only history cannot be updated") and in the escape suite (3kk).

### 3. No duplicate identity — ENFORCED
`AttendanceRecord` references the shared `StudentProfile` via composite FK
`(institutionId, studentId) → student_profiles(institutionId, id)`; the session references
the shared `ScheduledClass` via the three-column FK. No student/class data is copied.
Students are loaded from `ClassEnrollment` (status ENROLLED) at open.

### 4. Tenant isolation — ENFORCED and ESCAPE-SUITE EXTENDED
All four tables carry `institutionId`, `(id, institutionId)` composite unique, tenant-root
FK, composite same-tenant FKs incl. `institutionId`, and `ENABLE`+`FORCE` RLS with
nullif-guarded fail-closed policies (standard pair on the three mutable tables; append-only
pair on history). The escape suite (`tenant-escape.integration.test.ts` 3gg–3kk) adds
cross-tenant read-denied, spoofed-write, foreign-parent (incl. the three-column term FK
3jj), buggy-query backstop (3jk), three-GUC fail-closed (3jl), the self-contained
append-only case (3kk), and `attendance_record_history` in the RLS-forced no-modify-policy
meta-assertion. Setup helper seeds the three mutable tables per tenant and excludes the
append-only table from the generic loop (trigger-safe), matching the schedule_revisions
precedent.

### 5. Module gating — ENFORCED
`attendance` is in `MODULES`; `MODULE_DEPENDENCIES.attendance = []` (Option (a),
foundational-not-gated) with the rationale documented inline. Every operational route
carries `requireModuleActive("attendance")` in addition to `requirePermission(...)`.
Proven: `attendance-routes.integration.test.ts` "module-inactive: every operational route
is 403 when attendance is not ACTIVE (incl. GET /me and HOD report)". The module-system
dependency state-machine exemplar was re-architected off `attendance` onto `examinations`
(multi-dep) + `fees`/`academic_sessions` (reverse-edge), so engine coverage is preserved,
not deleted; `modules.test.ts` adds the positive foundational-not-gated assertions.
Catalogue-sync stays green: the new dir is in `SEEDING_MIGRATION_DIRS` and the migration
seeds exactly the nine `(role, key)` pairs union-equal to `ROLE_PERMISSIONS`.

### 6. Attendance independent of GatePass/movement — CONFIRMED
No table, FK, or code path in the attendance module couples to gate-pass/movement state
(only a doc-comment references the `campus_movement` gating precedent). No coupling
introduced.

### 7. Migration hygiene — CONFIRMED
Single new hand-authored CREATE-only dir; frozen dirs + ledger untouched; additive
`scheduled_classes(institutionId, id, academicTermId)` UNIQUE created in the Phase-4 dir,
not by editing the frozen Phase-3 dir. campass_app stays NOSUPERUSER NOBYPASSRLS.

### 8. Backend-only — CONFIRMED
No `apps/web` changes in the diff. Deferred frontend respected.

### 9. Permissions / audit keys / notifications — CORRECT
Five `attendance.*` permissions + the exact nine role pairs (GUARD/SUPER_ADMIN zero),
nine `attendance.*` audit keys, all mutations call `recordAuditEvent(..., tx)` in-tx;
`requirePermission` gating present on every route; shim + legacy role claim untouched.
Low-attendance alert reuses the existing `notifyUser` inside a fresh post-commit
`withTenant` tx (tx passed to BOTH notify + audit, never base prisma), downward-crossing
predicate via the one shared `attendanceRate` helper, wrapped try/catch so a notify
failure never rolls back the committed finalize. No new notification system.

---

## Non-blocking observations (not findings; no action required)

- `attendanceDepartmentScopeFilter` defines a `"record"` kind that is not currently
  referenced by any route (reads go through `"session"`/`"correction"`). Harmless dead
  branch; no correctness impact.
- `GET /me` and `POST /sessions` recompute policy per request via `loadPolicy`
  (one indexed `institutionModule` read). Acceptable; matches the design's "read at
  operation time" stance.

These are explicitly not blocking and require no change under the review scope.

---

## Conclusion

Every approved requirement and critical invariant is implemented by construction and
proven by tests, the roadmap phase-completion gate (escape suite extended, permissions
registered + bound, audit on important actions, versioned migration with RLS/FKs in the
same migration) is satisfied, and the recorded verification evidence is complete and green.
No blocking findings. **APPROVED.**
