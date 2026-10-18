# Wiring API routes onto the multi-tenant RLS model (B-2)

This change connects the existing CampusGate API routes to the B-1 Postgres RLS model so the app runs correctly as the `campass_app` role. It adds a second Prisma client, `privilegedPrisma`, that connects as the postgres/owner role and bypasses RLS, and routes every DB access by context: tenant-scoped routes (student, hod, guard, admin tenant handlers, notifications) run their DB work inside `withTenant(request.user.institutionId, tx => ...)`, while pre-auth bootstrap (login, register, `/departments`, the `authenticate` middleware, the ws `/connect` handshake) and cross-tenant SUPER_ADMIN platform routes use `privilegedPrisma`. An optional `db: Prisma.TransactionClient = prisma` parameter was threaded through the authz, allowance-engine, reliability-engine, and notifications services so they run on the request's `tx`; the default keeps the mocked service tests working unchanged.

Watch for: nothing blocking. The security crux — tenant `institutionId` always coming from the verified JWT and never from client input — holds across every `withTenant` call site (confirmed). Tenant route files import only `withTenant` and have no reference to `prisma` or `privilegedPrisma`, so an accidental RLS bypass from a tenant handler is structurally impossible (confirmed). The `/me` and session routes use `privilegedPrisma` on the caller's own rows, which is a deliberate, plan-documented trade-off (confirmed).

**Verdict**: APPROVED

## High-level view

The isolation model is enforced by where each file can reach: the five tenant route files (`student.ts`, `hod.ts`, `guard.ts`, `admin.ts`, `notifications.ts`) import `withTenant` and nothing else from `@campusgate/db`, so every DB call in them goes through a tenant transaction whose GUC is pinned from `request.user.institutionId`. There is no path for a tenant handler to touch the base or privileged client.

`privilegedPrisma` is confined to genuine pre-tenant-context and cross-tenant code: the `authenticate` middleware and ws handshake (which run before any tenant context exists), the auth-bootstrap routes in `auth.ts`, and the SUPER_ADMIN `platform.ts` handlers. Each of those is either pre-token or cross-tenant by design, so campass_app under RLS would fail closed there (the original login-returns-401 symptom).

Services were made tenant-aware without breaking callers by adding a trailing optional `db` client that defaults to the module `prisma`. Tenant handlers pass `tx`; the fan-out in the notification helpers forwards `db` so `notification.create` satisfies the RLS WITH CHECK policy. The guard mark-exit/mark-return handlers flatten their former inner `prisma.$transaction` onto the outer `withTenant` tx, and their post-response fire-and-forget blocks each open their own `withTenant` so the late notify/snapshot writes still carry tenant context.

The B-1 surface is untouched: no migration file, no `.env`, and no BYPASSRLS grant appear in the commit; the auth/authz decision logic and the cross-tenant escape harness are unchanged; `withTenant`'s RLS body is byte-for-byte the same, with only transaction `maxWait`/`timeout` options added. The new `PRIVILEGED_DATABASE_URL` is documented in both `.env.example` files as a placeholder with the fallback order spelled out.

<details>
<summary>Issues (0)</summary>

No blocking or actionable findings. The two deliberate trade-offs below (privilegedPrisma on `/me` and session routes; the `maxWait`/`timeout` addition to `withTenant`) are documented in the plan and are not action items.

</details>

<details>
<summary>Details</summary>

### Tenant institutionId always comes from the verified JWT

Every `withTenant` call in the five tenant route files takes `institutionId` destructured from `request.user`, which is populated by the `authenticate`/`requireTenantRole` middleware from the verified JWT. No call site reads `institutionId` from a body, param, query, or route value. The one `withTenant` call that does not use `request.user` is in `auth.ts` `register`, where it uses `department.institutionId` — a value looked up server-side from the submitted `departmentId`, not trusted from the client — to give the admin-notification fan-out a tenant context. That is the correct source: the notification rows belong to the department's institution, derived server-side.

Model-delegate filters inside the handlers still carry the belt-and-suspenders `institutionId`/`user: { institutionId }` scoping (e.g. `where: { institutionId, status: "ACTIVE" }`), with RLS as the backstop. The scoping was preserved, not relaxed.

