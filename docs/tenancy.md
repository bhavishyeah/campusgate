# CAMPASS Multi-Tenant Isolation (A2)

> Owning doc for decision **D2 (tenant isolation = A2)**. This is the single most
> important foundation decision: every module inherits this pattern. Read with
> [`database.md`](./database.md) (where the schema + Supabase connection details live)
> and [`identity-rbac.md`](./identity-rbac.md) (which supplies the identity that scopes
> each request).

> **Supabase-specific facts in this doc** (role privileges, pooler ports, how
> `current_setting` behaves under the pooler) are marked **⚠ VERIFY** and must be
> confirmed against current Supabase docs at implementation time. The *design* is
> stable; the exact Supabase knobs are the thing to re-check.

---

## 1. The rule, in one sentence

**Every tenant-owned row carries its own `institutionId`; every query is filtered by it
at the application layer (tenant-scoped Prisma client) AND at the database layer
(Postgres Row-Level Security); and every link between tenant-owned rows is proven to
stay within one tenant (composite foreign keys).**

Two independent layers means a bug in application code cannot, by itself, leak data
across tenants — the database refuses.

---

## 2. Why A2 (tradeoff record)

During planning we compared two models. This section records the decision so it is not
re-litigated.

### Option A1 — Derived tenancy (rejected)

Keep deriving tenant identity through relations (`student → user → institutionId`), as
the code does today, but make it rigorous with a mandatory query wrapper and tests.

- **Pros:** smallest migration now; no backfill; matches existing code.
- **Cons:** every new module must *remember* to join back to the tenant root — one
  forgotten join is a silent cross-tenant leak. Deep joins get expensive
  (loan → copy → title; student → user → institution on every query). The core
  integrity rule ("a matching parent `institution_id` is not enough; check linked
  records too") is *harder* to enforce when tenancy is implicit. **Postgres RLS is
  effectively impossible** because child tables have no tenant column to filter on.

### Option A2 — Denormalized `institutionId` + composite FKs + RLS (CHOSEN)

Every tenant-owned row stores its own `institutionId`; composite FKs force linked rows
to share a tenant; RLS enforces isolation in the database.

- **Pros:** the no-compromise answer. Every query filters one indexed column. **RLS**
  becomes possible — the database refuses cross-tenant access even if app code has a
  bug (defense in depth). **Composite FKs** like `(institutionId, studentId)` let the
  database enforce that a pass and its student share a tenant — closing the exact hole
  the blueprint warns about. Cheap, uniform queries for every future module.
- **Cons:** bigger migration now (add columns, backfill from the `user` join, add
  constraints); every write must set `institutionId` (mitigated by the scoped client);
  tenant is stored redundantly (the standard, accepted SaaS tradeoff).

**Decision:** A2. Doing it now (a handful of tables) is cheap; retrofitting it after
fees + library + attendance + exams exist is a migration nightmare across dozens of
tables. This is precisely the "do it once, never redo it" case.

---

## 3. Which tables are "tenant-owned"

A table is **tenant-owned** if a row belongs to exactly one institution. Those rows get
an `institutionId` column + RLS. Tables that are **not** tenant-owned:

- **Platform tables** — `Institution` itself, platform subscription/entitlement
  records, platform-level `SupportGrant` (these are operated by the Super Admin; see
  [`superadmin-security.md`](./superadmin-security.md)).
- **Global reference data** — if any truly global lookup tables exist.

Everything else is tenant-owned. From today's schema that includes (and the ones
**missing** a column today are flagged):

