# Phase 1 (Shared Institutional Data) — final implementation review

Phase 1 adds academic sessions + terms, the program hierarchy, and a generalized academic calendar as foundational institution-layer data on top of the live Phase-0 tenancy/RBAC/module stack. The work landed in three commits on local `main` (one migration + schema/catalogue/seed, one API surface, one test suite) and is additive: the six FROZEN migrations are byte-for-byte untouched and exactly one new migration (`20261027111710_phase1_academics`) was added. I verified every mandated invariant against the actual code and against a full clean build + `vitest run` (31 files, 259 tests, all green, against live Supabase).

Watch for: nothing blocking. One cosmetic stale comment (`// academics.* (12)` labeling 11 keys) is the only finding — confirmed, NIT only.

**Verdict**: APPROVED

## High-level view

The migration is the load-bearing artifact and it is correct. Five enums and four tenant-owned tables (`academic_sessions`, `academic_terms`, `programs`, `academic_calendar_day_revisions`) each carry `institutionId`, the `(id, institutionId)` composite unique, an `institutionId` index, a tenant-root FK to `institutions(id)` ON DELETE RESTRICT, and ENABLE+FORCE RLS with `nullif`-guarded fail-closed policies. Cross-tenant links are composite FKs including `institutionId` (terms→sessions RESTRICT, programs→departments RESTRICT, calendar day→department RESTRICT, calendar day→session/term SET NULL), making a cross-tenant reference physically impossible. The `academic_calendar_days` unique swap (drop the single `(institutionId, date)` unique; add two partial uniques for institution-wide vs department-scoped) and the `academic_sessions_one_active_per_institution` partial unique are both present.

The revision table is genuinely append-only at the DB layer, not by convention: it gets the audit_events-shaped policy pair (`tenant_isolation_select` + `academic_calendar_day_revisions_tenant_insert`, no modify/FOR ALL policy), `campass_app` is granted only SELECT,INSERT with UPDATE,DELETE revoked, and a `BEFORE UPDATE OR DELETE` trigger raises `restrict_violation` on every role. It is registered in `EXPECTED_POLICIES` as the append-only pair, not the default modify pair.

The four `academics.*` permissions are seeded in the migration with the exact catalogue-sync markers and bound to the right template roles (ADMIN gets all four; STUDENT/GUARD/HOD get `academics.view`); the new migration dir is in `SEEDING_MIGRATION_DIRS`, so the catalogue-sync meta-test stays green. `modules.ts` is untouched — `academic_sessions` stays a dependency-graph placeholder (Decision A).

The allowance-engine calendar read gained exactly the `departmentId: null` clause and nothing else, keeping its institution-wide read behavior-preserving and deterministic once department-scoped rows exist. All academics routes are permission-gated only with no `requireModuleActive`; lifecycle transitions enforce exactly-one-ACTIVE and ≥1-term-before-activate, run status-only (preserve-history), and audit in-transaction. The Phase-2 SIS seams are left unbuilt: no StudentProfile FK to Program/AcademicSession, no promotion executed.

<details>
<summary>Issues (1)</summary>

1. **Stale audit-actions comment** — `packages/shared/src/audit-actions.ts:64` comment says `(12)` but 11 keys follow; 11 is correct per design §7. Change the comment to `(11)`. NIT, non-blocking.

</details>

<details>
<summary>Details</summary>

### Migration: frozen untouched, exactly one added

`git log` shows three commits (`33daf7c`, `d82b7d5`, `5bbfa66`) and `git diff HEAD~3 HEAD --stat -- packages/db/prisma/migrations` reports a single file changed: the new `20261027111710_phase1_academics/migration.sql` (+362 lines). The migrations directory holds exactly seven dirs, the six frozen ones plus the new one. FEAT-001 recorded that `migrate dev --create-only` was skipped because of a pre-existing `_prisma_migrations` checksum drift on the frozen superadmin_security row (confirmed clean in git, so it predates this work); the migration was hand-authored to the house style and applied with `migrate deploy`, which does not re-verify applied checksums. This is a documented, defensible deviation that did not touch any frozen file. (confirmed)

