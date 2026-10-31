# Re-evaluation, supplementary exams, and cross-session result history (Phase 8 slice 8.2, backend)

Slice 8.2 completes Phase 8 on top of 8.1, adding three capabilities with a deliberately small, additive surface: a student-initiated re-evaluation request with a forward-only staff lifecycle, supplementary exams linked to a parent via a nullable same-tenant self-FK, and a cross-session result-history read model with an XLSX transcript export. The load-bearing DB change is the `result_publications` trigger swap — the unconditional append-only trigger is replaced by a column guard that permits exactly `PUBLISHED → SUPERSEDED`, preceded by a one-time idempotent backfill that collapses any 8.1-era multi-`PUBLISHED` exam to a single max-version `PUBLISHED` row so the supersede flip can assert `count === 1`. The implementation tracks the approved design (REV 2) and plan step-for-step: the migration, schema mirror, shared catalogues, service helpers, routes, and both live-DB suites all landed as specified.

Watch for: one inconsistency the slice introduces but does not fully close — `SUPERSEDED` becomes a written state for the first time in 8.2, yet the two pre-existing 8.1 student read routes (`GET /me/results`, `GET /me/results/:examId`) still resolve via the max-version `latestPublication` helper rather than the hardened `latestPublishedPublication` the slice added for exactly this reason (NFR-4 / finding 3). **likely** — happy-path correct and invariant-protected, not a blocking leak, detail below.

**Verdict**: APPROVED

## High-level view

The re-evaluation lifecycle (`REQUESTED → UNDER_REVIEW → REMARKED → CLOSED`, side-exit `REQUESTED|UNDER_REVIEW → REJECTED`) is enforced in three aligned places: a pure `reevalTransitionLegal` helper the route consults before any write, an optimistic `updateMany where status = from` guard against concurrent moves, and the `reeval_requests_guard` trigger as the hard DB backstop. The frozen identity/provenance column set is byte-aligned across the Prisma model, the `CREATE TABLE`, and the trigger body.

The supersede flip is folded into the existing `POST /:id/publish` (not a new route), runs inside the same transaction and advisory lock, fires only when `nextVersion > 1`, and refuses to proceed unless exactly one prior `PUBLISHED` row flips. Because the re-mark path cannot use the 8.1 `MARKS_OPEN`/`MODERATION` routes (a `PUBLISHED` exam can never legally return there), a dedicated `exams.reeval.manage`-gated `POST /reeval/:id/remark` mutates the mark in-place while the request is `UNDER_REVIEW`, scoped to the request's own `(examId, candidateId)`, and leaves the exam status untouched.

Re-publication gating is reused verbatim: `requirePermission("exams.results.publish")` → `requireStepUp(...)` → `requireModuleActive(gate)` in the unchanged preHandler order. The new RBAC is clean — `exams.reeval.request_own` to STUDENT only, `exams.reeval.manage` to ADMIN+HOD only, FACULTY excluded — and the catalogue-sync meta-test includes the new migration dir so shared/migration set-equality holds.

Supplementary eligibility is computed from the parent's latest `PUBLISHED` non-passing snapshots; the registration endpoint has one deterministic contract (full computed set when `studentIds` omitted, or exactly the named set after an all-or-nothing eligibility check), and the parent link is a nullable composite same-tenant self-FK frozen after create by the re-authored `examinations_guard`. The grading engine is reused unforked.

Multi-tenancy A2 is intact on the new table — composite same-tenant FKs carrying `institutionId`, ENABLE+FORCE RLS with the nullif-guarded default pair, `campass_app` granted DML but never BYPASSRLS. `result_publications` correctly moves from the append-only RLS pair to the default modify pair (its immutability is now the column guard), and the escape harness is updated in lockstep. No fees import, `MODULE_DEPENDENCIES` untouched, the 15 frozen migration dirs byte-identical, and the extended escape suite covers `reeval_requests`, the `parentExaminationId` self-FK, and the `result_publications` column guard.

<details>
<summary>Issues (1)</summary>

1. **8.1 student read routes not hardened to `latestPublishedPublication`** — `GET /me/results` and `GET /me/results/:examId` still use the max-version `latestPublication`; since 8.2 makes `SUPERSEDED` a real written state, consider switching both to `latestPublishedPublication` for the defense-in-depth consistency the slice's own NFR-4 calls for. Non-blocking: happy path is correct and the single-`PUBLISHED`-max invariant protects it.

</details>

<details>
<summary>Details</summary>

### result_publications trigger swap and backfill ordering

The swap matches the design verbatim: DELETE always raises, every column except `status` is frozen with `IS DISTINCT FROM`, and `status` may change only from `PUBLISHED` to `SUPERSEDED` (plus the no-op self-transition). The ordering in migration section `m` is the load-bearing part and is correct — the append-only trigger is disabled, the idempotent backfill flips every non-max `PUBLISHED` row to `SUPERSEDED`, the trigger is re-enabled and then dropped with its function, the column guard is created, the INSERT-only RLS policy is dropped for the default `tenant_isolation_modify` (FOR ALL) pair, and `GRANT UPDATE` is added. `result_snapshots` and `marks_record_history` are left strictly append-only. **confirmed** — the escape suite proves the full guard matrix: a non-`status` column mutation and a DELETE both reject, the legal `PUBLISHED → SUPERSEDED` flip succeeds, and the `SUPERSEDED → PUBLISHED` reversal rejects; `result_snapshots` UPDATE/DELETE still reject.

