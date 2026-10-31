# Design Review — CAMPASS Phase 8 EXAMINATIONS SLICE 8.2 (backend only)

Document reviewed: `c:\campusgate\.agents\tasks\phase8-exams-slice2\design.md` (REV 2, post-review).
Reviewed fresh against the real slice 8.1 sources on `main`.

This is a revision (REV 2) of a design whose REV 1 review raised 2 HIGH + 5 MEDIUM
+ 1 NIT. Per the revision protocol I re-checked each prior finding against the
new design (see "Prior findings re-check" below), then reviewed what changed.

Verdict is mechanical: count of HIGH + MEDIUM findings. This review has **0 HIGH,
0 MEDIUM, 4 NIT** ⇒ **APPROVED**.

---

## Sources verified (read in full or in the relevant span)

- `packages/db/prisma/migrations/20261206000000_phase8_exams_slice1/migration.sql` (all 716 lines: enums, tables, indexes, FKs, CHECKs, RLS §g, triggers §h, GRANTs §i, catalogue seed §j).
- `packages/db/prisma/schema.prisma` (Examination, ResultPublication, GradingScheme, GradeBand models + relations).
- `apps/api/src/routes/exams.ts` (publish route, `latestPublication`, `deny`/`isDeny`/`isRestrictViolation`/`advisoryLock`/`actor`/`advanceExamStatus`, create `POST /`, `PUT /:id/marks`, `POST /:id/marks/:recordId/correct`, `/me/results*`).
- `apps/api/src/services/exams/grading.ts` (`gradeSubject`, `GradingError`, `isPassing`-authoritative banding, BigInt round-half-up).
- `apps/api/src/services/attendance-authz.ts` (`resolveMarkingFaculty` ACTIVE gate, `assertFacultyAssigned`).
- `packages/shared/src/permissions.ts` (`PERMISSIONS`, `ROLE_PERMISSIONS`: STUDENT, FACULTY, HOD, ADMIN exam bindings).
- `packages/shared/src/audit-actions.ts` (the 15 `exams.*` keys).
- `apps/api/src/services/__tests__/catalogue-sync.test.ts` (`SEEDING_MIGRATION_DIRS`, the permissions/role_permissions span parser, set-equality).
- `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` (`RLS_TABLES`, `EXPECTED_POLICIES`, `DEFAULT_POLICIES`, the exams seed/teardown comments).

---

## Prior findings re-check (REV 1 → REV 2)

