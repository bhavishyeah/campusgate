# CAMPASS Phase 1 — Shared Institutional Data — Design Review

Reviewer: design-review subagent (fresh read, no authoring context).
Scope reviewed: `.agents/tasks/phase1-academics/design.md` (revision 2), cross-checked
against `docs/roadmap.md` (Phase 1 + phase-completion gate), `docs/architecture.md`
(§2/§5/§7), `docs/tenancy.md` (§4/§5/§8), `docs/identity-rbac.md` (§6),
`docs/superadmin-security.md` (§6), `docs/database.md` (§4 + FROZEN list), and the live
Phase-0 source tree.

Method: every "the existing X does Y" claim in the design was checked against the actual
source file, not taken on the design's word. The design is a second revision that claims
to resolve a prior review's 10 findings; I independently re-verified the load-bearing
claims behind those resolutions rather than trusting the §15 response table.

## Verdict

APPROVED. No HIGH or MEDIUM findings. Three NITs are recorded below for the implementer;
none block implementation and none change the mechanical verdict.

The design stands on its own: the seven decision points the task flagged are each resolved
concretely and with justification, and the concrete source claims the design rests on were
all confirmed against live code.

---

## Findings

1. NIT — Revision-table append-only trigger name does not match the precedent it claims to
   mirror "byte-for-byte." §4.3 / §8 step 7 / §10.1 call the trigger
   `academic_calendar_day_revisions_append_only`. The live `audit_events` precedent
   (`migrations/20261019053533_superadmin_security/migration.sql`) names the *function*
   `audit_events_append_only` and the *trigger* `audit_events_no_update_delete`. The design
   reuses the function-style name for the trigger. This is cosmetic (Postgres does not care),
   but the "identical in shape to `audit_events_append_only`" wording invites an implementer
   to grep for a precedent that is actually split into two differently-named objects.
   CONCRETE FIX: name the function `academic_calendar_day_revisions_append_only()` and the
   trigger `academic_calendar_day_revisions_no_update_delete`, mirroring the real precedent
   (function + distinctly-named trigger), and update §4.3/§8/§10.1 to the trigger name.

2. NIT — The non-admin calendar/session reads (§5.5) land on `student.ts`, where **every**
   existing route pairs `requirePermission(...)` with `requireModuleActive("campus_movement")`
   (verified in `apps/api/src/routes/student.ts`). Decision A (§1.1) is explicit that
   academics routes are permission-gated only and never wired to `requireModuleActive`, and
   §5.5 lists only `requirePermission("academics.view") + withTenant` — so the design is
   internally correct. The risk is purely implementation drift: a coder mirroring the
   surrounding file could reflexively add a `requireModuleActive(...)` hook, which would wrongly
   404/403 the academics reads for every tenant (and, if keyed to `academic_sessions`, would
   fail permanently because nothing activates that key — Decision A §1.3).
   CONCRETE FIX: add one sentence to §5.5 making the omission explicit, e.g. "These routes
   carry NO `requireModuleActive` hook — unlike every peer route on `student.ts` — because
   academics is foundational, not a gated module (Decision A)." A code comment at the route
   is the belt-and-suspenders.

3. NIT — The soft-validation `warnings` array (§3.3, §5.1, §10.2) is a new response-body
   convention not present in any live handler (the existing `admin.ts` handlers return the
   resource or a `{ error }` object). The design specifies *when* a warning is emitted but not
   the *shape* of the success-plus-warnings envelope (e.g. `{ session, warnings: string[] }`
   vs `{ data, warnings }`), nor whether machine-readable warning codes accompany the human
   strings. Not blocking — any reasonable shape works — but leaving it unspecified invites
   two callers (admin UI vs tests) to assume different shapes.
   CONCRETE FIX: pin the envelope in §5.1, e.g. "create/activate responses return
   `{ <resource>, warnings: Array<{ code: string; message: string }> }`; `warnings` is `[]`
   when none apply," and have §10.2 assert on `warnings[].code`.

---

## Decision-point assessment (the task's (a)–(g))

- (a) **Configurable `structureType`** — PASS. §3.1/§3.3 make `structureType` descriptive
  metadata; term count is soft-validated (warn, never block), with a single hard rule (≥1 term
  before activation, §3.3). A `SEMESTER` session with 2 terms and an `ANNUAL` session with 1
  term both validate and activate (explicitly exercised in §10.2); a `TRIMESTER` with 2 terms
  activates with a warning; `ANNUAL` with 0 terms is the only rejection. Nothing is hardcoded
  to one pattern.

