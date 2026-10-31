# Phase 8 — Examinations & Results, Slice 8.1 (backend only) — FINALIZE

Branch: `main` (worked directly on `main`, no worktree). **Nothing was pushed, nothing deployed.**
Baseline: `e113810` (Phase 7 complete). Feature/test commits already on `main`:
`9d4df52` (feature) + `beb0b52` (tests). This finalize pass ran the full verification, confirmed
every acceptance item, updated `docs/roadmap.md`, and committed the finalize artifacts.

All commands were run once (single-run mode, no watch/dev-server). Logs captured under the
workspace root: `npm-ci.log`, `npm-build2.log`, `npm-test-fast.log`,
`apps/api/exams-behavioral-iso.log`, `apps/api/tenant-escape-iso.log`, `migrate-status.log`.

---

## AC-1 — Clean build (`npm ci` then monorepo build)

- `npm ci` (workspace root) → **exit 0**, `added 796 packages`, `node_modules/.package-lock.json`
  ci-marker present → the repo installs cleanly from the lockfile.
- `npx turbo build` → **`Tasks: 3 successful, 3 total`**, exit 0 (@campusgate/shared, @campusgate/api
  via `prisma generate && tsc`, @campusgate/web via `next build`). `npm ci` leaves the repo buildable.
- **Result: PASS.**

## AC-2 — Fast suite `npm test -w @campusgate/api` fully green

- `npm test -w @campusgate/api` → **`Test Files 48 passed (48)` / `Tests 484 passed (484)`**, exit 0.
- Was 454 before this slice; now 484 (grading unit tests + fast route-wiring + catalogue-sync
  set-equality all added and green). The **catalogue-sync set-equality test** passing is the
  self-enforcing proof that MUST-FIX 1's role bindings are exact.
- **Result: PASS (484/484).**

## AC-3 — New live-DB behavioral suites green IN ISOLATION

Run via `vitest run --config vitest.integration.config.ts <single file>` (serial config,
pooler-safe timeouts), each NEW suite run alone to avoid the free-tier pooler max-clients/P1001 flake:

- `src/routes/__tests__/exams-behavioral.integration.test.ts` → **`Test Files 1 passed (1)` /
  `Tests 7 passed (7)`**, exit 0. (AC-1..AC-7, AC-11 live-DB behaviors.)
- `src/routes/__tests__/tenant-escape.integration.test.ts` (extended for all ten exam tables) →
  **`Test Files 1 passed (1)` / `Tests 82 passed (82)`**, exit 0. The `countRemainingTestRows`
  teardown total==0 assertion is one of the 82 and passed.
- **Result: PASS (exams-behavioral 7/7, tenant-escape 82/82, each in isolation).**

## AC-4 — Migration discipline

- `prisma migrate status` → **`15 migrations found`**, **`Database schema is up to date!`**
- Frozen dirs: `git diff --stat e113810..HEAD -- packages/db/prisma/migrations` shows **one file
  changed, 716 insertions** (only the new `20261206000000_phase8_exams_slice1/migration.sql`).
  The 14 prior migration dirs are byte-untouched. `git status --porcelain` under migrations is empty.
- No DROP: grep for `DROP TABLE|DROP COLUMN|DROP CONSTRAINT|ALTER TABLE ... DROP` in the new
  migration → **no matches**. Strictly additive. The composite-vs-single-FK cosmetic diff is expected.
- **Result: PASS.**

## AC-5 — Behaviors provably tested (test files cited)

- **UNPUBLISHED results hidden from students** — `exams-behavioral.integration.test.ts` AC-1
  (student sees only latest PUBLISHED snapshot; unpublished → empty/404); enforced at query layer
  + the `exams.results.view_own`/`exams.results.view` permission split in `routes/exams.ts`.