| Table | Has `institutionId` today? | Action in Phase 0 |
|---|---|---|
| `users` | ✅ | keep; add composite FK targets |
| `departments` | ✅ | keep |
| `gates` | ✅ | keep |
| `exit_reasons` | ✅ | keep |
| `guard_shifts` | ✅ | keep |
| `emergency_alerts` | ✅ | keep |
| `academic_calendar_days` | ✅ | keep |
| `institution_configs` | ✅ | keep |
| `allowance_policies` | ✅ | keep |
| `student_profiles` | ❌ (derived via user) | **add `institutionId` + backfill** |
| `hod_profiles` | ❌ | **add `institutionId` + backfill** |
| `guard_profiles` | ❌ | **add `institutionId` + backfill** |
| `gate_passes` | ❌ | **add `institutionId` + backfill** |
| `gate_events` | ❌ | **add `institutionId` + backfill** |
| `guard_gate_assignments` | ❌ | **add `institutionId` + backfill** |
| `emergency_overrides` | ❌ | **add `institutionId` + backfill** |
| `reliability_score_snapshots` | ❌ | **add `institutionId` + backfill** |
| `notifications` | ❌ | **add `institutionId` + backfill** |
| `audit_logs` | ❌ | **add `institutionId`** (AuditLog v2; see `superadmin-security.md`) |
| `security_events` | ⚠ nullable | make non-null where an institution context exists |

Backfill derives the value from the existing join (e.g. a pass's `institutionId` comes
from `student → user → institutionId`). Migration mechanics are in
[`database.md`](./database.md).

---

## 4. Composite foreign keys (same-tenant links)

Adding a column is not enough. We must stop a child row from pointing at a parent in a
**different** tenant. Postgres enforces this with composite FKs.

### Pattern

1. Give the referenced table a **composite unique key** `(id, institutionId)` (in
   addition to its PK on `id`).
2. Give the referencing table an `institutionId` column.
3. Make the FK reference the composite key, including `institutionId` on both sides.

### Copy-ready example — `gate_passes.studentId`

```sql
-- 1. Composite unique on the parent so it can be referenced with institutionId.
ALTER TABLE "student_profiles"
  ADD CONSTRAINT "student_profiles_id_institutionId_key"
  UNIQUE ("id", "institutionId");

-- 2. (institutionId already added + backfilled on gate_passes in the migration step)

-- 3. Replace the single-column FK with a composite FK that includes institutionId.
ALTER TABLE "gate_passes"
  DROP CONSTRAINT "gate_passes_studentId_fkey";

ALTER TABLE "gate_passes"
  ADD CONSTRAINT "gate_passes_student_same_tenant_fkey"
  FOREIGN KEY ("institutionId", "studentId")
  REFERENCES "student_profiles" ("institutionId", "id")
  ON DELETE RESTRICT;
```

Now the database **physically cannot** store a `gate_passes` row whose `studentId`
belongs to a different `institutionId` than the pass — the FK will not resolve.

> Apply this pattern to every cross-row link between tenant-owned tables
> (`gate_passes.reasonId`, `gate_events.passId/gateId/guardId`,
> `guard_gate_assignments.guardId/gateId`, etc.). This is the mechanical answer to the
> blueprint's rule: *"a matching parent institution_id is not enough if a linked record
> belongs to another institution."*

### Rule for every future table

> When you add a tenant-owned table, it gets an `institutionId` column, and **every FK
> to another tenant-owned table is a composite FK including `institutionId`.** No
> exceptions. This is checked in review and by the cross-tenant test suite (§7).

---

## 5. Postgres Row-Level Security (RLS)

RLS makes the **database** enforce isolation, independent of application code.

### 5.1 The app role must NOT bypass RLS ⚠ VERIFY

- A Postgres **superuser** and any role with **`BYPASSRLS`** ignore RLS policies.
- On Supabase, the default `postgres` role is effectively superuser-equivalent and
  **bypasses RLS**. If Prisma keeps connecting as `postgres`, **RLS protects nothing.**
- **Therefore:** create a dedicated application role (e.g. `campass_app`) that is
  **NOT** a superuser and does **NOT** have `BYPASSRLS`, grant it only the DML it needs,
  and point Prisma's runtime connection at it. Migrations run as a more privileged role
  (see [`database.md`](./database.md)).

⚠ VERIFY the exact role names/privileges and how to create a custom role on Supabase at
implementation time.

### 5.2 Per-request tenant context

Each request sets the current tenant in a **transaction-local** session variable; RLS
policies read it via `current_setting(...)`.