### Tenancy shape on every new table

Each of the four new tables carries `institutionId`, `@@unique([id, institutionId])`, `@@index([institutionId])`, and a tenant-root FK to `institutions(id)` ON DELETE RESTRICT. Natural-key uniques are present: `(institutionId, name)` on sessions, `(academicSessionId, ordinal)` on terms, `(institutionId, code)` on programs. Cross-tenant links are composite FKs including `institutionId` — `academic_terms_session_same_tenant_fkey`, `programs_department_same_tenant_fkey`, `acd_department_same_tenant_fkey` (RESTRICT), and `acd_session_same_tenant_fkey` / `acd_term_same_tenant_fkey` (SET NULL for the informational links). The escape integration suite proves this at runtime: cases 3i–3n cover cross-tenant read-denied for sessions/terms/programs, spoofed-insert denied, the composite-FK blocking a term that references another tenant's session, spoofed-update yielding zero cross-tenant rows, and the three-GUC-state fail-closed path. (confirmed)

### Revision table is append-only by construction

The migration gives `academic_calendar_day_revisions` the append-only policy pair (`tenant_isolation_select` FOR SELECT + `academic_calendar_day_revisions_tenant_insert` FOR INSERT WITH CHECK) and no FOR ALL policy, grants `campass_app` SELECT,INSERT and REVOKEs UPDATE,DELETE, and installs `academic_calendar_day_revisions_append_only()` + trigger `academic_calendar_day_revisions_no_update_delete` BEFORE UPDATE OR DELETE raising `restrict_violation`. This is the verbatim audit_events shape. `EXPECTED_POLICIES` registers the table with the append-only pair, and the escape policy meta-test asserts neither it nor audit_events carries a `tenant_isolation_modify` policy. The behavioral suite proves a `campass_app` UPDATE and DELETE are both rejected, a DELETE revision survives the deletion of the calendar row it describes (snapshot columns carry no live FK, by design §4.3), and a cross-tenant read under another tenant returns none of the rows. Revision rows are written inside the same `withTenant` transaction as the calendar mutation, before the mutation. (confirmed)

### Catalogue sync and role bindings

The migration seeds the four permissions with `INSERT INTO "permissions" ... ON CONFLICT ("key") DO NOTHING` and the role_permissions with the `... SELECT ... FROM (VALUES ...) AS m("roleKey","permKey") JOIN ...` marker the catalogue-sync parser keys on. `permissions.ts` binds ADMIN to all four and STUDENT/GUARD/HOD to `academics.view`; `audit-actions.ts` declares the 11 `academics.*` keys. `SEEDING_MIGRATION_DIRS` in catalogue-sync.test.ts includes `20261027111710_phase1_academics`, and the full catalogue-sync + audit-actions meta-tests pass. `modules.ts` is unchanged across the three commits, so `academic_sessions` remains the dependency-graph placeholder Decision A specifies. (confirmed)

### Allowance-engine read is behavior-preserving and deterministic

`getRemainingAllowance` adds only `departmentId: null` to the `academicCalendarDay.findMany` where-clause; nothing else in the engine changed and it is not refactored onto CalendarService. On existing data every row is `departmentId IS NULL`, so the result is unchanged; once department-scoped rows exist, restricting to the institution-wide set makes the date-keyed map deterministic, backed by the `_inst_date_institutionwide` partial unique. The regression test (mocked) confirms identical computation with the new nullable columns present and that the institution-wide row wins over a same-date department row. (confirmed)

### Lifecycle, configurable structure, preserve-history

