# Design Review (Revision 1) — CAMPASS Phase 9.1 Faculty Management (backend only)

Reviewer: design-review subagent. This is a REVISION review: the prior review
(`design-review.json` / earlier `design-review.md`) returned CHANGES_REQUESTED with
1 HIGH, 3 MEDIUM, 5 NIT (F1–F9). I re-checked each prior finding against the new
design and the real files, then reviewed what the revision changed for new issues.

Target: `c:\campusgate\.agents\tasks\phase9-faculty-management\design.md`.
Verdict: **APPROVED** (0 HIGH, 0 MEDIUM; 1 new NIT recorded below).

The verdict is mechanical: APPROVED because there are zero HIGH and zero MEDIUM
findings. All nine prior findings are Closed (re-verified against the real
codebase, not taken on the design's word). One new NIT (N1) is recorded; a NIT
does not block.

---

## Re-check of prior findings

### F1 — HIGH — §B.1 module-registry rationale factually wrong about `examinations` → **CLOSED**
The revised §B.1 now states the `[]` precedent is **attendance / fees / admissions only**, adds a dedicated "Counter-example, acknowledged (not a universal `[]` rule)" paragraph citing the real `examinations: ["academic_sessions","class_course","student_enrollment"]` edge, states the distinguishing test ("is the prerequisite itself a gated module?"), and explicitly warns the author NOT to "fix" `examinations`. Verified against the real `packages/shared/src/modules.ts`: `attendance: []`, `fees: []`, `admissions: []` (each with the foundational-not-gated inline comment), and `examinations` carries the non-empty edge verbatim. The `faculty_management: []` decision itself is correct. Fixed exactly as directed.

### F2 — MEDIUM — policy cap not surfaced to profile readers, `overAllocated` uninterpretable → **CLOSED**
§B.9 now adds an explicit paragraph: routes 12 (`GET /:facultyId/profile`), 13 (`GET /me/profile`), and 9 (`GET /:facultyId/workload`) include a read-only `policyMaxWeeklyHours: number | null` in each workload block, resolved server-side with NO extra permission, so a `faculty.view_own`-only FACULTY caller and a `faculty.directory.view`-only reader can both interpret `overAllocated`. The editable policy view (route 6) stays on `faculty.workload.manage`. Route-table notes for 9/12/13 updated. Resolves the ambiguity.

### F3 — MEDIUM — teaching-hours derivation double-counts across sections; role handling unspecified → **CLOSED**
§B.4 "Teaching-hours derivation" is rewritten to specify: counting unit = one row per DISTINCT `(subjectId, classSectionId)` ACTIVE assignment (sections counted separately, two sections = two loads); ONLY `role = PRIMARY` counts (`SUBSTITUTE`/`ASSISTANT` excluded and surfaced as `excludedAssignmentIds`); null `contactHoursPerWeek` → 0 + `unestimatedSubjectIds`. OQ-5 added for future SUBSTITUTE/ASSISTANT weighting. §B.13 updates the pure `computeWorkload` input element to `{subjectId, classSectionId, role, status}` with four mandated unit tests. Verified against the real schema: `FacultyAssignmentRole` has exactly THREE values (`PRIMARY`, `SUBSTITUTE`, `ASSISTANT`), and `attendance-authz.ts` `assertFacultyAssigned` uses `OR: [{classSectionId}, {classSectionId: null}]`, so section-specific and section-less assignments legitimately coexist. The counting rule is now unambiguous.

### F4 — MEDIUM — catalogue-sync parser end-markers are strict → **CLOSED**
§B.3(j) is now prescriptive with concrete SQL skeletons: permissions block FIRST ending at `ON CONFLICT ("key") DO NOTHING` with no earlier `ON CONFLICT`; role_permissions block SECOND in the mandatory `FROM (VALUES …) AS m("roleKey","permKey")` join form (plain-VALUES form explicitly FORBIDDEN). AC4 restates that the new dir string `"20261220000000_phase9_faculty_management"` must be hand-appended to the hardcoded `SEEDING_MIGRATION_DIRS`. Verified against the real `catalogue-sync.test.ts`: `extractPermissionKeys` slices `INSERT INTO "permissions"` → first `ON CONFLICT`; `extractRolePermissionPairs` slices `INSERT INTO "role_permissions"` → first `AS m(` (throws `end marker not found` if absent); `SEEDING_MIGRATION_DIRS` is a hardcoded 13-element array ending at `20261213000000_phase8_exams_slice2`. The prescription matches the parser exactly.

### F5 — NIT — restrict_violation 409 vs 500 inconsistency → **CLOSED**
§B.5 now firmly says **500** for the teaching-history append-only backstop, with the explicit rationale that it deliberately differs from the exams `409` because no legal UPDATE/DELETE path exists (a hit = code defect). §B.10 already said 500 and now cross-references §B.5. Verified: `exams.ts` `isRestrictViolation` maps to 409 at all three call sites (lines 345, 1307, 1767); the divergence is intentional and documented.

### F6 — NIT — "16 frozen dirs" stated without derivation → **CLOSED**
§A.4 and §B.3 now use the RULE ("every pre-existing migration directory stays byte-identical") plus the derivation (currently 16 = the 15 the slice-2 header names as frozen plus slice-2 itself). Verified: the real slice-2 header says it "NEVER edits any of the fifteen frozen migration directories," so 15 + slice-2 = 16 is a correct derivation.

### F7 — NIT — no error-handling entry for qualification delete of a missing/cross-tenant row → **CLOSED**
§B.10 now has the entry: delete uses `deleteMany({ where: { id, institutionId, facultyId } })`; `count === 0` → DENIED audit + `404 { error: "qualification not found" }` (not a silent 200); `deleteMany` chosen so a 0-row match is a count rather than a P2025 throw. Resolves the gap.

### F8 — NIT — no-op PATCH audit behavior unstated → **CLOSED**
§B.11 (`patchFacultyQualificationSchema`) now states a successful PATCH ALWAYS records `faculty.qualification.updated` even on a semantic no-op (audit records the staff action, not a field diff). Decision is explicit.

### F9 — NIT — `@@unique([institutionId])` vs OQ-2 per-term openness is non-additive → **CLOSED**
§B.2.2 now annotates the `@@unique([institutionId])` line as a deliberate this-slice commitment and notes that widening to per-term/per-designation later requires DROP+RECREATE of the unique — a non-additive change explicitly deferred with OQ-2 to its own later slice. The tension is acknowledged, not hidden.

---

## New findings (introduced or still latent in Revision 1)

### N1 — NIT — the §B.3(j) `role_permissions` skeleton omits the `AND r."institutionId" IS NULL` template-role join predicate

**Where:** Part B §B.3 section (j), the role_permissions INSERT skeleton:
```sql
...
) AS m("roleKey","permKey")
JOIN "roles" r ON r."key" = m."roleKey"
JOIN "permissions" p ON p."key" = m."permKey"
ON CONFLICT DO NOTHING;
```

**Problem:** EVERY existing seed block in all 13 migrations joins roles with `AND r."institutionId" IS NULL` (verified across `identity_rbac_b2`, `phase1_academics`, `module_system`, `phase2_sis`, `phase3_classes`, `phase4_attendance`, `phase5_library`, `phase6_admissions`, `phase7_fees_slice1`, `phase8_exams_slice1`, `phase8_exams_slice2`, etc.). The skeleton in §B.3(j) drops that predicate. The `roles_key_institutionId_key` unique permits tenant-scoped roles sharing a key with a template, and `roles_key_template_unique` only guarantees one template per key — so an unscoped join could match a tenant-custom role of the same key and bind faculty permissions to it (the `ON CONFLICT` guard de-dups duplicates but does not restrict the join target to templates). This does not block: the narrative §B.14 says the migration "mirrors the frozen house style," and the skeleton's stated purpose is to illustrate the parser's `AS m(` end-marker, not the full join. But a coder copying the skeleton verbatim would diverge from the invariant house pattern.

**Fix (concrete):** add the template-role predicate to the roles join, matching the house style verbatim, and use the deterministic-id and conflict-target forms the real migrations use:
```sql
INSERT INTO "role_permissions" ("id","roleId","permissionId")
SELECT 'rp_' || r."key" || '__' || p."key", r."id", p."id"
FROM (VALUES
  ('ADMIN','faculty.qualifications.manage'),
  ... (all ADMIN/HOD/FACULTY → faculty.* pairs) ...
) AS m("roleKey","permKey")
JOIN "roles"       r ON r."key" = m."roleKey" AND r."institutionId" IS NULL
JOIN "permissions" p ON p."key" = m."permKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
```
(The parser only requires the `AS m(` end-marker, so adding `AND r."institutionId" IS NULL` and the explicit conflict target is parser-safe and keeps the seed byte-aligned with the frozen house style.)

---

## Verified Assumptions (checked against the real files this revision cycle)

1. **`faculty_management: []` is correct and `examinations` is the acknowledged counter-example.** `packages/shared/src/modules.ts`: `attendance: []`, `fees: []`, `admissions: []` (each foundational-not-gated), `examinations: ["academic_sessions","class_course","student_enrollment"]`. ✓
2. **`FacultyAssignmentRole` has THREE values** (`PRIMARY`, `SUBSTITUTE`, `ASSISTANT`) — `schema.prisma` lines 1227–1232. The F3 rewrite's three-value claim is accurate. ✓
3. **`Subject.contactHoursPerWeek Int?` exists** — `schema.prisma` `model Subject`. ✓
4. **`FacultyAssignment`** carries `assignedAt`, `endedAt DateTime?`, `status FacultyAssignmentStatus` (ACTIVE/ENDED), `role FacultyAssignmentRole`, `@@index([institutionId, facultyId, status])`, `@@unique([id, institutionId])` — the reconcile read path + ACTIVE filter are feasible. ✓
5. **`attendance-authz.ts` `assertFacultyAssigned`** uses `OR: [{classSectionId}, {classSectionId: null}]` — section-specific + section-less coexist, so the F3 counting-unit rule is grounded in a real code fact. ✓
6. **`resolveMarkingFaculty(tx, institutionId, userId)`** exists in `attendance-authz.ts` with exactly the cited signature, returning `{ facultyId } | null` for `status: "ACTIVE"` faculty — the self-service (route 13) reuse is real. ✓
7. **`FacultyProfile`** has `userId @unique`, `name`, `departmentId?`, `status FacultyStatus`, `@@unique([id, institutionId])`, and relation-only back-ref list — additive relation back-refs and (conditional) additive-nullable columns are safe; no `SELECT *`-breaking shape. ✓
8. **Composite-FK targets** `subjects`, `academic_terms`, `class_sections` all carry `@@unique([id, institutionId])` — the §B.3(e) composite same-tenant FKs are feasible. ✓
9. **Append-only trigger idiom** matches `marks_record_history_append_only()` verbatim (slice-1 lines 614–623): same `RAISE EXCEPTION '… is append-only: % is not permitted', TG_OP USING ERRCODE = 'restrict_violation'`, same `BEFORE UPDATE OR DELETE … FOR EACH ROW`. ✓
10. **Append-only GRANT pattern** matches slice-1 (`GRANT SELECT, INSERT ON "marks_record_history"`; `REVOKE UPDATE, DELETE`). The design's "SELECT, INSERT only" is correct. ✓
11. **`isRestrictViolation` → 409 in exams.ts** at every call site (345, 1307, 1767); the design's deliberate 500 for the teaching-history backstop is a documented divergence. ✓
12. **catalogue-sync parser** behaves exactly as §B.3(j)/AC4 describe: permissions span ends at first `ON CONFLICT`; role_permissions span ends at first `AS m(`; `SEEDING_MIGRATION_DIRS` is a hardcoded array ending at `20261213000000_phase8_exams_slice2`. The 4-column `("id","key","module","description")` permissions shape is parsed by the 2nd-literal-is-key regex. ✓
13. **Audit actions need no migration mirror.** `audit-actions.ts` header confirms "NO pg enum and NO seeded rows … validation lives in the single `recordAuditEvent` writer"; `module` is a free string, so `module: "faculty_management"` is valid. ✓
14. **No existing `faculty.*` key collision.** A repo-wide search of `packages/shared/src` finds no `"faculty.` permission or audit key — the new `faculty.*` family is collision-free. ✓
15. **`FACULTY` role exists** in `ROLE_PERMISSIONS` (`["classes.view_own","attendance.mark","attendance.view_own","exams.marks.enter"]`) — adding `faculty.view_own` is additive and consistent with the self-scope precedent. ✓
16. **ADMIN+HOD management precedent** is real: `exams.reeval.manage` binds to ADMIN and HOD (and slice-2 seeds `('ADMIN','exams.reeval.manage'),('HOD','exams.reeval.manage')`) — the "no new role, bind to ADMIN+HOD" decision is grounded. ✓
17. **Recorded-actor-no-FK + decoupling precedents** are real: slice-2 `requestedByUserId`/`processedByUserId` (no FK) and `outcomePublicationId` (no FK, cycle-avoidance) — the design's `createdByUserId`/`recordedByUserId`/`sourceAssignmentId` (no FK) choices cite real precedents. ✓
18. **Tenant-escape harness extension points** (`SeededTenant`, the per-phase seed/teardown with append-only tables excluded from the generic loop and proven via self-contained `DISABLE TRIGGER` cases) are real in `tenant-escape-setup.ts`; the design's harness plan (three mutable tables seeded via adminClient, `faculty_teaching_history` as a self-contained append-only case) matches the documented precedent. ✓
19. **Additive column-guard / RLS swap patterns** (slice-2 §k `ADD COLUMN "parentExaminationId"`, the column-guard CREATE OR REPLACE, the standard pair `{tenant_isolation_select, tenant_isolation_modify}` with `nullif(current_setting('app.current_institution_id', true), '')`) are all verbatim in the real migrations — the design's RLS/GRANT/CHECK plans mirror them. ✓

## Unverified / Wrong Assumptions

1. **N1 (NIT):** The §B.3(j) role_permissions skeleton's roles join omits the `AND r."institutionId" IS NULL` template predicate that every one of the 13 real seed blocks uses. Verified WRONG against house style; recorded as N1 (non-blocking, since it is an illustrative skeleton and §B.14 commits to mirroring the frozen style).
2. **Note (not a finding):** OQ-1…OQ-5 are genuine product decisions the design correctly flags as open with stated defaults (explicit-staff-reconcile, uncapped-absent policy with override-with-reason default, no additive FacultyProfile fields, no new coordinator role, PRIMARY-only workload). These are legitimate deferrals with safe defaults, not spec gaps, and do not block a backend-only slice. No verification was possible or required beyond confirming they are product calls, not code facts.
3. **Note (not a finding):** The §B.3(j) skeleton shows `ON CONFLICT DO NOTHING` without a conflict target while the real seeds use `ON CONFLICT ("roleId", "permissionId") DO NOTHING`. This is parser-irrelevant (the end-marker is `AS m(`) and SQL-valid, folded into the N1 fix for house-style alignment rather than raised separately.
