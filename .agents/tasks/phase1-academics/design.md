# CAMPASS Phase 1 — Shared Institutional Data — Design

> The first real ERP data phase on top of the LIVE Phase 0 foundation (tenancy RLS,
> identity/RBAC, Super Admin security, module entitlement/activation). It introduces a
> single, configurable representation of academic time and structure that every later
> module (SIS, classes, attendance, exams) reuses: **academic sessions + terms**, the
> **program hierarchy** (institution → department → program), and a **generalized
> academic calendar** exposed as a read service. Additive only; the six FROZEN migrations
> are untouched — a NEW migration (`phase1_academics`) is added. On `main`, no worktree.
> The app must keep working at every step — in particular the allowance-engine's existing
> `AcademicCalendarDay` reads must not break.

Source of truth followed: `docs/roadmap.md` (Phase 1 + the phase-completion gate),
`docs/architecture.md` (§2 layers, §5 module model, §7 per-module DoD), `docs/tenancy.md`
(§4 composite FKs, §5 RLS, §8 checklist), `docs/identity-rbac.md` (§6 catalogue), 
`docs/superadmin-security.md` (§6 AuditLog v2), `docs/database.md` (§4 migration rule +
FROZEN list). Patterns mirrored from the live `module_system` design/migration, the
`superadmin_security` migration DDL, and the existing `admin.ts` calendar routes.

---

## 0. Overview

Phase 1 adds **four new tenant-owned tables across three entity groups**
(session/term, program, calendar-revision) plus one read service — and extends the
existing `academic_calendar_days` table additively (new columns, no new table):

1. **`AcademicSession`** (a year/cycle, e.g. "2026-2027") and **`AcademicTerm`** (its
   subdivisions, e.g. "Semester 1"). A session carries a `structureType`
   (`SEMESTER | TRIMESTER | ANNUAL | CUSTOM`) so different institutions subdivide
   differently without the schema hardcoding one pattern. A session moves through
   `UPCOMING → ACTIVE → CLOSED`; a closed session stays fully readable. At most one
   `ACTIVE` (current) session per institution, enforced by a partial unique index.
2. **`Program`** (institution → department → program) building on the existing
   `Department`. Programs are referenced by SIS later; this phase models the entity and
   does **not** migrate `StudentProfile.program` onto it.
3. **Calendar generalization.** The existing `AcademicCalendarDay` is extended
   additively with an optional **department scope** (`departmentId`), an optional
   **session/term link**, and a **revision-history** table (`AcademicCalendarDayRevision`)
   that records previous values on every change instead of silently overwriting. A new
   **`CalendarService`** (`apps/api/src/services/calendar-service.ts`) is the single read
   API other modules call. The service **describes dates; it does not invent rules** — the
   allowance-engine keeps deciding what a `dayType` *means*.
4. **Endpoints** on `admin.ts` (tenant, via `withTenant`, new permissions, audit) for CRUD
   of sessions, terms, programs, and calendar entries, plus session/term **lifecycle
   transitions** (create → define terms → activate → close). Promotion that touches student
   records is **modelled, not executed** — it belongs to SIS (Phase 2). Read endpoints let
   other roles view the current session/calendar within their tenant + permission scope.
5. **Seed** extension: the DEMO institution gets a `2026-2027` `SEMESTER` session with two
   terms, two programs under existing departments, and a few calendar entries (some
   department-scoped) to exercise the new shape.

**The headline design decisions**, resolved with justification below:

- **A. Institution-layer foundational data, NOT a gated module** (§1). Academic sessions,
  terms, programs, and the calendar are available to **every** tenant unconditionally and
  are **not** wired to `requireModuleActive`. This resolves the apparent tension with the
  `MODULE_DEPENDENCIES` graph, which lists `academic_sessions` as a module key (§1.3).
- **B. Configurable structure via `structureType` + ordinal terms** (§3), never a
  per-pattern schema.
- **C. Preserve-history by construction** (§6): sessions/terms are immutable historical
  rows advanced only by **status transitions**; promotion never rewrites a historical row;
  calendar edits write a revision row before mutating.
- **D. Calendar generalized additively** (§4): the live `(institutionId, date)` unique and
  the allowance-engine's exact query are preserved; department scope is layered on with a
  **new** uniqueness rule that keeps the institution-wide row shape intact.

**Locked technology stack** (unchanged from the rest of the platform; locked once this
design is approved): TypeScript on Node; Fastify for the API; Prisma `6.19.3` against
Supabase Postgres (runtime via the `campass_app` NOSUPERUSER NOBYPASSRLS pooled client,
migrations/DDL + platform reads via the privileged `postgres` client); `@campusgate/shared`
for the permission/audit/module catalogues; Vitest for tests; versioned Prisma migrations
with hand-authored raw SQL for enums, RLS, composite FKs, partial unique indexes, and
GRANT pins. **Prisma is NOT upgraded** to the 8.x RC the deploy log advertises. No new
runtime dependency is introduced.

---

## 1. Decision A — institution-layer foundational data, NOT a gated module

### 1.1 The decision

Academic sessions, terms, programs, and the academic calendar are **foundational
institution-layer data (Layer B)**, available to **all** tenants unconditionally. Their
routes are gated by `requirePermission(...)` only and are **never** wired to
`requireModuleActive(...)`. No `InstitutionModule` row, entitlement, or activation gate is
introduced for them; no `phase1_academics`-specific module key is added to `MODULES`.

### 1.2 Why (architecture.md §5 + the layer model)

- `architecture.md` §2 **Layer B — Institution** explicitly enumerates "Departments,
  programs, academic sessions, academic calendar" as institution-admin **foundation**,
  listed *beside* "Module activation and configuration", i.e. as the substrate modules
  configure against — not as a Layer-C operational module.
- `architecture.md` §5.1 defines a module as something the platform **entitles** and the
  institution **activates** against a subscription/plan. Academic time/structure is not a
  sellable booster an institution could sensibly run *without* — SIS, classes, attendance,
  and exams (§5.4 dependency graph) all require it. Gating it would mean an institution
  could "turn off" the academic calendar out from under the allowance-engine that is
  already live and reading it — a regression, not a feature.
- The per-module Definition of Done (§7) still applies to this phase via the **phase
  completion gate** (roadmap.md): tenant isolation, authz, audit, preserve-history, and the
  escape-suite extension are all delivered below. "Not a gated module" removes only the
  entitlement/activation lifecycle, not the DoD obligations.

### 1.3 Resolving the `academic_sessions` module-key tension (explicit)

`packages/shared/src/modules.ts` **already** declares an `academic_sessions` module key and
makes `attendance` + `examinations` depend on it (`MODULE_DEPENDENCIES`). This is **not**
contradicted by Decision A and is deliberately **left exactly as-is**:

- The `academic_sessions` key is a **dependency-graph placeholder** so the future
  Attendance/Exams activation checks have a stable key to require. Decision A means that
  key maps to **foundational data that is always present**, i.e. a dependency that is
  effectively always satisfiable — not that Phase 1 creates an `InstitutionModule` row for
  it.
- **Phase 1 does NOT seed an `academic_sessions` entitlement/activation row, does NOT add
  a `requireModuleActive("academic_sessions")` guard, and does NOT change `MODULES` or
  `MODULE_DEPENDENCIES`.** The graph stays the single source of truth for later phases; a
  future phase that decides Attendance should *require academic_sessions to be ACTIVE* will
  make that decision in its own design. Phase 1's contract is only: the academic data and
  its routes exist for every tenant, permission-gated, never module-gated.
- **Assumption A1 (flagged for review).** Leaving `academic_sessions` in the dependency
  graph while treating the underlying data as always-present foundational is the chosen
  reconciliation. The alternative — removing `academic_sessions` from `MODULE_DEPENDENCIES`
  — is rejected because it would weaken a FROZEN, tested contract that Attendance/Exams
  designs already assume, for no Phase-1 benefit. If the reviewer prefers the graph not
  reference a non-module key, that is a module-system change to schedule separately, not a
  Phase-1 edit.

---

## 2. Scope boundaries (what this phase does and does not build)

**In scope:** the four new tenant-owned tables (§3–§4), the calendar read service (§4.4),
the admin CRUD + lifecycle endpoints and the read endpoints (§5), a **minimal additive
Phase-0 auth surface extension** to carry `departmentScope` on `request.auth` (needed by the
non-admin department-scoped calendar read — §5.5), the one-line `departmentId: null`
hardening of the allowance-engine's calendar query (§4.4), the permission + audit keys (§7),
the `phase1_academics` migration with RLS/FK/partial-unique DDL (§8), the seed additions
(§9), and the test plan (§10). The two touches to live Phase-0 code (auth surface, engine
query clause) are both strictly additive and behavior-preserving on existing data; both are
regression-tested (§10.5, §10.6).

**Explicitly out of scope (modelled, not executed):**

- **Promotion / session transition that touches student records.** Phase 1 designs the
  session/term lifecycle and the **promotion seam** (§6.3) so SIS inherits preserve-history
  by construction, but executes **no** student promotion — Phase 2 (SIS) owns that.
- **`StudentProfile` refactor.** `StudentProfile.program` (free text), `semester` (int),
  and `section` stay as-is. This phase adds **no** FK from `StudentProfile` to `Program` or
  `AcademicSession`. (See §3.4 for why even a nullable forward-compat FK is deferred.)
- **Phase 2+ entities** (Student, ClassSection, enrollment, attendance, exams).
- **A gated-module lifecycle** for academics (Decision A).

---

## 3. Decision — sessions + terms (configurable structure)

### 3.1 Enums (new)

Added to `schema.prisma` and created as pg enums in the migration (mirroring how
`ModuleState` was added):

```prisma
enum AcademicSessionStatus {
  UPCOMING   // created, not yet the current session; terms may still be defined/edited
  ACTIVE     // the single current session for the institution
  CLOSED     // historical; fully readable, never mutated except re-open guard (none in P1)
}

enum AcademicStructureType {
  SEMESTER   // typically 2 terms
  TRIMESTER  // typically 3 terms
  ANNUAL     // typically 1 term
  CUSTOM     // any N terms, institution-defined
}

enum AcademicTermStatus {
  UPCOMING
  ACTIVE
  CLOSED
}
```