### Supersede flip in the existing publish route

The flip lives inside `POST /:id/publish`, after the new header and snapshots are written, within the same transaction under the `exampub:${institutionId}:${examId}` advisory lock the route already holds, and only when `nextVersion > 1`. It flips the immediately-prior version with `updateMany where { version: priorVersion, status: "PUBLISHED" }` and bails with a 409 unless `flipped.count === 1`; a `restrict_violation` from the guard is also mapped to 409. The `count === 1` assertion is sound precisely because the migration backfill established the single-`PUBLISHED`-max invariant, so the prior version is the sole `PUBLISHED` row. A `GradingError` earlier in the transaction aborts before any flip, so no window exists where two `PUBLISHED` versions coexist across a commit. The `exams.results.superseded` audit pins `resourceId` to the new header with `{ supersededVersion, byVersion }` metadata (NIT-2). **confirmed** — the behavioral suite asserts version 2 is created, version 1 becomes `SUPERSEDED`, and a `SUCCESS` supersede audit is written.

### Re-mark route and the PUBLISHED-exam constraint

Because `examinations_guard` makes `PUBLISHED` terminal and both 8.1 mark routes are status-gated to `MARKS_OPEN`/`MODERATION`, a re-eval on a published exam provably cannot reuse them. The dedicated `POST /reeval/:id/remark` (`exams.reeval.manage`) is the single place a mark may change post-publication: it requires the parent request to be `UNDER_REVIEW` (else 409), scopes the target `marks_records` row to the request's own `(examId, candidateId)` (else 404, so staff cannot re-mark an arbitrary record under cover of a request), range-checks against the assessment `maxMarks` (else 400 + DENIED audit), updates `marks` (permitted by `marks_records_guard`, which freezes only identity), writes a `CORRECTED` `marks_record_history` row with `actorMembershipId` spelled out (NIT-3), and never touches exam status. **confirmed** — the behavioral suite covers the out-of-scope-record and non-`UNDER_REVIEW` rejections.

### Transition legality: three aligned layers

`reevalTransitionLegal` is the single source of truth and is consulted before any write (finding 6), returning 409 on an illegal edge. The write then uses an optimistic `updateMany where { status: current.status }` and treats `count === 0` as a concurrent-change 409; `reeval_requests_guard` remains the DB backstop mapped through `isRestrictViolation`. The helper correctly rejects the no-op self-transition (the route never advances to the same state), every backward edge, and every edge out of terminal `CLOSED`/`REJECTED`. The `transitionReevalSchema` enforces the body rules (note required for `REJECTED`, `outcomePublicationId` only for `REMARKED`), and the route validates `outcomePublicationId` as same-tenant and belonging to the request's exam. **confirmed** — unit tests enumerate every legal and representative illegal edge; the behavioral suite exercises the `outcomePublicationId` scope check.

### RBAC and gating matrix

`exams.reeval.request_own` is bound to STUDENT only and `exams.reeval.manage` to ADMIN and HOD only, with FACULTY deliberately excluded; the migration seeds the two permissions and three role-permission pairs with the exact `ON CONFLICT` / `AS m(` marker shapes the catalogue-sync parser slices on, and `SEEDING_MIGRATION_DIRS` gains the new dir so set-equality reconciles (10 exam keys, 17 pairs). Every new route carries `requireModuleActive("examinations")` plus its `requirePermission`, and the republish path keeps the `permission → step-up → module` preHandler order unchanged, so re-publication still requires `exams.results.publish` + MFA step-up. **confirmed** — the behavioral suite asserts FACULTY and STUDENT both get 403 on the `exams.reeval.manage` list route.

### Supplementary linkage and eligibility

`assertSupplementaryLinkage` enforces the pairing rule (SUPPLEMENTARY requires a resolvable same-tenant parent; non-SUPPLEMENTARY must not carry a parent) with a clean message and a DENIED audit, backed by the composite same-tenant self-FK. The registration endpoint computes eligibility from the parent's latest `PUBLISHED` non-passing snapshots via the pure `computeSupplementaryEligible`, then either registers the full computed set (`studentIds` omitted) or exactly the named set after asserting every id is eligible — rejecting the whole request atomically with a 409 + DENIED audit if any is ineligible (finding 4), never partially registering. Candidate creation skips duplicates idempotently. The parent link is frozen after create by the re-authored `examinations_guard` (which adds `parentExaminationId` to the frozen set). **confirmed** — behavioral and escape suites cover the linkage rejections, the atomic ineligible-allowlist rejection, the same-tenant self-FK backstop, and the frozen-link UPDATE rejection.

### History read models

