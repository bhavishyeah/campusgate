# CAMPASS Phase 2 — Student Information System (SIS) — Design

> The authoritative student record every academic module reuses, built on the LIVE
> Phase 0 foundation (tenancy RLS, identity/RBAC, Super-Admin security, module system)
> and Phase 1 (academic sessions/terms, programs, generalized calendar). The delicate
> core of this phase is **generalizing the existing, live `StudentProfile` table**
> (model `StudentProfile` → table `student_profiles`) — which holds real production data
> and is actively used by GatePass, allowance, and reliability — onto the Phase 1
> structures **additively, without breaking any consumer and without losing data**.
> On `main`, NO worktree. The six FROZEN Phase-0 migrations and the FROZEN
> `20261027111710_phase1_academics` migration are untouched; a single NEW migration
> (`phase2_sis`) is added. The app must keep working at every step — in particular
> GatePass's `studentId → student_profiles.id` FK and the allowance/reliability engines'
> reads of `StudentProfile.id`, `program`, and `semester` must not break.

Source of truth followed: `docs/roadmap.md` (Phase 2 + the phase-completion gate),
`docs/architecture.md` (§2 layers, §5 module model, §7 per-module DoD),
`docs/tenancy.md` (§4 composite FKs, §5 RLS, §8 checklist), `docs/identity-rbac.md`
(§6 catalogue convention), `docs/superadmin-security.md` (§6 AuditLog v2),
`docs/database.md` (§4 migration rule + FROZEN list + checksum-drift note). Patterns
mirrored verbatim from the Phase-1 precedent (`.agents/tasks/phase1-academics/design.md`,
`context.json`, `features/FEAT-001.json`) and the live `superadmin_security` /
`module_system` / `phase1_academics` migrations.

---

## 0. Overview

Phase 2 does **one** structurally delicate thing and a set of operations around it:

1. **Generalize the live `student_profiles` table in place** (ALTER, never recreate) into
   the authoritative student record. New columns are **all nullable or defaulted** so
   every existing row (e.g. `bhavishya@demo.edu`) stays valid and every live query keeps
   working byte-for-byte:
   - a configurable **`StudentStatus`** enum (`APPLICANT | ENROLLED | ACTIVE | ON_LEAVE |
     GRADUATED | WITHDRAWN | SUSPENDED`) with existing rows backfilled to `ACTIVE`;
   - **forward-compatible, additive-nullable Phase-1 links**: `programId` (→ `Program`,
     composite FK incl. `institutionId`), `academicSessionId` (→ `AcademicSession`),
     `currentTermId` (→ `AcademicTerm`), all composite same-tenant FKs, all `ON DELETE
     SET NULL`;
   - the **retained** free-text `program: String` and `semester: Int` columns (NOT
     dropped — GatePass export, bulk-import, self-registration, and UI read them). The
     new structured FKs **coexist** with the old columns; §3.4 documents the coexistence
     contract and the eventual-deprecation seam;
   - `admissionDate: DateTime?`.
2. A new tenant-owned, **append-only** `StudentProfileHistory` table recording every
   status/program/term/department transition with who + when, immutable by construction
   at the DB layer (the `audit_events` / `academic_calendar_day_revisions` machinery:
   INSERT-only RLS, `REVOKE UPDATE, DELETE`, a `BEFORE UPDATE OR DELETE` trigger).
   `PRESERVE-HISTORY` is thereby structural, not conventional.
3. A **deferred-with-seam** `StudentDocument` reference table (§5) — modelled minimally
   as a decision, built now at minimal shape OR deferred; §5.6 chooses and justifies.
4. **Operations** on a dedicated `students.ts` route (plus the existing bulk-import on
   `admin.ts` folded into the new model): create, update (permitted-mutable-field rule),
   assign program, enroll, promote, transfer, deactivate/archive, search/filter
   (paginated, tenant-scoped), view history — all tenant-scoped via `withTenant`, all
   `students.*`-permission-gated, all audited; PII-aware audited export is the retained
   live `admin.ts` route under `admin.students.export` (§5.1), not re-homed here.
5. **Student self-service** on `student.ts`: own profile + current academic info +
   services from ACTIVE modules only, strictly own-record + tenant scoped.
6. The **GatePass / allowance / reliability non-breaking argument** (§9) and its
   regression test plan (§11.6).

**The headline design decisions**, resolved with justification below:

- **A. SIS is institution-layer FOUNDATIONAL data, NOT a gated module** (§1), exactly as
  Phase-1 academics. Student identity is the substrate every later module references; it
  is never wired to `requireModuleActive`. Routes are `requirePermission(...)`-gated only.
- **B. Generalize in place, additively** (§3). ALTER the live table; never recreate it;
  never drop `program`/`semester`; every new column nullable/defaulted; backfill
  `status = ACTIVE`. The live `student_profiles` RLS + grants from Phase 0 (B-1) are
  reused untouched.
- **C. NO-DUPLICATE-IDENTITY by construction** (§7). The live `enrollmentNo UNIQUE` and
  `userId UNIQUE` constraints are the DB-level backstop; every create/register/re-import
  path resolves against them so a duplicate identity is physically rejected, not merely
  checked in code.
- **D. PRESERVE-HISTORY by construction** (§6). Promote/transfer/deactivate are status
  transitions that write an immutable `StudentProfileHistory` row in the same transaction
  and NEVER hard-delete. The history table is append-only at the DB layer.

**Locked technology stack** (unchanged from the rest of the platform; locked once this
design is approved): TypeScript on Node (ESM, `.js` import specifiers); Fastify for the
API; Prisma **`6.19.3`** against Supabase Postgres (runtime via the `campass_app`
`NOSUPERUSER NOBYPASSRLS` pooled client on 6543; migrations/DDL + platform/pre-auth reads
via the privileged `postgres` client on `DIRECT_URL`); `@campusgate/shared` for the
permission/audit catalogues; Vitest for tests; versioned Prisma migrations with
hand-authored raw SQL for enums, RLS, composite FKs, partial unique indexes, the
append-only trigger pair, GRANT pins, and the catalogue seed. **Prisma is NOT upgraded**
to the 8.x RC the deploy log advertises. No new runtime dependency is introduced
(`StudentDocument` stores a reference/metadata only — §5.6 — never file bytes).

---

## 1. Decision A — SIS is institution-layer foundational data, NOT a gated module

### 1.1 The decision

The authoritative student record, its status/history, its document references, and all
SIS operations are **foundational institution-layer data (Layer B)**, available to every
tenant unconditionally. SIS routes are gated by `requirePermission(...)` **only** and are
**never** wired to `requireModuleActive(...)`. No `InstitutionModule` row, entitlement, or
activation gate is introduced for SIS; no `student_management`/`sis` module key is seeded
or required by Phase 2.

### 1.2 Why (architecture.md §5 + the layer model + the single-identity rule)

- `architecture.md` §2 **Layer B — Institution** lists the student identity substrate
  (`Student`) among the shared entities modules **reference**, not among Layer-C
  operational modules. §4 makes `Institution, Student, User/Membership` platform/
  institution-owned entities that modules reference by ID.
- `roadmap.md`'s **single-identity rule** is explicit: "there is one authoritative
  `Student` … reused by every later module. No module (attendance, library, fees, exams)
  creates its own copy." Gating the student record behind an activation toggle would mean
  an institution could "turn off" the identity that GatePass (already live) and every
  future module depend on — a regression, not a feature. The whole point of SIS is to be
  always-present.
- The Phase-1 precedent is identical and already shipped: academic sessions/programs/
  calendar are foundational, permission-gated, never module-gated (Phase-1 Decision A).
  SIS is the same class of data and takes the same decision for the same reasons.
- The per-module Definition of Done (`architecture.md` §7) still applies via the phase
  completion gate (roadmap.md): tenant isolation, authz, audit, preserve-history, and the
  escape-suite extension are all delivered below. "Not a gated module" removes only the
  entitlement/activation lifecycle, not the DoD obligations.

### 1.3 Interaction with the module dependency graph (explicit)

`packages/shared/src/modules.ts` lists dependency keys such that Attendance/Fees/Exams
depend on "Student Management". Mirroring Phase-1 Decision A §1.3: **Phase 2 does NOT seed
a `student_management` entitlement/activation row, does NOT add a
`requireModuleActive("student_management")` guard, and does NOT edit `modules.ts`.** The
dependency key (if present) maps to **foundational data that is always present** — a
dependency that is effectively always satisfiable. A future phase that wants
Attendance activation to *require* a student-management module state makes that decision
in its own design. Phase 2's contract is only: the student record and its routes exist
for every tenant, permission-gated, never module-gated. `modules.ts` is frozen for this
task (consistent with the Phase-1 context.json "Do NOT edit modules.ts").

---

## 2. Scope boundaries (what this phase does and does not build)

**In scope:** the in-place generalization of `student_profiles` (§3), the
`StudentProfileHistory` append-only table (§6), the `StudentDocument` minimal reference
table (§5.6 decision: build-minimal), the dedicated `students.ts` route with create/
update/assign-program/enroll/promote/transfer/deactivate/search/history (§5; export stays
on the live `admin.ts` route — §5.1), the
fold-in of the existing `/students/bulk-import` and `/register` onto the new model
preserving no-duplicate-identity (§7), the self-service additions on `student.ts` (§8),
the `students.*` permission keys + role bindings + `students.*` audit keys +
catalogue-sync union update (§7/§10), the `phase2_sis` migration with RLS/FK/partial-
unique/append-only DDL + the checksum-drift workaround (§10), the seed extension (§12),
the GatePass/allowance/reliability non-breaking argument (§9), and the test plan (§11).

**Explicitly out of scope (modelled, not executed):**

- **Phase 3+ entities** (Course, Subject, ClassSection, ClassEnrollment, Timetable,
  attendance, exams). §13 records the Phase-3 reference seams SIS leaves behind (the
  `(id, institutionId)` composite unique on `student_profiles`, the program/session/term
  parents) but builds none of Phase 3.