`structureType` is **descriptive metadata**, not a constraint on term count: the schema
does **not** enforce "SEMESTER ⇒ exactly 2 terms". Term count is validated **softly** at
the service layer (§3.3) so an institution with an unusual structure is never blocked by a
hardcoded assumption — this is the mechanism that keeps structure configurable (Decision B).

### 3.2 Models (new, tenant-owned)

```prisma
model AcademicSession {
  id            String                @id @default(cuid())
  institutionId String
  institution   Institution           @relation(fields: [institutionId], references: [id])
  name          String                // e.g. "2026-2027" (unique per institution, see @@unique below; not globally unique)
  structureType AcademicStructureType
  status        AcademicSessionStatus @default(UPCOMING)
  startDate     DateTime
  endDate       DateTime
  createdAt     DateTime              @default(now())
  updatedAt     DateTime              @updatedAt

  terms               AcademicTerm[]
  calendarDays        AcademicCalendarDay[]      // optional link from a calendar entry
  calendarDayRevisions AcademicCalendarDayRevision[]

  @@unique([institutionId, name])  // one "2026-2027" label per institution
  @@unique([id, institutionId])    // referenceable with institutionId (tenancy §4)
  @@index([institutionId])
  @@index([institutionId, status])
  @@map("academic_sessions")
}

model AcademicTerm {
  id                String             @id @default(cuid())
  institutionId     String
  institution       Institution        @relation(fields: [institutionId], references: [id])
  academicSessionId String
  academicSession   AcademicSession    @relation(fields: [academicSessionId], references: [id])
  name              String             // e.g. "Semester 1"
  ordinal           Int                // 1-based sequence within the session
  status            AcademicTermStatus @default(UPCOMING)
  startDate         DateTime
  endDate           DateTime
  createdAt         DateTime           @default(now())
  updatedAt         DateTime           @updatedAt

  calendarDays         AcademicCalendarDay[]
  calendarDayRevisions AcademicCalendarDayRevision[]

  @@unique([academicSessionId, ordinal])  // no duplicate ordinal within a session
  @@unique([id, institutionId])            // referenceable with institutionId
  @@index([institutionId])
  @@index([academicSessionId])
  @@map("academic_terms")
}
```

Composite FK (raw SQL in the migration — Prisma models the single-column FK; the migration
**replaces** it with the composite including `institutionId`, exactly as `tenancy.md` §4
prescribes and as the gate_passes example shows):

```sql
ALTER TABLE "academic_terms" DROP CONSTRAINT "academic_terms_academicSessionId_fkey";
ALTER TABLE "academic_terms"
  ADD CONSTRAINT "academic_terms_session_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "academicSessionId")
  REFERENCES "academic_sessions" ("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
```

This makes it **physically impossible** for a term to reference a session in another tenant.
The session's tenant-root FK (`institutionId → institutions(id)`, single-leg, `ON DELETE
RESTRICT`) matches the `institution_modules` shape.

### 3.3 Invariant — exactly one ACTIVE session per institution (ownership + enforcement)

**Decision + enforcement:** at most one `ACTIVE` session per institution. Enforced in **two
layers** (tenancy.md §6.3 philosophy — DB owns the structural invariant, service owns the
transition logic):

- **Database (owner of the invariant):** a **partial unique index**, hand-authored in the
  migration because Prisma does not model partial indexes:
  ```sql
  CREATE UNIQUE INDEX "academic_sessions_one_active_per_institution"
    ON "academic_sessions" ("institutionId")
    WHERE "status" = 'ACTIVE';
  ```
  This guarantees the invariant under concurrent writes — two simultaneous activations
  cannot both win; the second gets a unique-violation.
- **Service (owner of the transition):** `activateSession()` (§5.2) runs inside the
  `withTenant` transaction and, before flipping the target to `ACTIVE`, transitions the
  current `ACTIVE` session (if any) to `CLOSED` — *only when the admin explicitly requests
  the handover* — or rejects with `409` if an `ACTIVE` session exists and no handover was
  requested. The partial index is the backstop; the service gives the clear error.

**Term count validation (soft, configurable).** `structureType` implies a *suggested* term
count (`SEMESTER`→2, `TRIMESTER`→3, `ANNUAL`→1, `CUSTOM`→any ≥1). The service **warns** (a
non-fatal `warnings` array in the response) when the defined term count differs from the
suggestion, but **never blocks** — so a `SEMESTER` session with 3 terms is allowed. This is
how structure stays configurable rather than hardcoded. `ANNUAL` with zero terms is the one
**hard** rule: a session must have ≥1 term before it can be activated (validated in
`activateSession()`), because downstream modules assume at least one term exists.

### 3.4 Why no `StudentProfile` FK yet (forward-compat deferred)

The task permits an *additive, nullable, non-breaking* FK for forward-compat but does not
require it. **Decision: add none in Phase 1.** Reasoning: a nullable
`StudentProfile.academicSessionId` / `programId` would be dead (always null — nothing
populates it until SIS) and would pre-commit SIS to a particular link shape before SIS is
designed. Adding it later is **data + a nullable column**, not a breaking migration
(exactly the identity-rbac.md "additive on the model, not a migration" principle). The
`Program` and `AcademicSession` models **do** carry the `(id, institutionId)` composite
unique so SIS can add composite FKs to them cleanly when it is built — the forward-compat
cost is paid on the *parent* side (cheap, done now), not the *child* side (deferred to the
owner).

---

## 4. Decision — program hierarchy + calendar generalization

### 4.1 `Program` (new, tenant-owned)

```prisma
enum ProgramStatus {
  ACTIVE
  INACTIVE   // retired program; historical records still reference it (preserve-history)
}

enum ProgramDurationUnit {
  TERMS
  YEARS
}