- **Faculty marks-entry scope + deactivated-faculty rejection** —
  `exams-behavioral.integration.test.ts` AC-2 (out-of-scope write → 403 + `exams.marks.entered`
  `DENIED` audit, `marksRecord.count == 0`); the deactivated/no-profile path is pinned in the fast
  suite `exams-routes.integration.test.ts` ("403 + DENIED audit when the caller is not an ACTIVE
  faculty", `resolveMarkingFaculty -> null`).
- **Publication requires BOTH `exams.results.publish` AND MFA step-up** — `routes/exams.ts`
  `POST /:id/publish` runs `[requirePermission, requireStepUp, requireModuleActive]`; the step-up
  gate (401 without token) + AC-6/AC-7 are in `exams-behavioral.integration.test.ts` and the fast
  wiring suite.
- **Grading engine deterministic with documented BigInt rounding** —
  `services/exams/__tests__/grading.test.ts` (14 tests): band boundaries (90.00→9000, 89.99→A),
  integer half-up edges incl. the explicit `Math.round(1.005*100)===100` float counter-example vs
  integer `101`, and 89.995→9000; weight-sum=100 enforcement; zero/absent marks; 0%/100% extremes;
  passing band with gradePoints=0; band-gap `GradingError`; determinism.
- **Post-MARKS_LOCKED changes are audited append-only corrections** —
  `exams-behavioral.integration.test.ts` AC-2/AC-3 (first write MARKED, edit CORRECTED, two
  `marks_record_history` rows, previousMarks preserved, no silent overwrite).
- **Examinations status state machine is forward-only** — `examinations_guard()` column-guard
  trigger (illegal transition / DELETE → `restrict_violation`); illegal transition proven in
  `tenant-escape.integration.test.ts` and AC-5 behavioral.
- **New append-only/versioned/snapshot tables are trigger-protected** —
  `marks_record_history`, `result_publications`, `result_snapshots` raise on UPDATE/DELETE;
  proven by the self-contained append-only case in `tenant-escape.integration.test.ts`.
- **Result: PASS.**

## AC-6 — The three MUST-FIX items

1. **RBAC binding exact.** `packages/shared/src/permissions.ts` `ROLE_PERMISSIONS`: ADMIN =
   `{exams.manage, exams.grading.manage, exams.candidates.manage, exams.moderate,
   exams.results.publish, exams.results.view}` (NO `exams.marks.enter`, NO `exams.results.view_own`);
   HOD = the identical six; FACULTY = `exams.marks.enter` only; STUDENT = `exams.results.view_own`
   only → 6+6+1+1 = **14 role_permissions pairs**. The migration seed mirrors the same 8 permissions
   + 14 pairs. The **catalogue-sync set-equality test passes** (inside the green 484 fast suite) =
   self-enforcing proof the bindings are exact.
2. **No dead audit keys.** `packages/shared/src/audit-actions.ts` has no `exams.marks.locked` and no
   `exams.moderation.opened` (they appear only in a comment stating their absence). The two status
   transitions (and all others) are audited under the single `exams.examination.status_changed` key
   with `{from,to}` metadata.
3. **Tenant-escape harness fully extended.** `helpers/tenant-escape-setup.ts` extends `SeededTenant`
   with a typed id per new seeded exam table, `seedTenant`/`seedBothTenants` return them, seeds the
   seven mutable/column-guard tables in child-safe FK order, `countRemainingTestRows` covers those
   seven (teardown total==0 asserted and green), the three INSERT-only tables are excluded from the
   generic seed/count loop, and all ten exam tables are in `RLS_TABLES` with the three INSERT-only
   in `EXPECTED_POLICIES` (`*_tenant_insert`).
- **Result: PASS.**

## AC-7 — Roadmap updated

- `docs/roadmap.md` Phase 8 section now carries a **"Slice 8.1 — SHIPPED (backend only)."**
  paragraph (matching the Phase 7 convention) recording the ten tables, additive migration,
  route surface, grading engine, RBAC (14 pairs), single status audit key, unchanged module
  dependency graph, and the verification results.

## AC-8 — Commits on `main` (NOT pushed)

- Feature + tests were already committed: `9d4df52`, `beb0b52`.
- Finalize commit adds `docs/roadmap.md` + this `finalize.md` (see final message for sha).
- **Nothing was pushed; nothing was deployed.** The orchestrator pushes after independent verification.