- **Dropping `program`/`semester`.** They are retained (§3.4). The deprecation is a
  future, separate, reviewed workstream (§3.4 seam), not part of Phase 2.
- **Admissions (Phase 6).** The `APPLICANT` status value exists in the enum so Admissions
  can later feed SIS without an enum migration, but Phase 2 does not build any admission
  workflow and does not create applicant rows.
- **Document file storage.** `StudentDocument` models a reference (metadata + ownership +
  external storage key) only; it never stores bytes and introduces no object-storage
  dependency (§5.6).
- **Emergency-contact fields.** The roadmap scope lists "emergency contact (**only if
  collected**)". The live `student_profiles` table collects no emergency-contact field, and
  no live consumer requires one, so Phase 2 **does not add** an emergency-contact column —
  the conditional "only if collected" is not met. Adding it later is a trivial additive-
  nullable column (the same generalization pattern §3 uses) in a future phase that actually
  collects it; it is called out here so its omission is a deliberate decision, not an
  oversight.
- **A gated-module lifecycle** for SIS (Decision A).
- **Multi-institution-per-user UX / self-service role management** (deferred in Phase 0,
  unchanged here).

---

## 3. Decision B — generalize `student_profiles` in place (additive)

### 3.1 The live table (verified, unchanged shape)

```prisma
model StudentProfile {
  id            String      @id @default(cuid())
  userId        String      @unique                      // -> User
  institutionId String                                   // added B-1, RLS applies
  enrollmentNo  String      @unique                      // headline identity key
  rollNumber    String?
  name          String
  departmentId  String                                   // -> Department (composite FK B-1)
  program       String                                   // FREE-TEXT, retained
  semester      Int                                      // retained
  section       String?
  dob           String?
  phone         String?
  address       String?
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt
  gatePasses           GatePass[]
  reliabilitySnapshots ReliabilityScoreSnapshot[]
  @@unique([id, institutionId])                          // referenceable with institutionId
  @@index([institutionId])
  @@map("student_profiles")
}
```

Verified live facts this design relies on: `enrollmentNo` is `@unique` (globally);
`userId` is `@unique`; `@@unique([id, institutionId])` already exists (Phase 0 B-1, used
by `gate_passes_student_same_tenant_fkey` and
`reliability_score_snapshots_student_same_tenant_fkey`); RLS is ENABLE+FORCE'd on
`student_profiles` with the standard pair from the FROZEN
`20261018110658_tenancy_isolation_rls` migration; `campass_app` already holds full DML on
the table via the B-1 grant. GatePass + allowance + reliability reference
`studentId → student_profiles.id` (never `enrollmentNo`), and read `name`, `enrollmentNo`,
`program`, `semester` for display/logic.

### 3.2 New enum (added to schema + created as a pg enum in the migration)

```prisma
enum StudentStatus {
  APPLICANT    // pre-enrollment (Admissions Phase 6 feeds this; not created in Phase 2)
  ENROLLED     // admitted + enrolled into a session/term, not yet marked active
  ACTIVE       // the default for all existing live rows (backfill); normal in-progress student
  ON_LEAVE     // temporary authorized leave; still a current student
  GRADUATED    // completed; historical, read-only lifecycle
  WITHDRAWN    // left before completion
  SUSPENDED    // disciplinary/administrative hold
}
```

These are **lifecycle states, not hardcoded business rules**: the schema does not encode
"a WITHDRAWN student cannot do X" — that is policy the service layer applies (§5). The one
structural rule the enum carries is the backfill default (`ACTIVE`) and the transition
audit (§6). The value set is a reasonable configurable default; institutions that need a
narrower policy enforce it at the service layer, not by removing enum values.

### 3.3 Generalized model (new fields, all additive-nullable/defaulted)

```prisma
model StudentProfile {
  // ... all existing fields UNCHANGED (id, userId, institutionId, enrollmentNo,
  //     rollNumber, name, departmentId, program, semester, section, dob, phone,
  //     address, createdAt, updatedAt) ...

  status            StudentStatus    @default(ACTIVE)      // NOT NULL w/ default; backfilled ACTIVE
  admissionDate     DateTime?                              // nullable

  // Forward-compatible Phase-1 links — additive, nullable, composite-FK same-tenant:
  programId         String?                                // -> Program.id (structured)
  structuredProgram Program?         @relation(fields: [programId], references: [id])
  academicSessionId String?                                // -> AcademicSession.id
  academicSession   AcademicSession? @relation(fields: [academicSessionId], references: [id])
  currentTermId     String?                                // -> AcademicTerm.id (current term)
  currentTerm       AcademicTerm?    @relation(fields: [currentTermId], references: [id])

  history           StudentProfileHistory[]
  documents         StudentDocument[]

  // existing @@unique([id, institutionId]), @@index([institutionId]), @@map stay.
  @@index([institutionId, status])                         // new: paginated status filter
  @@index([institutionId, programId])                      // new: program filter
}
```

**Why the relation field is named `structuredProgram`, not `program`.** The live table
already has a scalar field named `program` (the free-text string). Prisma forbids two
fields with the same name, so the new `Program` relation is named `structuredProgram`
(scalar FK column `programId`). The **database column** for the string stays `program`
(unchanged); the new FK column is `programId`. This keeps the old column's name and every
existing query stable while adding the structured link under a distinct name. (Decision:
`structuredProgram` over alternatives like `programRef` for readability; locked here.)

### 3.4 Coexistence of the old columns + the deprecation seam (the delicate contract)

**Decision: keep `program: String` and `semester: Int` exactly as they are; add the
structured links alongside; populate the links best-effort; never drop the old columns in
Phase 2.** Rationale and the coexistence rules, stated so the implementer has no
architectural choice to make:

- **Why retain.** The free-text `program` and int `semester` are read by live code that
  Phase 2 does not rewrite: the admin CSV/XLSX export (`admin.ts` builds rows from
  `studentProfile.program`-adjacent fields and `department.code`), the bulk-import and
  self-register create paths, and the web UI. Dropping or renaming them is a breaking
  change to live consumers and would risk data loss on a table with real rows — forbidden
  by the migration rule and the task. They stay.
- **Source of truth during Phase 2.** The free-text `program`/`semester` remain the
  **display/operational source of truth** for GatePass and existing UI. The structured
  `programId`/`academicSessionId`/`currentTermId` are **additive metadata** that new SIS
  operations populate and that Phase 3+ will reference. The two are not auto-synced by a
  trigger (a trigger would couple a free-text string to a structured FK with no reliable
  mapping); instead the SIS operations that set structured links (`assign program`,
  `enroll`, `promote`, `transfer` — §5) also keep the free-text fields coherent
  **best-effort** (e.g. `assign program` sets `programId` and may set `program =
  program.name` when the admin opts in), and the bulk-import best-effort resolves
  `programId` from the free-text/`courseCode` without ever failing the import if it
  cannot (§7.3).
- **Best-effort link population (never fatal).** On create/import/enroll, the service
  attempts to resolve `programId` from an in-tenant `Program` whose `code` or `name`
  matches the provided program text; on no match it leaves `programId = null` and the row
  is still valid (the column is nullable). A null structured link is an expected,
  non-error state throughout Phase 2 — nothing requires it to be non-null until a Phase-3
  operation that needs it, which will validate at its own point of use.
- **The deprecation seam (future, not Phase 2).** When every live consumer has migrated
  to the structured links, a future reviewed migration may (a) backfill `programId`/
  `academicSessionId` for all rows, (b) switch reads off `program`/`semester`, and only
  then (c) drop the free-text columns. Phase 2 makes that future cheap by: keeping the
  structured parents referenceable with `(id, institutionId)` composite uniques (already
  true from Phase 1), writing a `StudentProfileHistory` row on every structured-link
  change (so the migration has an audit trail), and never letting new code read
  `program`/`semester` where a structured link is available (new SIS read endpoints
  surface both, preferring the structured value when present — §8). **This seam is
  documented, not executed**; dropping columns is explicitly out of scope (§2).

### 3.5 Composite same-tenant FKs for the new links (migration-authored)

Prisma models the single-column FK; the migration **drops it and re-adds the composite**
including `institutionId`, exactly as tenancy.md §4 and the Phase-1 precedent prescribe.
All three new links are **informational** (a closed session / retired program being
referenced must not block), so all are `ON DELETE SET NULL`:

```sql
-- programId -> programs(institutionId, id)
ALTER TABLE "student_profiles" DROP CONSTRAINT "student_profiles_programId_fkey";
ALTER TABLE "student_profiles"
  ADD CONSTRAINT "student_profiles_program_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "programId")
  REFERENCES "programs" ("institutionId", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- academicSessionId -> academic_sessions(institutionId, id)
ALTER TABLE "student_profiles" DROP CONSTRAINT "student_profiles_academicSessionId_fkey";
ALTER TABLE "student_profiles"
  ADD CONSTRAINT "student_profiles_session_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "academicSessionId")
  REFERENCES "academic_sessions" ("institutionId", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- currentTermId -> academic_terms(institutionId, id)
ALTER TABLE "student_profiles" DROP CONSTRAINT "student_profiles_currentTermId_fkey";
ALTER TABLE "student_profiles"
  ADD CONSTRAINT "student_profiles_term_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "currentTermId")
  REFERENCES "academic_terms" ("institutionId", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;
```

`programs`, `academic_sessions`, `academic_terms` all carry `@@unique([id, institutionId])`
from Phase 1 (verified in FEAT-001 findings), so they are referenceable with
`institutionId` — no change to any FROZEN Phase-1 object. A nullable composite FK still
enforces same-tenant when the value is non-null and permits null — so an unlinked student
is legal and a linked student can never point at another tenant's program/session/term.

### 3.6 The live RLS + grant on `student_profiles` is reused untouched