### Tenant routes cannot reach a non-tenant client

`student.ts`, `hod.ts`, `guard.ts`, `admin.ts`, and `notifications.ts` import only `withTenant` (guard additionally imports the `Prisma` type). None import `prisma` or `privilegedPrisma`. A search for `privilegedPrisma` or a bare `prisma.` call across these files returns only a comment in guard.ts and the `Prisma.TransactionClient` type annotation — no runtime client access. This makes a cross-tenant hole from a tenant handler a compile error rather than a review judgement call, which is the strongest form this guarantee can take.

### privilegedPrisma scope is limited to pre-auth and cross-tenant

```
pre-tenant-context ─────────────────────────┐
  authenticate() session+user lookups        │
  ws /connect user status lookup             ├──> privilegedPrisma (RLS bypass)
auth-bootstrap (auth.ts)                      │
  /departments /login /register              │
  /me /logout /sessions*                      │
platform (SUPER_ADMIN, cross-tenant)          │
  /stats /institutions* status ───────────────┘

tenant (student/hod/guard/admin/notifications)
  ──> withTenant(request.user.institutionId, tx) on base prisma (RLS enforced)
```

The `authenticate` middleware swaps its three lookups (session revocation `findFirst`, background `session.update`, and the user+institution `findUnique`) to `privilegedPrisma`; these run before tenant context exists and would otherwise fail closed. The ws `/connect` user-status lookup is the same pre-handshake case. `platform.ts` moves all four handlers — including the institution+admin creation `$transaction` — to `privilegedPrisma`, which is correct because those are cross-tenant by design and operate on the non-tenant `Institution` table. In every case only the client was swapped; no auth/role decision logic changed.

`auth.ts` `/me`, `/logout`, `/sessions`, `DELETE /sessions/:id`, and `/sessions/revoke-all` use `privilegedPrisma`. `User`/`Session` are not in the RLS-forced tenant set, and `/me` returns only the caller's own joined profile; routing these through the privileged client preserves the existing single-query shape. This is the plan's documented Option A trade-off, not a gap.

### Services run on the request transaction

`authz.ts`, `allowance-engine.ts`, `reliability-engine.ts`, and `notifications.ts` each gained a trailing `db: Prisma.TransactionClient = prisma` and use `db.` internally, forwarding `db` to nested calls (`getRemainingAllowance` → `getOrCreatePolicy`/`getOrCreateInstitutionConfig`; `computeScore` → `getScoreTrend` and `getOrCreatePolicy`; the notify fan-out → `notifyUser`). Tenant handlers pass `tx` at every call site, so the service queries — including `notification.create`, which must satisfy the RLS WITH CHECK — run inside the tenant transaction. `getScoreTrend` keeps its `limit = 30` default and adds `db` as the final parameter, so existing two-arg and one-arg callers still resolve to the mocked base `prisma`. Pure helpers were left untouched, and `pass-lifecycle.ts` (no DB) was not changed.

### Guard flattening and fire-and-forget tenant context

`mark-exit` and `mark-return` previously wrapped their state transition in an inner `prisma.$transaction`. That inner transaction is flattened onto the outer `withTenant` tx: the pre-checks, the `gatePass.update`, the `gateEvent.create`, and the `auditLog.create` all run directly on `tx`, so there is no nested interactive transaction and the audit row stays inside the tenant context. A search confirms no `$transaction` call remains in any tenant route file (only a descriptive comment). The same flattening applies to admin `POST /users`, whose user/profile/assignment creates and audit write run on the outer `tx`.

The two post-response fire-and-forget blocks each open their own `withTenant(institutionId, tx2 => ...)` and thread `tx2` into `notifyUser`, `ReliabilityEngine.computeScore`, and `ReliabilityEngine.recordSnapshot`, so the late notification and snapshot writes carry a valid tenant context and satisfy RLS. They remain unawaited by the handler, preserving the response-latency behavior, and failures are logged rather than surfaced.

### B-1 surface, auth logic, and secrets untouched