- (b) **Tenancy checklist on every new tenant-owned table** — PASS. All four new tables carry
  `institutionId`, `(id, institutionId)` composite uniques, tenant-root FKs
  (`institutionId → institutions(id)`, `ON DELETE RESTRICT`), `institutionId` indexes, and
  `ENABLE + FORCE` RLS with `nullif`-guarded fail-closed policies (§3.2, §4.1, §4.3, §8). The
  cross-tenant links use composite FKs including `institutionId`
  (`academic_terms → academic_sessions`, `programs → departments`, and the three new
  `academic_calendar_days` links), matching the tenancy.md §4 copy-ready pattern. The revision
  table deliberately omits FKs on its *snapshot* columns (`calendarDayId`, session/term,
  department) because it is an immutable history record that must outlive its referents — this
  correctly mirrors how `audit_events` uses single-column/looser links (verified), and the
  tenant-root FK + RLS still scope it. The revision table gets the append-only RLS pair, not
  the default modify pair — the right choice, and registered as such in `EXPECTED_POLICIES`.

- (c) **Preserve-history by construction** — PASS. §6 enforces it structurally: lifecycle is
  status-only (no destructive rewrite), `ON DELETE RESTRICT` on all session/term FKs makes a
  historical link physically immutable, and calendar edits write an append-only revision in the
  same transaction. The revision immutability is genuine DB-layer append-only (INSERT-only RLS,
  `REVOKE UPDATE/DELETE` from `campass_app`, and a `BEFORE UPDATE OR DELETE` trigger binding
  every role) — I verified this machinery exists verbatim for `audit_events`. The earlier
  review's HIGH finding that the revision table had been given the FOR-ALL modify pair is
  genuinely resolved.

- (d) **Institution-layer-foundational vs gated-module** — PASS. §1 justifies the
  not-a-gated-module decision directly from `architecture.md` §2 (Layer B explicitly lists
  "academic sessions, academic calendar" as institution foundation) and §5.1 (a module is an
  entitled/activated booster; academic time is a prerequisite for SIS/attendance/exams, not a
  sellable add-on). The `academic_sessions` key in `MODULE_DEPENDENCIES` (verified present in
  `packages/shared/src/modules.ts`, with `attendance`/`examinations` depending on it) is left
  untouched and reconciled as an always-satisfiable dependency placeholder — the right call; a
  FROZEN, tested contract is not weakened for no Phase-1 benefit.

- (e) **Calendar generalization keeps the allowance engine working** — PASS. The live engine
  query (verified in `allowance-engine.ts`:
  `academicCalendarDay.findMany({ where: { institutionId, date: { gte, lte } } })`, no
  `orderBy`) keeps working because the new columns are nullable (§4.2). The design correctly
  identifies that once department-scoped rows exist, the no-`orderBy` `findMany` folded into a
  date-keyed `Map` would be order-undefined, and promotes the `departmentId: null` clause from
  optional to required (§4.4, A2). This makes the result a real invariant backed by the
  `..._inst_date_institutionwide` partial unique index. The engine is *not* refactored onto
  `CalendarService` (a live hot path left alone), and the change is behavior-preserving on all
  existing data (every current row is `departmentId IS NULL`).

- (f) **Migration honors create-only + deploy, FROZEN untouched** — PASS. §8 uses
  `prisma migrate dev --create-only` locally then `migrate deploy`, never `migrate dev` against
  the shared Supabase DB (matches `database.md` §4 and the 6a operational note). I confirmed
  exactly six migrations on disk (`init`, `add_allowance_and_reliability_models`,
  `tenancy_isolation_rls`, `identity_rbac_b2`, `superadmin_security`, `module_system`) —
  consistent with the deploy log's "6 migrations found." The one live index the design drops
  (`academic_calendar_days_institutionId_date_key`) is the auto-named Prisma unique from the
  `init` migration (verified by name in `init/migration.sql`), replaced with two partial unique
  indexes — a constraint swap the new migration owns, not an edit to a frozen file. The
  Prisma-mapping caveat is correct: the live `admin.ts` upsert/delete use the generated
  `institutionId_date` compound input (verified), so removing the `@@unique` requires rewriting
  those three handlers to `findFirst`/`create`/`update` keyed on
  `(institutionId, date, departmentId)` — the design calls this out and tests it (§10.5).

- (g) **Permission + audit keys concrete and catalogue-sync-safe** — PASS. The four
  `academics.*` permission keys (§7.1) and the audit action keys (§7.4) follow the verified
  catalogue conventions. `requirePermission` is typed `PermissionKey` (verified), so the keys
  must be added to `PERMISSIONS` — the design does. Audit keys are validated only in
  `recordAuditEvent` against `AUDIT_ACTION_KEY_SET` (verified) and need no migration/enum
  mirror — the design states this correctly. §7.5 matches the real `catalogue-sync.test.ts`:
  it parses the `INSERT INTO "permissions" ... ON CONFLICT` and
  `INSERT INTO "role_permissions" ... AS m(` blocks and unions over `SEEDING_MIGRATION_DIRS`
  (verified), so the plan to seed the four permissions with the exact markers and add the new
  migration dir to that array keeps the meta-test green. Retaining the now-route-unused
  `admin.academic_calendar.manage` (A3) keeps the catalogue in sync without a shim change.

