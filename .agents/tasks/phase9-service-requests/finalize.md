# Phase 9.6 — Service Requests Management — Finalize Report

Backend-only module. Branch `main`, cwd `c:\campusgate`, NO worktree. NOT pushed (orchestrator
pushes after independent verification). Implementation commit under finalization: `230d8b4`
(`feat: Phase 9.6 Service Requests Management (backend)`), 14 files, +4169.

Migration dir: **`20270124000000_phase9_service_requests`** (the 22nd dir; next timestamp after
`20270117000000_phase9_inventory`).

All verification below was run fresh after a clean `npm ci` on this commit. Logs are kept
alongside this report in `.agents/tasks/phase9-service-requests/`.

---

## Acceptance items — how each was verified

### 1. Clean build: `npm ci` then clean build — ✅ GREEN
- `npm ci` → exit 0 (log `npm-ci.log`). One documented Windows filesystem transient: the first
  attempt failed `ENOTEMPTY rmdir node_modules\any-promise` / `neo-async` because an earlier
  interrupted `npm ci` (PID 17460) was left holding locks on `node_modules`. Resolved by killing
  the orphaned process; the retried `npm ci` completed cleanly. (This is an environment transient,
  not a dependency/lockfile defect.)
- `npm run build` (root turbo: shared → db generate+tsc → api → web) → **3 successful, 3 total**,
  exit 0 (log `build.log`). No tsc errors.

### 2. Fast suite `npm test -w @campusgate/api` fully GREEN — ✅ GREEN, **651/651**
- Command: `npm test -w @campusgate/api` (`vitest run`) → exit 0 (log `fast-suite.log`).
- Result: **Test Files 57 passed (57); Tests 651 passed (651)**, 72.5s.
- Baseline before this module was 616; new count is **651** (+35 = service-requests unit suite +
  the catalogue-sync extension). Includes `catalogue-sync.test.ts` (permission-key + role-permission
  set-equality against the migration seed).

### 3. Every new/extended live suite GREEN IN ISOLATION — ✅ GREEN
Run each on its own via `vitest run --config vitest.integration.config.ts <filter>` (serial,
generous timeouts). Multi-query test `$transaction`s kept small per the live-DB anti-flake
discipline.
- **tenant-escape** (`tenant-escape` filter): **Test Files 1 passed (1); Tests 123 passed (123)**,
  368.8s, exit 0 (log `tenant-escape.log`).
- **service-requests.behavioral** (`service-requests.behavioral` filter): **Test Files 1 passed (1);
  Tests 23 passed (23)**, 123.6s, exit 0 (log `sr-behavioral.log`).
- **Transient note:** both new/extended live suites passed **in isolation on the FIRST attempt** —
  no free-tier pooler cold/congestion transient (`max clients reached` / P1001) on this run, so no
  rested-DB retry was needed.

### 4. `prisma migrate status` up to date — ✅ GREEN
- Command (from `packages/db`): `npx prisma migrate status` → exit 0 (log `migrate-status.log`).
- Output: `22 migrations found in prisma/migrations` / **`Database schema is up to date!`**.

### 5. Migration is additive — NO DROP — ✅ GREEN
- Command (from `packages/db`): `npx prisma migrate diff --from-schema-datasource
  prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma` → exit 0 (log `migrate-diff.log`).
- Scanned the full diff: the ONLY change lines are **183 `[-] Removed foreign key on columns`** and
  **13 `[-] Removed unique index on columns`** — the long-standing composite-vs-single-FK cosmetic
  diff (Prisma models single-column FKs; the live DB carries composite same-tenant FKs). There are
  **zero** `Removed the <table>`, zero column drops, zero enum drops, zero `DROP TABLE/COLUMN/TYPE`.
- No `service_request*` lines appear in the diff → the five new tables match the datamodel exactly
  (no drift). Conclusion: strictly additive, NO DROP.

### 6. 21 prior frozen migration dirs byte-untouched — ✅ GREEN
- `git show --stat 230d8b4` touches exactly ONE migrations path:
  `packages/db/prisma/migrations/20270124000000_phase9_service_requests/migration.sql` (added). No
  prior dir appears in the commit.