`student_profiles` already has `ENABLE + FORCE` RLS and the standard
`tenant_isolation_select` + `tenant_isolation_modify` pair from the FROZEN B-1 migration,
and `campass_app` already holds full `SELECT, INSERT, UPDATE, DELETE`. The `phase2_sis`
migration **only adds columns, FKs, and indexes** to this table — it does **not** touch
its RLS or re-grant it. The new columns automatically fall under the existing policies
(RLS filters by `institutionId`, which is unchanged). This is the same "additive to a
FROZEN-migration table" approach Phase 1 used for `academic_calendar_days`.

---

## 4. Decision — `StudentProfileHistory` (new, tenant-owned, append-only)

### 4.1 Model

Every status/program/term/department transition writes an immutable history row. This is
the structural mechanism behind PRESERVE-HISTORY (§6) — promote/transfer/deactivate are
non-destructive **because** they only flip the live row's fields and append a history row
that can never be rewritten.

```prisma
enum StudentHistoryChangeType {
  CREATED          // row created (import/register/admin create)
  STATUS_CHANGED   // status transition
  PROGRAM_CHANGED  // programId and/or free-text program changed
  ENROLLED         // session/term assigned (enroll)
  PROMOTED         // term/semester advanced
  TRANSFERRED      // department and/or program changed
  DEACTIVATED      // archived via status (WITHDRAWN/SUSPENDED/GRADUATED)
  UPDATED          // permitted-field profile edit (non-lifecycle)
}

model StudentProfileHistory {
  id               String                   @id @default(cuid())
  institutionId    String
  institution      Institution              @relation(fields: [institutionId], references: [id])
  studentProfileId String                                   // the row changed (live FK, RESTRICT)
  studentProfile   StudentProfile           @relation(fields: [studentProfileId], references: [id])
  changeType       StudentHistoryChangeType

  // Snapshots of the fields that may change (previous + new; null where N/A):
  previousStatus       StudentStatus?
  newStatus            StudentStatus?
  previousProgramId    String?                               // snapshot (no FK — may outlive program)
  newProgramId         String?
  previousProgramText  String?                               // snapshot of free-text program
  newProgramText       String?
  previousSemester     Int?
  newSemester          Int?
  previousDepartmentId String?
  newDepartmentId      String?
  previousSessionId    String?
  newSessionId         String?
  previousTermId       String?
  newTermId            String?

  actorUserId      String                                    // who (snapshot, no FK)
  actorMembershipId String?
  reason           String?                                   // optional free-text reason
  metadata         Json?                                     // minimal; NO indiscriminate PII
  createdAt        DateTime                 @default(now())   // when (server-controlled)

  @@unique([id, institutionId])
  @@index([institutionId])
  @@index([institutionId, studentProfileId])
  @@index([studentProfileId])
  @@map("student_profile_history")
}
```

- **`studentProfileId` carries a real composite FK to `student_profiles(institutionId,
  id)`** (`ON DELETE RESTRICT`, migration-authored) — because a student is **never hard
  deleted** (§6), a history row's parent always exists, so the live FK is safe and
  desirable (it lets the DB enforce same-tenant history). This differs from the Phase-1
  calendar-revision table's deliberately-omitted FK, which was omitted precisely because
  calendar rows *can* be deleted; student rows cannot, so the FK stays.
- **All the `previous*`/`new*`/`actor*` fields are plain snapshot columns** (no FKs to
  programs/sessions/terms/users) — they are immutable history values that must survive
  even if a referenced program is later retired or re-coded. This mirrors how
  `audit_events` keeps `actorUserId` as a single-column snapshot.
- Tenant-root FK `institutionId → institutions(id)` (`ON DELETE RESTRICT`), composite
  unique `(id, institutionId)`.

### 4.2 Append-only by construction (DB-enforced, mirrors `audit_events`)

The history table is made immutable the same way `audit_events` and
`academic_calendar_day_revisions` are — this is the structural PRESERVE-HISTORY guarantee:

- RLS gets the **append-only pair**, NOT the default pair: `tenant_isolation_select`
  (FOR SELECT, `nullif`-guarded) + `student_profile_history_tenant_insert` (FOR INSERT
  WITH CHECK, `nullif`-guarded). There is **no** `tenant_isolation_modify` / FOR ALL
  policy.
- `campass_app` is granted `SELECT, INSERT` only; `UPDATE, DELETE` are `REVOKE`d from it.
- A `BEFORE UPDATE OR DELETE` trigger `student_profile_history_no_update_delete`
  (function `student_profile_history_append_only()` raising `restrict_violation`, identical
  in shape to `audit_events_append_only`) binds **every** role, including the table owner
  / privileged path that GRANTs alone cannot restrict.
- Because the table is append-only at the DB layer, it is **registered in
  `EXPECTED_POLICIES` in `tenant-escape-setup.ts` as an append-only table** (as
  `audit_events` and `academic_calendar_day_revisions` are), NOT in the default-pair set
  (§10 step 7, §11.1).

A history row is written **inside the same `withTenant` transaction** as the live-row
mutation (atomic: a transition and its history row commit together or not at all). The
INSERT-only policy + trigger make the SIS operation the **only** way a row enters the
table, and once in it can never change — immutability is a property of the schema, not of
the service.

---

## 5. Decision — operations + the dedicated `students.ts` route

### 5.1 Routing & shape

A new route file `apps/api/src/routes/students.ts` (exported `studentAdminRoutes`,
registered under a `/students` prefix in the API's route registration, mirroring the
`admin.ts` / `student.ts` split). It follows the exact house pattern:

- a single top-level `app.addHook("preHandler", authenticate)` (auth runs once per
  request; verified pattern in `student.ts`);
- each route carries `preHandler: [requirePermission("students.<x>")]` — **permission-
  gated only, NO `requireModuleActive`** (Decision A);
- every read/write runs inside `withTenant(institutionId, async (tx) => { ... })`, where
  `institutionId` comes from `request.user` / `request.auth` (the verified token), never
  from body/param;
- every mutation calls `recordAuditEvent(input, tx)` **inside** the same transaction with
  a `students.*` action key (§7.4);
- lifecycle mutations also append a `StudentProfileHistory` row **inside** the same
  transaction (§6).

The existing `/students/bulk-import` and `/students/export` handlers on `admin.ts` stay
where they are (bulk-import folded onto the new model — §7.3) to avoid churning their live
callers; the new per-student operations live on `students.ts`. (Decision: keep bulk-import
on `admin.ts` rather than move it — moving a live route's path is a client-breaking change
for no Phase-2 benefit; a new route file hosts only the new operations. Justified over
"move everything to students.ts", which was rejected as unnecessary churn.)