`academic-session.ts` owns the state machine. `activateSession` requires UPCOMING status, ≥1 term, each term `startDate < endDate`, and enforces exactly-one-ACTIVE: with no handover and an existing ACTIVE session it returns `ACTIVE_EXISTS` (→ 409); with handover it flips the current ACTIVE to CLOSED first. Transitions are status-only — no dates/name/structure rewrites, no term deletion — so history is preserved by construction, with the partial unique index as the concurrency backstop. `structureType` is descriptive: `termCountWarning` warns on mismatch (SEMESTER/TRIMESTER/ANNUAL suggestions, CUSTOM never) but never blocks; the one hard rule is ≥1 term before activation. The behavioral suite proves SEMESTER+2 and ANNUAL+1 both activate with no warning, TRIMESTER+2 activates with the soft warning, ANNUAL+0 is rejected with `NO_TERMS`, the handover path closes the old session and leaves exactly one ACTIVE, and closing a session leaves its terms and linked calendar entry intact and readable. (confirmed)

### Routes: permission-gated only, audited in-tx

Every academics route on `admin.ts` and the two reads on `student.ts` use `requirePermission(...)` with no `requireModuleActive`, run through `withTenant`, and call `recordAuditEvent(input, tx)` inside the transaction. The three rewritten calendar handlers key on `(institutionId, date, departmentId ?? null)` via findFirst/create/update (the removed compound-unique input is gone), write the revision row before each mutation, and audit `academics.calendar.updated`. Session/term lifecycle writes `academics.session.*` / `academics.term.*`; the handover path emits both `academics.session.activated` and `academics.session.closed`. The student reads narrow department scope from `request.auth.departmentScope` (populated additively in `auth.ts`, null for SUPER_ADMIN), never from request input, and carry an in-file comment noting the deliberate absence of `requireModuleActive`. (confirmed)

### Phase-2 (SIS) seams left unbuilt

`StudentProfile` still has `program String`, `semester Int`, `section String?` and no FK to `Program` or `AcademicSession` — forward-compat is paid only on the parent side via the `(id, institutionId)` composite uniques. The session service touches no StudentProfile and creates no enrollment rows; the promotion seam is a documented comment only. The seed adds a session, two terms, two programs, and three calendar entries but no revision rows and no student links. (confirmed)

### Verification run

Clean sequence from repo root: `npm ci`; `(cd packages/shared && npx tsc)` exit 0; `npx prisma generate` ok; `(cd apps/api && npx tsc)` exit 0; `npm run build` 3/3 tasks successful. `cd apps/api && npx vitest run` → 31 test files, 259 tests, 0 failures, against live Supabase (the suite serializes file execution to stay under the session-pooler cap). (confirmed)

</details>

<details>
<summary>File map</summary>

- `packages/db/prisma/migrations/20261027111710_phase1_academics/migration.sql` — new: enums, four tables, calendar columns + partial-unique swap, one-active partial unique, composite FKs, RLS (standard + append-only), append-only trigger, campass_app GRANT pin, permission seed.
- `packages/db/prisma/schema.prisma` — four new models + five enums; `AcademicCalendarDay` gains three nullable columns and drops `@@unique([institutionId, date])`.
- `packages/shared/src/permissions.ts` / `audit-actions.ts` — four permissions + role bindings; 11 audit keys.
- `apps/api/src/middleware/auth.ts` — additive `departmentScope` on RequestAuth.
- `apps/api/src/services/allowance-engine.ts` — single `departmentId: null` clause.
- `apps/api/src/services/calendar-service.ts` — new read service + pure precedence resolver.
- `apps/api/src/services/academic-session.ts` — new state machine + pure predicates.
- `apps/api/src/routes/admin.ts` — session/term/program CRUD + lifecycle; rewritten calendar handlers.
- `apps/api/src/routes/student.ts` — two academics read endpoints.
- `packages/db/src/seed.ts` — demo session/terms/programs/calendar (no revisions, no student links).
- `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts`, `tenant-escape.integration.test.ts`, `academics-behavioral.integration.test.ts`, `academics-routes.integration.test.ts`, `services/__tests__/{academic-session,calendar-service,allowance-calendar-regression}.test.ts`, `catalogue-sync.test.ts`, `vitest.config.ts` — tests.

Full diff: `git diff HEAD~3 HEAD`.

</details>