- `git status --short packages/db/prisma/migrations` → clean (no working-tree modifications to any
  migration dir).
- `packages/db/prisma/migrations/` holds 22 dirs: the 21 prior + the new one.

### 7. Module key `service_requests` in registry with deps=[] and activation gating — ✅ GREEN
- `packages/shared/src/modules.ts`: `MODULES` has `{ key: "service_requests", name: "Service
  Requests", ... (Phase 9.6) }`; `MODULE_DEPENDENCIES` has `service_requests: []`
  (foundational-not-gated, inventory/transport precedent).
- `apps/api/src/routes/service-requests.ts`: `const MODULE_KEY = "service_requests"`, `const gate =
  MODULE_KEY`. All **28** routes carry `requireModuleActive(gate)` in their preHandler array (28
  route declarations, 28 `requireModuleActive(gate)` preHandlers) → `requireModuleActive` gates
  every route. Verified by grep.

### 8. `service_requests.*` RBAC bound EXACTLY + catalogue-sync set-equality — ✅ GREEN
- `packages/shared/src/permissions.ts`: six `service_requests.*` permissions
  (`types.manage`, `assign.manage`, `requests.handle`, `requests.approve`, `view`, `request_own`).
  ADMIN binds the five staff keys (handling/config/view); the additive `SERVICE_AGENT` template role
  binds the same five; STUDENT binds ONLY `service_requests.request_own` (self raise/track-own). No
  other role gets `request_own` → requester-self key only; STUDENT/members never see others'.
- Set-equality enforced by `catalogue-sync.test.ts` (in the fast suite, GREEN): the migration seed's
  six permission keys + 11 role-permission pairs (ADMIN×5, SERVICE_AGENT×5, STUDENT×1) are set-equal
  to the shared `PERMISSIONS`/`ROLE_PERMISSIONS`. New dir added to `SEEDING_MIGRATION_DIRS`.

### 9. tenant-escape covers EVERY new table + RLS meta-test — ✅ GREEN
- Covered by the tenant-escape suite (123/123 in isolation, item 3). The setup helper seeds all five
  new tables (3 mutable child-safe order + 2 append-only ledgers) and the test adds per-table escape
  cases (cross-tenant read denied, spoofed insert denied, foreign-parent composite-FK violation,
  spoofed update → 0 rows, fail-closed unset/empty GUC) for the five tables, the append-only
  INSERT-ok / UPDATE+DELETE-denied cases for the two ledgers, and the five table names in the RLS
  meta-test table list (asserts RLS enabled+forced with both policies on every new table).

### 10. Request lifecycle is a FIXED enumerated state machine, column-guard trigger — ✅ GREEN
- Migration `service_request_status_guard()` (BEFORE UPDATE OR DELETE on `service_requests`):
  raises on DELETE; freezes nine identity columns (`institutionId, requestTypeId, requesterUserId,
  title, priority, fieldValues, description, raisedAt, createdAt`) via `IS DISTINCT FROM`; enumerates
  exactly the legal edges + the self no-op. **Terminal states (CLOSED, REJECTED, CANCELLED) never
  appear as a source `OLD.status`** → no outgoing edge. Read from the migration SQL.
- Behavioral test proves the DB backstop: `adminClient.serviceRequest.update({ status: "RESOLVED" })`
  from OPEN and a `delete()` both reject (→ 409) while the row stays OPEN (part of the 23/23).

### 11. Form-field values validated against the type's definitions at raise time — ✅ GREEN
- Pure `validateFieldValues(defs, values)` enforces required/non-empty, type coercion (TEXT/NUMBER/
  DATE), SELECT-range, and unknown-key rejection; raise returns 422 with a per-field error map and
  persists nothing on failure. Covered by the unit suite (fast) and the behavioral 422 matrix (part
  of 23/23).