**Export permission — decision (resolves an ambiguity).** The live
`GET /students/export` on `admin.ts` is already permission-gated by the existing
`admin.students.export` key (verified in `admin.ts` + `permissions.ts`) and is already PII-
bearing and audited. Phase 2 **keeps export on `admin.ts` under `admin.students.export`
unchanged** and does **NOT** introduce a new `students.export` permission key — a second
export key gating nothing (or forcing the live route's key to change) would be redundant
churn on a live, authorized, audited path. The "export (authorized)" roadmap operation is
therefore satisfied by the existing route + key; Phase 2's folded-in model only makes the
new structured columns additionally available to a future export enhancement (not built
here). Consequently the `students.*` permission set below has **six** keys, not seven, and
`students.export` does not appear. Any export-side audit continues to use the live
`admin.students.exported`-class path on `admin.ts` (unchanged).

### 5.2 Create / update (permitted-mutable-field rule)

- `POST /students` — create a student (admin). `requirePermission("students.create")`.
  Body (zod, in `packages/shared/src/validation.ts` — new `createStudentSchema`):
  `email, name, enrollmentNo, departmentId, program (free-text, required for coexistence),
  semester, section?, rollNumber?, dob?, phone?, address?, admissionDate?, programId?`.
  Behavior: inside `withTenant`, (a) reject if `enrollmentNo` already exists in-tenant
  (friendly `409`; the DB `enrollmentNo UNIQUE` is the backstop — §7.1); (b) reject if
  `email` already a user (`409`); (c) create the `User` (role `STUDENT`, `ACTIVE`) + the
  `StudentProfile` (status defaults `ACTIVE`, or `ENROLLED` if a session/term is supplied)
  in one transaction; (d) best-effort resolve `programId` (§3.4); (e) write a
  `StudentProfileHistory` row `changeType = CREATED`; (f) audit `students.student.created`.
- `PATCH /students/:id` — update **permitted mutable fields only**.
  `requirePermission("students.update")`. **The permitted-mutable-field rule is enforced by
  construction**: the handler accepts a zod schema (`updateStudentSchema`) whose keys are
  exactly the mutable set — `{ name?, rollNumber?, section?, dob?, phone?, address?,
  admissionDate? }` — and passes **only** those parsed keys to `tx.studentProfile.update`.
  Identity and lifecycle fields are **not** in the schema and therefore cannot be set by
  this route: `enrollmentNo`, `userId`, `institutionId`, `status`, `programId`,
  `academicSessionId`, `currentTermId`, `semester`, `departmentId`, `program` are each
  changed only by their dedicated lifecycle operation (assign-program/enroll/promote/
  transfer/deactivate). An attempt to send a non-permitted key is ignored by zod stripping
  (default) — and to make the rule explicit rather than silent, the schema uses
  `.strict()` so an unknown/forbidden key yields `400 "field not editable"`. A
  profile-field edit writes a `StudentProfileHistory` row `changeType = UPDATED` and audits
  `students.student.updated`.

### 5.3 Assign program / enroll / promote / transfer

Each is a **status/field transition** owned by a small service
`apps/api/src/services/student-sis.ts` (pure transition functions taking a
`Prisma.TransactionClient`, DB-free-unit-testable, mirroring `module-system.ts` /
`academic-session.ts`), called from thin route handlers inside `withTenant`. Every one
writes a history row + audit event in-tx.

- `POST /students/:id/assign-program` — set `programId` (+ optionally refresh free-text
  `program`). `requirePermission("students.update")`. Validates the `Program` exists
  in-tenant and is `ACTIVE` (friendly `400` otherwise; composite FK is the backstop).
  History `PROGRAM_CHANGED`; audit `students.student.program_assigned`.
- `POST /students/:id/enroll` — enroll into a session/term: set `academicSessionId` +
  `currentTermId`, set `status = ENROLLED` (or `ACTIVE` if body `{ activate: true }`),
  optionally set `semester` from the term's ordinal. `requirePermission("students.enroll")`.
  Validates the session is in-tenant and (soft-warn) `ACTIVE`; validates the term belongs
  to that session. History `ENROLLED`; audit `students.student.enrolled`.
- `POST /students/:id/promote` — advance to a target term (and/or increment `semester`),
  set `status = ACTIVE`. `requirePermission("students.promote")`. **Non-destructive by
  construction**: it only updates the *live* row's `currentTermId`/`semester`/`status` and
  appends a `PROMOTED` history row capturing the previous term/semester; it NEVER rewrites
  or deletes any prior history row, and (per the Phase-1 promotion seam §6.3) it creates
  NO cross-session rewrite — future enrollment rows (Phase 3) are new rows in the target
  session. History `PROMOTED`; audit `students.student.promoted`.
- `POST /students/:id/transfer` — change `departmentId` and/or `programId`.
  `requirePermission("students.update")` (+ optionally a dedicated `students.transfer` —
  see §7.1 decision). Validates new department/program in-tenant. History `TRANSFERRED`
  capturing previous+new department/program; audit `students.student.transferred`.

### 5.4 Deactivate / archive (NEVER hard delete)

- `POST /students/:id/deactivate` — set `status` to a terminal/hold value
  (`WITHDRAWN | SUSPENDED | GRADUATED | ON_LEAVE`, body-specified, validated against the
  enum). `requirePermission("students.deactivate")`. **There is no DELETE route for a
  student** — archival is always a status flip. The live row, its `gatePasses`,
  `reliabilitySnapshots`, and `history` are all preserved (the composite FKs are
  `ON DELETE RESTRICT`, so even an attempted delete would be refused by the DB). History
  `DEACTIVATED` capturing previous+new status; audit `students.student.deactivated`.
  A reactivate path (`→ ACTIVE`) is the same operation with an `ACTIVE` target under
  `students.update`; it also writes history + audit.

### 5.5 Search / filter / view history

- `GET /students?status=&programId=&departmentId=&q=&page=&pageSize=` — paginated,
  tenant-scoped list. `requirePermission("students.view")`. `q` matches `name` /
  `enrollmentNo` / `rollNumber` (case-insensitive `contains`). Pagination is
  offset/limit with a hard `pageSize` cap (e.g. ≤ 100) and a stable `orderBy
  [{ createdAt: "asc" }, { id: "asc" }]`. The query runs inside `withTenant`, so RLS
  guarantees tenant scope even if a `where` clause were buggy (the deliberately-buggy-query
  escape test covers this — §11.1). HOD callers are additionally narrowed to their
  `departmentScope` (§5.7).
- `GET /students/:id` — detail (profile + structured links resolved + current status).
  `requirePermission("students.view")`, department-scoped for HOD.
- `GET /students/:id/history` — the append-only `StudentProfileHistory` for that student,
  newest first, paginated. `requirePermission("students.view")`.

### 5.6 `StudentDocument` — DECISION: build minimal reference table now

**Decision: build a minimal reference table now (not defer).** The task permits either;
building minimal is chosen because (a) the model is tiny and follows an established
tenant-owned pattern, so it does not bloat scope, and (b) it lets the single-identity rule
hold for documents too (a document references the one student, never a copy). It stores a
**reference/metadata only** — never file bytes — so it introduces no object-storage
dependency (object storage lands with Phase 9 Document Management, per roadmap §9).

```prisma
enum StudentDocumentKind {
  ID_PROOF
  PHOTO
  TRANSCRIPT
  CERTIFICATE
  OTHER
}

model StudentDocument {
  id               String              @id @default(cuid())
  institutionId    String
  institution      Institution         @relation(fields: [institutionId], references: [id])
  studentProfileId String                                   // -> StudentProfile (composite FK)
  studentProfile   StudentProfile      @relation(fields: [studentProfileId], references: [id])
  kind             StudentDocumentKind @default(OTHER)
  title            String
  storageKey       String                                   // opaque external ref; NOT bytes
  contentType      String?
  sizeBytes        Int?
  uploadedByUserId String
  createdAt        DateTime            @default(now())
  updatedAt        DateTime            @updatedAt

  @@unique([id, institutionId])
  @@index([institutionId])
  @@index([institutionId, studentProfileId])
  @@map("student_documents")
}
```

- Tenant-owned → `institutionId` + `@@unique([id, institutionId])` + `@@index` + composite
  same-tenant FK to `student_profiles(institutionId, id)` (`ON DELETE RESTRICT` — a
  student with documents is never deleted anyway) + tenant-root FK to `institutions`.
- RLS: the **standard** pair (`tenant_isolation_select` + `tenant_isolation_modify`) — a
  document reference is legitimately editable/removable metadata (unlike history/audit),
  so it takes full DML, not the append-only pair. `campass_app` gets full DML (no REVOKE).
- **Phase-2 operations on documents are intentionally minimal**: there is **no** document
  upload/download route in Phase 2 (that is Phase 9). The table + its tenancy/RLS land now
  so the seam exists; routes are the documented deferral. If the reviewer considers even
  the minimal table scope creep, the fallback is to defer the table entirely with this
  section as the seam — but the chosen path is build-minimal-table-only.

### 5.7 Error handling (concrete, per operation)

| Operation | Failure condition | Recoverable? | Caller receives | Logged? |
|---|---|---|---|---|
| create / register / import | `enrollmentNo` exists in-tenant | recoverable (fix input) | `409 "enrollment number already registered"` (import: per-row skip + error string) | audit `result: DENIED` on route-level reject; per-row import errors in response, not audited individually |
| create | `email` already a user | recoverable | `409 "email already registered"` | audit `DENIED` |
| create/import | invalid body (zod) | recoverable | `400` + zod flatten (import: per-row skip) | not audited |
| assign-program | program not in-tenant / not ACTIVE | recoverable | `400 "unknown or inactive program"` | audit `DENIED` |
| enroll | session/term not in-tenant or term∉session | recoverable | `400 "invalid session or term"` | audit `DENIED` |
| promote | target term not in-tenant | recoverable | `400 "invalid target term"` | audit `DENIED` |
| transfer | department/program not in-tenant | recoverable | `400 "unknown department or program"` | audit `DENIED` |
| deactivate | target not a valid StudentStatus | recoverable | `400 "invalid status"` | audit `DENIED` |
| any `:id` op | student not found in-tenant | recoverable | `404 "student not found"` | not audited (no resource) |
| update | forbidden/unknown field sent | recoverable | `400 "field not editable"` (zod `.strict()`) | not audited |
| export (live `admin.ts` route) | caller lacks `admin.students.export` | fatal for request | `403` | audit on the live export path (unchanged) |
| any write | composite FK / RLS `WITH CHECK` rejection (cross-tenant, should be unreachable via route) | fatal | `500` generic (cross-tenant is a bug, not a user path) | `request.log.error` + audit `ERROR` |
| any write | DB transaction failure / pooler P1001 | retryable at infra | `500 "operation failed"` | `request.log.error` |

Every lifecycle mutation's history-row write and audit-event write are **in the same
transaction** as the field change, so a failure rolls all three back atomically — a
transition can never be recorded without its history, nor vice versa.

### 5.8 Validation rules (per external input)

- `enrollmentNo`: required, non-empty string, trimmed; **uniqueness is enforced by the DB
  `enrollmentNo UNIQUE` + checked for a friendly error** (§7.1). On failure: `409`.
- `email`: required, valid email (zod `.email()`); uniqueness via `User` lookup. `409` on
  collision.
- `semester`: optional on update paths; where present, int `1..12` (matches the live
  `bulkImportStudentSchema` / `registerSchema` limits — kept consistent). `400` on range.
- `program` (free-text): required on create/import (coexistence — §3.4), non-empty. `400`.
- `programId` / `academicSessionId` / `currentTermId` / `departmentId`: optional; when
  present must be a cuid that resolves in-tenant; the composite FK is the hard backstop and
  a service pre-check returns `400` with a friendly message. Null is always permitted.
- `status` target (deactivate): must be a member of the `StudentStatus` enum. `400`.
- `admissionDate` / `dob`: optional; `admissionDate` is `DateTime?`, `dob` stays the live
  `String?` shape (unchanged — not re-typed, to avoid a breaking column change).
- Pagination `page`/`pageSize`: coerced ints, `page ≥ 1`, `1 ≤ pageSize ≤ 100`
  (out-of-range clamped, not errored).

---

## 6. PRESERVE-HISTORY by construction (non-negotiable)

The invariant: no SIS operation ever destroys or rewrites a student's history, and every
lifecycle change is recoverable. Enforced **structurally**, with the owning layer named:

1. **No hard delete anywhere.** There is no DELETE route for a student, and the composite
   FKs from `gate_passes`, `reliability_score_snapshots`, `student_profile_history`, and
   `student_documents` to `student_profiles` are all `ON DELETE RESTRICT`. **Owner: the
   database.** Even a buggy or malicious attempt to delete a student row is refused by the
   FK constraints. Archival is a `status` flip (§5.4).
2. **Every lifecycle transition appends an immutable history row in the same transaction.**
   promote/transfer/deactivate/enroll/assign-program each write a `StudentProfileHistory`
   row capturing previous+new values + actor + timestamp, atomically with the field change
   (§4, §5.3–5.4). **Owner: the service layer writes it; the database makes it immutable**
   (append-only RLS + REVOKE + trigger — §4.2). A silent overwrite of history is therefore
   structurally impossible, not merely something the service declines to do.
3. **The live row is advanced, never branched destructively.** A promotion updates the
   *current* `currentTermId`/`semester`/`status` and leaves every historical fact intact:
   the prior values live in the history row, and (per the Phase-1 promotion seam) any
   future session-scoped records (Phase 3 enrollment/attendance/grades) will be **new**
   rows in the target session that physically cannot rewrite the source-session rows
   (those parents are never deleted; FKs are RESTRICT). **Owner: the schema** (immutable
   historical links by construction).
4. **Audit is additional, not a substitute.** Each transition also writes an
   `audit_events` row via `recordAuditEvent` (§7.4). History (`student_profile_history`) is
   the domain record of *what the student's state was*; audit is the security record of
   *who did what*. Both are append-only; neither can be edited.

### 6.1 The Phase-1 promotion seam, consumed here

Phase 1 modelled promotion as "create new session-scoped rows, never mutate old rows" and
built none of it (Phase-1 §6.3). Phase 2 consumes that seam: `POST /students/:id/promote`
flips the live student's current-term pointer + appends history, and **defers all
session-scoped record creation to Phase 3** (there are no enrollment/attendance rows in
Phase 2 to create). So Phase 2's promote is purely "advance the pointer + record history";
the heavier "new rows in the target session" work is Phase 3's, against the immutable
session/term parents Phase 1 guaranteed.

---

## 7. NO-DUPLICATE-IDENTITY by construction + catalogue + fold-in

### 7.1 The headline invariant, enforced by the database

**There is exactly one student identity per `enrollmentNo` per tenant, and one per
`userId`.** Enforced at the DB layer by the **existing live constraints** (no new
migration needed for the backstop):

- `student_profiles.enrollmentNo` is `@unique` (global unique — stronger than per-tenant;
  verified live). A second row with the same `enrollmentNo` is **physically rejected** by
  Postgres, regardless of which code path attempts it.
- `student_profiles.userId` is `@unique` — one profile per user.

Every create path (admin create §5.2, self-register §7.2, bulk-import §7.3) resolves
against these constraints: it **first looks up** the existing `enrollmentNo` and either
rejects or updates (per the documented rule below), and even if that check were buggy, the
unique index is the final backstop — a duplicate cannot be stored. This is "by
construction", not "by convention".

> **Design note — per-tenant vs global uniqueness.** The live constraint is *global*
> unique on `enrollmentNo`, which is stricter than the tenancy model strictly needs
> (two institutions could in principle reuse an enrollment number). Phase 2 **keeps the
> global unique as-is** — changing it to a composite `@@unique([institutionId,
> enrollmentNo])` would be a change to a FROZEN-migration constraint on a live table with
> real data, carrying collision risk, for no Phase-2 requirement (the demo data has no
> cross-tenant collision). The stricter global unique fully satisfies NO-DUPLICATE-IDENTITY
> within a tenant; relaxing it to per-tenant is a documented future option, not Phase 2.
> (Decision locked: retain global `enrollmentNo UNIQUE`.)

### 7.2 Self-registration (`auth.ts /register`) folded in

The live `/register` already enforces no-duplicate-identity (verified: it rejects a
mismatched `enrollmentNo` on an existing imported user, rejects an existing email that is
not a matching student, and rejects a new self-registration whose `enrollmentNo` already
exists via `studentProfile.findUnique({ where: { enrollmentNo } })`). Phase 2 **keeps this
behavior** and only adds, to the two `studentProfile.create`/`update` sites, the new
defaulted/nullable fields where available: `status` defaults `ACTIVE` on the DB side (so
no code change is strictly required for status), and the create path may set
`admissionDate`/best-effort `programId` if derivable. No change weakens the existing
collision checks; the `enrollmentNo UNIQUE` backstop is unchanged. Registration continues
to create a `PENDING_APPROVAL` user whose profile status is `ACTIVE` by column default
(status tracks the *student lifecycle*, not the *account* lifecycle — account
approval stays on `User.accountStatus`, a separate axis; §7.5 notes the distinction).

### 7.3 Bulk import (`admin.ts /students/bulk-import`) folded in — the re-import rule

The live bulk-import creates a `User` + nested `StudentProfile` per CSV row, skipping rows
whose email already exists. Phase 2 folds it onto the new model with a **documented
re-import rule that prevents duplicate identity**:

- **Rule (no duplicate identity on re-import):** for each row, resolve the existing
  student by `enrollmentNo` (the identity key) **first**, before the email check.
  - If a student with that `enrollmentNo` already exists in-tenant → **UPDATE the permitted
    mutable fields** of the existing profile (name, rollNumber, section, program/semester
    best-effort, phone, address, dob) and **do NOT create a new row**; count it as
    `updated` (a new counter alongside `created`/`skipped`). This is the
    "update, not duplicate" branch.
  - If no such `enrollmentNo` but the `email` already belongs to a different user → skip
    with an error string (unchanged behavior), because email is a `User`-level unique and a
    mismatch indicates a data conflict the admin must resolve.
  - If neither exists → create `User` + `StudentProfile` as today, now additionally setting
    `status = ACTIVE` (column default — explicit for clarity) and best-effort `programId`
    resolution from `courseCode`/`program` (§3.4), never failing the row if the program
    cannot be resolved.
- The DB `enrollmentNo UNIQUE` remains the backstop: even if the resolve-first logic had a
  gap, a second insert of the same `enrollmentNo` throws and that row is caught by the
  existing per-row `try/catch` → counted as an error, never a silent duplicate.
- A re-imported (updated) row writes a `StudentProfileHistory` `UPDATED` row; the whole
  import writes one summarizing `students.student.imported` audit event (the live
  `admin.students.imported` key is retained; §7.4 adds the new key and the import may write
  the new `students.student.imported` going forward — decision in §7.4).

This directly satisfies the roadmap's "no duplicate identity on re-import" test (§11.3).

### 7.4 Permission keys + audit keys + role bindings

**New permission keys** (`packages/shared/src/permissions.ts`, module `"students"`,
`<module>.<resource>.<action>` convention):

```
students.view        — read student records + history (list/detail/history)
students.create      — create a student
students.update      — edit permitted fields; assign-program; transfer; reactivate
students.enroll      — enroll into a session/term
students.promote     — promote (advance term/semester)
students.deactivate  — archive via status (withdraw/suspend/graduate/leave)
```

(Export is intentionally NOT a `students.*` key — it stays on the live
`admin.students.export` permission + the `admin.ts` route; §5.1.)

**Decision on `transfer`:** transfer is bound to `students.update` (not a separate
`students.transfer` key) — it is a field edit (department/program) with a history row, and
adding a key per lifecycle verb over-fragments the catalogue. The candidate set in the
task is honored; `transfer` maps to `students.update`. (Locked.)

**Template-role bindings** (`ROLE_PERMISSIONS`):

- `ADMIN` gains all six: `students.view/create/update/enroll/promote/deactivate` (plus the
  self-service `students.view_own` below). Export stays on the live `admin.students.export`
  ADMIN binding — unchanged.
- `HOD` gains `students.view` and the **manage-within-department** subset
  `students.update`, `students.enroll`, `students.promote` — but **record-level department
  scope** (§5.7) narrows every HOD query/mutation to the HOD's `departmentScope`; an HOD
  cannot create (`students.create`) or deactivate (`students.deactivate`) across the
  institution, and export stays an ADMIN-only `admin.students.export` capability (HOD is not
  bound to it). (Decision: HOD gets view + in-department promote/enroll/update, not
  create/deactivate/export — matches the task's "HOD view/manage within department scope
  where appropriate".)
- `STUDENT` gains **no** `students.*` admin permission; self-service reads go through the
  existing own-record path (§8), which needs only `campus_movement.*`-style view-own
  semantics — Phase 2 adds `students.view_own` for the self-service profile read (see
  below).
- `GUARD` gains nothing (`students.*` is not guard surface).
- `SUPER_ADMIN` gains **nothing** (platform role; student data is tenant data it has no
  standing access to — superadmin-security.md §2).

> **`students.view_own` (self-service, low-privilege).** To gate the self-service profile
> endpoint (§8) distinctly from the admin `students.view`, add `students.view_own` bound to
> `STUDENT` (and harmlessly to `HOD`/`ADMIN`). It authorizes reading **only the caller's
> own** record; ownership is enforced in the handler via `getStudentInTenant(userId, ...)`
> (§8), never by trusting a request id. This mirrors the existing
> `campus_movement.pass.view_own` pattern.

**New audit action keys** — appended to the `AUDIT_ACTIONS` array in
`packages/shared/src/audit-actions.ts` (module `"students"`), each with an `id`-free
`{ key, module, description }` entry exactly like every existing catalogue row:

```
students.student.created        students.student.updated
students.student.program_assigned
students.student.enrolled       students.student.promoted
students.student.transferred    students.student.deactivated
students.student.imported
```

(No `students.student.exported` key — export stays on the live `admin.ts` route under its
existing audit path; §5.1.)

**How audit keys are enforced (verified, two mechanisms — no pg-enum, no migration
mirror):** (1) at runtime, `recordAuditEvent` (`apps/api/src/services/audit.ts`) rejects
any `action` not in `AUDIT_ACTION_KEY_SET` (the set derived from the `AUDIT_ACTIONS`
array) — so a new key is usable **only after** it is added to that array, and the
`AuditActionKey` literal-union type additionally fails `tsc` on any unlisted key; (2) the
`audit-actions.test.ts` meta-test asserts every catalogue key matches the shape regex
`KEY_RE = /^[a-z_]+(\.[a-z_]+)+$/` (two-or-more lower-snake dot segments). The eight new
`students.student.*` keys are 3-segment and satisfy both. There is no runtime `KEY_RE`
validator on the write path — adding the keys to the `AUDIT_ACTIONS` array is the single
required change (the set + the type + the meta-test all flow from it).
The legacy live `admin.students.imported` key (currently written by bulk-import) is
**retained untouched** in the catalogue; the folded-in importer writes the **new**
`students.student.imported` key going forward, and the old key remains valid history
(same stance Phase-1 took with `admin.academic_calendar.updated`). `LEGACY_AUDIT_ACTION_MAP`
is not touched.

### 7.5 Keeping catalogue-sync green (the established union pattern)

`catalogue-sync.test.ts` parses the seeding migrations' `INSERT INTO "permissions"` and
`INSERT INTO "role_permissions"` blocks and asserts set-equality against `PERMISSION_KEYS`
+ `ROLE_PERMISSIONS`, unioned across `SEEDING_MIGRATION_DIRS`. Therefore the `phase2_sis`
migration MUST:

1. Seed the new `students.*` permissions into `permissions` and their `(roleKey, permKey)`
   pairs into `role_permissions` (ADMIN × all six + `students.view_own`; HOD × the
   in-department subset `students.view`/`students.update`/`students.enroll`/`students.promote`
   + `students.view_own`; STUDENT × `students.view_own`),
   using the **exact block markers** the parser keys on (`INSERT INTO "permissions" ...
   ON CONFLICT`, the `INSERT INTO "role_permissions" ... SELECT ... FROM (VALUES ...) AS
   m(...)` join form), idempotently (`ON CONFLICT DO NOTHING`) — byte-for-byte the shape
   `module_system` / `phase1_academics` used.
2. Add the new migration dir (`20...._phase2_sis`) to `SEEDING_MIGRATION_DIRS` in
   `catalogue-sync.test.ts` (the one cross-feature test edit, exactly as Phase-1 did).

Audit action keys need no migration mirror, so only permissions require the seed + the
test-dir addition.

> **Account lifecycle vs student lifecycle (clarified, §7.2).** `User.accountStatus`
> (`ACTIVE|INACTIVE|PENDING_APPROVAL`) is the *login/account* axis and is unchanged by
> Phase 2. `StudentProfile.status` (`StudentStatus`) is the *academic/student lifecycle*
> axis introduced here. They are deliberately separate: a `GRADUATED` student may retain an
> `ACTIVE` account (to view records), and a `PENDING_APPROVAL` account may have an `ACTIVE`
> student status by column default. Deactivate (§5.4) flips `StudentStatus`; it does NOT
> touch `accountStatus` (the existing `admin.ts` user deactivate route owns that).

---

## 8. Student self-service (`student.ts`) — own record + ACTIVE-module services

Additions to the existing `student.ts` route (which already authenticates once at the top
and uses `getStudentInTenant(userId, institutionId, tx)` for ownership):

- `GET /me/profile` — the caller's own `StudentProfile`: identity + current academic info
  (resolved `structuredProgram` name/code if `programId` set else free-text `program`;
  resolved `academicSession` name + `currentTerm` name/ordinal if set else the free-text
  `semester`), `status`, `admissionDate`, department. `requirePermission("students.view_own")`.
  Ownership is enforced by resolving the record via `getStudentInTenant(userId, ...)` —
  the handler reads **only** the row owned by the authenticated `userId`; it never accepts
  a student id from the request. A student who somehow queries another id gets their own
  record or 404, never another student's.
- `GET /me/academic` — the caller's current session/term/program summary (a focused view
  over the same owned row + the Phase-1 `academics.view` current-session data). Reuses the
  Phase-1 `CalendarService`/current-session read where helpful; `students.view_own`.
- `GET /me/services` — the list of services available **from ACTIVE modules only**. This
  reuses the existing module-system state: the handler reads the caller's institution's
  `institutionModule` rows (via the same mechanism `requireModuleActive` uses) and returns
  the set of modules whose `state = ACTIVE`, mapping each to the self-service entry points
  the student may use (e.g. `campus_movement` → gate-pass actions). A module that is
  `ENTITLED`/`SUSPENDED`/`NOT_ENTITLED` does **not** appear. This directly satisfies the
  roadmap DoD "a student logs into self-service and sees only what their institution has
  activated and permitted." `requirePermission("students.view_own")` + the per-service
  entries additionally reflect the student's own permissions.

**Scoping guarantee:** every self-service read runs inside `withTenant` (RLS tenant scope)
and resolves the record by the authenticated `userId` (ownership scope). The combination —
tenant RLS + own-`userId` resolution — means a student sees exactly their own record within
their own tenant, enforced at two layers (DB RLS + handler ownership), consistent with the
Phase-0 escape model.

---

## 9. GatePass / allowance / reliability — the NON-BREAKING argument

The generalization is **additive-only to a live hot table**; the argument that nothing
breaks, made concretely:

1. **GatePass FK is unchanged.** `gate_passes.studentId` → `student_profiles(institutionId,
   id)` (the FROZEN B-1 composite FK) references the `id` + `institutionId` columns, which
   this phase does **not** touch. Adding nullable columns and new FKs to `student_profiles`
   does not alter `id` or `institutionId`, so the FK keeps resolving. Verified: the FK is
   `gate_passes_student_same_tenant_fkey FOREIGN KEY ("studentId","institutionId")
   REFERENCES "student_profiles"("id","institutionId")`.
2. **Reliability FK is unchanged** for the same reason
   (`reliability_score_snapshots_student_same_tenant_fkey`).
3. **Every live read keeps working.** The allowance engine, reliability engine, and the
   `student.ts` dashboard read `student.id`, `student.name`, `student.enrollmentNo`,
   `student.program`, `student.semester`, `student.department` — all **retained, unchanged
   columns**. No read selects a dropped/renamed field (nothing is dropped/renamed). The new
   columns are additive; `SELECT *` returns extra columns the existing code ignores.
4. **Every live write keeps working.** `admin.ts` create-user, bulk-import, and `auth.ts`
   register `create`/`update` the same columns they do today; `status` is defaulted at the
   DB (so omitting it is fine), and the new FK columns are nullable (so omitting them is
   fine). The folded-in importer (§7.3) changes *logic* (resolve-first) but still writes
   only valid columns.
5. **RLS/grants unchanged.** `student_profiles` keeps its B-1 policies + `campass_app`
   grant (§3.6); the new columns fall under the existing `institutionId`-keyed policies.
6. **No enum collision.** `StudentStatus`, `StudentHistoryChangeType`, `StudentDocumentKind`
   are brand-new type names; they do not conflict with existing enums.

The one behavioral change to live code is the **bulk-import resolve-first logic** (§7.3),
which is deliberately additive (adds an `updated` branch; the `enrollmentNo UNIQUE`
backstop guarantees no duplicate even if the new logic regressed). It is covered by the
re-import test (§11.3).

### 9.1 Regression test plan for GatePass/allowance/reliability (§11.6 detail)

A dedicated regression suite asserts the generalization did not change campus-movement
behavior: (a) create a student the new way, request → approve → exit → return a gate pass,
asserting the full lifecycle still works against the generalized row; (b) allowance
summary + enforcement decision compute identically for a student with `status = ACTIVE`
and null structured links (the live shape) and for one with populated links (no behavior
change — the engine ignores the new columns); (c) reliability snapshot computes unchanged;
(d) a student whose `status` is later `GRADUATED` still resolves for historical pass reads
(no row deleted). This proves additivity, not just compile-cleanliness.

---

## 10. Decision — the `phase2_sis` migration (house style + checksum-drift workaround)

One **new** migration directory, `20...._phase2_sis` (timestamp from the system clock,
sorting AFTER the seven existing dirs). The seven FROZEN migrations
(`20260824143031`, `20261018100917_init`, `20261018110658_tenancy_isolation_rls`,
`20261018171747_identity_rbac_b2`, `20261019053533_superadmin_security`,
`20261019093119_module_system`, `20261027111710_phase1_academics`) are **not** edited. The
migration is hand-authored for everything Prisma's diff does not model, mirroring the
`phase1_academics` / `superadmin_security` ordering and style.

### 10.1 Migration section ordering (hand-authored, in order)

1. **`CREATE TYPE`** the three new enums: `StudentStatus`, `StudentHistoryChangeType`,
   `StudentDocumentKind`.
2. **`ALTER TABLE "student_profiles"`** — additive columns only (NEVER recreate the table):
   - `ADD COLUMN "status" "StudentStatus" NOT NULL DEFAULT 'ACTIVE'` (the `DEFAULT 'ACTIVE'`
     is the **backfill**: every existing row gets `ACTIVE` at column-add time, so no
     separate `UPDATE` is needed — Postgres fills existing rows with the default);
   - `ADD COLUMN "admissionDate" TIMESTAMP(3)` (nullable);
   - `ADD COLUMN "programId" TEXT`, `ADD COLUMN "academicSessionId" TEXT`,
     `ADD COLUMN "currentTermId" TEXT` (all nullable).
3. **`CREATE TABLE`** `student_profile_history` and `student_documents` with PKs, the
   `(id, institutionId)` composite uniques, and `institutionId` + composite indexes.
4. **Tenant-root FKs** (`institutionId → institutions(id)`, `ON DELETE RESTRICT`) for
   `student_profile_history` and `student_documents`.
5. **Composite same-tenant FKs:**
   - the three `student_profiles` links — drop Prisma's single-col FK, add composite incl.
     `institutionId` → `programs` / `academic_sessions` / `academic_terms`, all
     `ON DELETE SET NULL ON UPDATE CASCADE` (§3.5);
   - `student_profile_history.studentProfileId` → `student_profiles(institutionId, id)`,
     `ON DELETE RESTRICT` (§4.1);
   - `student_documents.studentProfileId` → `student_profiles(institutionId, id)`,
     `ON DELETE RESTRICT` (§5.6).
6. **New indexes on `student_profiles`:** `(institutionId, status)` and
   `(institutionId, programId)` (§3.3). (The existing `(institutionId)` index + composite
   unique are untouched.)
7. **`DO $$ ENABLE + FORCE RLS`** on the two **new** tenant-owned tables, byte-for-byte the
   house style:
   - `student_documents`: the **standard** `nullif`-guarded pair —
     `tenant_isolation_select` (FOR SELECT) + `tenant_isolation_modify` (FOR ALL
     WITH CHECK);
   - `student_profile_history`: the **append-only** pair — `tenant_isolation_select`
     (FOR SELECT, `nullif`-guarded) + `student_profile_history_tenant_insert`
     (FOR INSERT WITH CHECK, `nullif`-guarded), and **no** FOR ALL/modify policy.

   **`student_profiles` RLS is NOT touched** (it already has ENABLE+FORCE + the standard
   pair from FROZEN B-1 — §3.6).
8. **Append-only trigger** for `student_profile_history`: function
   `student_profile_history_append_only()` (raising `restrict_violation`, identical shape
   to `audit_events_append_only`) + trigger `student_profile_history_no_update_delete`
   `BEFORE UPDATE OR DELETE` binding every role (§4.2).
9. **Guarded idempotent `campass_app` GRANT pin** inside `DO $$ ... IF EXISTS (pg_roles
   ... 'campass_app') $$`, never `BYPASSRLS`:
   - `GRANT SELECT, INSERT, UPDATE, DELETE ON "student_documents"` (full DML — editable
     metadata, no REVOKE);
   - `GRANT SELECT, INSERT ON "student_profile_history"` and `REVOKE UPDATE, DELETE` from
     `campass_app` on it (the `audit_events` pin shape).

   `student_profiles` needs **no** new grant (the B-1 ALTER DEFAULT PRIVILEGES + explicit
   grant already cover it; new columns inherit the table grant).
10. **Seed** the `students.*` permissions + their `role_permissions` pairs (§7.5), exact
    catalogue-sync markers, idempotent `ON CONFLICT DO NOTHING`.

**Backfill:** the only backfill is `status = ACTIVE` for existing rows, achieved by the
`ADD COLUMN ... NOT NULL DEFAULT 'ACTIVE'` in step 2 (no separate `UPDATE` statement, and
no best-effort structured-link backfill in the migration — link population happens through
operations, not DDL, so the migration stays purely additive and fast on the live table).

### 10.2 Authoring + apply workflow (the checksum-drift workaround — DESIGN FOR IT)

**KNOWN ISSUE (verified against database.md, the "Correction to an earlier note" block,
+ the Phase-1 FEAT-001 findings):** the live `_prisma_migrations` ledger has a
**pre-existing checksum mismatch** on the FROZEN `20261019053533_superadmin_security` row
(the recorded checksum does not match the current file; the file is clean in git — the
drift was introduced by earlier create-only/deploy iterations and predates this phase).
database.md records this as **harmless**: `prisma migrate status` is clean and
`prisma migrate deploy` tolerates it. The documented risk is only that it *may* block a
local `prisma migrate dev` (which, against the shared Supabase DB, could try to RESET —
**forbidden**). The correct remedy per database.md if `migrate dev` ever blocks is
`prisma migrate resolve`, **never** a manual checksum overwrite and **never** a reset. To
sidestep the risk entirely, Phase 2 does not depend on `migrate dev` at all:

**Design for the exact same approach the Phase-1 coder proved works:**

1. Update `schema.prisma` (verified current shape):
   - add the three enums (`StudentStatus`, `StudentHistoryChangeType`,
     `StudentDocumentKind`);
   - add the new scalar fields + relation fields to `StudentProfile` (§3.3) — the relation
     field is `structuredProgram Program?` (scalar `programId`), plus `academicSession`,
     `currentTerm`, and the `history StudentProfileHistory[]` / `documents
     StudentDocument[]` back-relations;
   - add the two new models `StudentProfileHistory` + `StudentDocument`;
   - add the required Prisma **back-relation fields** (Prisma rejects a one-sided relation):
     on `Institution` add `studentProfileHistory StudentProfileHistory[]` and
     `studentDocuments StudentDocument[]` (it already has `studentProfiles`); on `Program`,
     `AcademicSession`, and `AcademicTerm` add a `StudentProfile[]` back-relation for the new
     optional links (named distinctly, e.g. `students`/`enrolledStudents`/`currentStudents`,
     to avoid colliding with any existing relation field).
   Then regenerate the client from repo root:
   `npx prisma generate --schema=packages/db/prisma/schema.prisma`.
2. **Hand-author** the migration directory `packages/db/prisma/migrations/
   20...._phase2_sis/migration.sql` in the house style (do NOT run plain `migrate dev`;
   do NOT rely on `migrate dev --create-only` either — it may trip the pre-existing
   superadmin checksum mismatch into a reset prompt against the shared DB, and hand-
   authoring is required regardless for the RLS/trigger/grant/seed SQL Prisma's diff does
   not model).
3. **Confirm the intended DDL with the read-only diff** (never a reset):
   `npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel
   packages/db/prisma/schema.prisma --script` — compare its output against the
   hand-authored SQL for the `student_profiles` ALTERs, the two `CREATE TABLE`s, the FK
   constraints, and the indexes. (The diff does NOT model RLS/triggers/grants/seed — those
   are hand-written and reviewed by eye against the Phase-1 precedent.)
4. **Apply with `prisma migrate deploy`** (from `packages/db`), which does **NOT**
   re-verify applied-migration checksums, so it is unaffected by the pre-existing
   superadmin drift (confirmed by Phase-1). Retry transient pooler errors
   (`P1001` / "tenant or user not found" — the free tier pauses on inactivity). If
   `migrate deploy` reports **new** drift, STOP and diagnose; never force-reset the shared
   DB.
5. Regenerate the client again; rebuild `@campusgate/shared` (`cd packages/shared &&
   npx tsc`) so the new `students.*` catalogue keys are in `dist` before `apps/api`
   consumes them; `cd apps/api && npx tsc` must compile clean.

**Ordering constraint.** The new `students.ts` routes + the generalized schema + the
migration ship in the **same deployable**; `migrate deploy` runs before the API boots
(database.md), so the columns/tables exist before any new route serves. Nothing is newly
*gated* (Decision A), so there is no 403-risk window.

---

## 11. Test plan

Mirrors the phase-completion gate and the Phase-1 test structure. Vitest; real-DB suites
hit live Supabase and read `apps/api/.env` + `packages/db/.env` (never modified).

### 11.1 Cross-tenant escape suite — EXTENDED to the new tables (the gate)

Extend `tenant-escape.integration.test.ts` + its helper `tenant-escape-setup.ts` to cover
`student_profile_history` and `student_documents` (and the generalized `student_profiles`
columns). The concrete, verified edits to `tenant-escape-setup.ts` (its current shape was
read; these are the exact touch points):

- **`RLS_TABLES`** (the array of tables asserted to have ENABLE+FORCE RLS) — add
  `"student_profile_history"` and `"student_documents"`. (`student_profiles` is already in
  the list from B-1; its generalization adds no new entry.)
- **`EXPECTED_POLICIES`** (the per-table override map; a table absent from it is asserted
  against `DEFAULT_POLICIES = {tenant_isolation_select, tenant_isolation_modify}`) — add
  `student_profile_history: ["tenant_isolation_select",
  "student_profile_history_tenant_insert"]` (append-only pair, the `audit_events` /
  `academic_calendar_day_revisions` shape). **Do NOT** add `student_documents` — it uses
  the standard pair, so it must fall through to `DEFAULT_POLICIES` (adding it would be
  wrong).
- **`SeededTenant`** interface + **`seedTenant`** — add a `studentDocumentId` (and seed one
  `student_documents` row per tenant via the RLS-bypassing `adminClient`, overlapping-shaped
  like the other rows). The generalized `student_profiles` seed row gains `status` (defaults
  `ACTIVE`) + optional structured links. **`student_profile_history` is deliberately NOT
  seeded in this helper** — the `BEFORE UPDATE OR DELETE` trigger blocks even `adminClient`
  in the shared teardown, exactly the `academic_calendar_day_revisions` / `audit_events`
  precedent already documented in this file; its escape + append-only behaviour is proven by
  a self-contained test that inserts + asserts within one tenant and never needs teardown.
- **`cleanup`** + **`countRemainingTestRows`** — add `student_documents` (child-first,
  before `studentProfile`, because its composite FK to `student_profiles` is
  `ON DELETE RESTRICT`); `student_profile_history` is neither cleaned nor counted (not
  seeded, and the trigger would block its delete — the same stance the helper already takes
  for the revision table).

The escape assertions themselves:

- **Read escape:** as tenant A, attempt to read B's `student_profile_history` /
  `student_documents` rows (by id, by list, by nested include) → empty/not-found.
- **Write escape — spoofed tenant:** as A, insert a history/document row with
  `institutionId = B` → RLS `WITH CHECK` rejection.
- **Write escape — foreign parent:** as A, create a `student_document` /
  `student_profile_history` referencing B's `studentProfileId` → composite FK violation.
- **Deliberately-buggy query (headline):** a test route issues a `student_profile_history`
  / `student_documents` / generalized-`student_profiles` query that **forgets** the tenant
  filter; with RLS on it returns only A's rows.
- **Missing-context fail-closed:** query without `app.current_institution_id` → zero rows.
- **Append-only enforcement:** attempt `UPDATE`/`DELETE` on `student_profile_history` as
  `campass_app` → denied by the trigger + REVOKE (the same assertion `audit_events` has).
- **Meta-test (`EXPECTED_POLICIES`):** `student_profile_history` registered as
  **append-only**; `student_documents` as **standard-pair**; both asserted to have
  ENABLE+FORCE RLS + the expected policy set.

### 11.2 Permitted-mutable-field enforcement

`PATCH /students/:id` with a forbidden key (`enrollmentNo`, `status`, `programId`,
`semester`, …) → `400 "field not editable"` (zod `.strict()`); with only permitted keys →
`200` and exactly those fields changed; a `StudentProfileHistory` `UPDATED` row written.

### 11.3 No-duplicate-identity (create / register / re-import)

- `POST /students` with an existing `enrollmentNo` → `409`, no second row (count unchanged).
- `/register` with an `enrollmentNo` already present → `409` (existing behavior preserved).
- **Re-import test (the roadmap's named test):** bulk-import a CSV containing an
  `enrollmentNo` that already exists → the existing row is **updated** (not duplicated),
  `results.updated` increments, `results.created` does not, and the row count for that
  `enrollmentNo` stays 1. A direct second insert of the same `enrollmentNo` (simulating a
  logic gap) is rejected by the `enrollmentNo UNIQUE` backstop.

### 11.4 Preserve-history

promote/transfer/deactivate each write a history row with correct previous/new snapshots +
actor; the history table rejects UPDATE/DELETE (append-only); no student row is ever
deleted (there is no delete route; an attempted FK-parent delete is RESTRICT-refused).
Promote leaves prior history rows byte-identical.

### 11.5 Self-service scoping

- `GET /me/profile` returns only the caller's own record; a second student cannot see the
  first's record (own-`userId` resolution + RLS).
- `GET /me/services` lists only `ACTIVE`-module services; flipping a module to
  `SUSPENDED`/`ENTITLED` removes it from the list.

### 11.6 GatePass / allowance / reliability regression

The §9.1 suite: full gate-pass lifecycle against a generalized student; allowance +
reliability compute identically with null and with populated structured links; a
`GRADUATED` student's historical passes still read. Plus the existing 259-test suite stays
green (the final FEAT runs the full clean build + `npx vitest run`).

### 11.7 Testability notes

- **Unit-testable (DB-free):** the `student-sis.ts` transition functions (status machine:
  which `changeType` + which previous/new snapshot a given transition produces), the
  permitted-field zod schemas, and the bulk-import resolve-first decision (given an
  existing-vs-new `enrollmentNo`, choose update/create/skip) — all pure functions taking a
  mocked client or plain inputs, mirroring `module-system.ts` unit tests.
- **Integration-tested (real DB):** RLS/append-only/composite-FK behavior, the escape
  suite, the re-import against a live row, the gate-pass regression — anything whose
  correctness is a DB property must hit the live Supabase suite, because RLS and triggers
  are invisible to a mocked client.
- The transition logic being pure + the DB enforcing the invariants (unique, FK, RLS,
  append-only) is what makes this design testable: no invariant depends on a service
  remembering to check it.

---

## 12. Seed extension (`packages/db/src/seed.ts`)

Idempotent additions, matching the seed's existing `console.log` style and the Phase-1
seed shape (which already creates the `2026-2027` SEMESTER session + Semester 1/2 terms +
BCA/BTECH-CSE programs):

- Backfill the existing seeded students' structured links best-effort: set
  `academicSessionId` to the active `2026-2027` session, `currentTermId` to Semester 1, and
  `programId` to the matching `Program` (BCA for the BCA-department students), leaving
  `status = ACTIVE` (the column default). Use `update` keyed by the known `enrollmentNo`
  so it is idempotent and touches only demo rows.
- Optionally seed one `StudentProfileHistory` `CREATED`/`ENROLLED` row per demo student to
  exercise the append-only table — **or** leave history unseeded (Phase-1 left revisions
  unseeded). **Decision: seed one `ENROLLED` history row per demo student** so the escape
  suite + history-read test have data without creating it at test time; it is idempotent
  via a `findFirst`-guarded create (the append-only trigger forbids update, so guard with
  existence check, never upsert).
- Do **not** seed `StudentDocument` rows (no document routes in Phase 2; the table exists
  for the seam only).

`cd packages/db && npx tsc` must type-check the extended seed.

---

## 13. Phase-3 (Class & Course) reference seams left for later (NOT built)

Phase 3 depends on Phase 2 (roadmap). SIS leaves these seams so classes/enrollment/
attendance can reference the student cleanly, and builds none of them:

- **The student is referenceable with tenant safety.** `student_profiles` keeps
  `@@unique([id, institutionId])`, so Phase-3 tables (`ClassEnrollment`,
  `FacultyAssignment`, `AttendanceRecord`, …) add composite FKs
  `(institutionId, studentId) → student_profiles(institutionId, id)` — the exact pattern
  GatePass already uses. No Phase-2 change is needed for Phase 3 to link.
- **Program/session/term parents are stable + referenceable.** `programId` /
  `academicSessionId` / `currentTermId` on the student give Phase 3 a resolved academic
  context per student; Phase-3 class sections link to the same `Program`/`AcademicSession`/
  `AcademicTerm` parents (all `(id, institutionId)`-unique from Phase 1).
- **The promotion seam is live.** `POST /students/:id/promote` advances the current-term
  pointer + records history; Phase 3's "new session-scoped enrollment rows on promotion"
  slots onto this without rewriting Phase 2 (§6.1).
- **Status drives enrollability.** Phase 3 enrollment can gate on `StudentStatus`
  (`ACTIVE`/`ENROLLED` enrollable; `WITHDRAWN`/`GRADUATED` not) — a service-layer policy
  Phase 3 owns, reading the Phase-2 status field.
- **No Phase-3 entity, route, permission, or table is created here.**

---

## 14. Responses to design-review findings

No design review exists for this artifact yet (no `design-review.json`). This pass
**re-verified every load-bearing assumption against the live code + docs** and tightened
the ones that were imprecise (recorded below). When the review step produces
`design-review.md`, each finding will be addressed / backlogged (with reason) /
justified-ignored here, consistent with the original requirements.

**Assumptions verified this pass (against the actual repo, not memory):**

- Live `StudentProfile` shape — `enrollmentNo @unique`, `userId @unique`,
  `@@unique([id, institutionId])`, `dob String?`, `program String`, `semester Int` — all
  confirmed in `schema.prisma` (§3.1 accurate).
- `Program` / `AcademicSession` / `AcademicTerm` each carry `@@unique([id, institutionId])`
  (confirmed) → the composite same-tenant FKs in §3.5 are valid; `AcademicTerm.ordinal Int`
  confirmed (§5.3 "term's ordinal").
- `GatePass.studentId` composite FK to `student_profiles(id, institutionId)` and the
  identical reliability FK are on columns Phase 2 never touches (§9 non-breaking argument
  holds).
- Append-only machinery — the `academic_calendar_day_revisions` RLS append-only pair,
  `*_append_only()` `restrict_violation` function, `BEFORE UPDATE OR DELETE` trigger, and
  `GRANT SELECT, INSERT` / `REVOKE UPDATE, DELETE` — exists verbatim in the FROZEN
  phase1_academics migration (§4.2 / §10 faithfully mirror it).
- `catalogue-sync.test.ts` parser markers (`INSERT INTO "permissions"` → `ON CONFLICT`;
  `INSERT INTO "role_permissions"` → `AS m(`; the `('ROLE','key')` tuple regex) and
  `SEEDING_MIGRATION_DIRS` confirmed (§7.5 accurate).
- `tenant-escape-setup.ts` structure — `RLS_TABLES`, `EXPECTED_POLICIES` (override map),
  `DEFAULT_POLICIES`, `SeededTenant`/`seedTenant`/`cleanup`/`countRemainingTestRows` —
  read and named precisely in the tightened §11.1.
- Live `/register`, `admin.ts` bulk-import, `admin.ts /students/export`, and
  `getStudentInTenant` behaviours confirmed (§7.2 / §7.3 / §5.1 / §8 accurate).
- `database.md` records the superadmin-migration checksum mismatch as harmless +
  deploy-tolerated; §10.2 reworded to match (no longer overstates a guaranteed reset).

**Corrections made this pass:**

- §7.4: audit keys are enforced by `AUDIT_ACTION_KEY_SET` membership + the
  `AuditActionKey` type + the `audit-actions.test.ts` `KEY_RE` **meta-test** — not a
  runtime `KEY_RE` validator; the new keys must be added to the `AUDIT_ACTIONS` array.
- §10.2: softened the checksum-drift rationale to match `database.md` exactly and keep the
  hand-author + `migrate deploy` path as the risk-free choice.
- §11.1: named the exact `tenant-escape-setup.ts` edits (and that `student_documents` must
  **not** be added to `EXPECTED_POLICIES`).
- §5.1 / §7.4 / §7.5: resolved an export-permission contradiction — export stays on the
  live `admin.students.export` route/key; the `students.*` set is **six** keys (+
  `students.view_own`), with no `students.export` / `students.student.exported`.
- §2: added an explicit emergency-contact out-of-scope decision ("only if collected"
  unmet).
- §10.2 step 1: enumerated the exact Prisma back-relation fields the new models require.

**Open assumptions flagged inline for the reviewer:**

- **A1 — retain global `enrollmentNo UNIQUE`** rather than relax to per-tenant composite
  (§7.1). Low-risk; satisfies NO-DUPLICATE-IDENTITY within a tenant; relaxing is a
  FROZEN-constraint change on live data, deferred.
- **A2 — build the minimal `StudentDocument` table now** (§5.6) rather than fully defer.
  Reviewer may prefer full deferral (table + section both removed, seam-only); the chosen
  path is table-only, no routes.
- **A3 — keep `program`/`semester`; coexist with structured links; no trigger sync**
  (§3.4). The deprecation is a documented future workstream, not Phase 2.
- **A4 — HOD gets view + in-department enroll/promote/update, not create/deactivate**
  (§7.4). Reviewer may tune the HOD subset; record-level department scope (§5.7) is the
  enforcement.
- **A6 — export is NOT a new `students.*` key; it stays on the live `admin.students.export`
  route/permission** (§5.1), to avoid redundant churn on a live authorized+audited path.
  The `students.*` set is therefore six keys (+ `students.view_own`), not seven.
- **A5 — importer writes the new `students.student.imported` key; legacy
  `admin.students.imported` retained unused** (§7.4), mirroring the Phase-1 calendar-key
  stance.

