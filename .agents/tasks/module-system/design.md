# CAMPASS Module Entitlement / Activation / Dependency System — Design

> Phase 0 final foundation piece (the "booster model", `architecture.md` §5). Replaces
> the permissive `requireModuleActive` stub in `apps/api/src/services/authz-engine.ts`
> with real server-side enforcement, backed by a new tenant-owned `InstitutionModule`
> table, a shared module registry + dependency graph, platform (entitlement) and
> institution (activation) endpoints, and tests. Additive only; the FROZEN migrations
> (`B-1`/`identity_rbac_b2`/`superadmin_security`) are not touched — a NEW migration is
> added.

---

## 0. Overview

An institution's relationship to a module is a single lifecycle with four states
(`architecture.md` §5.2): `NOT_ENTITLED → ENTITLED → ACTIVE ⇄ SUSPENDED`. The platform
(Super Admin) grants/revokes **entitlement**; the institution admin performs
**activation** and may **suspend/reactivate**. A module becomes operational only when it
is `ACTIVE`, and activation is blocked until every declared dependency is already
`ACTIVE` for that institution (§5.4). When a module is not `ACTIVE`, its operational
routes reject requests, its history is preserved, and modules that depend on it are
warned rather than silently broken (§5.5).

The decisions below are made to **fit the live foundation exactly**, not to invent new
patterns:

- The state row is **tenant-owned** and obeys the same two-layer isolation the rest of
  the platform uses (`tenancy.md`): `institutionId` + composite FK + `ENABLE`+`FORCE`
  RLS + fail-closed `nullif`-guarded policies, exactly mirroring the
  `superadmin_security` migration's hand-authored style.
- The module registry and dependency graph live in `packages/shared` as typed
  constants, alongside `PERMISSIONS` and `AUDIT_ACTIONS`, so there is one source of
  truth and the established catalogue-sync meta-test pattern extends to them.
- Platform writes go through `privilegedPrisma` on `platform.ts` under
  `requirePermission('platform.entitlements.manage')`; institution writes go through
  `withTenant` on `admin.ts` under a new `admin.modules.manage` permission; both call
  `recordAuditEvent` with new `<module>.<action>` keys.
- `requireModuleActive` becomes a real preHandler that reads the module state for
  `request`'s institution and 403s when not `ACTIVE`, wired onto the GatePass tenant
  routes **in addition to** the existing `requirePermission` guards. Platform and
  pre-auth routes are never module-gated.

> **Where enforcement actually begins (resolves review finding 2, MEDIUM).** Verified in
> source: `requireModuleActive` is today a permissive stub and is **wired onto zero
> routes** (`grep requireModuleActive` across `apps/api/src/routes/**` returns no matches;
> it is referenced only in `authz-engine.ts` and its unit test). Therefore **replacing the
> stub body has zero runtime effect** — enforcement only begins when the guard is
> **wired** onto the `campus_movement.*` routes (§7.3). "Keep every live GatePass route
> working the instant the permit-all stub is replaced" must be read precisely: the moment
> that matters is **the instant the guard is wired and serving**, not the stub edit. The
> backfill (§5) must precede that **wiring**, and — see A4 — the backfill migration and the
> route wiring ship in the **same deployable**. An implementer must not conclude that
> landing the stub rewrite + migration makes enforcement live, nor split the wiring from
> the backfill across separate deploys.

Locked technology stack (unchanged from the rest of Phase 0): TypeScript on Node;
Fastify for the API; Prisma against Supabase Postgres (runtime via `campass_app`
NOBYPASSRLS pooled client, migrations/DDL + platform reads via the privileged
`postgres` client); `@campusgate/shared` for catalogues; Vitest for tests; versioned
Prisma migrations with hand-authored raw SQL for RLS/FK/trigger DDL. No new runtime
dependency is introduced.

---

## 1. Decision — `InstitutionModule` table shape (one row + state enum)

### 1.1 Chosen shape

**One row per `(institutionId, moduleKey)`** carrying the full lifecycle in a single
`ModuleState` enum, plus lifecycle timestamps, an optional config blob, and who/when
audit fields.

Prisma model (added to `packages/db/prisma/schema.prisma`; the raw DDL — composite
unique, composite FK, RLS, GRANT pins — is authored by hand in the new migration because
Prisma does not model them, following the `superadmin_security` precedent):

```prisma
enum ModuleState {
  ENTITLED
  ACTIVE
  SUSPENDED
}

model InstitutionModule {
  id            String      @id @default(cuid())
  institutionId String
  institution   Institution @relation(fields: [institutionId], references: [id])
  moduleKey     String      // validated against MODULE_KEYS in @campusgate/shared
  state         ModuleState @default(ENTITLED)

  entitledAt    DateTime    @default(now())
  activatedAt   DateTime?
  suspendedAt   DateTime?

  settings      Json?       // optional per-institution module config

  // who/when audit fields (actor ids; no composite FK — a platform actor has
  // no membership in this tenant, mirroring AuditEvent.actorUserId being a
  // single-column FK)
  entitledByUserId  String?
  activatedByUserId String?
  suspendedByUserId String?
  updatedAt         DateTime @updatedAt

  @@unique([institutionId, moduleKey])
  @@unique([id, institutionId])      // referenceable with institutionId (tenancy §4)
  @@index([institutionId])
  @@map("institution_modules")
}
```

`NOT_ENTITLED` is modelled as the **absence of a row** — the state enum therefore holds
only the three states a row can be in (`ENTITLED | ACTIVE | SUSPENDED`), exactly as the
task requires. Reads treat "no row" as `NOT_ENTITLED`.

### 1.2 Why one row + enum, not two tables (entitlement + activation)