```sql
-- Set at the start of each request's transaction. 'true' = local to the transaction.
SELECT set_config('app.current_institution_id', $1, true);
-- or equivalently:  SET LOCAL app.current_institution_id = '<institution-id>';
```

- `SET LOCAL` / `set_config(..., true)` scopes the value to the **current transaction**
  only, so it cannot leak to the next request that reuses a pooled connection.
- ⚠ VERIFY behavior under Supabase's connection pooler (Supavisor). In **transaction**
  pooling mode, a transaction maps to one backend for its duration, so `SET LOCAL`
  inside an explicit transaction is safe; **session**-scoped `SET` is not safe under a
  transaction pooler. Confirm the pooling mode and that `set_config(..., true)` inside
  the Prisma transaction behaves as expected. This interacts with the
  pooled-vs-direct connection choice in [`database.md`](./database.md).

### 5.3 Enabling RLS and the policy template

```sql
-- Enable + force RLS so even the table owner is subject to policies
-- (owner is otherwise exempt). FORCE is important.
ALTER TABLE "gate_passes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gate_passes" FORCE ROW LEVEL SECURITY;

-- Isolation policy: a row is visible/mutable only when it belongs to the
-- institution set for this request.
CREATE POLICY "tenant_isolation_select" ON "gate_passes"
  FOR SELECT
  USING ("institutionId" = current_setting('app.current_institution_id', true));

CREATE POLICY "tenant_isolation_modify" ON "gate_passes"
  FOR ALL
  USING ("institutionId" = current_setting('app.current_institution_id', true))
  WITH CHECK ("institutionId" = current_setting('app.current_institution_id', true));
```

- `USING` filters which existing rows are visible/affected (SELECT/UPDATE/DELETE).
- `WITH CHECK` validates rows being **written** (INSERT/UPDATE) — this stops a request
  from inserting a row for *another* tenant.
- `current_setting('app.current_institution_id', true)` — the `true` second argument
  returns `NULL` instead of erroring if the variable is unset. A `NULL` compared with
  `=` yields no rows, i.e. **fail-closed**: if the request forgot to set the tenant
  context, it sees nothing rather than everything. Verify this fail-closed behavior in
  tests (§7).

> Apply `ENABLE + FORCE RLS` and the two policies to **every** tenant-owned table.
> A small SQL generator or a migration helper should produce these uniformly so no
> table is missed.

### 5.4 Platform / Super Admin access under RLS

- Platform tables (`Institution`, entitlements, support grants) are **not** tenant-owned
  and are accessed by the Super Admin through platform endpoints.
- The Super Admin never gets a blanket RLS bypass. Break-glass access to a single
  tenant's data works by setting `app.current_institution_id` to that one tenant under
  an audited [`SupportGrant`](./superadmin-security.md) — same mechanism, scoped to one
  institution, time-limited and logged. It does **not** use a `BYPASSRLS` role.

---

## 6. Tenant-scoped Prisma client (application layer)

RLS is the backstop. The application layer still scopes every query so normal code is
correct by construction and queries stay efficient (filtering the indexed column).

### 6.1 Design

- A thin wrapper around `PrismaClient` that, per request, **opens a transaction**, runs
  `set_config('app.current_institution_id', <id>, true)`, and exposes a client whose
  queries run inside that transaction.
- Obtained from the authenticated request context (the `institutionId` comes from the
  verified JWT/membership — see [`identity-rbac.md`](./identity-rbac.md)), never from a
  client-supplied body/param/route value.
- Writes default `institutionId` from the context so application code cannot set the
  wrong tenant.

### 6.2 Sketch (illustrative — final form decided at implementation)

