# Phase 3 — Class & Course Management · Context Note

Pre-work ground-truth for the design/plan steps. No application code has been written in
this step. Facts below are read from the source-of-truth docs under `docs/` and verified
against the live `packages/db/prisma/schema.prisma` and `apps/api` source.

Sources: `docs/roadmap.md` (Phase 3 + Phase completion gate), `docs/tenancy.md`
(§4 composite FKs, §5 RLS, §7 escape suite, §8 checklist), `docs/identity-rbac.md`,
`docs/superadmin-security.md`, `docs/architecture.md` (§5 modules, §7 per-module DoD),
`docs/database.md` (§2 connections, §4 migration rule, §6a frozen/ledger notes).

---

## 1. Git / working state

- Branch: **`main`** (confirmed via `git branch --show-current`).
- State: **clean** — `git status` reports "working tree clean", up to date with
  `origin/main`.
- Phase 3 runs **on `main`**. Do **NOT** create a worktree for this phase.
- Artifact dir for this phase: `c:\campusgate\.agents\tasks\phase3-classes\` (this file
  lives there).

---

## 2. FROZEN migration directories — NEVER edit

`packages/db/prisma/migrations/` currently holds **8** applied migrations. These are
frozen history: never edit their SQL, never rename, never re-checksum. New work is a
**new** migration directory appended after the last one.

1. `20260824143031_add_allowance_and_reliability_models`
2. `20261018100917_init`
3. `20261018110658_tenancy_isolation_rls`
4. `20261018171747_identity_rbac_b2`
5. `20261019053533_superadmin_security`
6. `20261019093119_module_system`
7. `20261027111710_phase1_academics`
8. `20261027161616_phase2_sis`

> Note (from `database.md` §6a): a couple of these carry recorded-checksum quirks that are
> deliberately left as-is — `20261019053533_superadmin_security` (checksum reflects the
> exact deployed SQL) and the B-1 CRLF "false alarm". `migrate status` is clean and
> `migrate deploy` tolerates them. If a local `migrate dev` ever trips on a checksum, use
> `prisma migrate resolve` — **never** a manual checksum overwrite, and never edit the
> frozen files.

---

## 3. Proven migration workflow (shared Supabase) — MIGRATION RULE

From `database.md` §4 and §6a. This is the only approved way to ship schema changes:

1. **Hand-author** the migration: create a new timestamped dir under
   `packages/db/prisma/migrations/` and write `migration.sql` by hand (include RLS
   enable+force, the two standard policies, composite FKs, and `(id, institutionId)`
   uniques in the **same** migration as the table — raw SQL; Prisma does not model these
   natively).
2. **Read-only verify** the SQL against the schema with `prisma migrate diff`
   (diagnostic only — it does not touch the DB).
3. **Apply** with `prisma migrate deploy` (Railway also deploys this way on start).
4. **Confirm** with `prisma migrate status` ("Database schema is up to date", no
   duplicates).

Hard rules:

- **NEVER** run `prisma migrate dev` against the shared Supabase DB — it caused ledger
  drift before. If generation help is wanted locally, use `migrate dev --create-only`
  against a throwaway/local DB only, then hand-reconcile; the production path is always
  `migrate deploy`.
- **NEVER** `prisma db push --accept-data-loss` (removed in Phase 0; unsafe for an ERP).
- **Do NOT touch the `_prisma_migrations` ledger** by hand. The one past reconciliation
  was a guarded, re-verified one-off; treat the ledger as read-only.
- A tenant-owned table's migration must, in that same migration, add `institutionId`,
  composite FKs to every linked tenant table, the `(id, institutionId)` unique on
  referenced parents, `ENABLE`+`FORCE` RLS, the SELECT + ALL policies on
  `app.current_institution_id`, and an index on `institutionId`
  (`tenancy.md` §8 checklist; CI meta-test enforces RLS presence).

Connections (`database.md` §2): runtime `DATABASE_URL` = transaction pooler (6543,
`?pgbouncer=true`, role `campass_app`, NON-`BYPASSRLS`); `DIRECT_URL` = session pooler
(5432) for migrations/DDL as privileged `postgres`.

---

## 4. What Phases 0 / 1 / 2 already provide (reuse — do not reinvent)

**Phase 0 — Foundation (all built):**
- Two-layer tenancy (A2): `institutionId` on every tenant-owned table, `(id,
  institutionId)` composite uniques, composite FKs, `ENABLE`+`FORCE` RLS with standard
  SELECT/ALL policies keyed on `app.current_institution_id`, tenant-scoped Prisma client
  (`withTenant` helper, `set_config(..., true)` inside `$transaction`).
- Identity/RBAC (B2): `User` + `InstitutionMembership` + `Role` + `Permission` +
  `MembershipRole`/`RolePermission`; JWT with `membershipId`/`roles`/`permissions`;
  central authz engine (`requirePermission`, `requireModuleActive`, `canOnResource`);
  legacy `requireRole` shim still in place.
- Super-Admin / security (C): zero standing tenant access, `SupportGrant` break-glass,
  MFA + step-up, **AuditLog v2** = generic `AuditEvent` with **string** `action`
  (`<module>.<action>`), tenant-scoped under RLS, `supportGrantId` for break-glass.
- Module system: `ModuleEntitlement` + `ModuleActivation` with the
  NOT_ENTITLED/ENTITLED/ACTIVE/SUSPENDED states and server-side dependency checks.

**Phase 1 — Shared institutional data (built):**
- `AcademicSession`, `AcademicTerm`, `Program` (institution → department → program), and
  the academic calendar: `AcademicCalendarDay` + `AcademicCalendarDayRevision`
  (append-only revisions) exposed via `CalendarService`
  (`apps/api/src/services/calendar-service.ts`). Modules decide what dates **mean**; the
  calendar does not invent rules.

**Phase 2 — SIS (built):**
- Generalized `StudentProfile` (status/program/term, `@@unique([id, institutionId])`),
  append-only `StudentProfileHistory`, and `StudentDocument` (reference metadata only).
- The authoritative single student identity. Phase 3 enrollment **references** the shared
  `StudentProfile` via composite FK — it must **not** create a second student copy.

---

## 5. FACULTY is a NEW concept in Phase 3

There is **no Faculty entity today**. Verified against `schema.prisma`:

- The only faculty-adjacent things that exist are the `UserRole` enum (values:
  `STUDENT`, `HOD`, `GUARD`, `ADMIN`, `SUPER_ADMIN` — note: **no `FACULTY` value**) and
  the `HodProfile` model.
- No `Faculty`, `FacultyAssignment`, `Course`, `Subject`, `ClassSection`,
  `ClassEnrollment`, `Timetable`, or `ScheduledClass` models exist yet.

So Phase 3 introduces the **faculty concept** (how a teaching identity is represented —
likely a tenant-owned profile referencing the shared `User`, parallel to `HodProfile`),
plus the Phase 3 domain tables listed in `roadmap.md`: `Course`, `Subject`,
`ClassSection`, `ClassEnrollment`, `FacultyAssignment`, `Timetable`, `ScheduledClass`.
All tenant-owned; composite FKs link to the shared student/faculty/session.

---

## 6. Phase 3 scope + Definition of Done (from roadmap.md)

- **Scope:** courses/programs, subjects/units, class/section creation, student class
  enrollment, faculty assignment, subject allocation, room allocation, timetable creation
  with **conflict detection** (faculty overlap, room double-booking, section conflicts,
  invalid periods, out-of-hours), class cancellation, substitute assignment, and
  **schedule history as revisions** (not silent overwrite).
- **Security/tenancy:** faculty-assignment changes do not erase historical teaching
  records; published timetable changes create revisions (append-only, mirroring the
  `AcademicCalendarDayRevision` / `StudentProfileHistory` / `audit_events` precedents).
- **Module DoD (`roadmap.md` DoD):** build a timetable; reject a double-booked
  room/faculty; a published change is recorded as a revision; students/faculty see their
  schedule.

**Phase completion gate (applies on top of the DoD — `roadmap.md` end-of-file):**
- Every module passes the per-module DoD checklist (`architecture.md` §7).
- The cross-tenant **escape suite is extended** to the new tables and passes — including
  the deliberately-buggy-query test (`tenancy.md` §7).
- New permissions registered in the catalogue + bound to template roles
  (`identity-rbac.md` §6); keys follow `<module>.<resource?>.<action>`.
- Important actions write **AuditLog v2** events (`superadmin-security.md` §6).
- Schema changes shipped as versioned migrations with RLS + FKs **in the same migration**
  (`database.md` §4).

---

## 7. Append-only revision-table precedents to follow

Phase 3 schedule/assignment history should mirror the existing append-only patterns
(`tenancy.md` §8 + Phase 1/2 models), never silent overwrite:

- `audit_events` — generic AuditLog v2 (string action, tenant-scoped).
- `academic_calendar_day_revisions` — calendar-day revision history.
- `student_profile_history` — student change history (CREATED/STATUS_CHANGED/…).

---

## 8. Test baseline & flake handling

- Baseline: **304 tests green** before Phase 3 work starts.
- Runner: vitest with **`fileParallelism: false`** (serial file execution — set in
  `apps/api/vitest.config.ts`). Run once in single-run mode, never watch.
- **Transient pooler flake:** if a run fails with `FATAL: tenant/user ... not found`,
  that is Supabase **free-tier auto-pause** (project paused after inactivity), **not** a
  credentials/network/code fault (`database.md` §6a). Resume the project / retry — do not
  "fix" code in response to it.