### 12. SLA breach is DERIVED (not a drifting stored flag) — ✅ GREEN
- `dueAt = raisedAt + slaTargetHours` computed once at raise (`dueAt` NOT NULL); `isBreached(status,
  dueAt, now)` recomputes at read (`now > dueAt AND status ∉ terminal`); no stored breach flag
  anywhere. Behavioral test backdates `dueAt`, sees the row in `/reports/overdue`, drives it to
  RESOLVED, and confirms it drops out (part of 23/23).

### 13. Approval gate restricts APPROVE/REJECT to authorized approvers — ✅ GREEN
- APPROVE/REJECT sit behind `service_requests.requests.approve` and only fire from PENDING_APPROVAL
  (else 409 + DENIED). Behavioral test: approver succeeds; a non-approver token gets 403 (part of
  23/23).

### 14. Feedback is one-per-request and only by the owner after RESOLVED/CLOSED — ✅ GREEN
- Owner-only, RESOLVED/CLOSED-only, one row via a pre-check + the `(institutionId, serviceRequestId)`
  unique index (P2002 → clean 409). Behavioral test: 201 then 409 on second submit, plus
  non-terminal/foreign rejections (part of 23/23).

### 15. Activity/comment history is append-only (UPDATE/DELETE blocked at the DB) — ✅ GREEN
- `service_request_activities_append_only` + `service_request_feedback_append_only` triggers
  (BEFORE UPDATE OR DELETE, raise `restrict_violation`) + REVOKE UPDATE, DELETE from `campass_app`.
  Behavioral test asserts UPDATE and DELETE both reject on both ledgers even via `adminClient`
  (part of 23/23) and tenant-escape asserts the same.

### 16. A requester sees only their own requests + cross-tenant blocked — ✅ GREEN
- `/me/requests*` routes gated by `request_own` and every query scoped by `requesterUserId ==
  token.userId`; foreign ids → owner-scoped 404; staff `GET /` requires `view` (STUDENT → 403).
  Cross-tenant reads/writes blocked by RLS (tenant-escape). Behavioral + tenant-escape (part of the
  23/23 and 123/123).

### 17. NO generic workflow engine; NO cross-module coupling — ✅ GREEN
- Fixed enumerated states only: the guard hard-codes the edge set; no state/rule table, no DSL. The
  in-handler `STATUS_TRANSITIONS` map mirrors the same edges for the 409. Grep of
  `service-requests.ts` shows no imports from other route modules (inventory/transport/hostel/hr/
  fees/exams/library/admissions) — only comments naming the house precedent.

### 18. Existing Phase 1–9.5 tests still pass — ✅ GREEN
- The fast suite (651/651, 57 files) runs every prior module's unit/mocked suites with no regression.
- The extended `tenant-escape` live suite (123/123) exercises every prior tenant table's escape +
  RLS meta-test alongside the five new tables with no regression.

---

## Roadmap update
- File: `docs/roadmap.md` (the file the prior Phase-9 modules updated; same SHIPPED-block format).
- Added a **Service Requests — SHIPPED (backend only)** block (sixth Phase-9 module) following the
  inventory block's format, recording the migration dir, module key/deps, gating, the five tables,
  the fixed state machine, data-driven validation, derived SLA, approval gate, one-per-request
  feedback, append-only ledgers, requester-own scoping, RBAC, and the verification numbers
  (build 3/3, fast 651/651, behavioral 23/23, tenant-escape 123/123, first-attempt isolation).
- **Corrected the premature "Phase 9 complete" line** left by the inventory note: inventory was
  relabeled "the fifth Phase-9 module" (was "fifth and final"), and the inventory block's
  "Phase 9 ... is COMPLETE — all five modules shipped" closer was replaced with an explicit "Phase 9
  is NOT complete — it completes only after Document Management (the final module) ships" (6 of 7
  shipped).

---

## Summary
Every acceptance item is **GREEN**. One documented environment transient (Windows `npm ci`
ENOTEMPTY from an orphaned interrupted process, cleared by killing the orphan and re-running) — no
live-DB cold/congestion transient occurred (both live suites passed in isolation on the first
attempt). NOT pushed.