```ts
// packages/db — tenant-scoped execution helper (sketch)
export async function withTenant<T>(
  institutionId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // Transaction-local: cannot leak to the next pooled request.
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_institution_id', $1, true)`,
      institutionId,
    );
    return fn(tx);
  });
}
```

```ts
// Route usage (sketch): institutionId comes from the verified request, not the body.
app.get("/passes", async (req, reply) => {
  const { institutionId } = req.tenant; // set by middleware from JWT/membership
  const passes = await withTenant(institutionId, (tx) =>
    tx.gatePass.findMany({ /* no manual institution join needed */ }),
  );
  return reply.send(passes);
});
```

- ⚠ VERIFY the Prisma + pooler interaction: that `set_config(..., true)` executed as the
  first statement of `$transaction` applies to the subsequent queries on the **same**
  connection under Supabase's pooler. Consider a Prisma **client extension** instead of
  raw `withTenant` if it gives cleaner guarantees. Decide at implementation time.
- Middleware that derives `req.tenant.institutionId` from the JWT is the single place
  tenant context originates. A request that changes an ID/URL/body cannot change its
  tenant.

### 6.3 Why both layers

| Layer | Protects against | If it alone fails |
|---|---|---|
| Tenant-scoped Prisma client | forgotten filters, wrong-tenant writes in normal code | RLS still blocks cross-tenant data at the DB |
| Postgres RLS (+ FORCE) | app bugs, raw queries, a compromised query path | scoped client still filters correctly |
| Composite FKs | linked rows drifting across tenants | isolation holds but a bad link could exist — FKs prevent it entirely |

---

## 7. Cross-tenant escape test strategy

The real Definition of Done for the foundation is a **test suite that tries to escape
the tenant and fails.** These tests are a Phase 0 deliverable and run in CI forever.

**Seed:** at least two institutions (A and B) with overlapping-shaped data (students,
passes, reasons, gates) so IDs from one are plausible in the other.

**Tests (each must be DENIED or return empty):**

1. **Read escape:** authenticated as Institution A, request a `gate_passes` row whose ID
   belongs to B (by ID, by list filter, by nested include). Expect not-found/empty.
2. **Write escape — foreign parent:** as A, try to create a pass referencing B's
   `studentId`. Expect FK violation (composite FK) AND/OR RLS `WITH CHECK` rejection.
3. **Write escape — spoofed tenant:** as A, try to insert a row with `institutionId = B`.
   Expect RLS `WITH CHECK` rejection.
4. **Deliberately buggy query:** a test route issues a Prisma query that *forgets* the
   tenant filter entirely. With RLS on, it must still return only A's rows (proves RLS
   is the backstop, not the app filter). **This is the headline test.**
5. **Missing context fail-closed:** run a query without setting
   `app.current_institution_id`. Expect zero rows (not all rows).
6. **Report/aggregate scope:** an analytics/aggregate endpoint must not sum across
   tenants.
7. **Notifications/files scope:** a notification or document fetch cannot cross tenants.
8. **Break-glass scope:** a `SupportGrant` for tenant A must not expose tenant B, and
   every access is audited (see [`superadmin-security.md`](./superadmin-security.md)).

**CI requirement:** any new tenant-owned table added without RLS + policies should be
caught — add a meta-test that enumerates tenant-owned tables and asserts each has RLS
enabled and the standard policies.

---

## 8. Checklist for adding any new tenant-owned table (every future phase)

- [ ] Table has a non-null `institutionId` column.
- [ ] Every FK to another tenant-owned table is a **composite FK** including
      `institutionId`.
- [ ] Parent tables carry a `(id, institutionId)` composite unique for referencing.
- [ ] `ENABLE` **and** `FORCE` RLS; add SELECT + ALL (USING + WITH CHECK) policies using
      `app.current_institution_id`.
- [ ] All access goes through the tenant-scoped client; no raw query bypasses it without
      review.
- [ ] Cross-tenant escape tests extended to cover the new table (incl. the
      deliberately-buggy-query test).
- [ ] Index on `institutionId` (and composite indexes where queries filter by it + other
      columns).

---

## Changelog

| Date | Change |
|---|---|
| 2026-10-18 | Initial tenancy doc: A2 design, A1-vs-A2 tradeoff, composite-FK pattern, RLS policy templates, Supabase app-role + `SET LOCAL` approach, tenant-scoped Prisma client sketch, cross-tenant test strategy, per-table checklist. Supabase specifics flagged ⚠ VERIFY. |