The commit touches no file under `packages/db/prisma/migrations/**` and no `.env` file. The only BYPASSRLS token in the migration is a comment noting `campass_app` is `NOBYPASSRLS`; the campass_app GRANTs (SELECT/INSERT/UPDATE/DELETE/USAGE) are not in the diff and are unchanged. No `requirePermission`, membership, or RBAC model was introduced. `requireRole`/`requireTenantRole`/`requireSuperAdmin` decision logic is unchanged — the middleware diff is only the `prisma` → `privilegedPrisma` client swap. The `tenant-escape.integration.test.ts` harness and its setup helper are not in the commit.

`withTenant`'s body is unchanged apart from added interactive-transaction options (`maxWait: 15000`, `timeout: 30000`); the `set_config('app.current_institution_id', $1, true)` first statement and the transaction-local GUC semantics are byte-for-byte the same. The timeout widening is a latency accommodation for multi-query handlers over the remote pooler and does not alter RLS semantics.

### Env documentation

Both `apps/api/.env.example` and `packages/db/.env.example` gained a documented `PRIVILEGED_DATABASE_URL` placeholder (`postgresql://postgres.<project-ref>:<password>@...pooler.supabase.com:5432/postgres`) with guidance that it must point at the postgres/owner role, never `campass_app`, and that the app falls back to `DIRECT_URL` then `DATABASE_URL` when it is unset. The values are placeholders with `<project-ref>`/`<password>` tokens — no real secret committed.

### Mocked test doubles extended without weakening assertions

The mocked route suites (e.g. `tenant-boundary.integration.test.ts`) extend their `vi.mock("@campusgate/db")` factory with `privilegedPrisma` aliased to the same mocked `prisma` delegates, a `withTenant` that invokes `fn(prisma)` immediately so tenant-handler DB calls land on the delegates the assertions inspect, and a `Prisma: {}` stub. Because `privilegedPrisma` and the tenant `tx` resolve to the same mock object, the existing institution-scoped `where`-clause assertions and the SUPER_ADMIN-blocked assertion continue to apply unchanged.

### Verification evidence

The plan records that the coder ran the root build (PASS), `apps/api` vitest 109/109 including `tenant-escape.integration.test.ts` 6/6 (live Supabase campass_app vs postgres), and a live end-to-end smoke test: login `admin@demo.edu` returned 200 with a token (was 401 under RLS), `GET /api/admin/stats` returned tenant-scoped data, the tenant write path (student gate-pass create → HOD approve → persisted PASS_APPROVED notification) succeeded, and SUPER_ADMIN `GET /api/platform/stats` returned cross-tenant aggregates. The evidence is present and specific, so no suite was re-run as part of this review.

</details>

<details>
<summary>File map</summary>

- `packages/db/src/index.ts` — add `privilegedPrisma` singleton + `DbClient` type; `withTenant` gains maxWait/timeout (RLS body unchanged).
- `apps/api/src/middleware/auth.ts` — pre-tenant lookups swapped to `privilegedPrisma` (logic unchanged).
- `apps/api/src/routes/ws.ts` — `/connect` user-status lookup swapped to `privilegedPrisma`.
- `apps/api/src/routes/auth.ts` — auth-bootstrap handlers to `privilegedPrisma`; register notify wrapped in `withTenant(department.institutionId)`.
- `apps/api/src/routes/platform.ts` — all SUPER_ADMIN handlers (incl. the create `$transaction`) to `privilegedPrisma`.
- `apps/api/src/routes/student.ts` / `hod.ts` / `guard.ts` / `admin.ts` / `notifications.ts` — every handler's DB work wrapped in `withTenant(request.user.institutionId, tx)`; guard/admin inner transactions flattened; guard fire-and-forget blocks get their own `withTenant`.
- `apps/api/src/services/authz.ts` / `allowance-engine.ts` / `reliability-engine.ts` / `notifications.ts` — optional `db` client threaded through DB methods and fan-out.
- `apps/api/src/routes/__tests__/*.integration.test.ts` — mock factories extended with `withTenant`/`privilegedPrisma`/`Prisma`; assertions preserved.
- `apps/api/.env.example` / `packages/db/.env.example` — documented `PRIVILEGED_DATABASE_URL` placeholder.
- `.agents/tasks/tenancy-b2-plan.md` — implementation plan + verification record.

Full diff: `git show 84c6bac`.

</details>