model Program {
  id            String              @id @default(cuid())
  institutionId String
  institution   Institution         @relation(fields: [institutionId], references: [id])
  departmentId  String
  department    Department          @relation(fields: [departmentId], references: [id])
  name          String              // e.g. "Bachelor of Computer Applications"
  code          String              // e.g. "BCA" — unique within the institution
  duration      Int                 // magnitude
  durationUnit  ProgramDurationUnit @default(TERMS)
  status        ProgramStatus       @default(ACTIVE)
  createdAt     DateTime            @default(now())
  updatedAt     DateTime            @updatedAt

  @@unique([institutionId, code])  // one "BCA" code per institution
  @@unique([id, institutionId])    // referenceable with institutionId (SIS links here)
  @@index([institutionId])
  @@index([departmentId])
  @@map("programs")
}
```

`durationTermsOrYears` from the task is modelled as the pair `(duration: Int, durationUnit:
enum)` rather than a single ambiguous integer, so "6 terms" and "3 years" are both
representable unambiguously and configurably. The composite FK to `Department`
(migration-authored, including `institutionId`) enforces same-tenant:

```sql
ALTER TABLE "programs" DROP CONSTRAINT "programs_departmentId_fkey";
ALTER TABLE "programs"
  ADD CONSTRAINT "programs_department_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "departmentId")
  REFERENCES "departments" ("institutionId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
```

`departments` already carries `@@unique([id, institutionId])` (verified in schema), so it is
referenceable with `institutionId` — no change to the FROZEN departments table needed.

### 4.2 Calendar generalization — the critical additive change (Decision D)

The live `AcademicCalendarDay` is:

```prisma
model AcademicCalendarDay {
  id            String          @id @default(cuid())
  institutionId String
  institution   Institution     @relation(...)
  date          DateTime
  dayType       AcademicDayType
  note          String?
  createdAt     DateTime        @default(now())
  updatedAt     DateTime        @updatedAt
  @@unique([institutionId, date])
  @@index([institutionId, date])
  @@map("academic_calendar_days")
}
```

The allowance-engine (verified in `allowance-engine.ts`) reads it with
`db.academicCalendarDay.findMany({ where: { institutionId, date: { gte, lte } } })` and maps
on `dayType`. **This query and its result shape MUST keep working byte-for-byte** — the
generalization is strictly additive:

**New nullable columns** (added via `ALTER TABLE ADD COLUMN`, all nullable so existing rows
are valid and the engine's query is unaffected):

```prisma
  // added to AcademicCalendarDay
  departmentId      String?          // null = institution-wide (the existing behavior)
  department        Department?      @relation(fields: [departmentId], references: [id])
  academicSessionId String?          // optional link to a session
  academicSession   AcademicSession? @relation(fields: [academicSessionId], references: [id])
  academicTermId    String?          // optional link to a term
  academicTerm      AcademicTerm?    @relation(fields: [academicTermId], references: [id])
```

**The uniqueness problem and its resolution.** The live `@@unique([institutionId, date])`
means one entry per institution per date. Adding department-scoped entries breaks that: an
institution-wide holiday on a date AND a department-specific exam day on the same date must
coexist. **Decision:** replace the single unique with a composite that includes
`departmentId`, but because Postgres treats `NULL` as distinct in a plain unique index
(which would allow *two* institution-wide rows for the same date), use **two partial unique
indexes** — one for the institution-wide (`departmentId IS NULL`) case and one for the
department-scoped case:

```sql
-- drop the live single unique (this is NOT a FROZEN object; it is a constraint this
-- migration owns the change to — the table predates Phase 0 and the unique is replaced,
-- not an edit to a frozen migration file):
DROP INDEX "academic_calendar_days_institutionId_date_key";

-- institution-wide: at most ONE row per (institution, date) with NULL department:
CREATE UNIQUE INDEX "academic_calendar_days_inst_date_institutionwide"
  ON "academic_calendar_days" ("institutionId", "date")
  WHERE "departmentId" IS NULL;

-- department-scoped: at most ONE row per (institution, date, department):
CREATE UNIQUE INDEX "academic_calendar_days_inst_date_dept"
  ON "academic_calendar_days" ("institutionId", "date", "departmentId")
  WHERE "departmentId" IS NOT NULL;
```

> **Prisma-mapping note (important for the implementer).** The live code upserts by the
> Prisma compound key `institutionId_date` (verified in `admin.ts` — `where: {
> institutionId_date: { institutionId, date } }`). Dropping the `@@unique([institutionId,
> date])` removes that generated input type and would break the existing upsert. **Resolution:**
> keep an **`@@unique([institutionId, date])` in the Prisma schema removed** and instead
> have the implementer rewrite the three live calendar handlers (`PUT`/`DELETE`/`GET
> academic-calendar`, §5.4) to operate on the institution-wide entries explicitly via
> `findFirst`/`create`/`update` keyed on `(institutionId, date, departmentId: null)`,
> because the partial-unique shape is not expressible as a Prisma compound-unique. The
> allowance-engine's `findMany` is **unaffected** (it never used the compound-unique input
> type — it filters by `institutionId` + `date` range). This handler rewrite is the one
> place the live app code changes for the calendar; it is behavior-preserving for the
> institution-wide path and additive for the department path. Covered by the
> allowance-engine regression test (§10.5) and a calendar-scope test (§10.4).

Composite same-tenant FKs for the new nullable links (migration-authored; FK still enforces
same-tenant even when nullable — a non-null value must match the tenant, a null is allowed):

```sql
ALTER TABLE "academic_calendar_days"
  ADD CONSTRAINT "acd_department_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "departmentId")
  REFERENCES "departments" ("institutionId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "academic_calendar_days"
  ADD CONSTRAINT "acd_session_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "academicSessionId")
  REFERENCES "academic_sessions" ("institutionId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "academic_calendar_days"
  ADD CONSTRAINT "acd_term_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "academicTermId")
  REFERENCES "academic_terms" ("institutionId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
```

`ON DELETE SET NULL` for the session/term links (a closed session being referenced by a
calendar entry should not block, and the link is informational), `ON DELETE RESTRICT` for
department (a department with calendar entries should not be silently orphaned). The
`academic_calendar_days` table **already has** `institutionId` + RLS + the `campass_app`
grant from Phase 0; the migration only adds columns, FKs, and swaps the unique indexes — it
does **not** re-create the table or its RLS (those are FROZEN-migration objects and stay).

### 4.3 Calendar revision history (new, tenant-owned)

Per the task and `architecture.md` configuration-history guidance: important calendar
changes record the previous value + actor + timestamp rather than silently overwriting.

```prisma
model AcademicCalendarDayRevision {
  id                 String           @id @default(cuid())
  institutionId      String
  institution        Institution      @relation(fields: [institutionId], references: [id])
  calendarDayId      String?          // the row changed; nullable so a DELETE revision survives the row
  date               DateTime         // snapshot of the entry's date (stable even after delete)
  departmentId       String?          // snapshot of scope
  previousDayType    AcademicDayType? // null when the change is a CREATE
  newDayType         AcademicDayType? // null when the change is a DELETE
  previousNote       String?
  newNote            String?
  changeType         String           // "CREATE" | "UPDATE" | "DELETE" (validated in service)
  actorUserId        String
  academicSessionId  String?
  academicTermId     String?
  createdAt          DateTime         @default(now())

  @@unique([id, institutionId])
  @@index([institutionId])
  @@index([institutionId, date])
  @@index([calendarDayId])
  @@map("academic_calendar_day_revisions")
}
```

- The FK from `calendarDayId` to `academic_calendar_days` is **deliberately omitted** (left
  as a plain nullable string) so a `DELETE` revision outlives the deleted row — a revision
  is an immutable history record, not a live link. `institutionId` + RLS still scope it. The
  `academicSessionId`/`academicTermId` snapshots are plain nullable strings (history
  snapshots, not live FKs) for the same reason. This mirrors how `AuditEvent` uses
  single-column actor FKs because its rows may outlive/cross their referents.
- Tenant-root FK `institutionId → institutions(id)` (`ON DELETE RESTRICT`), composite
  unique `(id, institutionId)`.
- **Append-only by construction (DB-enforced), not by convention.** The revision table is
  made immutable the same way `audit_events` is — this is the one place the earlier draft
  overstated "by construction" while handing the table the FOR-ALL modify policy, and it is
  now corrected to actually mirror `audit_events`:
  - RLS gets the **append-only pair**, NOT the default pair: `tenant_isolation_select`
    (FOR SELECT, `nullif`-guarded) + `academic_calendar_day_revisions_tenant_insert`
    (FOR INSERT WITH CHECK, `nullif`-guarded) — there is **no** `tenant_isolation_modify`
    / FOR ALL policy (verified precedent: `superadmin_security/migration.sql` gives
    `audit_events` exactly this `SELECT` + `*_tenant_insert` pair and no modify policy).
  - `campass_app` is granted `SELECT, INSERT` only and `UPDATE, DELETE` are `REVOKE`d
    from it (the `audit_events` GRANT pin shape — §8 step 8).
  - A `BEFORE UPDATE OR DELETE` trigger `academic_calendar_day_revisions_append_only`
    (identical in shape to the live `audit_events_append_only`: raises `restrict_violation`)
    binds **every** role, including the table owner / privileged path that GRANTs cannot
    restrict. So even a bug or a privileged client cannot rewrite a revision.
  - Because the table is append-only at the DB layer, it is **registered in
    `EXPECTED_POLICIES` in `tenant-escape-setup.ts`** (as `audit_events` is), **not** in
    the default-pair set — see §8 step 7, §10.1, and §12.
- A revision row is written **inside the same `withTenant` transaction** as the calendar
  mutation (atomic: the history can never be missing for a change that happened). The
  `INSERT`-only policy + trigger mean the service's write path is the *only* way a row ever
  enters the table, and once in it can never change — immutability is a structural property
  of the schema, not a property the service happens to uphold.

### 4.4 The calendar read service (`apps/api/src/services/calendar-service.ts`)

A new service module — the single read API other modules call. It **describes dates; it
does not invent rules.** Signatures (final shape decided here, not left to the implementer):

```ts
export interface CalendarEntry {
  date: Date;
  dayType: AcademicDayType;
  note: string | null;
  departmentId: string | null;         // null = institution-wide
  academicSessionId: string | null;
  academicTermId: string | null;
}

export class CalendarService {
  /**
   * Entries overlapping [from, to] for an institution, optionally narrowed to a
   * department. Department-scoped query returns BOTH institution-wide
   * (departmentId null) AND the department's own rows, with the department row
   * taking precedence on a date collision (resolved in `effectiveDayType`).
   * Runs on the passed tenant tx (RLS-scoped); never reads cross-tenant.
   */
  static async getEntries(
    institutionId: string,
    from: Date,
    to: Date,
    db: Prisma.TransactionClient,
    opts?: { departmentId?: string },
  ): Promise<CalendarEntry[]>;

  /**
   * The effective dayType for a single date + optional department, applying the
   * precedence rule (department-scoped row wins over institution-wide). Returns
   * null when no explicit entry exists (caller falls back to its own weekday
   * rule — e.g. the allowance-engine's workingDaysOfWeek). The service does NOT
   * decide "working vs not" — it only returns the dayType.
   */
  static async effectiveDayType(
    institutionId: string,
    date: Date,
    db: Prisma.TransactionClient,
    opts?: { departmentId?: string },
  ): Promise<AcademicDayType | null>;
}
```

**Precedence rule (the one piece of resolution logic the service owns):** when both an
institution-wide and a department-scoped entry exist for the same date, the
department-scoped entry wins for that department's query. This is a **lookup precedence, not
a business rule** — the service still returns a raw `dayType`; the caller decides meaning.

**Allowance-engine relationship (do NOT break it).** The `CalendarService` is introduced
as the *forward* API for new callers (and for Phase 1's own read endpoints). We do **not**
refactor the allowance-engine onto `CalendarService` in this phase (that would be a behavior
change on a live hot path for no Phase-1 requirement); the regression test (§10.5) pins the
engine's behavior.

**Required one-line hardening of the engine's query (not optional).** The engine today reads
(verified in `allowance-engine.ts`):

```ts
db.academicCalendarDay.findMany({ where: { institutionId, date: { gte: start, lte: end } } })
```

and folds the result into `calendarMap = new Map(days.map(d => [dateKey(d.date), d.dayType]))`.
This `findMany` has **no `orderBy`**. Once department-scoped rows can exist (this phase),
an institution-wide `HOLIDAY` and a department-scoped `WORKING_DAY` on the **same date**
would both be returned, and because there is no ordering, *which one wins* the last-write
into the date-keyed `Map` is **undefined** — the `isWorkingDay` result for that date would
become non-deterministic, and the §10.5 "unchanged" assertion would be an ordering accident,
not an invariant.

**Decision (required, not a reviewer-optional):** add `departmentId: null` to the engine's
`findMany` `where`, so it reads **institution-wide entries only** — exactly the set the
engine conceptually read before department scoping existed:

```ts
db.academicCalendarDay.findMany({
  where: { institutionId, date: { gte: start, lte: end }, departmentId: null },
})
```

This is:

- **Additive and behavior-preserving for all existing data** — every current
  `academic_calendar_days` row has `departmentId IS NULL` (the column is brand-new and
  nullable, defaulting null), so the engine returns the identical set it does today on live
  data. The change only *excludes* the newly-possible department rows that did not exist
  before, which is the correct institution-wide semantics for a global allowance engine.
- **Deterministic** — at most one institution-wide row per `(institutionId, date)` is
  guaranteed by the `..._inst_date_institutionwide` partial unique index (§4.2), so the
  date-keyed `Map` now has a single, well-defined entry per date. The §10.5 assertion
  becomes a real structural invariant.
- **Not a refactor** — it is a one-clause addition to the existing query; the engine is
  **not** moved onto `CalendarService`, and no other engine logic changes.

A follow-up phase may migrate the engine onto `CalendarService` once department-scoped
working-day semantics are actually needed; until then this clause keeps the live hot path
correct and deterministic. (Supersedes the earlier "A2 flagged / optional" framing — the
reviewer was right that the mitigation was not structurally guaranteed; it now is.)

---

## 5. Decision — endpoints (routes on `admin.ts`, tenant via `withTenant`)

All new routes are registered inside `adminRoutes` (the top-level `authenticate` hook
already runs), gated by new `requirePermission(...)` guards (§7), reading/writing through
`withTenant` (RLS-enforced), and auditing mutations via `recordAuditEvent(input, tx)` inside
the same transaction — identical to the live calendar/emergency handlers. They are **not**
module-gated (Decision A). Read endpoints for non-admin roles are covered in §5.5.

### 5.1 Session CRUD + term CRUD

- `GET /admin/academic/sessions` — list sessions (optionally `?status=`), newest first.
  `requirePermission("academics.sessions.manage")`.
- `POST /admin/academic/sessions` — create a session (`name`, `structureType`, `startDate`,
  `endDate`; status defaults `UPCOMING`). Validate `startDate < endDate`; validate `name`
  unique per institution (DB unique + friendly 409 on conflict). Audit
  `academics.session.created`.
- `GET /admin/academic/sessions/:id` — detail incl. its terms. Scoped by `withTenant`.
- `PATCH /admin/academic/sessions/:id` — **allowed only while the session is `UPCOMING`.**
  One rule, no exceptions: any field edit (`name`, `structureType`, `startDate`, `endDate`)
  on a session whose status is `ACTIVE` or `CLOSED` returns `409 "session not editable"`.
  This preserves history (an active/closed session's structure is immutable) and removes the
  ambiguity of the earlier "editable via a documented exception" wording — there is **no**
  exception path in Phase 1. Dates are edited only by deleting the mistaken `UPCOMING`
  session and recreating it (an `UPCOMING` session with no terms/references may be deleted,
  per the DELETE rule below). Audit `academics.session.updated`. (Error row added to §11.)
- `POST /admin/academic/sessions/:id/terms` — add a term (`name`, `ordinal`, `startDate`,
  `endDate`). Validation rules, stated explicitly (finding 5):
  - **Hard (blocks the request, `400`):** each term must have `startDate < endDate`. A term
    with inverted/zero-width dates is always rejected (zod refine + re-checked server-side).
  - **Hard (blocks, `409`):** `ordinal` must be unique within the session (DB
    `@@unique([academicSessionId, ordinal])`).
  - **Soft (warning, never blocks):** a term's `[startDate, endDate]` falling outside the
    session's `[startDate, endDate]` range returns a non-fatal `warnings` entry but is
    **allowed** — this keeps the structure configurable (an institution may define a term
    that begins before the nominal session start, e.g. an orientation week).
  - **Soft (warning, never blocks):** two terms in the same session overlapping in time is
    **allowed** (ordinal uniqueness does not prevent date overlap) and returns a `warnings`
    entry. Phase 1 deliberately does **not** block overlap, because a "coherent but
    configurable" model must permit institutions whose terms legitimately overlap (e.g. a
    year-long term running alongside semester terms). **Downstream assumption recorded:**
    modules that key date ranges off terms (attendance, exams — Phase 2+) **must not assume
    non-overlapping terms** and must resolve a date to a term explicitly; this is called out
    here so SIS/attendance design against the real guarantee, not an implied one.

  Audit `academics.term.created`.
- `PATCH /admin/academic/terms/:id` — edit a term while its session is `UPCOMING`/`ACTIVE`
  and the term is not `CLOSED`. Audit `academics.term.updated`.
- No hard DELETE of a session/term that has any dependent data; a session/term is retired by
  status, not deleted (preserve-history §6). An `UPCOMING` session with no terms and no
  references **may** be deleted (admin mistake cleanup) — guarded by a reference check.

### 5.2 Session lifecycle transitions (state machine — the preserve-history core)

A dedicated service `apps/api/src/services/academic-session.ts` owns the transitions (single
owner of the state-machine invariant, mirroring `module-system.ts`), called from thin route
handlers inside `withTenant`:

- `POST /admin/academic/sessions/:id/activate` — `UPCOMING → ACTIVE`. Preconditions
  (all validated server-side, inside the transaction):
  - session is `UPCOMING` (else `409`);
  - session has **≥1 term** (else `409 "session needs ≥1 term"`);
  - **each term has `startDate < endDate`** (the one hard term-date rule enforced at
    activation, `409 "term has invalid dates"` identifying the offending term). Term dates
    falling outside the session range, and term time-overlap, are **not** checked here — they
    are allowed-but-warned at term-add time (§5.1), consistent with the configurable model;
    activation does not re-block them. This is the explicit activation contract (finding 5):
    activation guarantees downstream only that terms exist and each term's own range is
    well-formed, **not** that terms are contained in the session or mutually non-overlapping.
  - **no other `ACTIVE` session exists** unless `?handover=true` (or body
    `{ handover: true }`) is set, in which case the current `ACTIVE` session is transitioned
    to `CLOSED` first (its rows are **not** mutated beyond the status flip — preserve-history).
    The partial unique index (§3.3) is the backstop. Returns `409` if an `ACTIVE` session
    exists and handover was not requested.

  Audit `academics.session.activated` (and `academics.session.closed` for the handed-over
  session).
- `POST /admin/academic/sessions/:id/close` — `ACTIVE → CLOSED` (or `UPCOMING → CLOSED` to
  cancel an upcoming session). Sets `status = CLOSED`; **never** touches terms, calendar, or
  any future enrollment rows — it is a pure status transition. Audit
  `academics.session.closed`.
- Term status (`activate`/`close` a term) follows the same pattern under
  `academics.sessions.manage`; a term can be `ACTIVE` only within an `ACTIVE` session.

**No re-open in Phase 1.** `CLOSED → ACTIVE` is not exposed (a closed session is historical).
If ever needed it is a future, audited, step-up action — out of scope here.

### 5.3 Program CRUD

- `GET /admin/academic/programs` — list programs (optionally `?departmentId=`, `?status=`).
  `requirePermission("academics.programs.manage")`.
- `POST /admin/academic/programs` — create (`departmentId`, `name`, `code`, `duration`,
  `durationUnit`). Validate department exists in-tenant (the composite FK enforces it; a
  friendly pre-check returns 400 on a bad department). `code` unique per institution. Audit
  `academics.program.created`.
- `PATCH /admin/academic/programs/:id` — edit fields; retire via `status = INACTIVE` (never
  hard-delete a program that could be referenced later). Audit `academics.program.updated`.

**Program status / department coupling / code-reuse rules (finding 7 — stated explicitly):**

- **`code` uniqueness spans ALL statuses.** `@@unique([institutionId, code])` is
  status-agnostic, so a retired (`INACTIVE`) program's code is **not** reusable — an admin
  who retires `BCA` and tries to create a new `BCA` gets `409 "program code exists"`. This
  is the chosen behavior (preserve-history: a historical program and its code remain
  referenceable forever). Reuse is deliberately **not** supported in Phase 1; if a future
  phase wants it, the clean change is a partial unique `WHERE status = 'ACTIVE'`, which is
  explicitly deferred (not added now, to avoid two live programs sharing a code while one is
  merely retired-but-referenced). This rule is in the §11 error table.
- **No `Department` status in Phase 1 (verified: the live `Department` model has no `status`
  field).** A program may therefore be created or edited under **any** existing in-tenant
  department; there is no "inactive department" concept to guard against. The composite FK
  `(institutionId, departmentId) → departments(institutionId, id)` enforces only that the
  department is in the same tenant; a friendly pre-check returns `400 "unknown department"`
  on a bad id.
- **Retiring a program cascades to nothing.** Setting `status = INACTIVE` is a pure status
  flip (preserve-history); it does not touch the department, any calendar entry, or any
  future enrollment row. No `ON DELETE` cascade fires because nothing is deleted.

### 5.4 Calendar entry CRUD (generalized; preserves the live handlers' behavior)

The three live handlers (`GET/PUT/DELETE /admin/academic-calendar...`) are **extended**, not
replaced, under the **existing** `admin.academic_calendar.manage` permission (see §7.3 for
why the existing key is kept and a new `academics.calendar.manage` is added as an alias-free
superset decision):

- `GET /admin/academic-calendar?startDate&endDate&departmentId?` — returns entries in range;
  with `departmentId` returns institution-wide + that department's rows. Uses
  `CalendarService.getEntries`. Existing query (no `departmentId`) behavior unchanged
  (institution-wide + any dept rows — see §4.4 note).
- `PUT /admin/academic-calendar/day` — upsert an entry. Body gains optional `departmentId`,
  `academicSessionId`, `academicTermId` (all validated same-tenant). **Writes a revision row
  first** (capturing the previous `dayType`/`note` when updating, `changeType` `CREATE` or
  `UPDATE`) then upserts — both inside one `withTenant` transaction. Because the compound
  Prisma unique is gone (§4.2), the handler resolves the existing row via `findFirst({ where:
  { institutionId, date, departmentId: departmentId ?? null } })` and `create`/`update`
  explicitly. Audit `academics.calendar.updated`.
- `DELETE /admin/academic-calendar/day/:date?departmentId?` — writes a `DELETE` revision row
  (capturing the previous value) then deletes the resolved entry. Audit
  `academics.calendar.updated`.

### 5.5 Read endpoints for non-admin roles

Students/faculty/guards need to see the current session + calendar within their tenant. New
read-only routes with a new low-privilege permission `academics.view` (bound to all tenant
template roles — see §7.2):

- `GET /me/academic/current-session` (on `student.ts`, and reused by other role routers) —
  returns the institution's single `ACTIVE` session + its terms (names/dates/ordinals only;
  no admin-only fields). `requirePermission("academics.view")`, `withTenant`.
- `GET /me/academic/calendar?startDate&endDate` — institution-wide calendar entries for the
  range, plus department-scoped entries **only** for the caller's own department, derived
  from `request.auth.departmentScope` (never from request input). `requirePermission(
  "academics.view")`, `withTenant`, via `CalendarService.getEntries({ departmentId })` where
  `departmentId = request.auth.departmentScope ?? undefined` (undefined ⇒
  institution-wide-only read). The service's precedence rule (§4.4) applies: when the
  caller's department has its own entry on a date, it wins over the institution-wide one.

These are reads only; they respect RLS (tenant scope) and expose no cross-department data
beyond the caller's own `departmentScope`.

**Required Phase-0 auth surface extension (sub-task — do NOT skip).** The non-admin
department-scoped read above reads `request.auth.departmentScope`, but the **live**
`RequestAuth` interface and the `authenticate` middleware (verified in
`apps/api/src/middleware/auth.ts`) do **not** carry or select `departmentScope` today. The
column exists on `InstitutionMembership` (`departmentScope String?`, verified in schema) but
is never surfaced on the request. §5.5 is therefore **not implementable** without this
change, so Phase 1 includes it as an explicit, minimal, additive sub-task:

1. Add `departmentScope: string | null` to the `RequestAuth` interface in `auth.ts`.
2. Add `departmentScope: true` to the tenant-actor membership `select` in `authenticate`
   (the `privilegedPrisma.institutionMembership.findUnique` call).
3. Set `departmentScope: membership.departmentScope` in the `request.auth = { ... }`
   assignment for the tenant-actor branch. For the `SUPER_ADMIN` branch set
   `departmentScope: null` (no membership, no tenant reads — it never opens a tenant tx).

Scope/safety of this change:

- It is **additive and read-only** — it does not change any existing auth decision, token
  shape, or route behavior; it only surfaces an already-stored column on the request. No
  JWT change is needed: `departmentScope` is re-read from the membership on every request
  (the same place `permissionsVersion`/`roles` are already read), so it is always fresh and
  cannot go stale in a long-lived token.
- It touches a Phase-0 file but does **not** alter tenancy/RBAC/audit/module-system
  semantics; the escape suite and the authz engine are unaffected (the engine reads
  `permissions`, not `departmentScope`). It is covered by the §10.6 route test (a student
  whose `departmentScope` is set sees their department's entries; a student with
  `departmentScope = null` sees institution-wide only; neither sees another department's
  entries).
- **Alternative considered and rejected:** drop department-scoped narrowing from the
  non-admin read and return institution-wide entries only. Rejected because
  department-scoped calendar entries are a core deliverable of this phase (§4.2), and
  shipping a read endpoint that silently ignores them would make the department-scope
  feature invisible to exactly the non-admin users it is for. The three-line auth surface
  extension is the lower-risk way to honor the feature; it is listed in the §2 scope.

---

## 6. Decision C — preserve-history by construction (non-negotiable)

This is the phase's load-bearing guarantee. It is enforced **structurally**, not by
convention:

1. **Sessions/terms advance by status, never by destructive rewrite.** The lifecycle
   (`UPCOMING → ACTIVE → CLOSED`) only ever flips a `status` enum + sets a timestamp. No
   transition updates `startDate`/`endDate`/`name`/`structureType` of a non-`UPCOMING`
   session, and no transition deletes terms. A `CLOSED` session + its terms remain fully
   readable forever (the read endpoints and admin list include CLOSED sessions).
2. **Records created in one session stay linked to THAT session.** Because future rows
   (enrollment, attendance, grades — Phase 2+) will carry a composite FK to
   `(institutionId, academicSessionId)` / `(institutionId, academicTermId)`, and because a
   session is never deleted (FKs are `ON DELETE RESTRICT`), a promotion that creates *new*
   rows in a *new* session physically cannot rewrite the old rows. The schema makes the
   historical link immutable.
3. **Closing/advancing a session does not rewrite historical calendar data.** Calendar
   entries are linked to sessions with `ON DELETE SET NULL` and are never cascaded on a
   session close; a session close is a pure status flip.
4. **Calendar edits are non-destructive-by-record.** Every create/update/delete of a
   calendar entry writes an `AcademicCalendarDayRevision` row **in the same transaction**
   capturing the previous value + actor + timestamp, so the prior state is always
   recoverable. This is immutable **by construction at the DB layer** (§4.3): the revision
   table carries an INSERT-only RLS policy (no modify policy), a `REVOKE UPDATE, DELETE`
   from `campass_app`, and a `BEFORE UPDATE OR DELETE` trigger that binds every role — the
   same append-only machinery `audit_events` uses. A revision, once written, can never be
   rewritten or erased, so a silent overwrite of history is structurally impossible, not
   merely something the service declines to do. (The *calendar row itself* is still
   mutable — editing a holiday to a working day is a legitimate admin action — but the
   change always leaves an immutable revision behind.)

### 6.3 The promotion seam (modelled, NOT executed)

Phase 1 defines the *shape* SIS will use so SIS inherits preserve-history for free, and
builds **none** of it:

- **Promotion is "create new session-scoped rows", never "mutate old rows".** The seam is:
  SIS's promote operation (Phase 2) will, for each student, create a **new** enrollment row
  in the **target** `AcademicSession`/`AcademicTerm`, leaving the source session's enrollment
  row untouched and `CLOSED`-session-linked. Phase 1 guarantees the target structures
  (`AcademicSession`, `AcademicTerm` with stable `(id, institutionId)` composite uniques)
  exist and are immutable-by-status so SIS can only ever *reference* them, not rewrite them.
- **What Phase 1 provides to SIS:** (a) a current/active session lookup
  (`AcademicSessionStatus.ACTIVE` + the one-active invariant) so SIS knows the promotion
  target; (b) referenceable session/term parents for composite FKs; (c) the status model
  that keeps the source session historical. **What Phase 1 does NOT do:** touch
  `StudentProfile`, create enrollment rows, or run any promotion. The design note here is the
  contract; the implementation is Phase 2's.

---

## 7. Decision — permission keys + audit action keys

### 7.1 New permission keys (`packages/shared/src/permissions.ts`, module `"academics"`)

Following the `<module>.<resource>.<action>` convention (identity-rbac.md §6), a new
`academics` module namespace:

```
academics.sessions.manage   — create/edit sessions + terms, run session/term lifecycle
academics.programs.manage    — create/edit/retire programs
academics.calendar.manage    — create/edit/delete calendar entries (generalized)
academics.view               — read current session + calendar (low-privilege, all roles)
```

### 7.2 Template-role bindings (`ROLE_PERMISSIONS`)

- `ADMIN` gains `academics.sessions.manage`, `academics.programs.manage`,
  `academics.calendar.manage`, and `academics.view`.
- `STUDENT`, `GUARD`, `HOD` each gain `academics.view` (so every tenant role can read the
  current session/calendar). This matches §5.5.
- `SUPER_ADMIN` gains **nothing** (platform role; academics is tenant data it has no
  standing access to — superadmin-security.md §2).

### 7.3 Relationship to the existing `admin.academic_calendar.manage` permission

The live calendar handlers are gated by `admin.academic_calendar.manage` (module `admin`).
**Decision:** keep that permission working (the shim + live routes depend on it) and gate the
**generalized** calendar write path behind the **new** `academics.calendar.manage`. To avoid
a confusing dual-gate, the three calendar routes are re-gated to **require either** via a
small `requireAnyPermission([...])` — **rejected**: the engine today exposes
`requirePermission(single)` only, and inventing a multi-permission guard is scope creep.

**Chosen approach:** the three calendar routes migrate to `academics.calendar.manage`
(single new key), and `admin.academic_calendar.manage` is **retained in the catalogue and in
`ROLE_PERMISSIONS.ADMIN`** (not removed — removing it would be a catalogue-sync + shim
change) but is no longer the gate on those routes. Because `ADMIN` is granted **both** keys,
no admin loses access; the old key simply becomes unused by routes (harmless, and its removal
is deferred housekeeping, consistent with database.md's "legacy cleanup is its own
workstream" stance). **Assumption A3 (flagged):** retaining an now-route-unused permission is
the low-risk choice; the reviewer may prefer deleting `admin.academic_calendar.manage`
entirely, which is a clean but higher-touch catalogue change (seed + both catalogue-sync
migration dirs + the shim) — deferred unless the reviewer requires it.

### 7.4 New audit action keys (`packages/shared/src/audit-actions.ts`, module `"academics"`)

```
academics.session.created     academics.session.updated
academics.session.activated   academics.session.closed
academics.term.created        academics.term.updated
academics.term.activated      academics.term.closed
academics.program.created     academics.program.updated
academics.calendar.updated    (covers create/update/delete; changeType is in metadata + the revision row)
```

These are dot-separated lower-snake keys with two or more segments (the meta-test's enforced
shape regex is `KEY_RE = /^[a-z_]+(\.[a-z_]+)+$/`, which admits any ≥2-segment key — e.g.
the catalogue's own 2-segment `platform.onboarding`); the new keys all use the 3-segment
`<module>.<resource>.<action>` form. They need **no** pg-enum/migration mirror (audit
actions are validated only in `recordAuditEvent`, per the catalogue comment). The legacy
`ACADEMIC_CALENDAR_UPDATED` enum → `admin.academic_calendar.updated` map is **untouched**
(the live calendar handlers keep writing `admin.academic_calendar.updated` until they are
re-pointed; the new generalized path writes `academics.calendar.updated`). **Decision:** the
rewritten §5.4 handlers write the **new** `academics.calendar.updated` key, so the live
`admin.academic_calendar.updated` key remains valid in the catalogue (used by nothing new,
retained as history, same stance as §7.3).

### 7.5 Keeping catalogue-sync green (the established union pattern)

`catalogue-sync.test.ts` parses the **seeding migrations'** `INSERT INTO "permissions"` and
`INSERT INTO "role_permissions"` blocks and asserts set-equality against `PERMISSION_KEYS` +
`ROLE_PERMISSIONS`, unioned across `SEEDING_MIGRATION_DIRS`. Therefore the new migration
MUST:

1. Seed the four new `academics.*` permissions into `permissions` and their
   `(roleKey, permKey)` pairs into `role_permissions` (ADMIN × all four; STUDENT/GUARD/HOD ×
   `academics.view`), using the **exact block markers** the parser keys on (`INSERT INTO
   "permissions" ... ON CONFLICT`, the `INSERT INTO "role_permissions" ... SELECT ... FROM
   (VALUES ...) AS m(...)` join form), idempotently (`ON CONFLICT DO NOTHING`) — byte-for-byte
   the shape `module_system`/`superadmin_security` used.
2. Add the new migration dir (`20261019..._phase1_academics`) to `SEEDING_MIGRATION_DIRS` in
   `catalogue-sync.test.ts` so the union includes it.

Audit action keys need **no** migration mirror (no enum/seed), so only permissions require
the migration seed + the test-dir addition — exactly the module-system precedent.

---

## 8. Decision — the `phase1_academics` migration

One **new** migration directory, generated with `prisma migrate dev --create-only --name
phase1_academics` (against a local/dev DB — **never** `migrate dev` against the shared
Supabase DB, per database.md) and applied in prod/CI with `prisma migrate deploy`. The six
FROZEN migrations are **not** edited. The migration is hand-authored for everything Prisma's
diff does not model (enums are modelled; RLS, composite FKs, partial unique indexes, the
calendar unique-swap, the GRANT pins, and the catalogue seed are hand-written), mirroring the
`module_system` migration's ordering and style:

1. `CREATE TYPE` the **five** new enums (`AcademicSessionStatus`, `AcademicStructureType`,
   `AcademicTermStatus`, `ProgramStatus`, `ProgramDurationUnit`).
2. `CREATE TABLE academic_sessions`, `academic_terms`, `programs`,
   `academic_calendar_day_revisions` with PKs, the `(id, institutionId)` composite uniques,
   the `(institutionId, name)` / `(institutionId, code)` / `(academicSessionId, ordinal)`
   uniques, and `institutionId` indexes.
3. `ALTER TABLE academic_calendar_days ADD COLUMN` the three nullable columns
   (`departmentId`, `academicSessionId`, `academicTermId`).
4. Tenant-root FKs (`institutionId → institutions(id)`, `ON DELETE RESTRICT`) for **all
   four** new tenant-owned tables (`academic_sessions`, `academic_terms`, `programs`,
   `academic_calendar_day_revisions`); composite same-tenant FKs for
   `academic_terms → academic_sessions`, `programs → departments`, and the three new
   `academic_calendar_days` links (department, session, term — per §3.2, §4.1, §4.2).
5. Swap the calendar unique: `DROP INDEX academic_calendar_days_institutionId_date_key`; create
   the two partial unique indexes (§4.2).
6. The partial unique index `academic_sessions_one_active_per_institution` (§3.3).
7. `ENABLE` + `FORCE` RLS on all **four new** tenant-owned tables
   (`academic_sessions`, `academic_terms`, `programs`,
   `academic_calendar_day_revisions`), byte-for-byte the
   `module_system`/`superadmin_security` house style. **Two of the four get the
   standard fail-closed `nullif`-guarded modify pair; the revision table gets the
   append-only pair:**
   - `academic_sessions`, `academic_terms`, `programs`: the standard pair
     `tenant_isolation_select` (FOR SELECT) + `tenant_isolation_modify` (FOR ALL
     WITH CHECK) — these tables take full tenant DML (admin CRUD under
     `withTenant`).
   - `academic_calendar_day_revisions`: the **append-only** pair, mirroring
     `audit_events` exactly (§4.3) — `tenant_isolation_select` (FOR SELECT, same
     `nullif`-guard) + `academic_calendar_day_revisions_tenant_insert` (FOR INSERT
     WITH CHECK, same guard), and **no** `FOR ALL`/modify policy. A
     `BEFORE UPDATE OR DELETE` trigger
     (`academic_calendar_day_revisions_append_only`, raising `restrict_violation`,
     identical in shape to `audit_events_append_only`) binds **every** role
     including the owner, so the history is immutable by construction at the DB
     layer, not merely by service convention.

   `academic_calendar_days` **already** has RLS from Phase 0 — not re-created.
8. Guarded idempotent `campass_app` GRANT pin inside a
   `DO $$ ... IF EXISTS (pg_roles...) $$`, never `BYPASSRLS`:
   - `GRANT SELECT, INSERT, UPDATE, DELETE` on `academic_sessions`,
     `academic_terms`, `programs` (full tenant DML — admin CRUD under
     `withTenant`, so **no** `REVOKE`).
   - `GRANT SELECT, INSERT` on `academic_calendar_day_revisions` and
     `REVOKE UPDATE, DELETE` from `campass_app` on it — exactly the
     `audit_events` pin, so the tenant role can append a revision inside the
     calendar-mutation transaction but can never alter or erase history.

   The B-1 `ALTER DEFAULT PRIVILEGES` already covers new tables; the explicit
   pin + the targeted `REVOKE` on the revision table match the
   `superadmin_security` precedent.
9. Seed the four `academics.*` permissions + their `role_permissions` pairs (§7.5), exact
   markers, idempotent.

**No backfill is needed** (unlike module-system): these are brand-new tables with no existing
rows and no live route depends on them existing until this migration + the new routes ship
together. The allowance-engine's calendar reads keep working because step 3/5 are purely
additive to `academic_calendar_days` (the engine's `findMany` is unaffected — §4.4).

**Ordering constraint.** The new routes (§5) and the migration ship in the **same
deployable**; `migrate deploy` runs before the API boots (database.md), so the tables/columns
exist before any new route serves. Unlike module-system there is no 403-risk window (nothing
is newly *gated*), so the ordering is a correctness-of-reads concern only, satisfied by the
standard deploy order.

---

## 9. Decision — seed additions (`packages/db/src/seed.ts`)

Extend the seed so a fresh/dev DB gives the DEMO institution a realistic Phase-1 dataset,
all idempotent (`upsert` on the composite/natural keys), added after the existing module
upsert. Operate on the demo `institution` object the seed already created (not a `findMany`),
matching the module-system seed precedent:

- **One `AcademicSession`:** name `"2026-2027"`, `structureType = SEMESTER`, `status =
  ACTIVE`, `startDate`/`endDate` spanning the academic year. Upsert keyed on
  `(institutionId, name)`.
- **Two `AcademicTerm`s:** `"Semester 1"` (ordinal 1) and `"Semester 2"` (ordinal 2) under
  that session, each with sensible dates, `status` ACTIVE for term 1 / UPCOMING for term 2.
  Upsert keyed on `(academicSessionId, ordinal)`.
- **Two `Program`s** under existing demo departments (verified in the current
  `packages/db/src/seed.ts`, where "courses" are seeded as `Department` rows and the seed
  already captures the BCA department in the `bca` variable):
  - `BCA` under the **"Bachelor of Computer Applications (BCA)"** department (`code = "512"`,
    the one the seed holds as `bca`). Reuse that `bca` object directly (do not re-query).
  - `BTECH-CSE` under the **"B.Tech (Computer Science & Engineering)"** department
    (`code = "501"`). Look it up via the composite natural key
    `institutionId_code: { institutionId: institution.id, code: "501" }` (the same
    `@@unique([institutionId, code])` the seed already upserts departments on).

  Both `durationUnit = TERMS`, `duration = 6`, upsert keyed on `(institutionId, code)`.
- **A few calendar entries:** one institution-wide `HOLIDAY`, one institution-wide
  `WORKING_DAY`, and one **department-scoped** `EXAM_DAY` (scoped to the BCA department —
  the `bca` object above, code `512` — to exercise the new `departmentId` path and its
  partial-unique). Linked to the seeded session.
  Use the §5.4 resolution-by-`findFirst` approach (not the removed compound upsert).

The seed does **not** create `AcademicCalendarDayRevision` rows (revisions are written by the
runtime handlers, not seeded) — though a single seeded revision is acceptable to demonstrate
the shape; decision: **do not** seed revisions, to keep the seed representing a clean initial
state.

---

## 10. Decision — test plan (Vitest, mirroring existing suites)

Every new tenant-owned table gets escape-suite coverage (phase-completion gate +
tenancy.md §7/§8). The plan has five groups:

### 10.1 Escape-suite extension (real DB, `tenant-escape*` + `helpers/tenant-escape-setup.ts`)

- Add `"academic_sessions"`, `"academic_terms"`, `"programs"`, and
  `"academic_calendar_day_revisions"` to `RLS_TABLES` (the meta-test asserts `ENABLE`+`FORCE`
  RLS on all of them). **Three of the four use the default pair; the revision table is a
  special case** (finding 2):
  - `academic_sessions`, `academic_terms`, `programs` carry the standard `DEFAULT_POLICIES`
    pair — no `EXPECTED_POLICIES` entry.
  - `academic_calendar_day_revisions` is registered in `EXPECTED_POLICIES` as
    `["tenant_isolation_select", "academic_calendar_day_revisions_tenant_insert"]` — the
    append-only pair, **not** the default modify pair — exactly mirroring the existing
    `audit_events: ["tenant_isolation_select", "audit_events_tenant_insert"]` entry. The
    meta-test then asserts this append-only pair (and the absence of a `tenant_isolation_modify`
    policy) on that table.
  - Add an escape-suite assertion that `campass_app` **cannot UPDATE or DELETE** a revision
    row (both the `REVOKE` and the append-only trigger block it) — mirroring the
    `audit_events` append-only coverage.

  `academic_calendar_days` is already in `RLS_TABLES`.
- Seed each tenant (A and B) an `AcademicSession` (+1 term), a `Program`, and a
  department-scoped calendar entry via the RLS-bypassing `adminClient`; capture their ids on
  `SeededTenant`. **No revision row is seeded here** (append-only — see the teardown note
  below; revision escape behavior is covered by its own self-contained test).
- **Cross-tenant read denied:** as A (via `withTenant`), `findUnique` B's
  session/term/program → `null`; unscoped `findMany` under A returns only A's rows. (The
  revision table's cross-tenant read denial is asserted in its own isolated test, §10.4.)
- **Cross-tenant/spoofed write denied:** as A, attempt to `create`/`update` a row stamped
  `institutionId = B` → rejected by `WITH CHECK`; attempt to create a term referencing B's
  session → composite-FK violation.
- **Buggy-query backstop:** as A, `findMany({})` with no filter on each new table still returns
  only A's rows (the headline RLS-backstop test, extended).
- **Fail-closed:** unset / empty-string / wrong-tenant GUC each yield zero rows for every new
  table (the `nullif`-guarded policy).
- Add the **three mutable** new tables (`academic_sessions`, `academic_terms`, `programs`)
  to **both** `cleanup()` (deleted child-first — terms before sessions; programs before
  departments; all before the institution, because the tenant-root FKs are
  `ON DELETE RESTRICT`) **and** `countRemainingTestRows()` (so the teardown `=== 0`
  assertion covers them — the module-system finding-8 precedent).
- **The revision table needs explicit teardown handling because it is append-only.** The
  `BEFORE UPDATE OR DELETE` trigger (§4.3) binds **every** role including `adminClient`
  (postgres owner), so a plain `adminClient.academicCalendarDayRevision.deleteMany(...)` in
  `cleanup()` would be **blocked by the trigger** — the same reason the existing escape
  suite deliberately seeds **no** `audit_events` rows (verified note in
  `tenant-escape-setup.ts`: "the escape suite itself seeds no audit_events rows"). Two
  acceptable approaches, decision below:
  - **Chosen:** follow the `audit_events` precedent exactly — the escape suite does **not**
    seed `academic_calendar_day_revisions` rows into tenants A/B. The revision table's
    RLS/escape behavior (cross-tenant read denied, fail-closed, insert-only) is covered in a
    **separate, self-contained** revision test under its own prefix that drops+recreates or
    disables the trigger in its own teardown (via `adminClient` DDL), never touching the
    shared escape-suite teardown. This keeps the shared `cleanup()` trigger-free and mirrors
    how the superadmin-security integration suite kept its `audit_events` rows self-contained.
  - Rejected alternative: have the shared `cleanup()` run `ALTER TABLE ... DISABLE TRIGGER`
    around the revision delete — rejected because it mutates shared teardown to toggle a
    security-relevant trigger on the live DB, a broader blast radius than the isolated
    approach warrants.
  - The revision table is therefore added to `RLS_TABLES` (for the policy meta-test) and to
    `EXPECTED_POLICIES`, but **not** to the shared `cleanup()`/`countRemainingTestRows()`
    seed-and-delete path — exactly the `audit_events` treatment.

### 10.2 Configurable-structure test (the Definition-of-Done demo)

Two institutions with **different** structures, proving the schema is not hardcoded:

- Institution A: a `SEMESTER` session with 2 terms → activates cleanly, no term-count warning.
- Institution B: an `ANNUAL` session with 1 term → activates cleanly.
- A `TRIMESTER` session with 2 terms → activates but returns a non-fatal term-count **warning**
  (proving soft validation, not a block).
- An `ANNUAL` session with **0** terms → activation **rejected** (the one hard rule, §3.3).

### 10.3 One-active-session invariant test

- Activating a second session while one is `ACTIVE` without `handover` → `409`.
- With `handover=true` → the old session flips to `CLOSED`, the new one to `ACTIVE`, and a
  direct DB read confirms exactly one `ACTIVE` row (the partial unique index holds).
- A concurrency assertion: two parallel activations (simulated) — exactly one succeeds, the
  other hits the partial-unique violation (DB backstop).

### 10.4 Preserve-history + calendar-scope tests

- **Preserve-history:** create session S1 (ACTIVE) with term T1; create a calendar entry
  linked to S1; activate S2 with handover (S1 → CLOSED). Assert S1 and T1 are **unchanged**
  (same dates/name/ordinal), S1's calendar entry still links to S1, and S1 remains readable.
  This is the roadmap DoD: "records created in one session remain correctly linked after a
  promotion."
- **Calendar revision (self-contained, own prefix).** Through the §5.4 handler path
  (`withTenant`, `campass_app`): create a calendar entry, update its `dayType`, and assert an
  `AcademicCalendarDayRevision` row exists with the **previous** `dayType`, the actor, and a
  timestamp; delete the entry and assert a `DELETE` revision **survives** the row deletion
  (the omitted FK on `calendarDayId`, §4.3). Append-only assertions (the finding-2
  guarantee): as `campass_app`, attempt to `UPDATE` and to `DELETE` a revision row — both
  rejected (the `REVOKE` + the `BEFORE UPDATE OR DELETE` trigger). Cross-tenant: as tenant A,
  a `findUnique` of a B-seeded revision → `null`; fail-closed GUC yields zero rows. This test
  seeds and tears down its own rows under its own prefix, and because the trigger blocks even
  the owner, its teardown disables/recreates the trigger within its own `adminClient` DDL
  scope (never touching the shared escape `cleanup()`), mirroring how the superadmin-security
  suite kept `audit_events` self-contained.
- **Calendar scope:** a department-scoped `EXAM_DAY` and an institution-wide `HOLIDAY` on the
  **same date** coexist (both partial-unique indexes allow it); `CalendarService.getEntries`
  with the department returns both with the department entry taking precedence in
  `effectiveDayType`; without the department it returns the institution-wide one; cross-tenant
  and cross-department scope respected.

### 10.5 Allowance-engine regression (do NOT break the live calendar read)

- A focused test seeding `AcademicCalendarDay` rows (institution-wide) and asserting
  `AllowanceEngine.getRemainingAllowance` computes working-day consumption **identically**
  before and after the Phase-1 migration shape (i.e. its `findMany` + `dayType` mapping is
  unaffected by the new nullable columns).
- A second assertion that is now a **real invariant** (because the §4.4 `departmentId: null`
  hardening is applied to the engine's query, not left optional): seed an institution-wide
  `HOLIDAY` and a department-scoped `WORKING_DAY` on the **same in-range date**, then assert
  `getRemainingAllowance` returns the **institution-wide** result deterministically — i.e.
  the department row is excluded by the engine's `departmentId: null` clause, so the outcome
  does not depend on Postgres row ordering. This directly pins the "keep the allowance-engine
  working" constraint and proves the department-scope generalization cannot perturb the live
  working-day computation. (Without the §4.4 clause this assertion would be flaky; with it,
  it is guaranteed by the `..._inst_date_institutionwide` partial unique index.)

### 10.6 Route/permission + audit tests (integration, mirroring `admin-config-calendar`)

- Admin can CRUD sessions/terms/programs/calendar; a role without `academics.sessions.manage`
  is `403`; a student with `academics.view` can read the current session but not mutate.
- Each mutation writes the expected `academics.*` audit event (re-read the persisted
  `audit_events` row, asserting `action`, `resourceType`, `resourceId`, `institutionId`,
  `result = SUCCESS`), matching the live audit-assertion style.
- Cross-tenant route check: an admin of A cannot read/mutate B's session via a guessed id
  (RLS + `withTenant` → not-found).

All new tests use Vitest; the real-DB escape tests reuse the existing two-connection harness.
Temporary artifacts (if any) are cleaned by the existing prefix-scoped teardown.

---

## 11. Error handling + validation (concrete, per operation)

| Operation | Failure condition | Recoverable? | Caller receives | Logged |
|---|---|---|---|---|
| Create session | `startDate >= endDate` | yes (user fixes input) | `400` + zod flatten | no (client error) |
| Create session | duplicate `name` for institution | yes | `409` "session name exists" | no |
| PATCH session | status != `UPCOMING` (ACTIVE/CLOSED) | yes | `409` "session not editable" | info |
| Add term | `startDate >= endDate` | yes | `400` + zod flatten | no |
| Activate session | session not `UPCOMING` | yes | `409` "invalid state" | info |
| Activate session | 0 terms | yes | `409` "session needs ≥1 term" | info |
| Activate session | a term has `startDate >= endDate` | yes | `409` "term has invalid dates" | info |
| Activate session | another `ACTIVE` exists, no handover | yes | `409` "active session exists; pass handover=true" | info |
| Activate session | partial-unique race (backstop) | yes (retry) | `409` mapped from unique violation | warn |
| Add term | duplicate `ordinal` in session | yes | `409` "ordinal exists" | no |
| Create program | `departmentId` not in tenant | yes | `400` "unknown department" (pre-check) / FK error mapped to `400` | info |
| Create program | duplicate `code` (incl. a retired/`INACTIVE` program's code — not reusable, finding 7) | yes | `409` "program code exists" | no |
| Calendar upsert/delete | unknown `departmentId`/session/term (cross-tenant) | yes | `400` composite-FK/validation error | info |
| Any write | tenant GUC unset / RLS denies (should never happen via `withTenant`) | no (bug) | `500` generic | error |
| Any read | DB connectivity (`P1001`) | yes (transient) | `500` "temporarily unavailable" | error |

**External-input validation rules** (new zod schemas in `packages/shared/src/validation.ts`,
mirroring the existing `upsertAcademicCalendarDaySchema`):

- `createAcademicSessionSchema`: `name` (string, 1–100), `structureType` (enum),
  `startDate`/`endDate` (ISO date strings, required), refine `start < end`.
- `createAcademicTermSchema`: `name` (1–100), `ordinal` (int ≥1), `startDate`/`endDate`
  (required), `academicSessionId` (string, required).
- `createProgramSchema`: `departmentId` (required), `name` (1–200), `code` (1–32),
  `duration` (int 1–20), `durationUnit` (enum, default `TERMS`).
- `upsertAcademicCalendarDaySchema`: **extended** with optional `departmentId`,
  `academicSessionId`, `academicTermId` (all strings, optional) — additive, so the live
  callers remain valid.

Validation happens at the route (zod `safeParse` → `400` on failure, exactly as the live
handlers do); invariant enforcement (state transitions, one-active) happens in the service
inside the transaction; structural invariants (uniqueness, same-tenant FK) are owned by the
DB. This three-layer split matches `tenancy.md` §6.3 and the module-system ownership table.

---

## 12. Invariant ownership summary

| Invariant | Owner layer | Why |
|---|---|---|
| At most one `ACTIVE` session per institution | **Database** (partial unique index) | Only the DB enforces it under concurrency; service gives the friendly error |
| Unique term `ordinal` within a session | **Database** (`@@unique([academicSessionId, ordinal])`) | Structural uniqueness |
| One institution-wide + N dept calendar entries per date | **Database** (two partial unique indexes) | NULL-distinctness requires partial indexes, not a plain unique |
| A term/program/calendar link stays in one tenant | **Database** (composite FKs incl. `institutionId`) | The exact hole tenancy.md §4 closes |
| A tenant reads/writes only its own academic rows | **Database** (RLS FORCE + fail-closed policies) + tenant-scoped client | Two-layer isolation (tenancy.md §6.3) |
| Legal lifecycle transitions only (UPCOMING→ACTIVE→CLOSED; ≥1 term before active) | **Service** (`academic-session.ts`) | Multi-row business logic SQL can't express; runs in the tenant tx |
| Preserve-history: sessions/terms advance by status only (no destructive rewrite) | **Service + schema** (status-only transitions; `ON DELETE RESTRICT` on all session/term FKs) | A promotion creates new rows; it structurally cannot rewrite or delete historical ones |
| Preserve-history: calendar revisions are immutable (append-only) | **Database** (INSERT-only RLS policy, `REVOKE UPDATE/DELETE` from `campass_app`, `BEFORE UPDATE OR DELETE` trigger on every role) | Same append-only machinery as `audit_events`; a revision can never be rewritten or erased, even by a privileged/buggy caller — immutability by construction, not convention |
| Who may do what (admin manages; all roles view) | **API/route layer** (`requirePermission` guards) | Action-level authz (identity-rbac.md §6) |

---

## 13. Testability notes

- **Unit-testable (no DB):** the term-count soft-validation (`structureType` → suggested
  count), the calendar precedence rule in `CalendarService.effectiveDayType` (pure over an
  in-memory entry list), and the session state-machine transition predicates (pure functions
  over a state + request, mirroring `module-system.ts`'s pure `missingDependencies`).
- **Integration (real DB):** RLS/escape coverage, the partial-unique one-active invariant,
  composite-FK same-tenant enforcement, the revision-write atomicity, and the allowance-engine
  regression — all need Postgres and reuse the existing harness.
- The state machine and precedence logic are deliberately factored as **pure functions** taking
  the fetched rows (not issuing their own queries) so they are unit-testable without the
  pooler, exactly as `module-system.ts` separates `missingDependencies`/`affectedDependents`
  from the DB-touching `activate`/`suspend`. A design that forced DB round-trips inside the
  predicate would be harder to test — this split is chosen to keep them cheap to test.

---

## 14. Assumptions flagged for design review

- **A1** — `academic_sessions` is left in `MODULE_DEPENDENCIES` as a dependency-graph
  placeholder that maps to always-present foundational data; Phase 1 adds no module
  row/guard/graph edit for academics (§1.3). Alternative (remove the key) rejected as a
  FROZEN-contract change for no Phase-1 benefit.
- **A2 (resolved — hardening now required, not optional).** The allowance-engine keeps its
  own direct `academicCalendarDay.findMany` (not refactored onto `CalendarService`), but the
  query **gains a required `departmentId: null` clause** (§4.4) so it reads institution-wide
  rows only. This is additive and behavior-preserving on all existing data (every current
  row has `departmentId IS NULL`) and makes the §10.5 "unchanged" result a deterministic
  invariant backed by the institution-wide partial unique index — not an ordering accident.
  (Design-review finding 3 addressed: the earlier "mitigated by the date-keyed map" claim
  was order-undefined; it is now structurally guaranteed.)
- **A3** — `admin.academic_calendar.manage` is retained in the catalogue (route-unused)
  rather than deleted; the generalized calendar routes move to `academics.calendar.manage`.
  Deleting the old key is clean but higher-touch (seed + both catalogue-sync dirs + shim) and
  is deferred unless required (§7.3).
- **A4** — no `StudentProfile` FK (even nullable) is added in Phase 1; forward-compat is paid
  on the parent side via the `(id, institutionId)` composite uniques on `Program`/
  `AcademicSession`, and SIS adds the child-side composite FK when built (§3.4).
- **A5** — promotion/session-transition that touches student records is modelled only (the
  seam in §6.3); Phase 1 executes none of it and does not touch `StudentProfile`.

---

## 15. Responses to design-review findings (revision 2)

This revision resolves every finding in `design-review.json`
(`verdict: CHANGES_REQUESTED`; 2 HIGH, 5 MEDIUM, 3 NIT). Each is **addressed** (no finding
backlogged or ignored); all changes stay inside the original requirements (additive,
app-keeps-working, no FROZEN edits, no Phase-2 build). Live source was re-verified for the
two HIGH findings before editing.

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | HIGH | `request.auth.departmentScope` read in §5.5 but not surfaced by the live `authenticate`/`RequestAuth` | **Addressed.** Verified against `apps/api/src/middleware/auth.ts`: `RequestAuth` has no `departmentScope` and the membership `select` omits it. Added an explicit, minimal, additive Phase-0 auth sub-task (§5.5 + §2 scope): add `departmentScope: string \| null` to `RequestAuth`, add `departmentScope: true` to the tenant-actor membership `select`, set it in both `request.auth` branches (`null` for SUPER_ADMIN). Read-only, no token change (re-read per request), no authz/tenancy impact; regression-tested in §10.6. Chose the auth-extension option over dropping department reads because department-scoped entries are a core deliverable. |
| 2 | HIGH | Revision table claimed "immutable by construction" but given the default FOR-ALL modify RLS pair (permits UPDATE/DELETE); not mirroring the `audit_events` append-only precedent | **Addressed (option b — genuine append-only).** Verified `audit_events` in `superadmin_security/migration.sql` + `tenant-escape-setup.ts`. Reworked §4.3/§6.4/§8/§10.1/§12 so `academic_calendar_day_revisions` gets: INSERT-only RLS (`tenant_isolation_select` + `academic_calendar_day_revisions_tenant_insert`, **no** modify policy), `REVOKE UPDATE, DELETE` from `campass_app`, and a `BEFORE UPDATE OR DELETE` trigger on every role — byte-for-byte the `audit_events` machinery. Registered in `EXPECTED_POLICIES`, not the default pair. "By construction" is now literally true at the DB layer. |
| 3 | MEDIUM | Allowance-engine double-count "mitigated" claim rests on undefined row ordering (`findMany` has no `orderBy`) | **Addressed.** Verified the engine's `findMany` has no `orderBy`. Promoted the `departmentId: null` clause from optional to **required** (§4.4, §10.5, A2): the engine now reads institution-wide rows only. Additive, behavior-preserving on all existing data (every current row is `departmentId IS NULL`), and deterministic via the `..._inst_date_institutionwide` partial unique index — the §10.5 assertion is now a real invariant. |
| 4 | MEDIUM | PATCH-session rule self-contradictory ("editable via exception" vs "forbidden, 409") | **Addressed.** §5.1 now states one rule: PATCH allowed **only while `UPCOMING`**; any field edit on `ACTIVE`/`CLOSED` → `409 "session not editable"`; no exception path in Phase 1. Removed the "documented exception" clause; added the row to the §11 error table. |
| 5 | MEDIUM | Term date containment/overlap vs activation under-specified | **Addressed.** §5.1 + §5.2 now decide explicitly: hard rule `startDate < endDate` per term (blocked at term-add `400` and re-checked at activation `409`); term-vs-session containment and term time-overlap are **allowed-but-warned** (soft `warnings`), never blocked — consistent with the configurable philosophy. Recorded the downstream assumption that attendance/exams must not assume non-overlapping terms. Reflected in §11. |
| 6 | MEDIUM | Migration miscounts (four vs five enums; three vs four tables) | **Addressed.** §8 step 1 → "**five** new enums"; step 7 → "**four new** tenant-owned tables"; §0 clarified as "four tables across three entity groups." |
| 7 | MEDIUM | Program status/department coupling + code-reuse unspecified | **Addressed.** §5.3 now states: (a) `code` uniqueness spans all statuses — a retired code is **not** reusable (partial-unique-for-reuse explicitly deferred); (b) a program may attach to any in-tenant department (no `Department` status exists in Phase 1 — verified); (c) retiring a program cascades to nothing. Code-reuse rule added to §11. |
| 8 | NIT | `AcademicSession.name` comment "not unique on its own" conflicts with `@@unique` | **Addressed.** §3.2 comment reworded to "unique per institution, see `@@unique` below; not globally unique." |
| 9 | NIT | Seed "code 512's department" opaque | **Addressed.** §9 now names the exact demo departments from `packages/db/src/seed.ts`: `BCA` under "Bachelor of Computer Applications (BCA)" (code `512`, the seed's `bca` object) and `BTECH-CSE` under "B.Tech (Computer Science & Engineering)" (code `501`). |
| 10 | NIT | Audit-key shape described as "3-segment" but regex allows 2+ | **Addressed.** §7.4 reworded: "dot-separated lower-snake keys with two or more segments (regex `^[a-z_]+(\.[a-z_]+)+$`, e.g. the 2-segment `platform.onboarding`); the new keys use the 3-segment form." |

**Net code-surface change from this revision:** two live Phase-0 files now receive small
additive edits that the first draft had under-scoped — `apps/api/src/middleware/auth.ts`
(surface `departmentScope`, finding 1) and `apps/api/src/services/allowance-engine.ts`
(add `departmentId: null` to one `findMany`, finding 3). Both are strictly additive and
behavior-preserving on existing data, both are regression-tested, and neither alters
tenancy/RBAC/audit/module-system semantics. All other resolutions are schema/migration/test
specification changes with no new live-code footprint beyond what the first draft already
planned.