---

## Verified assumptions

Each was checked against the cited live file, not the design's description.

- `RequestAuth` and the `authenticate` middleware do NOT carry/select `departmentScope`
  today — VERIFIED in `apps/api/src/middleware/auth.ts` (the interface omits it; the
  tenant-actor membership `select` omits it). The design's finding-1 resolution (add it
  additively, re-read per request, `null` for SUPER_ADMIN) is accurate and minimal.
- `departmentScope` is a `Department.id` (not a code/name) — VERIFIED in
  `identity_rbac_b2/migration.sql`: a composite FK
  `institution_memberships(departmentScope, institutionId) → departments(id, institutionId)`
  exists. This validates the design's §5.5 use of `departmentScope` directly as `departmentId`
  in `CalendarService.getEntries` — the one place this could have been a silent-mismatch bug,
  and it is sound.
- The allowance-engine's calendar `findMany` has no `orderBy` and no `departmentId` filter —
  VERIFIED in `allowance-engine.ts`. The required `departmentId: null` hardening is correct.
- `academic_sessions` is a declared module key with `attendance`/`examinations` depending on
  it — VERIFIED in `packages/shared/src/modules.ts` (`MODULES` + `MODULE_DEPENDENCIES`).
- `audit_events` append-only machinery (INSERT-only RLS pair, `REVOKE UPDATE, DELETE`,
  `BEFORE UPDATE OR DELETE` trigger raising `restrict_violation` on every role) —
  VERIFIED verbatim in `superadmin_security/migration.sql`. The revision table mirrors it.
- `EXPECTED_POLICIES` lists `audit_events: ["tenant_isolation_select", "audit_events_tenant_insert"]`
  and the escape suite deliberately seeds no `audit_events` rows — VERIFIED in
  `helpers/tenant-escape-setup.ts`. The design's §10.1 treatment of the revision table matches
  this precedent exactly.
- `Department` carries `@@unique([id, institutionId])` — VERIFIED in `schema.prisma`
  (so `programs → departments` and the calendar department link are referenceable with
  `institutionId`, no FROZEN-table change needed).
- `AcademicCalendarDay` live shape + `@@unique([institutionId, date])` + the
  `academic_calendar_days_institutionId_date_key` index name — VERIFIED in `schema.prisma`
  and `init/migration.sql`.
- Live calendar handlers upsert/delete via the `institutionId_date` compound unique and are
  gated by `admin.academic_calendar.manage` — VERIFIED in `apps/api/src/routes/admin.ts`.
- `StudentProfile` has `program String`, `semester Int`, `section String?`, `departmentId` —
  VERIFIED in `schema.prisma` (supports the §2/§3.4 "no StudentProfile refactor" decision).
- `admin.academic_calendar.manage` exists in the catalogue and is bound to `ADMIN` —
  VERIFIED in `packages/shared/src/permissions.ts`.
- `requirePermission(permission: PermissionKey)` takes a single key; no `requireAnyPermission`
  exists — VERIFIED in `apps/api/src/services/authz-engine.ts` (confirms §7.3's rejection of a
  multi-permission guard as scope creep).
- `recordAuditEvent` throws on any action key not in `AUDIT_ACTION_KEY_SET` — VERIFIED in
  `apps/api/src/services/audit.ts`; the catalogue-sync and audit-actions meta-tests exist and
  behave as the design describes.
- Seed demo departments: `bca` variable = the code `512` "Bachelor of Computer Applications
  (BCA)" department; code `501` "B.Tech (Computer Science & Engineering)" exists and is
  upserted by `institutionId_code` — VERIFIED in `packages/db/src/seed.ts`. (The `courses`
  array lists `501`/`512` multiple times, but the `institutionId_code` upsert collapses them to
  one row each, so the design's §9 lookups resolve unambiguously.)
- Six FROZEN migrations on disk — VERIFIED by directory listing.

## Unverified / wrong assumptions

None material. Every concrete source claim the design makes was confirmed against live code
(see above). Two items are deferred-by-design rather than wrong, and are correctly flagged as
such in the design:

- The `departmentScope` column is defined and FK-constrained but is **never populated** by any
  current code path (no finding: the design itself notes it is "never surfaced" today, and the
  §10.6 test seeds it directly; populating it at login/membership creation is out of Phase 1's
  scope and does not block the read endpoints, which treat a null scope as institution-wide).
- No production data exercises department-scoped calendar rows yet (expected — the column is
  new; the partial-unique and precedence behavior are covered by §10.4 against seeded data).