| REV1 # | Severity | Status in REV 2 | Verification |
|--------|----------|-----------------|--------------|
| 1 | HIGH | **Closed** | Confirmed against the real routes: `POST /:id/marks/:recordId/correct` gates on `status === "MODERATION"` and `PUT /:id/marks` on `"MARKS_OPEN"`; `examinations_guard` freezes a PUBLISHED exam's status with no `PUBLISHED → *` edge. So neither 8.1 route can mutate a mark on a PUBLISHED exam. REV 2's dedicated `POST /reeval/:id/remark` (`exams.reeval.manage`, UNDER_REVIEW-gated, scoped to the request's `(examId, candidateId)`) is the correct fix. `marks_records_guard` (§h.2) freezes only `institutionId, examId, assessmentId, candidateId, studentId` and raises on DELETE — it already permits a `marks`/`enteredByUserId` UPDATE, so no trigger change is needed. Matches the 8.1 correct route's own `update({ marks, enteredByUserId })`. |
| 2 | HIGH | **Closed** | Confirmed 8.1 never writes `SUPERSEDED` (append-only trigger blocks UPDATE) yet its publish route supports re-publication, so legacy exams can carry multiple `PUBLISHED` rows across versions. REV 2's ordered one-time backfill (disable append-only trigger → flip non-max PUBLISHED → SUPERSEDED → drop trigger → create column guard → swap RLS/GRANT) is sound and idempotent; it establishes the "max version is the sole PUBLISHED row" invariant on which the `flipped.count === 1` assertion depends. |
| 3 | MEDIUM | **Closed** | Confirmed the 8.1 `latestPublication` helper orders by `version desc` with NO status filter, so a stray SUPERSEDED row at max version would leak to a student. REV 2 adds `latestPublishedPublication` (`status = 'PUBLISHED'` AND `version desc`) for all student-facing reads and keeps `latestPublication` for staff. |
| 4 | MEDIUM | **Closed** | The supplementary-registration contract is now single/deterministic (omit `studentIds` ⇒ full computed eligible set; present ⇒ exactly that set after an atomic all-eligible assertion, else 409 + DENIED audit). Per-subject semantics clarified against the real `candidates` table (exam-scoped, no `subjectId`). |
| 5 | MEDIUM | **Closed** | Supersede key renamed to `exams.results.superseded` (plural `results`), consistent with the real 8.1 keys `exams.results.published` / `exams.results.exported` in `audit-actions.ts`. |
| 6 | MEDIUM | **Closed** | `reevalTransitionLegal(from,to)` pure helper decides legality before the write; `from` read in-tx; optimistic `updateMany where:{status:from}` with `count===0 ⇒ 409`; `outcomePublicationId` validated via `findFirst({id,institutionId,examId})` and permitted only when `to==="REMARKED"`. Trigger is the backstop. |
| 7 | MEDIUM | **Closed** | Confirmed `result_publications_tenant_insert` is referenced only in `EXPECTED_POLICIES` (verified: the escape harness entry at the `result_publications` key) besides the 8.1 migration; REV 2 removes that entry so it falls through to `DEFAULT_POLICIES` (`tenant_isolation_select` + `tenant_isolation_modify`). The `FOR ALL` modify policy's `WITH CHECK` is satisfied by the 8.1 INSERT path (institutionId always = tenant GUC). Policy/trigger swaps are invisible to `prisma migrate diff`. |
| 8 | NIT | **Closed** | Frozen-column alignment note added across the Prisma model, migration columns, and the guard body; a behavioral assertion that an UPDATE of `studentReason` is rejected (409) is added. |

All eight prior findings are genuinely resolved against the real sources. No prior
finding is Unchanged.

---

## New findings (this review)

### NIT-1 — §14 files-touched map omits the edit to the existing `POST /` examination create handler
The real `POST /` handler (`apps/api/src/routes/exams.ts`) builds its `tx.examination.create({ data: {...} })` with an explicit field list that does NOT include `parentExaminationId`, and it does not call any linkage check. §8.4 and §6.1 require (a) `assertSupplementaryLinkage` to run and (b) `parentExaminationId` to be persisted on create. §14's implementation map lists new routes + the supersede flip in `exams.ts` but never names the modification of the existing create handler.
**Fix:** add to §14 an explicit bullet: "modify the existing `POST /` examination create handler to call `assertSupplementaryLinkage(tx, institutionId, { type, parentExaminationId })` after the session/term/program checks and before `create`, and add `parentExaminationId: data.parentExaminationId ?? null` to the `examination.create` data." Concretely:
```ts
// after the session/term/program findFirst checks, before create:
const linkDeny = await assertSupplementaryLinkage(tx, institutionId, {
  type: data.type, parentExaminationId: data.parentExaminationId,
});
if (linkDeny) return deny(linkDeny.message, 400); // + DENIED audit per §8.4
// ...
const exam = await tx.examination.create({
  data: { /* ...existing... */, parentExaminationId: data.parentExaminationId ?? null },
});
```

### NIT-2 — supersede audit event does not specify `resourceId` / actor plumbing
§8.3 specifies the `exams.results.superseded` audit metadata `{ supersededVersion: priorVersion, byVersion: nextVersion }` but does not name the `resourceId`/`resourceType`. The 8.1 publish audit uses `resourceType: "ResultPublication", resourceId: publication.id` (the NEW version's header). For the supersede event the natural anchor is the flipped prior row, which the current flip code (`updateMany`) does not return. 
**Fix:** state in §8.3 that the supersede audit uses `resourceType: "ResultPublication"` with `resourceId` = the prior PUBLISHED row's id (fetch it in the same `updateMany`'s preceding `findFirst`, or set `resourceId` to the new `publication.id` and carry `supersededVersion` in metadata). Either is fine — just pin one so the implementer does not invent it.

### NIT-3 — §8.2a re-mark history-row shape elides `actorMembershipId`
The real 8.1 correct route writes `marks_record_history` with `actorMembershipId: request.auth?.membershipId ?? null`. §8.2a's `marksRecordHistory.create` data list shows `{ changeType, previousMarks, newMarks, actorUserId, reason, … }` with the trailing `…`. To avoid an implementer dropping `actorMembershipId` (nullable in 8.1, so not fatal, but the slice claims "reused verbatim"), spell it out.
**Fix:** in §8.2a step 4, list `actorMembershipId: request.auth?.membershipId ?? null` explicitly in the history-create shape, matching the 8.1 correct route verbatim.

### NIT-4 — AC#2 "a–j house style" vs the extra sections the 8.2 migration requires
The 8.1 migration is sectioned a–j. The 8.2 migration additionally performs a trigger/function SWAP on `result_publications`, a re-authored `examinations_guard`, a one-time backfill, and an ALTER on `examinations` — operations that do not map cleanly onto the 8.1 a–j letters (which assume strictly-additive CREATEs). AC#2 asserts "the a–j house style" without saying where the swap/backfill/ALTER sections sit in the letter sequence. This is a presentation-only ambiguity (the SQL is fully specified in §6.1/§7.1), not a correctness gap.
**Fix:** in AC#2 / §5 / §11, state the intended section placement, e.g. "sections a–j mirror 8.1 for the new `reeval_requests` table + enum + seed; the `examinations.parentExaminationId` ALTER, the re-authored `examinations_guard`, and the `result_publications` backfill+swap are appended as explicitly-labelled sections k/l/m (clearly non-additive, documented as such)."

---

## Verified Assumptions (design claim ↔ real source — all CONFIRMED)

1. `ExaminationType` enum includes `SUPPLEMENTARY`; `examinationTypeEnum` Zod enum lists it; `ResultPublicationStatus` = `{PUBLISHED, SUPERSEDED}` with 8.1 writing only PUBLISHED. (migration §a; `validation.ts:1151`.)
2. `result_publications` / `result_snapshots` / `marks_record_history` are INSERT-only in 8.1 via `<table>_append_only()` + `BEFORE UPDATE OR DELETE` trigger, append-only RLS pair, and `REVOKE UPDATE, DELETE`. (migration §g/§h.3/§i.)
3. The publish route accepts `status === "APPROVED" || "PUBLISHED"`, computes `nextVersion = (latest?.version ?? 0) + 1`, requires `reason` when `nextVersion > 1`, re-grades from current `marks_records` + active scheme, writes fresh snapshots, and does NOT flip the prior version. (`exams.ts` publish handler, verified line-by-line.)
4. `examinations_guard` freezes `institutionId, academicSessionId, academicTermId, programId, type, createdByUserId`, freezes a PUBLISHED exam's status, enumerates the forward-only edges, and raises on DELETE. No `PUBLISHED → *` edge exists. (migration §h.1.)
5. `marks_records_guard` freezes only `institutionId, examId, assessmentId, candidateId, studentId` and raises on DELETE — `marks` and `enteredByUserId` are mutable. (migration §h.2.) ⇒ the re-mark route needs no trigger change. CONFIRMED against the 8.1 correct route which updates `{ marks, enteredByUserId }`.
6. `POST /:id/marks/:recordId/correct` requires `MODERATION`; `PUT /:id/marks` requires `MARKS_OPEN`; both would reject a PUBLISHED exam. (verified both handlers.) ⇒ REV 2's dedicated re-mark route is necessary and correct.
7. `gradeSubject(assessments, marks, bands)` is pure integer/BigInt, round-half-up `(num + 5000n)/10000n`, `isPassing`-authoritative; snapshots persist `passed`. ⇒ eligibility's `passed = false` test is sound. (`grading.ts`.)
8. `resolveMarkingFaculty` enforces `FacultyProfile.status = 'ACTIVE'`; `assertFacultyAssigned` is the assignment gate. Reused by supplementary marks via the unchanged `PUT /:id/marks`. (`attendance-authz.ts`.)
9. Step-up seam: publish preHandler order is `[requirePermission("exams.results.publish"), requireStepUp("exams.results.publish"), requireModuleActive(gate)]`. (verified.)
10. RBAC: STUDENT has `exams.results.view_own`; FACULTY has `exams.marks.enter`; HOD and ADMIN each hold the SIX management keys (`manage, grading.manage, candidates.manage, moderate, results.publish, results.view`) and NOT `exams.marks.enter`. 14 role_permission pairs seeded in both shared and the 8.1 migration §j. ⇒ FR-12 bindings (STUDENT→request_own, ADMIN+HOD→manage) sit cleanly on this structure; count goes 8→10 keys, 14→17 pairs. (CONFIRMED.)
11. `catalogue-sync.test.ts` unions permission keys + role_permission pairs over `SEEDING_MIGRATION_DIRS` (which already lists `20261206000000_phase8_exams_slice1`) and asserts exact set-equality vs `PERMISSION_KEYS` + `ROLE_PERMISSIONS`; the permissions span is parsed up to `ON CONFLICT`, the role_permissions span up to `AS m(`. ⇒ the §11 three-part edit (shared + migration spans + add 8.2 dir) is exactly what the test requires.
12. Audit keys live in `audit-actions.ts` (`AUDIT_ACTIONS`, 15 `exams.*` keys), no migration mirror, validated in `recordAuditEvent` against `AUDIT_ACTION_KEY_SET`. The 8.1 family uses plural `exams.results.published`/`exams.results.exported` and `exams.candidate.registered` — the 4 new keys are consistent and each is emitted by a named route (no dead keys); reused keys all exist.
13. `EXPECTED_POLICIES.result_publications = [tenant_isolation_select, result_publications_tenant_insert]`; `DEFAULT_POLICIES = [tenant_isolation_select, tenant_isolation_modify]`; `RLS_TABLES` already includes `result_publications`. ⇒ removing the `result_publications` entry so it falls through to the default pair, and adding `reeval_requests`, is exactly the harness edit the §13/§17 plan describes.
14. The 8.1 RLS §g gives the seven mutable/column-guard tables the default modify pair and the three INSERT-only tables the append-only pair — matching the design's class taxonomy and the `payment_transactions` immutability-via-column-guard precedent it cites.
15. `(id, institutionId)` composite unique exists on `examinations`, anchoring the new composite self-FK for `parentExaminationId`. (migration §c; schema `@@unique([id, institutionId])`.)
16. The matrix (§8.7) is complete and internally consistent: every new audit key maps to at least one route (requested→1, transitioned→4/5/6/7, remarked→8, superseded→9); read routes emit none; reused keys resolve to existing 8.1 keys.

## Unverified / Wrong Assumptions

None. Every load-bearing claim in the design that I could check against a real
source was confirmed. No claim was found to misstate the 8.1 behaviour.

(Not independently exercised here, because they are runtime/DB-trigger behaviours
rather than static claims — all are covered by the design's integration-suite plan
in §13 and are not in doubt: the actual Postgres rejection of a `SUPERSEDED →
PUBLISHED` write, the idempotency of the backfill on a live multi-version exam,
and the `prisma migrate diff` output showing only the cosmetic composite-FK diff.
These are correctly deferred to `exams-behavioral.integration` /
`tenant-escape.integration`.)

---

## Verdict

0 HIGH, 0 MEDIUM, 4 NIT ⇒ **APPROVED**.

The design stands on its own: the two correctness-critical seams the prompt
singled out — the `result_publications` append-only→column-guard SWAP (with the
load-bearing pre-swap backfill) and the `reeval_requests` forward-only lifecycle
guard — are concrete, mirror the real `examinations_guard` / append-only idioms,
and are testable. The supersede flip's `flipped.count === 1` invariant is
correctly predicated on the backfill. Multi-tenancy A2 is applied to every new
table, no fees import is introduced, and the lifecycle × route × permission ×
audit-key matrix has no dead keys. The 4 NITs are documentation/completeness
polish for the build step and do not block.