Student history (`/me/results/history`, `exams.results.view_own`) is own-only and `PUBLISHED`-only — it resolves each exam through `latestPublishedPublication` (status-filtered, version desc), reads only the caller's own snapshots, and orders `publishedAt desc, examId asc` with subjects `subjectId asc`. Staff history (`/students/:studentId/results/history`, `exams.results.view`) returns all versions including `SUPERSEDED`, tagged with `status`, ordered `examId asc, version desc`. The XLSX export reuses the `exams.ts` ExcelJS pattern (one Transcript sheet, `writeBuffer`, Content-Disposition) and writes `exams.results.exported`. All values come from the frozen snapshots — no recomputation. **confirmed** — the behavioral suite asserts the student sees only the latest version after a republish while staff history shows both `{v:1, SUPERSEDED}` and `{v:2, PUBLISHED}`, and that the XLSX streams a valid workbook and writes the export audit.

### Student read-path consistency gap

`/me/results/history`, `/me/reeval`, and the supplementary parent lookup all resolve through `latestPublishedPublication`, which filters `status = 'PUBLISHED'` before taking the max version — exactly the hardening NFR-4 / finding 3 prescribe so a stray `SUPERSEDED` row at max version can never leak to a student. The two pre-existing 8.1 routes `GET /me/results` and `GET /me/results/:examId` were not switched to this helper; they still call `latestPublication` (max version, no status filter). These lines are unchanged by the 8.2 diff, so this is a pre-existing shape — but 8.2 is the slice that makes `SUPERSEDED` a written state, which is what gives the gap teeth. In normal flow after a republish the max version is the new `PUBLISHED` row, so both routes return the correct latest published result; the exposure is only theoretical (a `SUPERSEDED` row sitting at max version), which the backfill and the `flipped.count === 1` invariant are designed to prevent. Worth a follow-up to bring all student read paths onto the same status-filtered helper for consistency with the slice's own stated access-control posture. **likely**

### Multi-tenancy and non-regression

`reeval_requests` carries `institutionId`, the `(id, institutionId)` composite unique, composite same-tenant FKs on every parent (including `sourcePublicationId → result_publications`), ENABLE+FORCE RLS with the nullif-guarded default pair, and a guarded `campass_app` GRANT that never confers BYPASSRLS. The escape harness seeds a `reeval_requests` row (and its parent `result_publications` header) with deterministic ids, tears them down inside the scoped trigger-disable dance, counts them in `countRemainingTestRows`, adds `reeval_requests` to `RLS_TABLES`, and removes the now-stale `result_publications` entry from `EXPECTED_POLICIES` so it falls through to the default pair. The 3p8/3p9 escape cases prove cross-tenant read/spoof/foreign-parent isolation on both the table and the self-FK plus the frozen-column guard. No fees import appears in `exams.ts` or `reeval.ts`, `modules.ts` is untouched, and only the new `20261213000000_phase8_exams_slice2` migration dir changed. **confirmed** — `git diff` name-only on the migrations tree and `modules.ts` is empty; the fees grep returns nothing.

### Recorded verification (from the commit message, not re-run)

The coder recorded: `prisma migrate deploy` applied with `migrate status` up to date and `migrate diff` showing only the long-standing composite-vs-single-FK cosmetic diff (NO DROP on any existing table); `npm test` 497 passed (up from 484); `npm run test:integration` in isolation — exams-behavioral 12/12, tenant-escape 84/84. Per instructions these suites were not re-run here.

</details>

<details>
<summary>File map</summary>

- `packages/db/prisma/migrations/20261213000000_phase8_exams_slice2/migration.sql` — new: `ReevalRequestStatus` enum, `reeval_requests` table + guard, `examinations.parentExaminationId` self-FK, re-authored `examinations_guard`, `result_publications` backfill + trigger/RLS swap, catalogue seed.
- `packages/db/prisma/schema.prisma` — `ReevalRequest` model, `parentExaminationId` self-relation, back-relations, `SUPERSEDED` comment update.
- `packages/shared/src/permissions.ts` — two new `exams.reeval.*` keys + STUDENT/ADMIN/HOD bindings.
- `packages/shared/src/audit-actions.ts` — four new `exams.*` audit keys.
- `packages/shared/src/validation.ts` — reeval/supplementary Zod schemas + `parentExaminationId` on create.
- `apps/api/src/services/exams/reeval.ts` — new: `reevalTransitionLegal`, `assertSupplementaryLinkage`, `computeSupplementaryEligible`.
- `apps/api/src/routes/exams.ts` — `latestPublishedPublication`, re-eval/supplementary/history routes, supersede flip, create-route linkage check.
- `apps/api/src/services/__tests__/catalogue-sync.test.ts` — new migration dir added.
- `apps/api/src/services/exams/__tests__/reeval.test.ts` — new: fast unit tests.
- `apps/api/src/routes/__tests__/exams-behavioral.integration.test.ts` — 8.2 behavioral cases.
- `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` + `tenant-escape.integration.test.ts` — reeval/parent-link/column-guard escape coverage.

Full diff: `git -C c:\campusgate diff bcd1cf5` (pre-8.2 base) — HEAD `7240594`.

</details>