`database.md` §5.4 explicitly leaves this open ("Entitlement + activation may be one
table with a richer state enum — decide at implementation; the **states** in
`architecture.md` §5.2 are the contract"). The contract is the state machine, and the
state machine is **linear with a single current state** per `(institution, module)`:

- The four states are mutually exclusive points on one lifecycle; a module is never
  simultaneously "entitled" and "active" as independent facts — `ACTIVE` *implies*
  entitled. A two-table model (`ModuleEntitlement` + `ModuleActivation`) forces every
  reader to join two rows and re-derive the effective state from their combination,
  reintroducing exactly the "derive the truth from a join" fragility that `tenancy.md`
  rejected for A1. The enforcement hot path (`requireModuleActive`, once per GatePass
  request) must answer one question — "is this module `ACTIVE` for this tenant?" — and a
  single indexed row on `(institutionId, moduleKey)` answers it with one lookup.
- Entitlement is a platform concern and activation a tenant concern, but that split is a
  **write-authority** split, not a **storage** split: the design enforces it at the API
  layer (platform routes transition `absent↔ENTITLED`; tenant routes transition
  `ENTITLED↔ACTIVE↔SUSPENDED`), while the single row records the union of both with
  separate timestamps/actors so the history of each transition is preserved in place.
- A single row makes the unique constraint that guarantees "one state per module per
  institution" trivial (`@@unique([institutionId, moduleKey])`); two tables would need
  two such constraints plus cross-table consistency rules.

Tradeoff accepted: the single table mixes a platform-authored field (`entitledByUserId`)
with tenant-authored fields under tenant RLS. This is safe because the **platform write
path uses `privilegedPrisma`** (which bypasses RLS by design, exactly as it already does
for `support_grants` writes), while the **tenant read/activate path uses `withTenant`**
under RLS. The row is tenant-owned for *isolation* (an institution must only ever see
its own module states); platform writes to it are the same privileged-bypass pattern the
codebase already uses for other platform-owned-but-tenant-scoped data.

### 1.3 Ownership, isolation, and RLS (mirrors `superadmin_security` exactly)

`institution_modules` is **tenant-owned** (`tenancy.md` §3): a row belongs to exactly one
institution and an institution must never see another's module states.

- `institutionId` non-null; `@@index([institutionId])`.
- Composite FK to the tenant root so a row can never bind to another tenant's data, and
  the `(id, institutionId)` composite unique so it can itself be referenced later:
  ```sql
  ALTER TABLE "institution_modules"
    ADD CONSTRAINT "institution_modules_institution_same_tenant_fkey"
    FOREIGN KEY ("institutionId") REFERENCES "institutions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
  ```
  (The parent `institutions` is the tenant root; `institutionId` is the ownership column,
  so the FK is to `institutions(id)` — the same single-leg tenant-root FK the other
  tenant tables use. There is no *second* tenant-owned parent to make a two-leg composite
  FK against, so this matches the existing `notifications`/`audit_events` shape.)
- `ENABLE` + `FORCE` RLS with the **fail-closed `nullif`-guarded** policy pair, byte-for-
  byte in the style of `superadmin_security`'s `audit_events`:
  ```sql
  ALTER TABLE "institution_modules" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "institution_modules" FORCE  ROW LEVEL SECURITY;

  CREATE POLICY "tenant_isolation_select" ON "institution_modules"
    FOR SELECT
    USING ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));

  CREATE POLICY "tenant_isolation_modify" ON "institution_modules"
    FOR ALL
    USING     ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''))
    WITH CHECK ("institutionId" = nullif(current_setting('app.current_institution_id', true), ''));
  ```
  `nullif(current_setting(...,true),'')` fails closed for **both** an unset GUC and an
  empty-string GUC: `"institutionId" = NULL` is `NULL` (not `TRUE`), so no row is visible
  and no `WITH CHECK` passes. This is the exact guard the `superadmin_security` migration
  uses (the older `identity_rbac_b2` tables use the plainer `current_setting(...,true)`
  form; the `nullif` form is strictly stronger and is the current house style — the new
  table adopts it).

> **RLS policy-naming note for the escape meta-test.** This table carries the **standard
> pair** `{tenant_isolation_select, tenant_isolation_modify}` (it has a full modify path
> for the tenant, unlike `audit_events`/`support_grants` which are special-cased). So it
> uses `DEFAULT_POLICIES` in the escape harness — no new entry in `EXPECTED_POLICIES` is
> needed, only adding `"institution_modules"` to `RLS_TABLES` (§9).

- GRANT pin in the new migration (the live B-1 `GRANT ... ON ALL TABLES` +
  `ALTER DEFAULT PRIVILEGES` means `campass_app` already inherits DML on the new table;
  the tenant role legitimately needs full DML here because activation/suspension are
  tenant writes, so no REVOKE is required — unlike `audit_events`/`support_grants`):
  ```sql
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON "institution_modules" TO "campass_app";
    END IF;
  END $$;
  ```

---

## 2. Decision — module registry + dependency graph in `packages/shared`

Add a new `packages/shared/src/modules.ts` (exported from `index.ts` alongside
`permissions.ts`/`audit-actions.ts`), holding **known module-key constants** and the
**declared dependency graph**. Future module keys are declared as constants, never as
tables (`database.md` §5.4: "future keys declared as constants, NOT tables").

```ts
// packages/shared/src/modules.ts
export interface ModuleDef {
  key: string;
  name: string;
  description: string;
}

// Known module keys. Only campus_movement is operational in Phase 0; the rest are
// DECLARED so the dependency graph and future activation have stable keys. They are
// NOT seeded as entitlements and have NO tables yet.
export const MODULES = [
  { key: "campus_movement",   name: "Campus Movement", description: "GatePass / campus movement (Phase 0, operational)" },
  { key: "student_management", name: "Student Management", description: "SIS (future)" },
  { key: "academic_sessions",  name: "Academic Sessions", description: "Sessions/terms (future)" },
  { key: "class_course",       name: "Class & Course", description: "Classes/courses (future)" },
  { key: "student_enrollment", name: "Student Enrollment", description: "Enrollment (future)" },
  { key: "attendance",         name: "Attendance", description: "Attendance (future)" },
  { key: "examinations",       name: "Examinations", description: "Exams (future)" },
  { key: "fees",               name: "Fees", description: "Fees (future)" },
  { key: "library",            name: "Library", description: "Library (future)" },
] as const satisfies readonly ModuleDef[];

export type ModuleKey = (typeof MODULES)[number]["key"];
export const MODULE_KEYS: readonly ModuleKey[] = MODULES.map((m) => m.key);
export const MODULE_KEY_SET: ReadonlySet<string> = new Set<string>(MODULE_KEYS);

// Declared dependency graph (architecture.md §5.4): moduleKey -> required moduleKeys.
// A module may activate only when EVERY listed dependency is already ACTIVE.
// Phase-0 reality: campus_movement has NO deps. Future modules' edges are declared
// now so the MECHANISM is complete and tested, but their tables do not exist yet.
export const MODULE_DEPENDENCIES: Record<ModuleKey, readonly ModuleKey[]> = {
  campus_movement:    [],
  student_management: [],
  academic_sessions:  [],
  class_course:       [],
  student_enrollment: [],
  attendance:         ["student_management", "academic_sessions", "class_course"],
  examinations:       ["academic_sessions", "class_course", "student_enrollment"],
  fees:               ["student_management"],
  library:            [],
};
```

The dependency edges transcribe `architecture.md` §5.4 verbatim (Attendance → Student
Management + Academic Sessions + Class/Course; Examinations → Academic Sessions +
Class/Course + Student Enrollment; Fees → Student Management; Library → shared identity
only = no module deps).

### 2.1 Synthetic dependency for the dependency-validation test

`campus_movement` has no real dependencies, so a dependency-validation test cannot use it
directly. The test proves the **mechanism** using a declared future edge without needing
future tables: it uses `attendance` (which requires `student_management`,
`academic_sessions`, `class_course`). The test entitles `attendance` for a test
institution, leaves `student_management` **not active**, attempts `attendance`
activation, and asserts a `409` listing the missing deps; then it activates the three
deps and asserts `attendance` activation succeeds. Because this exercises only the
state table + graph (no attendance domain tables are read), it validates the dependency
mechanism exactly as required. This is called out explicitly so the reviewer can confirm
the "synthetic dependency" is a *declared real edge*, not a fabricated one — using a real
declared edge keeps the graph the single source of truth and avoids test-only constants.

> **Assumption A1.** The validation layer checks dependency `moduleKey`s against
> `InstitutionModule` **state only** (`ACTIVE`), not against the existence of the
> dependency's domain tables. For Phase 0 no future module's tables exist, which is fine
> because the test activates deps purely as state rows; a future phase that makes
> `student_management` real will add its tables independently. Flagged for review.

---

## 3. Decision — activation dependency validation (§5.4)

Validation lives in a new service function, the single owner of the state machine, so
every entry point (tenant activate route, future callers) shares one implementation:

```
apps/api/src/services/module-system.ts
```

Core transition rules (the invariant owner — see §8 for the layer-ownership rationale):

- **`activate(institutionId, moduleKey)`** (`ENTITLED → ACTIVE`, or `SUSPENDED → ACTIVE`
  re-activate): require the row exists and is `ENTITLED` or `SUSPENDED`; then apply the
  **single dependency-satisfaction predicate** below.

  **Dependency-satisfaction predicate (resolves review finding 3, MEDIUM — one rule for
  both first activation and reactivation):**

  > A declared dependency `d ∈ MODULE_DEPENDENCIES[moduleKey]` **satisfies** activation
  > **iff** the institution has an `InstitutionModule` row for `d` **and** that row's
  > `state = ACTIVE`. `missingDependencies` lists **every** declared dependency whose row
  > is **absent, or whose `state` is not `ACTIVE` (i.e. `ENTITLED` or `SUSPENDED`)**.

  This predicate is applied **identically** on `ENTITLED → ACTIVE` and `SUSPENDED →
  ACTIVE`: a dependency that is itself `SUSPENDED` (or merely `ENTITLED`, or absent) is
  **not** satisfied and **is** listed in `missingDependencies`. An implementer must not
  treat "missing" as "no row only" — the test (§9.2) pins a `SUSPENDED` dependency as a
  cause of a 409. If any dependency fails the predicate, return a structured failure
  listing the unmet keys; the route maps it to **`409 Conflict`**:
  ```json
  { "error": "Module dependencies not satisfied",
    "moduleKey": "attendance",
    "missingDependencies": ["student_management", "academic_sessions"] }
  ```
  On success set `state = ACTIVE`, `activatedAt = now()`, `activatedByUserId = actor`,
  clear `suspendedAt`.

Validation runs server-side **before** the state flips, inside the same `withTenant`
transaction as the write, so the dependency read and the state write are atomic (no
race where a dep is suspended between check and write — both observe one tenant
transaction).

Dependency reads are scoped to the same institution via the tenant GUC (RLS guarantees
the dependency rows read are the caller's own — a cross-tenant dependency can never
satisfy activation).

**Transitive dependency satisfaction is inductive (resolves review finding 7, NIT).**
`activate()` checks only the **direct** declared dependencies in
`MODULE_DEPENDENCIES[moduleKey]`, not the transitive closure. This is sufficient and
correct **by induction**: a dependency `d` can only be `ACTIVE` if, at *its own*
activation, all of *its* direct dependencies were `ACTIVE` — and so on down to leaf
modules with no dependencies. So if every declared dependency of `moduleKey` is `ACTIVE`,
their own dependencies are necessarily `ACTIVE` too, and the whole transitive closure is
satisfied without a transitive walk. This invariant holds **only while every activation
path runs this predicate**: there must be **no "force activate" / bypass path** that sets
`state = ACTIVE` without the dependency check (not on the route, not in the service, not
in a future admin tool). Any such bypass would break the inductive guarantee and let a
module be `ACTIVE` with an inactive transitive dependency. The §9.4 acyclicity test
guarantees the induction terminates (no cycle makes activation impossible).

**Future required-config seam (resolves review finding 6, NIT).** `architecture.md` §5.3
lists "Required configuration completed" as an activation step. Phase 0 satisfies it by
assertion A5 (no Phase-0 module declares required config). `activate()` is the **single
seam** where a future `requiredConfigSatisfied(moduleKey, settings)` check will plug in —
immediately after the dependency predicate passes and before the state flips to `ACTIVE`,
reading the row's `settings` JSON (§1.1). This is documented here so a future module with
required config extends `activate()` at this one point rather than requiring surgery or a
second activation path (which would also risk the force-activate bypass warned about
above). No Phase-0 code implements the check; the extension point is named.

---

## 4. Decision — suspend / deactivate behavior (§5.5)

Two tenant-admin operations, both state transitions on the existing row (history
preserved — the row is updated in place, never deleted; timestamps accumulate):

- **`suspend(institutionId, moduleKey)`** (`ACTIVE → SUSPENDED`): set `state =
  SUSPENDED`, `suspendedAt = now()`, `suspendedByUserId = actor`. The row and all module
  domain data (gate passes, events, etc.) are left intact. After this, operational routes
  reject (via `requireModuleActive`, §7); module-specific scheduled jobs stop their
  operational work (Phase 0 has no such job for `campus_movement` beyond the pass-expiry
  path; the gate is the enforcement point and is documented as the mechanism future
  jobs check — see Assumption A3).
- **Reactivate** is the same `activate()` path from `SUSPENDED → ACTIVE` (re-runs the
  §3 dependency-satisfaction predicate, so a module cannot be reactivated while any
  dependency is not `ACTIVE` — a `SUSPENDED` or `ENTITLED` dependency fails the predicate
  and appears in `missingDependencies`, identical to first activation).

There is **no hard "deactivate to ENTITLED"** transition exposed as a destructive drop:
"disabling" a module is `SUSPENDED` (data preserved), per §5.5. Revocation of the
entitlement entirely is the platform's job (§6), and the platform revoke path is itself
guarded against orphaning active dependents (§6.2).

**Dependent warnings (§5.5 — "dependents warned, never silently break").** When a module
is suspended (tenant) or its entitlement revoked (platform), the operation computes the
set of **dependent modules that declare the target as a dependency and are currently
`ACTIVE` or `SUSPENDED`** (reverse edges of `MODULE_DEPENDENCIES`, intersected with this
institution's `ACTIVE`+`SUSPENDED` rows — see finding-2 resolution below for why
`SUSPENDED` is included) and returns them as a non-fatal `warnings.affectedDependents`
**array** in the success response body. The operation still succeeds (suspension is a
deliberate admin action); the warning makes the blast radius explicit rather than
silent. For Phase 0 `campus_movement` has no dependents, so the array is empty in
practice, but the mechanism is implemented and unit-tested against the declared graph
(e.g. suspending `student_management` while `fees`/`attendance` are `ACTIVE`/`SUSPENDED`
warns about them). This keeps §5.5's "never a silent break" guarantee as real behavior,
not a TODO.

**Audit persistence of the dependent set (resolves review finding 1, HIGH).** The
response body carries `affectedDependents` as an array, but the **audit metadata must
not** — `apps/api/src/services/audit.ts`'s `sanitizeMetadata` copies only scalar
`string | number | boolean | null` values and **silently drops arrays and objects**
(verified: the `for` loop has no array branch, comment "objects, arrays, functions,
symbols, undefined, bigint: dropped"). An `affectedDependents: [...]` metadata field
would therefore never reach the persisted audit row, defeating the §5.5 "never a silent
break" guarantee for the permanent trail. Every suspend/revoke audit call therefore
serializes the set to **two scalar fields** that survive the sanitizer:

```ts
metadata: {
  affectedDependents: dependents.join(","),   // "" when none; "fees,attendance" otherwise
  affectedDependentsCount: dependents.length,  // 0 when none
}
```

Approach (a) from the review (serialize to a scalar) is chosen over (c) (extend
`sanitizeMetadata` to allow shallow scalar arrays) deliberately: `sanitizeMetadata` is a
shared, security-sensitive writer used by every audit path, and widening its allow-list
would be a cross-cutting change requiring its own regression test and risking leakage of
unanticipated array payloads elsewhere. A join-to-scalar at the two call sites is local,
lower-risk, and self-documenting. The count field is added so a reader can distinguish
"no dependents" (`count=0`, `affectedDependents=""`) from a future parsing ambiguity. The
§9.2 test asserts the **persisted audit row** (re-read from the DB), not just the
response body, carries `affectedDependents`/`affectedDependentsCount`.

> **Assumption A2.** Phase 0 does **not** cascade-suspend dependents (it warns, does not
> auto-suspend). `architecture.md` §5.4/§5.5 say "produce an explicit dependency
> warning, never a silent break" — a warning, not a forced cascade. Auto-cascade is
> deliberately out of scope to avoid an admin unexpectedly losing an unrelated-looking
> module; flagged for review in case the reviewer reads §5.5 as requiring cascade.

---

## 5. Decision — backfill plan (critical safety)

Wiring real `requireModuleActive` enforcement onto the GatePass routes **will 403 every
GatePass route** for any institution that has no `ACTIVE` `campus_movement` row. As
finding 2 makes precise (§0), the 403 risk materializes at the **wiring** step, not the
stub-body rewrite — the stub rewrite alone changes nothing because the guard is wired onto
no routes today. The backfill is therefore load-bearing and must land **in the same
migration** that introduces the table, and that migration together with the route
**wiring** must ship in **one deployable**, with `migrate deploy` running before the API
boots so the backfill is present before any wired route serves traffic.

> **Hard ordering constraint (resolves review finding 2, MEDIUM).** The following three
> changes are a single atomic unit of delivery and must not be split across deploys:
> (1) the backfill migration (`CREATE TABLE` + RLS + the per-institution `campus_movement`
> ACTIVE backfill + the invariant guard, §5.1); (2) the real `requireModuleActive` body
> (§7); and (3) the **wiring** of `requireModuleActive("campus_movement")` onto the
> `campus_movement.*` routes (§7.3). Because `migrate deploy` runs before the API process
> boots (`database.md`), step (1) is guaranteed present before steps (2)+(3) serve a
> single request. Shipping (3) in a later deploy than (1) — or shipping (1) without (3) —
> is a correctness error: (3)-before-(1) would 403 live traffic; (1)-before-(3) in
> separate deploys is harmless but defeats the point of co-shipping and invites a window
> where the two drift. The invariant guard in §5.1 is the backstop that aborts the deploy
> if (1) did not fully populate before (2)+(3) go live.

### 5.1 In the migration (new `institution_modules` migration)

After `CREATE TABLE` + constraints + RLS, seed one `campus_movement` row per existing
non-platform institution, `state = ACTIVE`, idempotently:

```sql
-- Backfill: every existing non-PLATFORM institution gets campus_movement ENTITLED+ACTIVE
-- (both entitledAt and activatedAt set) so the real requireModuleActive does not 403 live
-- GatePass traffic the moment it ships. Idempotent (ON CONFLICT on the unique pair).
INSERT INTO "institution_modules"
  ("id","institutionId","moduleKey","state","entitledAt","activatedAt","updatedAt")
SELECT 'imod_' || gen_random_uuid()::text, i."id", 'campus_movement', 'ACTIVE',
       now(), now(), now()
FROM "institutions" i
WHERE i."code" <> 'PLATFORM'
ON CONFLICT ("institutionId","moduleKey") DO NOTHING;
```

The PLATFORM institution (code `'PLATFORM'`, the SUPER_ADMIN scope) is excluded — it has
no tenant GatePass traffic and is never module-gated, exactly as `identity_rbac_b2`
excludes it from memberships.

> **Definition-of-tenant note (resolves review finding 3, NIT).** Both the backfill INSERT
> and the invariant guard use `i."code" <> 'PLATFORM'` as the **deliberate, sole
> definition of "tenant institution" for Phase 0**. Verified: `seed.ts` creates exactly
> one PLATFORM institution, so this holds today. The platform create-institution route
> (`platform.ts POST /institutions`) lets an operator pick any `code` and nothing enforces
> a single non-tenant institution, so this is an explicit assumption, not an invariant:
> **any future non-tenant / platform-like institution must be added to this `code <>
> 'PLATFORM'` exclusion** (or the exclusion re-keyed onto a dedicated status/flag column)
> or it would be wrongly backfilled an `ACTIVE campus_movement` row and wrongly required
> by the guard. Keeping the literal `code <> 'PLATFORM'` is acceptable for Phase 0 because
> PLATFORM is the only non-tenant institution; the assumption is pinned here so a later
> phase does not silently violate it.

> **Id-format note (review finding 5, NIT — acknowledged as-is).** Backfilled rows get
> `'imod_' || gen_random_uuid()` ids while seed/runtime rows get Prisma `cuid()`s. The
> `id` column is plain `TEXT`, so both forms are valid and unique, and this matches the
> `identity_rbac_b2` precedent (`'mbr_' || gen_random_uuid()`). The `imod_` prefix is
> **backfill-only and semantically meaningless** — nothing keys on it, and it must never
> be treated as a discriminator between backfilled and runtime-created rows. Kept as-is
> to match precedent.

A backfill invariant guard aborts the deploy if any non-platform institution is left
without an `ACTIVE campus_movement` row (same `RAISE EXCEPTION` style the other
migrations use), so a partial backfill can never ship a silently-403ing deploy:

```sql
DO $$
DECLARE missing INT;
BEGIN
  SELECT count(*) INTO missing
  FROM "institutions" i
  WHERE i."code" <> 'PLATFORM'
    AND NOT EXISTS (
      SELECT 1 FROM "institution_modules" m
      WHERE m."institutionId" = i."id"
        AND m."moduleKey" = 'campus_movement'
        AND m."state" = 'ACTIVE'
    );
  IF missing > 0 THEN
    RAISE EXCEPTION 'module-system backfill invariant violated: % institution(s) lack an ACTIVE campus_movement row; aborting deploy', missing;
  END IF;
END $$;
```

### 5.2 In the seed script (`packages/db/src/seed.ts`)

Mirror the backfill so a freshly-seeded dev/test DB has `campus_movement` `ACTIVE` for
every demo tenant: add an idempotent upsert (`where: { institutionId_moduleKey }`,
`create` state `ACTIVE` with both `entitledAt` and `activatedAt` timestamps, `update: {}`)
right after memberships are ensured. **Iterate the demo tenant `institution` object(s)
the seed itself created (resolves review finding 9, NIT)** — not a `findMany` over
`institutions`, and not a copy of the migration's `WHERE code <> 'PLATFORM'` query form.
The seed runs **before** any platform-created tenants exist, so the only non-PLATFORM
institution present is the demo `institution` the seed constructed (verified: `seed.ts`
creates exactly the PLATFORM institution plus the single demo tenant `institution`, and
already excludes `superadmin`/PLATFORM from membership backfill). Upserting against that
concrete object (and never the PLATFORM institution) is both correct and clearer than
re-deriving a non-PLATFORM set. This keeps the escape suite and the GatePass regression
suites green (they authenticate as real tenant users whose routes are now module-gated).

> **Assumption A4.** Migration order: this new migration runs **after**
> `superadmin_security` (it is the latest by timestamp, verified by directory listing).
> The enforcement change that actually introduces 403 behavior is the **route wiring** of
> `requireModuleActive("campus_movement")` (§7.3), not the stub-body rewrite (which is
> inert until wired — finding 2). The hard ordering constraint above binds specifically to
> that wiring: the backfill migration **and** the route wiring ship in the **same**
> deployable, and `prisma migrate deploy` runs before the API boots (per `database.md`),
> so the backfill is present before any wired, enforcing route serves traffic. Flagged for
> review.

---

## 6. Decision — platform + institution endpoints

### 6.1 Platform endpoints (`apps/api/src/routes/platform.ts`)

Registered inside `platformRoutes` (already gated by `requireSuperAdmin()` +
`requirePlatformMfa()` at the plugin level), each additionally guarded by
`requirePermission('platform.entitlements.manage')` (the permission already exists in
the catalogue). All writes use `privilegedPrisma` (platform is cross-tenant by design and
must not fail closed under RLS — same pattern as the existing platform routes). Each
writes a platform audit event (`institutionId` set to the target tenant so it is also
visible in that tenant's Audit Explorer, matching how `support_grant.*` events are
scoped; `actorMembershipId` null for the platform actor).

- `POST /platform/institutions/:id/modules` — **grant entitlement**: body
  `{ moduleKey }`. Validate `moduleKey ∈ MODULE_KEY_SET` (else 400) and institution
  exists (else 404). Upsert the `(institutionId, moduleKey)` row: create `state =
  ENTITLED` with `entitledAt`, `entitledByUserId`; if a row already exists in `ENTITLED`/
  `ACTIVE`/`SUSPENDED`, it is a no-op idempotent 200 (re-granting an entitled module
  changes nothing). Audit `platform.module.entitled`.
- `DELETE /platform/institutions/:id/modules/:moduleKey` — **revoke entitlement**:
  transitions the module to `NOT_ENTITLED` by **deleting the row** (absence = not
  entitled, §1.1). Guarded: refuse (**409**) if any module in that institution that is
  currently `ACTIVE` **or `SUSPENDED`** declares `:moduleKey` as a dependency, returning
  the affected dependents as `missingFor`/`affectedDependents`. **The dependent-scan query
  is `privilegedPrisma.institutionModule.findMany({ where: { institutionId: id } })`, and
  the `where: { institutionId: id }` filter is MANDATORY and load-bearing (resolves review
  finding 4, NIT)** — identical to the GET-list fix below: because this route runs on
  `privilegedPrisma` (RLS-bypassed, platform is cross-tenant), an unfiltered `findMany`
  would scan **every tenant's** module rows and could block a revoke on *another* tenant's
  dependent (a cross-tenant leak + a spurious 409). The guard therefore considers only the
  target institution's rows, computed over the reverse edges of `MODULE_DEPENDENCIES`. A
  §9.2 test asserts the revoke guard only considers the target institution's dependents
  (a dependent of the same `moduleKey` in a *different* institution must not block or
  appear). The `SUSPENDED` case is
  included deliberately (resolves review finding 2, MEDIUM): a `SUSPENDED` dependent can
  be reactivated later, and reactivation (§3/§4) re-runs dependency validation requiring
  every dependency to be `ACTIVE`; revoking a dependency while a dependent is `SUSPENDED`
  would leave that dependent **permanently un-reactivatable with no warning at revoke
  time** — the exact later-in-time silent break §5.5 forbids. Blocking the revoke (or at
  minimum surfacing the `SUSPENDED` dependents in the guard) keeps the admin informed.
  **Chosen behavior:** the guard **blocks (409)** on both `ACTIVE` and `SUSPENDED`
  dependents, because revoke is a destructive platform action and the platform operator
  should re-grant/clear the dependent relationship first; the 409 body lists the blocking
  dependents and their states so the operator knows what to clear. On a clean revoke (no
  `ACTIVE`/`SUSPENDED` dependents) the operation proceeds, includes the (empty for a leaf
  like `campus_movement`) dependent-warning array in the response, and audits
  `platform.module.revoked` with `affectedDependents`/`affectedDependentsCount` scalars in
  metadata (per finding-1 serialization). History note: revoking removes the *state* row
  but never the module's domain data (§5.5 preserve-history); domain tables are untouched.
- `GET /platform/institutions/:id/modules` — **list an institution's modules**: returns
  every `MODULES` key with its effective state for that institution (`NOT_ENTITLED` where
  no row exists), so the platform operator sees the full matrix. **Effective-state
  derivation (resolves review finding 4, MEDIUM):** iterate the **static `MODULES`
  catalogue** (never the DB rows) so `NOT_ENTITLED` keys are never dropped; for each key
  look up the institution's row in a map built from
  `privilegedPrisma.institutionModule.findMany({ where: { institutionId: id } })`. The
  `where: { institutionId: id }` filter is **mandatory and load-bearing**: because
  `privilegedPrisma` bypasses RLS, a `findMany` without it would return **every tenant's**
  module rows — the exact cross-tenant leak this read is most at risk of. Default any
  catalogue key with no matching row to `NOT_ENTITLED`.

### 6.2 Institution endpoints (`apps/api/src/routes/admin.ts`)

Registered inside `adminRoutes` (top-level `authenticate` hook already runs). A **new
tenant permission `admin.modules.manage`** gates the write operations (see §8 for why a
new permission rather than reusing an existing admin key). All reads/writes go through
`withTenant` (tenant-scoped, RLS-enforced). Each writes a tenant audit event via
`recordAuditEvent(input, tx)` inside the same `withTenant` transaction (atomic with the
state write, exactly as GatePass routes audit).

- `POST /admin/modules/:moduleKey/activate` — **activate**: `requirePermission(
  'admin.modules.manage')`. Runs `activate()` (§3): validates row is `ENTITLED`/
  `SUSPENDED` (404 if no row / not entitled; 409 if dependencies unmet with
  `missingDependencies`), flips to `ACTIVE`. Audit `admin.module.activated`.
- `POST /admin/modules/:moduleKey/suspend` — **suspend/deactivate**: `requirePermission(
  'admin.modules.manage')`. Runs `suspend()` (§4): `ACTIVE → SUSPENDED`, returns
  `affectedDependents` warnings, preserves history. Audit `admin.module.suspended`.
- `GET /admin/modules` — **list own modules + states**: `requirePermission(
  'admin.modules.manage')` (read is admin-only; it exposes the institution's module
  posture). Returns every `MODULES` key with the institution's effective state
  (`NOT_ENTITLED` where no row). **Effective-state derivation (resolves review finding 4,
  MEDIUM):** iterate the **static `MODULES` catalogue**; for each key look up the row in a
  map built from a `withTenant` `findMany` with **no explicit filter** — RLS scopes it to
  the caller's own institution, so no `institutionId` filter is needed or appropriate here
  (adding one would be redundant; omitting it is the RLS-first convention). Default any
  catalogue key with no matching row to `NOT_ENTITLED`. The merge direction (iterate
  `MODULES`, not DB rows) matches the platform list so the two endpoints return the same
  full matrix shape.

The activation flow in `architecture.md` §5.3 (grant → activate → dependency check →
config → permissions-to-roles → ACTIVE) is honored: the "required configuration" and
"permissions assigned to roles" steps are already satisfied for `campus_movement` (its
permissions ship in the catalogue and are bound to template roles by `identity_rbac_b2`);
the `settings` JSON column is the hook for future per-module required config, left
optional/nullable for Phase 0 (Assumption A5: no module currently declares required
config, so activation does not block on config — flagged for review).

---

## 7. Decision — `requireModuleActive` real enforcement

Replace the stub in `apps/api/src/services/authz-engine.ts`. The guard is a preHandler
that runs **after** the top-level `authenticate` hook (so `request.auth`/`request.user`
are populated) and **in addition to** the per-route `requirePermission` guards on the
GatePass tenant routes.

Two signature/import changes accompany the rewrite (both additive, no behavior change
elsewhere): `authz-engine.ts` gains `import { privilegedPrisma } from "@campusgate/db"`
and `import type { ModuleKey } from "@campusgate/shared"`, and the exported
`requireModuleActive` parameter type narrows from the stub's `_moduleKey: string` to
`moduleKey: ModuleKey`. Every current call site already passes the string literal
`"campus_movement"`, which is a valid `ModuleKey`, so the narrowing is source-compatible
with existing (and new) wiring and costs no call-site edits beyond the new wiring in §7.3.

### 7.1 How it reads state

The guard needs the module state for `request.auth.institutionId`. Two viable reads:

- **(a)** a short `withTenant` transaction reading its own `InstitutionModule` row under
  RLS, or
- **(b)** a `privilegedPrisma` point read filtered by `institutionId` + `moduleKey`.

**Choose (b): a `privilegedPrisma` read filtered explicitly by the request's
`institutionId`.** Reasoning: the guard runs once per request and must be cheap and
robust; it is a *gate*, not tenant business data mutation. Each GatePass handler already
opens its own `withTenant` transaction for the actual work, so opening a *second*
transaction in the preHandler just to read one row doubles the transaction count on the
hot path and risks pool pressure on the already-latency-sensitive Supabase pooler
(`database.md` known-issue note). The read is a single indexed lookup on
`(institutionId, moduleKey)` where `institutionId` comes **only** from the verified token
(never request input), so there is no cross-tenant risk: the query hard-filters the one
institution the caller is already authenticated into. This mirrors how `authenticate`
itself uses `privilegedPrisma` for the membership/session reads that gate every request.

**Reliability interaction with the documented Supabase P1001 (review finding 7, NIT —
acknowledged).** This guard adds one `privilegedPrisma` point read to **every** GatePass
request and fail-closes to **500** on any throw (§7.2). `database.md` §2 records a KNOWN
ISSUE: the Supabase `ap-south-1` pooler intermittently throws `P1001` locally (≈1 in 6).
If production exhibits the same P1001, this guard converts a transient DB hiccup into a
hard 500 on live GatePass traffic with no retry. The fail-closed-500 choice is
**intentional and correct for security** (never silently allow when module state is
unknowable). The mitigation, if production confirms P1001 — per `database.md`'s
"measure in production" plan and its already-deferred retry-wrapper decision — is a
**bounded retry/backoff around this specific read**. No retry code is added now; the link
is recorded here so the interaction is not a surprise when production metrics arrive.

```ts
export function requireModuleActive(moduleKey: ModuleKey) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.auth) {                       // wiring bug — same defensive branch as requirePermission
      request.log.error({ moduleKey, url: request.routeOptions?.url }, "requireModuleActive: request.auth unset");
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const { institutionId } = request.auth;    // from the verified token ONLY
    let row;
    try {
      row = await privilegedPrisma.institutionModule.findUnique({
        where: { institutionId_moduleKey: { institutionId, moduleKey } },
        select: { state: true },
      });
    } catch (err) {
      request.log.error({ err, moduleKey, institutionId }, "requireModuleActive: state read failed");
      return reply.status(500).send({ error: "Module state unavailable" });  // fail CLOSED
    }
    if (!row || row.state !== "ACTIVE") {
      request.log.info({ moduleKey, institutionId, state: row?.state ?? "NOT_ENTITLED" },
        "requireModuleActive: denied — module not active");
      return reply.status(403).send({ error: `Module not active: ${moduleKey}` });
    }
  };
}
```

### 7.2 Error / status contract

- Not `ACTIVE` (no row = `NOT_ENTITLED`, or `ENTITLED`/`SUSPENDED`) → **403**
  `{ error: "Module not active: <key>" }`, logged at `info`. (403, not 409: the caller
  is authenticated and permitted but the module is off for their tenant — an access
  decision, consistent with `requirePermission`'s 403. 409 is reserved for the
  *activation* dependency-conflict case in §3, where the request is a state transition
  that conflicts with current state.)
- State read throws (DB/connectivity) → **500** `{ error: "Module state unavailable" }`,
  logged at `error`, **fail-closed** (no silent allow). Recoverable by retry; not fatal
  to the process.
- `request.auth` unset → **401**, logged at `error` (wiring bug, identical to
  `requirePermission`'s defensive branch).

### 7.3 Wiring

Add `requireModuleActive("campus_movement")` to the `preHandler` array of every GatePass
**operational tenant route** on `student.ts`, `hod.ts`, `guard.ts`, and the GatePass
operational routes on `admin.ts`, **alongside** the existing `requirePermission(...)`
(order: `requirePermission` first, then `requireModuleActive`, so a caller lacking the
permission is 403'd on permission before a module probe runs — minor, both are 403, but
keeps the cheaper pure-check first). The base rule is: every route whose permission key is
in the `campus_movement.*` namespace gets the guard — **except the one named carve-out
below**.

**This wiring step is the point at which enforcement begins** (finding 2): the guard is
wired onto zero routes today, so until this step lands the real guard body is inert. This
step must therefore ship in the **same deployable** as the backfill migration (§5's hard
ordering constraint), never in a separate deploy.

> **Full `campus_movement.audit.view` / `campus_movement.analytics.view` call-site audit
> (resolves review finding 1, MEDIUM — must be done before wiring).** The namespace rule
> (A6) was verified against **every** call site in the codebase, not just the pass/gate/
> emergency routes, because `audit.view`/`analytics.view` are attached to routes that are
> *not* all Campus Movement operations. Verified call sites (`grep campus_movement.audit.view|campus_movement.analytics.view`):
>
> | Route (admin.ts) | Permission | Operational Campus-Movement route? | Gated? |
> | --- | --- | --- | --- |
> | `GET /stats` | `campus_movement.analytics.view` | yes (movement dashboard) | **yes** |
> | `GET /analytics` | `campus_movement.analytics.view` | yes (movement analytics) | **yes** |
> | `GET /audit-logs` | `campus_movement.audit.view` | yes (movement audit log) | **yes** |
> | `GET /support-grants` | `campus_movement.audit.view` | **no — break-glass/support surface** | **NO (carve-out)** |
>
> `GET /support-grants` (verified at `admin.ts` ~line 2012) reads the platform
> `support_grants` table — a break-glass/support-visibility surface that has nothing to do
> with Campus Movement operations and happens to share the `campus_movement.audit.view`
> read key with the movement audit log. Under the bare A6 namespace rule it would be
> gated, so suspending `campus_movement` would hide support-grant visibility from the
> tenant admin — a security surface silently suppressed for an unrelated reason. That is
> **not** acceptable (unlike emergency-view, which is argued as intended wholesale
> suspension below).
>
> **Chosen fix — option (a), a named per-route exception.** `GET /support-grants` is
> **excluded from `requireModuleActive`** even though its permission is
> `campus_movement.audit.view`. This is the same per-route-exception mechanism reserved
> for a future emergency carve-out. Option (b) (re-key the route to `admin.support.revoke`)
> is rejected: that key is the *write* permission for revoking a grant, and reusing it as
> the *read* gate would silently widen who can read support grants (anyone with revoke)
> and conflate read/write authority — a semantic regression. Option (c) (accept the
> suppression) is rejected because support-grant visibility is a security/break-glass
> surface, not a Campus Movement operation, so suppressing it on module suspension is a
> real gap, not an intended product behavior. The carve-out is implemented as a small
> explicit allow-list of `(method, url)` pairs the wiring step consults so the exclusion
> is auditable in one place rather than scattered.

**Explicitly NOT module-gated:**

- Platform routes (`platform.ts`) — cross-tenant, pre-tenant; never module-gated.
- Pre-auth routes (`auth.ts` login/register, public `/departments`, the MFA enrollment
  routes) — they run before a tenant/permission context exists.
- The new module-management routes themselves (`admin.modules.*`, `platform ... modules`)
  — gating module management on the module being active would be circular (you could
  never activate a suspended module). They are permission-gated only.
- The `admin.*` institution-administration routes that are **not** `campus_movement.*`
  (user management, departments, gates config, etc.) — these are institution-admin
  platform-foundation operations, not Campus Movement operational routes, so they are not
  gated on `campus_movement` being active. (A GatePass-specific admin route such as
  analytics/audit for campus movement **is** gated, because its permission is
  `campus_movement.*`.)
- **`GET /admin/support-grants`** — the named carve-out from finding 1: although keyed
  `campus_movement.audit.view`, it is a break-glass/support-visibility surface (reads the
  platform `support_grants` table), not a Campus Movement operation, so it is excluded
  from the gate via the `(method, url)` allow-list described above.

> **Assumption A6.** The boundary "gate a route iff its permission is in the
> `campus_movement.*` namespace, minus the named `GET /support-grants` carve-out" is the
> rule used to decide wiring. Admin routes that operate GatePass data and are keyed
> `campus_movement.analytics.view` / `campus_movement.audit.view` are gated (`/stats`,
> `/analytics`, `/audit-logs`); the one route whose permission is in the namespace but
> whose *purpose* is not a Campus Movement operation — `GET /support-grants` (break-glass/
> support visibility) — is **excluded** (finding 1). Admin routes keyed `admin.*` are not
> gated. The full call-site audit above is the authority for which routes fall in the
> namespace; the rule must not be applied by pattern-matching the key alone without
> checking a route's purpose against that table. This keeps "module active" tied to the
> module the route actually operates, not merely the namespace of its permission.
>
> **Emergency-view consequence (review finding 6, NIT — acknowledged, intentional).** The
> emergency-view routes (`GET /admin/emergency/active` and the student/guard emergency
> views, all keyed `campus_movement.emergency.view`, verified in `admin.ts`) fall inside
> the `campus_movement.*` namespace and are therefore **gated on module activity**:
> suspending `campus_movement` hides an active emergency from staff. This is the
> **intended** behavior for Phase 0 — suspension disables the module **wholesale**, and
> there is no partial "operational-off but emergency-on" state. Suspension of a live
> tenant's only operational module is not a normal path; if product later wants emergency
> visibility to survive suspension, carve `campus_movement.emergency.view` out of the
> gating rule (a per-route exception), but that is explicitly **out of scope** here and
> would need its own product decision.

> **Assumption A7 (SUPER_ADMIN).** SUPER_ADMIN never carries `campus_movement.*`
> permissions and its `request.tenant` is intentionally unset (per `identity_rbac_b2`
> design), so it cannot reach a module-gated tenant route anyway; no special-casing of
> SUPER_ADMIN inside `requireModuleActive` is needed. The task says platform/SUPER_ADMIN
> routes are not module-gated — satisfied by *not wiring the guard onto platform routes*,
> not by a branch in the guard. Flagged for review.

---

## 8. Decision — audit keys + catalogue sync; invariant ownership

### 8.1 New audit action keys (`packages/shared/src/audit-actions.ts`)

Add to `AUDIT_ACTIONS` (string `<module>.<action>`; no pg enum, no migration mirror for
audit actions — validation is in `recordAuditEvent`, exactly as the existing catalogue):

```
platform.module.entitled    — platform granted a module entitlement to an institution
platform.module.revoked     — platform revoked a module entitlement
admin.module.activated       — institution activated a module
admin.module.suspended       — institution suspended a module
```

These follow the established `platform.*` / `admin.*` grouping. The audit-actions
meta-test (`audit-actions.test.ts`) already asserts key shape/uniqueness generically, so
it continues to pass with the additions; the legacy-enum map is untouched (these are new,
not legacy-mapped).

> **Segment-reading note (resolves review finding 5, NIT — no change required).** These
> four keys are **3-segment** `<module>.<resource>.<action>` keys, matching the catalogue
> convention (`platform.support_grant.created`, `admin.user.created`,
> `campus_movement.pass.approved`) — the `resource` segment is literally the word
> `module` (`platform`.`module`.`entitled`, `admin`.`module`.`activated`, etc.). They are
> **not** 2-segment keys. The shape regex `^[a-z_]+(\.[a-z_]+)+$` accepts them (verified),
> so the meta-test passes. The note is recorded so a reviewer does not mistake the
> `resource = module` segment for a 2-segment key; the keys are kept as designed.

### 8.2 New permission key (`packages/shared/src/permissions.ts`)

Add one tenant permission and bind it to the `ADMIN` template role:

```
admin.modules.manage  (module "admin") — Activate / suspend / view the institution's modules
```

Add `"admin.modules.manage"` to `PERMISSIONS` and to `ROLE_PERMISSIONS.ADMIN`. The
`platform.entitlements.manage` permission **already exists** and is already bound to
`SUPER_ADMIN`, so no platform permission is added — only the tenant one.

**Why a new permission, not reuse of an existing admin key:** module activation is a
distinct capability (turning a whole module on/off for the institution) with a different
blast radius than, say, `admin.gates.manage`; `identity-rbac.md` §6 is explicit that
permissions are action-level and modules declare their own. A dedicated key lets a future
institution policy grant module management without granting every admin capability.

### 8.3 Keeping catalogue-sync green (the established union pattern)

`catalogue-sync.test.ts` parses the **seeding migrations'** `INSERT INTO "permissions"`
and `INSERT INTO "role_permissions"` blocks and asserts set-equality against
`PERMISSION_KEYS` + `ROLE_PERMISSIONS` from `@campusgate/shared`, **unioned across**
`SEEDING_MIGRATION_DIRS`. The new migration therefore must:

1. Seed `admin.modules.manage` into `permissions` and its `('ADMIN','admin.modules.manage')`
   pair into `role_permissions`, using the **exact block markers** the parser keys on
   (`INSERT INTO "permissions" ... ON CONFLICT`, `INSERT INTO "role_permissions" ... AS m(`),
   idempotently (`ON CONFLICT DO NOTHING`) — the same shape `superadmin_security` used for
   `admin.support.revoke`.
2. Add the new migration dir to `SEEDING_MIGRATION_DIRS` in `catalogue-sync.test.ts` so
   the union includes it.

This is the exact mechanism the task calls "the established union pattern". Audit action
keys need **no** migration mirror (no enum/seed), so only permissions require the
migration seed + the test-dir addition.

### 8.4 Invariant ownership (which layer owns what, and why)

- **"At most one state per `(institution, module)`"** — owned by the **database**
  (`@@unique([institutionId, moduleKey])`). The DB is the only place that can enforce
  uniqueness under concurrent writes.
- **"A tenant only ever reads/writes its own module rows"** — owned by the **database**
  (RLS `FORCE` + fail-closed policies), with the tenant-scoped client as the first layer
  (`tenancy.md` §6.3 two-layer rationale). Application code cannot be trusted alone.
- **"Legal state transitions only" (ENTITLED↔ACTIVE↔SUSPENDED; deps ACTIVE before
  ACTIVE)** — owned by the **service layer** (`module-system.ts`), because it is business
  logic over multiple rows (the module + its dependencies) that SQL constraints cannot
  express cleanly. It runs inside the tenant transaction so its reads and the write are
  atomic. This is the correct layer: the DB owns *structural* invariants, the service
  owns the *state-machine* invariant.
- **"Write authority split" (platform grants/revokes; tenant activates/suspends)** —
  owned by the **API/route layer** via which client + permission guards a route uses
  (`platform.ts` + `privilegedPrisma` + `platform.entitlements.manage`; `admin.ts` +
  `withTenant` + `admin.modules.manage`). Enforced by routing, not by a DB column.

---

## 9. Decision — test plan

All tests use Vitest, matching the existing suites. Three groups:

### 9.1 Escape suite extension (real DB, `apps/api/src/routes/__tests__/tenant-escape*`)

Extend the existing cross-tenant escape suite + its setup helper
(`helpers/tenant-escape-setup.ts`) to cover `institution_modules`:

- Add `"institution_modules"` to `RLS_TABLES` (so the meta-test §6 asserts
  `ENABLE`+`FORCE` RLS + the standard policy pair are present — it falls under
  `DEFAULT_POLICIES`, no `EXPECTED_POLICIES` entry needed).
- Seed each tenant (A and B) a `campus_movement` `institution_modules` row (via the
  RLS-bypassing `adminClient`) and capture its id on `SeededTenant`.
- **Cross-tenant read denied:** as A (via `withTenant`), `findUnique` B's module row →
  `null`; unscoped `findMany` under A returns only A's rows.
- **Cross-tenant/ spoofed write denied:** as A, attempt to `create`/`update` a row
  stamped `institutionId = B` → rejected by `WITH CHECK`.
- **Buggy-query backstop:** as A, `findMany({})` with no filter still returns only A's
  rows (RLS backstop — the headline test, extended to the new table).
- **Three-GUC-state fail-closed:** confirm the three states (unset GUC, empty-string GUC,
  wrong-tenant GUC) all yield zero visible rows for `institution_modules` — the
  `nullif`-guarded policy makes unset and empty both fail closed; the existing suite's
  fail-closed test (no tenant context → zero rows) is extended to the new table.
- Add `institution_modules` to **both** `cleanup()` **and** `countRemainingTestRows()`
  (resolves review finding 8, NIT). In `cleanup()` it must be **deleted child-first**
  (before the `institution` delete) because the new FK is `ON DELETE RESTRICT` — deleting
  the institution first would be blocked by a remaining module row. In
  `countRemainingTestRows()` it must be **added to the counted-table list**, because the
  teardown asserts the count `=== 0`: if the table is cleaned but not counted, a leaked
  `institution_modules` row would be silently uncounted and the `=== 0` assertion would
  still pass, losing leak-coverage for exactly the new table. Both edits are required for
  the teardown assertion to actually cover `institution_modules`.

### 9.2 Dependency-validation test (service/integration)

Using the synthetic-but-declared `attendance` edge (§2.1): entitle `attendance` for a
test institution, leave `student_management` inactive, assert `activate("attendance")`
fails with `409` + `missingDependencies` containing the unmet keys; then activate
`student_management` + `academic_sessions` + `class_course` and assert
`activate("attendance")` succeeds (`ACTIVE`, `activatedAt` set). Two cases pin the §3
satisfaction predicate (finding 3): (a) a **`SUSPENDED` dependency** causes a 409 and the
suspended key appears in `missingDependencies` (i.e. "not `ACTIVE`" is the bar, not "no
row"); (b) reactivation (`SUSPENDED → ACTIVE`) re-runs the identical predicate.

Also unit-test the reverse-edge dependent-warning computation (suspending
`student_management` with `fees`/`attendance` `ACTIVE` **or `SUSPENDED`** lists them as
`affectedDependents`, confirming finding 2's inclusion of `SUSPENDED` dependents). **Audit
persistence assertion (finding 1):** after a suspend/revoke that has dependents, re-read
the **persisted `audit_events` row** from the DB and assert its `metadata` carries
`affectedDependents` (the joined scalar string) and `affectedDependentsCount` — proving
the blast-radius set survives `sanitizeMetadata` and is not dropped as an array. A
companion assertion confirms the empty case persists `affectedDependents: ""` /
`affectedDependentsCount: 0`.

**Revoke dependent-scan tenant-scoping assertion (resolves current review finding 4,
NIT):** seed the same dependent edge (e.g. `fees` depending on `student_management`)
`ACTIVE` in **two** institutions, then platform-revoke `student_management` from
institution A. Assert the 409 guard lists **only A's** `fees` dependent, never B's —
proving the revoke `findMany` carries the mandatory `where: { institutionId: id }` filter
and does not scan cross-tenant under `privilegedPrisma`.

### 9.3 `requireModuleActive` enforcement test

- **403-when-not-ACTIVE:** with `campus_movement` in `SUSPENDED` (and separately with no
  row = `NOT_ENTITLED`) for the caller's institution, a GatePass tenant route returns
  `403 { error: "Module not active: campus_movement" }`.
- **Allow-when-ACTIVE:** with `campus_movement` `ACTIVE`, the same route proceeds to its
  handler (permission already satisfied). This is the pin that proves the stub is really
  replaced.
- **Fail-closed on read error:** mock the state read to throw → `500`, never a silent
  allow.
- **Replaces the permit-all pin:** the existing `requireModuleActive` permit-all unit
  test (identity-rbac design §9 finding #6) is **intentionally updated** — this is the
  deliberate, test-breaking change that proves the stub became real enforcement, mirrored
  in the test rather than silently flipped.

### 9.4 Catalogue / audit meta-tests

- `catalogue-sync.test.ts`: add the new migration dir to `SEEDING_MIGRATION_DIRS`; the
  existing set-equality assertions then cover `admin.modules.manage`.
- A small `modules.test.ts` in `packages/shared` (mirroring `audit-actions.test.ts`):
  assert `MODULE_KEYS` uniqueness, `MODULE_KEY_SET` consistency, that every key in
  `MODULE_DEPENDENCIES` (keys and values) is a known `MODULE_KEY`, and that the graph is
  acyclic (a cheap DFS — guards against a future edge accidentally creating a cycle that
  would make activation impossible).

### 9.5 Testability notes

- The state machine (`module-system.ts`) is **unit-testable** in isolation with a mocked
  `tx` client (transitions, dependency math, reverse-edge warnings) — no DB needed; this
  is where most logic is proven.
- RLS isolation is **integration-tested** only (real Supabase, `campass_app`), because
  RLS cannot be exercised against a mocked client — hence the escape-suite extension.
- `requireModuleActive` is **unit-testable** with a mocked `privilegedPrisma` for the
  status/branch contract, and covered end-to-end by the enforcement integration test.
- A design that forced the guard to open a tenant transaction would be harder to unit-test
  (needs a transaction mock); the chosen `privilegedPrisma` point read is a single mockable
  call — a small testability win reinforcing the §7.1 choice.

---

## 10. Files touched (summary)

- `packages/shared/src/modules.ts` (new) + `index.ts` export — registry + dependency graph.
- `packages/shared/src/permissions.ts` — add `admin.modules.manage` (+ ADMIN binding).
- `packages/shared/src/audit-actions.ts` — add 4 `platform.module.*`/`admin.module.*` keys.
- `packages/db/prisma/schema.prisma` — `ModuleState` enum + `InstitutionModule` model +
  `Institution.institutionModules` back-relation.
- `packages/db/prisma/migrations/<new>_module_system/migration.sql` (new, hand-authored):
  enum, table, composite unique + FK, RLS (`nullif` fail-closed) + GRANT pin, backfill +
  invariant guard, permission seed block (catalogue-sync markers). Authored via
  `migrate dev --create-only` then `migrate deploy` (NEVER `migrate dev` against shared
  Supabase — `database.md`). FROZEN migrations untouched.
- `packages/db/src/seed.ts` — idempotent `campus_movement` ACTIVE upsert per demo tenant.
- `apps/api/src/services/module-system.ts` (new) — state machine (activate/suspend/
  entitle/revoke, dependency validation, reverse-edge warnings).
- `apps/api/src/services/authz-engine.ts` — real `requireModuleActive` (adds the
  `privilegedPrisma` + `ModuleKey` imports; narrows the param `string → ModuleKey`, §7).
- `apps/api/src/routes/platform.ts` — grant/revoke/list endpoints.
- `apps/api/src/routes/admin.ts` — activate/suspend/list-own endpoints; wire guard onto
  `campus_movement.*` admin routes.
- `apps/api/src/routes/{student,hod,guard}.ts` — wire `requireModuleActive("campus_movement")`
  onto `campus_movement.*` routes.
- `apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts` + `tenant-escape.integration.test.ts`
  — extend for `institution_modules`.
- New tests: `module-system` dependency/enforcement tests; `packages/shared` `modules.test.ts`;
  update `catalogue-sync.test.ts` `SEEDING_MIGRATION_DIRS` and the `requireModuleActive`
  permit-all pin.

---

## 11. Open assumptions (for the reviewer)

- **A1** — Dependency validation checks dependency **state only** (`ACTIVE`), not the
  existence of a dependency module's domain tables (none exist in Phase 0). (§2.1)
- **A2** — Suspension/revocation **warns** dependents, does not auto-cascade-suspend them;
  reading §5.5 "never a silent break" as requiring a warning, not a forced cascade. (§4)
- **A3** — "Scheduled jobs stop operational work when suspended" (§5.5) has no concrete
  Phase-0 `campus_movement` job to gate beyond route enforcement; the gate is the
  documented mechanism future jobs will check (job-level checks are out of Phase-0 scope).
- **A4** — Enforcement begins at the **route wiring** of `requireModuleActive`, not the
  stub-body rewrite (which is inert until wired, finding 2). The backfill migration **and**
  the route wiring ship in the **same deployable**, and `migrate deploy` runs before the
  API boots, so the backfill precedes any wired enforcing route. (§5, §7.3)
- **A5** — No Phase-0 module declares *required* activation config, so activation does not
  block on config; the `settings` JSON column is the future hook and `activate()` is the
  named single seam where a future `requiredConfigSatisfied(moduleKey, settings)` check
  plugs in (§3, §6.2).
- **A6** — Route gating rule = "gate iff the route's required permission is in the
  `campus_movement.*` namespace"; `admin.*` routes (even those touching GatePass data) are
  not gated. (§7.3)
- **A7** — SUPER_ADMIN is handled by *not wiring* the guard onto platform routes (and its
  unset `request.tenant`), not by a branch inside `requireModuleActive`. (§7.3)
- **A8** — `requireModuleActive` reads via `privilegedPrisma` with a hard
  token-derived `institutionId` filter (not a second `withTenant` transaction), chosen for
  hot-path cost/robustness; cross-tenant safety rests on the filter being token-sourced. (§7.1)
- **A9** — Platform module-audit events set `institutionId` to the target tenant (so they
  surface in that tenant's Audit Explorer), consistent with `support_grant.*` scoping,
  even though the write is on `privilegedPrisma`. (§6.1)

---

## 12. Responses to design review

This design has been through two review rounds. §12.1 responds to the **current**
(latest) review on disk (`design-review.json` / `design-review.md`, verdict
`CHANGES_REQUESTED`, 0 HIGH / 2 MEDIUM / 6 NIT). §12.2 preserves the responses to the
**prior** review round for traceability.

### 12.1 Current review (`design-review.json`, 0 HIGH / 2 MEDIUM / 6 NIT)

Both MEDIUM findings are gating/semantics gaps the design's own stated rules produced but
did not resolve; all six NITs are consistency/clarity pins. Every source claim in the
review was re-verified against the live codebase before revising (see verification notes
inline). No factual premise changed — the review's "Verified Assumptions" all held — only
the two gaps were closed and the NITs pinned.

- **Finding 1 (MEDIUM — `campus_movement.audit.view` support-grants route would be
  module-gated, hiding break-glass/support visibility on suspension): ADDRESSED.**
  Verified in source: `GET /support-grants` (`admin.ts` ~line 2012) is keyed
  `campus_movement.audit.view` and reads the platform `support_grants` table — a
  break-glass surface, not a Campus Movement operation. I audited **every**
  `campus_movement.audit.view` / `campus_movement.analytics.view` call site (full table in
  §7.3): `/stats`, `/analytics`, `/audit-logs` are genuine Campus Movement operations
  (gated); `GET /support-grants` is not. §7.3 now adds a **named per-route carve-out**
  (review option (a)): `GET /support-grants` is excluded from `requireModuleActive` via an
  explicit `(method, url)` allow-list, even though its permission is in the namespace.
  Option (b) (re-key to `admin.support.revoke`) was rejected — that is the *write*
  permission and reusing it as the read gate would widen read access and conflate
  read/write authority; verified `admin.support.revoke` exists and is ADMIN-bound. A6 is
  reworded so the rule is "namespace minus the named carve-out," and the audit table is
  the authority for wiring.

- **Finding 2 (MEDIUM — enforcement begins at wiring, not stub replacement; backfill must
  precede wiring and co-ship): ADDRESSED.** Verified in source: `requireModuleActive` is
  wired onto **zero** routes today (`grep` returns only the stub in `authz-engine.ts` and
  its unit test), so the stub-body rewrite is inert until the guard is wired. §0 now states
  plainly that the permit-all→real change has **zero runtime effect until the guard is
  wired**, so "the instant the stub is replaced" means "the instant the guard is wired and
  serving." §5 adds a **hard ordering constraint**: the backfill migration (+ invariant
  guard), the real guard body, and the **route wiring** ship in **one deployable**, with
  `migrate deploy` before API boot; A4 and §7.3 bind the ordering specifically to the
  wiring step. No code change — only the ordering/semantics made explicit so wiring and
  backfill cannot be split across deploys.

- **Finding 3 (NIT — backfill `WHERE code <> 'PLATFORM'` assumes PLATFORM is the only
  non-tenant institution): ADDRESSED.** §5.1 now documents `code <> 'PLATFORM'` as the
  **deliberate sole definition of a tenant for Phase 0**, notes that the platform
  create-institution route allows any code (so this is an assumption, not an invariant),
  and states that any future non-tenant institution must be added to the exclusion (or the
  exclusion re-keyed onto a status/flag column). Kept the literal code match for Phase 0.

- **Finding 4 (NIT — revoke dependent-scan under `privilegedPrisma` needs the mandatory
  `institutionId` filter called out, same as GET-list): ADDRESSED.** §6.1 revoke now
  specifies the dependent-scan as
  `privilegedPrisma.institutionModule.findMany({ where: { institutionId: id } })` with the
  filter called out as **mandatory and load-bearing** (RLS-bypassed), identical to the
  GET-list caution. §9.2 adds a test seeding the same dependent edge `ACTIVE` in two
  institutions and asserting a revoke in A lists only A's dependent, never B's.

- **Finding 5 (NIT — new audit keys read as `<module>.<resource=module>.<action>`): NO
  CHANGE REQUIRED, NOTED.** §8.1 now records that the four keys are 3-segment
  `<module>.<resource>.<action>` with `resource = module` (not 2-segment), matching the
  catalogue convention and passing the shape regex (verified). Kept as designed.

- **Finding 6 (NIT — no seam in `activate()` for the §5.3 required-config step, A5):
  ADDRESSED.** §3 now names `activate()` as the **single seam** where a future
  `requiredConfigSatisfied(moduleKey, settings)` check plugs in (after the dependency
  predicate, before the state flip, reading the `settings` JSON). A5 in §11 points at the
  seam. No Phase-0 code implements the check (A5 holds).

- **Finding 7 (NIT — transitive dependency satisfaction relies on an unstated inductive
  argument): ADDRESSED.** §3 now states the inductive argument explicitly (a dependency can
  only be `ACTIVE` if its own direct deps were `ACTIVE` at its activation, so direct-only
  checking transitively satisfies the closure) and warns that there must be **no
  force-activate path** bypassing the predicate or the induction breaks.

- **Finding 8 (NIT — `institution_modules` must be in BOTH `cleanup()` and
  `countRemainingTestRows()`): ADDRESSED.** §9.1 now states both edits explicitly: delete
  child-first in `cleanup()` (because the FK is `ON DELETE RESTRICT`) **and** add to the
  counted list in `countRemainingTestRows()` — otherwise a leaked row is silently
  uncounted and the `=== 0` teardown assertion loses coverage for the new table.

### 12.2 Prior review round (1 HIGH / 3 MEDIUM / 5 NIT) — preserved for traceability

Review verdict was `CHANGES_REQUESTED` (1 HIGH, 3 MEDIUM, 5 NIT). Every finding is
addressed in place; responses below. The review's "Verified Assumptions" were all
confirmed correct against source, so no factual premise of the design changed — only
under-specified or gap areas were tightened.

- **Finding 1 (HIGH — `affectedDependents` dropped by `sanitizeMetadata`): ADDRESSED.**
  Confirmed against `apps/api/src/services/audit.ts`: `sanitizeMetadata` copies only
  scalar `string|number|boolean|null` and drops arrays/objects. §4 now serializes the
  dependent set to **two scalar metadata fields** — `affectedDependents` (comma-joined
  string, `""` when none) and `affectedDependentsCount` (number) — at the suspend/revoke
  audit call sites (review option (a), chosen over mutating the shared sanitizer). §6.1
  references the same serialization. §9.2 now asserts the **persisted** audit row carries
  both fields.

- **Finding 2 (MEDIUM — revoke guard ignores `SUSPENDED` dependents): ADDRESSED.** §6.1
  revoke now computes its guard/warning over dependents that are **`ACTIVE` or
  `SUSPENDED`** and **blocks (409)** on either, listing the blocking dependents and their
  states, so a `SUSPENDED` dependent can never be left silently un-reactivatable (review
  option (a), the recommended one). §4's dependent-warning set is correspondingly widened
  to `ACTIVE`+`SUSPENDED`.

- **Finding 3 (MEDIUM — `activate()` satisfaction predicate under-specified): ADDRESSED.**
  §3 now states the **single predicate** applied identically to first activation and
  `SUSPENDED → ACTIVE` reactivation: a dependency satisfies iff its row exists **and**
  `state = ACTIVE`; `missingDependencies` lists every declared dependency whose row is
  absent **or** whose state is not `ACTIVE` (`ENTITLED`/`SUSPENDED` included). §4's
  reactivate bullet and §9.2's test cases are aligned to it.

- **Finding 4 (MEDIUM — GET list derivation / platform RLS-bypass filter): ADDRESSED.**
  §6.1 (platform) now specifies: iterate the static `MODULES` catalogue, map rows from
  `findMany({ where: { institutionId } })` with the `institutionId` filter called out as
  **mandatory and load-bearing** (privilegedPrisma bypasses RLS). §6.2 (admin) specifies
  the same catalogue-iteration merge via an RLS-scoped `withTenant findMany` (no explicit
  filter). Both default no-row keys to `NOT_ENTITLED`.

- **Finding 5 (NIT — backfill `imod_` id vs cuid): ACKNOWLEDGED, kept as-is.** §5.1 now
  notes the `imod_` prefix is backfill-only, semantically meaningless, matches the
  `identity_rbac_b2` `mbr_` precedent, and must not be treated as a discriminator.

- **Finding 6 (NIT — emergency-view gated on suspension): ACKNOWLEDGED, intentional.**
  A6 now explicitly states `campus_movement.emergency.view` is gated along with the rest
  of the namespace on suspension (Phase-0 suspension is wholesale), with the carve-out as
  an out-of-scope future product decision.

- **Finding 7 (NIT — fail-closed 500 vs documented P1001): ACKNOWLEDGED.** §7.1 now
  records the interaction: fail-closed 500 is intentional for security; the mitigation if
  production confirms `database.md` §2's P1001 is a bounded retry/backoff around this read,
  deferred to the existing "measure in production" plan. No code now.

- **Finding 8 (NIT — audit key naming): NO CHANGE NEEDED.** Review confirmed
  `platform.module.*` / `admin.module.*` are well-formed and pass the
  `audit-actions.test.ts` shape regex. Keys kept as designed (§8.1).

- **Finding 9 (NIT — seed insertion point / iterate created object): ADDRESSED.** §5.2
  now says the seed upserts against the demo `institution` object(s) it created (not a
  `findMany` over `institutions` and not the migration's `WHERE code <> 'PLATFORM'`
  form), state `ACTIVE`, both timestamps, `update: {}`.
