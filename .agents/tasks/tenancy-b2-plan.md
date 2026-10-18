# Implementation Plan — CAMPASS Phase 0 Tenancy Step B-2

Wire the existing CampusGate/GatePass API routes onto the B-1 multi-tenant isolation
model so the app works under Postgres RLS as `campass_app`. Work on `main`, NO worktree.
All paths are absolute under `c:\campusgate`.

## Context discovered during exploration (ground truth)

- `@campusgate/db` (`packages/db/src/index.ts`) exports a singleton `prisma` (the
  `campass_app`, RLS-subject runtime client) and `withTenant(institutionId, fn)` which
  opens `prisma.$transaction`, runs `set_config('app.current_institution_id', $1, true)`
  as the first statement, then runs `fn(tx)`. B-1 is merged; `withTenant` is exported but
  not yet used by any route.
- Under RLS, `campass_app` with no tenant GUC set returns zero rows / fails closed. This
  breaks every route that uses the base `prisma` client directly, including pre-auth
  lookups (login's `prisma.user.findUnique` returns NULL → 401).
- `apps/api/.env` already defines `DIRECT_URL` (the `postgres` session-pooler URL, port
  5432, RLS-bypass). `packages/db/.env` defines `DATABASE_URL` (postgres pooler 6543) and
  `DIRECT_URL` (postgres 5432). `apps/api/.env` `DATABASE_URL` is the `campass_app` pooler
  URL (6543, `pgbouncer=true`). The prisma schema datasource uses `DATABASE_URL` +
  `directUrl = DIRECT_URL`.
- The mocked integration tests (`analytics`, `tenant-boundary`, `allowance-integration`,
  `reliability-integration`, and the `.property` tests) `vi.mock("@campusgate/db")` and
  supply only `prisma` (sometimes enums). They do NOT provide `withTenant` or
  `privilegedPrisma`. They assert against `mockedPrisma.<model>.<fn>` call args. These
  tests will break the moment routes call `withTenant`/`privilegedPrisma` unless the mocks
  are extended. This is the single biggest source of churn — handle it deliberately
  (items 2, 9, 10).
- The live escape suite (`apps/api/src/routes/__tests__/tenant-escape.integration.test.ts`
  + `helpers/tenant-escape-setup.ts`) connects `appClient` as `campass_app` and
  `adminClient` as `postgres` and passes 6/6. It must keep passing unchanged. It pins
  `process.env.DATABASE_URL` to the campass_app URL before importing `@campusgate/db`, so
  `privilegedPrisma`'s fallback must not break when only `DATABASE_URL`/`DIRECT_URL` are
  set.
- Build command (api): `npm run build -w @campusgate/api` (`prisma generate` + `tsc`).
  Test command (api): `npm run test -w @campusgate/api` (`vitest run`). Vitest includes
  `src/**/*.test.ts` and `src/**/*.property.test.ts`. The Prisma client is already
  generated.

## Design decisions (made here, grounded in the task + codebase)

1. **Second client name = `privilegedPrisma`** (exported from `@campusgate/db`). Rationale:
   the task offers `privilegedPrisma` or `adminDb`; `privilegedPrisma` reads clearly at the
   call sites ("this query intentionally bypasses RLS").
2. **Datasource selection + fallback:** `privilegedPrisma` connects using
   `process.env.PRIVILEGED_DATABASE_URL ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL`,
   passed via Prisma's `datasources: { db: { url } }` override. Rationale: the privileged
   URL is the postgres session-pooler URL, which is exactly what `DIRECT_URL` already holds
   in `apps/api/.env`; falling back to it keeps the app working today without a new secret,
   and falling back to `DATABASE_URL` keeps tests that only set `DATABASE_URL` from crashing
   at import (they just won't actually bypass RLS, which those mocked/escape tests never
   rely on). Document that for real RLS-bypass in production `PRIVILEGED_DATABASE_URL` (or
   `DIRECT_URL`) MUST point at the postgres/owner role, never `campass_app`.
3. **Singleton pattern preserved:** add a second global cache key
   (`globalForPrisma.privilegedPrisma`) mirroring the existing `prisma` pattern so dev
   hot-reload does not leak connections.
4. **Service refactor via an optional client parameter, default = base `prisma`.** Each
   service function/method that touches the DB gains a trailing optional parameter
   `db: PrismaClientLike = prisma` (a type that both the base client and
   `Prisma.TransactionClient` satisfy — use `Prisma.TransactionClient` where only model
   delegates are used; where `$transaction`/`$queryRaw` is needed keep base `prisma`).
   Rationale: tenant routes pass `tx`; existing mocked service tests call the methods with
   the old arity and transparently get the mocked base `prisma`, so they keep passing with
   NO change. This is the least-churn way to thread `tx` while honoring "do not break
   existing behavior."
5. **Notifications inside a tenant request run on the request's `tx`.** `notifyUser`,
   `notifyInstitution`, `notifyInstitutionAdmins`, `notifyDepartmentHods` gain the optional
   `db` param and pass it through the fan-out chain so the `notification.create` satisfies
   RLS `WITH CHECK`. `broadcastToInstitution` is pure WebSocket (no DB) — unchanged.
6. **Fire-and-forget async blocks in `guard.ts`** (post-response `notifyUser` + reliability
   snapshot) currently read/write via base `prisma` AFTER the response, i.e. outside any
   `withTenant` tx. Under RLS these now fail closed. Fix: wrap each fire-and-forget block's
   DB work in its own `withTenant(institutionId, (tx) => ...)` using the request's
   `institutionId`, and pass `tx` into the services/notifications it calls. They remain
   fire-and-forget (not awaited by the handler) but each gets a valid tenant context.
7. **`getActiveShiftForGuard` and the per-handler profile lookups** in guard/hod/student
   move inside `withTenant`. The simplest correct shape per tenant handler: wrap the whole
   handler body's DB access in a single `withTenant(request.user.institutionId, async (tx) => {...})`
   and replace `prisma.` with `tx.` inside, passing `tx` to `authz` helpers and services.
8. **`authz.ts` helpers** (`getStudentInTenant`, `getHodInTenant`, `getGuardInTenant`,
   `getTenantPassById`) gain the optional `db` param (default base `prisma`) and are called
   with `tx` from tenant handlers. Keep the `user: { institutionId }` filters as-is (belt
   and suspenders; RLS is the backstop).
9. **Interactive-transaction scope:** `withTenant` uses Prisma interactive transactions.
   Handlers that already call `prisma.$transaction` (guard mark-exit/mark-return,
   platform/admin create-user) must NOT nest a second interactive transaction inside the
   outer `withTenant` tx — instead run their statements directly on the outer `tx` (the
   outer tx already gives atomicity). Replace the inner `prisma.$transaction(async (t) =>
   ...)` with direct `tx.` calls. Keep audit-log writes inside the same `tx` so they also
   satisfy RLS (AuditLog is tenant-owned).

## Route-by-route classification

Legend: **PRIV** = `privilegedPrisma` (RLS-bypass); **TENANT** = wrap DB in
`withTenant(request.user.institutionId, (tx) => ...)`; **WS/none** = no DB or special.

### `apps/api/src/middleware/auth.ts` — PRIV (pre-tenant-context)
Runs before tenant context exists; its reads must bypass RLS or they fail closed.
- `authenticate`: `prisma.session.findFirst` (revocation check), the background
  `prisma.session.update(lastActiveAt)`, and `prisma.user.findUnique` (user+institution
  status) → **PRIV**. Do NOT change auth/role logic, only swap the client to
  `privilegedPrisma`.
- `requireRole` / `requireSuperAdmin` / `requireTenantRole`: call `authenticate`; no direct
  DB of their own — unchanged beyond inheriting the PRIV lookups.

### `apps/api/src/routes/auth.ts` — mostly PRIV (auth-bootstrap)
- `GET /departments` (public registration list) → **PRIV** (pre-auth, no tenant known).
- `POST /login` → **PRIV** (user lookup, lastLogin update, session.create,
  securityEvent.create — all pre-token). `notifyInstitutionAdmins` is not called here.
- `POST /register` → **PRIV** (department lookup, user/studentProfile create/update,
  enrollment collision check — self-service, no authenticated tenant). The
  `notifyInstitutionAdmins(department.institutionId, ...)` call must run with tenant
  context so the notification rows satisfy RLS: wrap just that fan-out in
  `withTenant(department.institutionId, (tx) => notifyInstitutionAdmins(..., tx))`, OR pass
  a privileged client into it. **Decision:** use `withTenant(department.institutionId, ...)`
  for the notify step so notification writes go through the normal tenant path.
- `GET /me`, `POST /logout`, `GET /sessions`, `DELETE /sessions/:id`,
  `POST /sessions/revoke-all` → **PRIV**. These are authenticated but operate on
  platform-wide `User`/`Session`/`SecurityEvent` (User & Session are NOT tenant-owned;
  SecurityEvent is nullable-tenant and written here without institution in logout). Using
  `privilegedPrisma` preserves today's behavior exactly and avoids RLS on non-tenant tables.
  (Note: `User` and `Session` are not in the RLS table set; `notifications`/`audit_logs`
  are. `/me` reads profiles which ARE tenant-owned — but the caller's own single-tenant
  rows; using PRIV preserves the existing single-query shape. Acceptable: `/me` returns
  only the authenticated user's own joined profile.)

### `apps/api/src/routes/platform.ts` — PRIV (platform/cross-tenant by design)
`addHook("preHandler", requireSuperAdmin())`. Super Admin is cross-tenant by design
(`superadmin-security.md` §2–§3). All handlers → **PRIV**:
- `GET /stats` (counts across ALL institutions), `GET /institutions`,
  `POST /institutions` (+ its `prisma.$transaction` creating institution+admin — switch to
  `privilegedPrisma.$transaction`), `PUT /institutions/:id/status`.
Rationale: these intentionally read/write across tenants and platform tables
(`Institution` is not tenant-owned); RLS as `campass_app` would (correctly) return zero
rows, so they MUST use the privileged client. No logic change.

### `apps/api/src/routes/student.ts` — TENANT (role STUDENT)
`addHook("preHandler", requireTenantRole("STUDENT"))`. Every handler wraps its DB work in
`withTenant(request.user.institutionId, (tx) => ...)`:
- `GET /emergency/active`, `GET /reasons`, `GET /allowance`, `GET /dashboard`,
  `POST /gate-pass`, `GET /active-pass`, `POST /gate-pass/:passId/cancel`, `GET /history`,
  `GET /gate-pass/:passId/timeline`, `GET /gate-pass/:passId/summary`, `GET /reliability`.
- Pass `tx` to `getStudentInTenant`, `AllowanceEngine.*`, `ReliabilityEngine.*`,
  `notifyDepartmentHods`. `buildPassTimeline`/`computeOutsideDurationMinutes` are pure
  (no DB) — unchanged.

### `apps/api/src/routes/hod.ts` — TENANT (role HOD)
`addHook("preHandler", requireTenantRole("HOD"))`. Wrap each handler in `withTenant`:
- `GET /emergency/active`, `GET /requests`, `GET /requests/:passId`,
  `GET /requests/:passId/reliability`, `GET /requests/:passId/allowance`,
  `POST /emergency-override`, `POST /approve`, `POST /reject`, `POST /revoke`,
  `GET /requests/:passId/timeline`, `GET /requests/:passId/summary`, `GET /stats`.
- Pass `tx` to `getHodInTenant`, `AllowanceEngine.*`, `ReliabilityEngine.computeScore`,
  `notifyUser`, and the `auditLog.create`/`emergencyOverride.create`/`gatePass.update`
  calls (run them on `tx`).

### `apps/api/src/routes/guard.ts` — TENANT (role GUARD)
`addHook("preHandler", requireTenantRole("GUARD"))`. Wrap each handler in `withTenant`:
- `GET /emergency/active`, `GET /shift/current`, `POST /shift/start`, `POST /shift/end`,
  `POST /verify`, `POST /mark-exit`, `POST /mark-return`, `GET /lookup`, `GET /activity`.
- `getActiveShiftForGuard` becomes a helper taking `tx`.
- `mark-exit`/`mark-return`: replace the inner `prisma.$transaction(async (t) => ...)` with
  direct `tx.` statements inside the outer `withTenant` tx (no nested interactive tx).
  Audit writes go on `tx`.
- The two post-response fire-and-forget IIFEs (exit notify; return notify + reliability
  snapshot): each opens its OWN `withTenant(institutionId, (tx2) => ...)` and passes `tx2`
  into `notifyUser`, `ReliabilityEngine.computeScore`, `ReliabilityEngine.recordSnapshot`,
  and the `gatePass.count`/`gatePass.findFirst` reads. Keep them unawaited by the handler.

### `apps/api/src/routes/admin.ts` — TENANT (role ADMIN)
`addHook("preHandler", requireTenantRole("ADMIN"))`. Wrap each handler in `withTenant`.
All are single-institution (`institutionId` from the token):
- `GET /stats`, `GET /analytics`, emergency (`GET /emergency/active`, `GET /emergency`,
  `POST /emergency/declare`, `POST /emergency/:id/resolve`), users (`GET /users`,
  `POST /users` + its `prisma.$transaction` → run on outer `tx`, `POST /users/:id/approve`,
  `/deactivate`, `/reactivate`), `POST /students/bulk-import`, `GET /students/export`,
  `GET /students/export.xlsx`, departments (`GET`/`POST`), gates (`GET /gates`,
  `GET /gates/health`, `GET /gates/:gateId/health`, `POST /gates`), guard-shifts
  (`GET`/`POST`), reasons (`GET`/`POST`), allowance-policy (`GET`/`PUT`),
  institution-config (`GET`/`PUT`), academic-calendar (`GET`, `PUT /day`,
  `DELETE /day/:date`), `POST /passes/:passId/revoke`, `POST /emergency-override`,
  `GET /audit-logs`.
- Pass `tx` to `AllowanceEngine.*`, `notifyUser`, `notifyInstitution`. `broadcastToInstitution`
  stays (WS only). The `/audit-logs` query filters by `actor: { institutionId }`; keep the
  filter and run on `tx`.

### `apps/api/src/routes/notifications.ts` — TENANT (role: any authenticated)
`addHook("preHandler", authenticate)`. `Notification` IS tenant-owned, so all reads/writes
must carry tenant context. Wrap each handler in
`withTenant(request.user.institutionId, (tx) => ...)`:
- `GET /`, `GET /unread-count`, `POST /:id/read`, `POST /read-all`. Keep the `userId`
  scoping in the `where` (defense in depth); RLS adds the institution backstop.

### `apps/api/src/routes/ws.ts` — PRIV (pre-tenant-context auth)
`GET /ws/connect`: verifies the JWT then does `prisma.user.findUnique` (status check)
BEFORE any tenant context, exactly like `authenticate`. → **PRIV** for that lookup. The
rest is WebSocket bookkeeping (no DB). No logic change.

### `apps/api/src/routes/__tests__/*` and health check
- `GET /api/health` in `server.ts`: no DB — unchanged.
- Escape suite + helper: MUST NOT change (verification target).

## Service signature changes + call sites

Introduce a shared client type in `@campusgate/db` for the optional param. Add to
`packages/db/src/index.ts`:
```ts
export type DbClient = PrismaClient | Prisma.TransactionClient;
```
Use `Prisma.TransactionClient` as the param type where only model delegates are used
(services only use `.findMany/.create/.count/...`), defaulting to the module `prisma`.

### `apps/api/src/services/authz.ts`
Change all four to accept `db: Prisma.TransactionClient = prisma` and use `db.` instead of
`prisma.`:
- `getStudentInTenant(userId, institutionId, db = prisma)`
- `getHodInTenant(userId, institutionId, db = prisma)`
- `getGuardInTenant(userId, institutionId, db = prisma)`
- `getTenantPassById(passId, institutionId, db = prisma)`
Call sites: student.ts, hod.ts, guard.ts pass `tx`.

### `apps/api/src/services/allowance-engine.ts`
Add `db: Prisma.TransactionClient = prisma` as the trailing param to every method that
reads the DB, and use `db.` internally; internal calls forward `db`:
- `computeActualDuration(passId, db = prisma)`
- `getOrCreatePolicy(institutionId, db = prisma)`
- `getOrCreateInstitutionConfig(institutionId, db = prisma)`
- `getRemainingAllowance(studentId, institutionId, db = prisma)` (forward `db` to
  `getOrCreatePolicy`, `getOrCreateInstitutionConfig`, and the two `db.gatePass`/
  `db.academicCalendarDay` queries)
- `getEnforcementDecision(studentId, institutionId, db = prisma)` (forward to
  `getRemainingAllowance` + `getOrCreatePolicy`)
Pure helpers (`getPeriodBounds`, `isWorkingDay`, etc.) unchanged.
Call sites: hod.ts, student.ts, admin.ts pass `tx`.

### `apps/api/src/services/reliability-engine.ts`
Add `db: Prisma.TransactionClient = prisma` to DB methods; forward:
- `computeScore(studentId, institutionId, db = prisma)` (forward to the `db.gatePass`/
  `db.emergencyOverride` queries, `AllowanceEngine.getOrCreatePolicy(..., db)`, and
  `getScoreTrend(studentId, db)`)
- `recordSnapshot(studentId, institutionId, score, movementNumber, db = prisma)`
- `getScoreTrend(studentId, limit = 30, db = prisma)` — keep `limit` default; add `db` as
  the final param so existing `getScoreTrend(studentId)` calls still work.
Pure methods (`classifySeverity`, `computeTimelyReturnRate`, `computeCompletionRate`,
`computeComplianceRate`, `filterMovementsForScoring`) unchanged.
Call sites: hod.ts, student.ts, guard.ts (fire-and-forget) pass `tx`.

### `apps/api/src/services/notifications.ts`
Add `db: Prisma.TransactionClient = prisma` and thread through the fan-out:
- `notifyUser(userId, payload, db = prisma)` — `db.user.findUnique` +
  `db.notification.create` on `db`.
- `notifyInstitutionAdmins(institutionId, payload, db = prisma)` — `db.user.findMany` then
  `notifyUser(admin.id, payload, db)`.
- `notifyDepartmentHods(departmentId, payload, db = prisma)` — `db.hodProfile.findMany`
  then `notifyUser(hod.userId, payload, db)`.
- `notifyInstitution(institutionId, payload, db = prisma)` — `db.user.findMany` then
  `notifyUser(user.id, payload, db)`.
- `broadcastToInstitution` — unchanged (WS only).
Call sites: student.ts, hod.ts, admin.ts, guard.ts pass `tx`; auth.ts `register` passes the
`withTenant` `tx` for the admin fan-out.

### `apps/api/src/services/pass-lifecycle.ts`
No DB access (pure functions). **Do NOT change.**

## Files that MUST NOT change

- The B-1 migration under `packages/db/prisma/migrations/**` (RLS, composite FKs, the
  `campass_app` role + grants). Do not weaken RLS, do not grant `BYPASSRLS` to
  `campass_app`.
- `apps/api/src/routes/__tests__/tenant-escape.integration.test.ts` and
  `helpers/tenant-escape-setup.ts` (the proof harness).
- `packages/db/src/index.ts` `withTenant` body and the existing `prisma` export (ADD
  `privilegedPrisma` + `DbClient` type; do not alter `withTenant`'s proven shape).
- Authentication/authorization LOGIC: `requireRole`/`requireTenantRole`/`requireSuperAdmin`
  decision logic, the JWT claims, role checks. Only the DB CLIENT used for the pre-tenant
  lookups changes (base `prisma` → `privilegedPrisma`). Do NOT add the
  membership/permission model or `requirePermission`.

## Ordered implementation items

- [ ] 1. Add `privilegedPrisma` + `DbClient` to `@campusgate/db`.
      Export a second singleton `privilegedPrisma` using
      `datasources: { db: { url: process.env.PRIVILEGED_DATABASE_URL ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL } }`,
      cached on `globalForPrisma.privilegedPrisma` (dev only), mirroring the existing
      `prisma` singleton + log config. Export `type DbClient = PrismaClient | Prisma.TransactionClient`.
      Add a doc comment explaining the fallback order and that the privileged URL must be
      the postgres/owner role (RLS-bypass), never `campass_app`. Do not touch `withTenant`.
      Files: `packages/db/src/index.ts`.
      Verify: `npm run build -w @campusgate/db` if present, else `npm run build -w @campusgate/api`
      (runs `prisma generate` + `tsc`) compiles with no new errors.

- [ ] 2. Document the new env var.
      Add `PRIVILEGED_DATABASE_URL` (placeholder only, no real secret) with guidance to
      BOTH `apps/api/.env.example` and `packages/db/.env.example`: it is the postgres
      session-pooler URL (same value as `DIRECT_URL`), used by `privilegedPrisma` to bypass
      RLS for pre-auth/platform routes; if unset the app falls back to `DIRECT_URL` then
      `DATABASE_URL`. Note in `apps/api/.env.example` that the real value is set locally by
      the user and MUST NOT be committed.
      Files: `apps/api/.env.example`, `packages/db/.env.example`.
      Verify: `git status` shows no change to `apps/api/.env` or `packages/db/.env`
      (secrets stay out of git); the two `.env.example` files contain the placeholder.

- [ ] 3. Thread an optional `db` client through `authz.ts`.
      Add `db: Prisma.TransactionClient = prisma` to `getStudentInTenant`, `getHodInTenant`,
      `getGuardInTenant`, `getTenantPassById`; use `db.` internally.
      Files: `apps/api/src/services/authz.ts`.
      Verify: `npm run build -w @campusgate/api` compiles.

- [ ] 4. Thread `db` through `allowance-engine.ts` and `reliability-engine.ts`.
      Add the trailing optional `db` param to every DB-touching method and forward it to
      nested calls (see "Service signature changes" above). Keep pure methods untouched.
      Files: `apps/api/src/services/allowance-engine.ts`,
      `apps/api/src/services/reliability-engine.ts`.
      Verify: `npm run test -w @campusgate/api -- allowance reliability` — the existing
      allowance/reliability integration + property tests still pass unchanged (they call the
      old arity and get the mocked base `prisma` via the default param).

- [ ] 5. Thread `db` through `notifications.ts`.
      Add optional `db` to `notifyUser`, `notifyInstitution`, `notifyInstitutionAdmins`,
      `notifyDepartmentHods` and forward through the fan-out. Leave `broadcastToInstitution`
      unchanged.
      Files: `apps/api/src/services/notifications.ts`.
      Verify: `npm run build -w @campusgate/api` compiles.

- [ ] 6. Switch pre-tenant-context lookups to `privilegedPrisma` in auth middleware + ws.
      In `authenticate` (session revocation `findFirst`, background `session.update`,
      `user.findUnique`) and in `ws.ts` `/connect` (`user.findUnique` status check), replace
      `prisma` with `privilegedPrisma`. Do NOT change any auth/role decision logic.
      Files: `apps/api/src/middleware/auth.ts`, `apps/api/src/routes/ws.ts`.
      Verify: `npm run build -w @campusgate/api` compiles.

- [ ] 7. Migrate `auth.ts` to privilegedPrisma (auth-bootstrap) + tenant notify.
      Replace `prisma` with `privilegedPrisma` in `/departments`, `/login`, `/register`,
      `/me`, `/logout`, `/sessions`, `/sessions/:id`, `/sessions/revoke-all`. In `/register`,
      wrap ONLY the `notifyInstitutionAdmins` fan-out in
      `withTenant(department.institutionId, (tx) => notifyInstitutionAdmins(..., tx))`.
      Files: `apps/api/src/routes/auth.ts`.
      Verify: `npm run build -w @campusgate/api` compiles.

- [ ] 8. Migrate `platform.ts` to privilegedPrisma.
      Replace `prisma` with `privilegedPrisma` in all four handlers, including
      `prisma.$transaction` → `privilegedPrisma.$transaction` in `POST /institutions`.
      Files: `apps/api/src/routes/platform.ts`.
      Verify: `npm run build -w @campusgate/api` compiles.

- [ ] 9. Migrate tenant routes to `withTenant` — student, hod, guard.
      Wrap each handler body's DB work in
      `withTenant(request.user.institutionId, async (tx) => { ... })`, replace `prisma.`
      with `tx.`, and pass `tx` to authz helpers, AllowanceEngine, ReliabilityEngine, and
      notifications. In guard `mark-exit`/`mark-return`, flatten the inner
      `prisma.$transaction` onto the outer `tx`; wrap each post-response fire-and-forget IIFE
      in its own `withTenant(institutionId, (tx2) => ...)`.
      Files: `apps/api/src/routes/student.ts`, `apps/api/src/routes/hod.ts`,
      `apps/api/src/routes/guard.ts`.
      Verify: `npm run build -w @campusgate/api` compiles; then
      `npm run test -w @campusgate/api -- tenant-boundary` — update the `tenant-boundary`
      mock FIRST (item 11) if it fails on missing `withTenant`.

- [ ] 10. Migrate tenant routes to `withTenant` — admin, notifications.
      Same pattern: wrap each handler in `withTenant`, flatten the `POST /users`
      `prisma.$transaction` onto the outer `tx`, pass `tx` to AllowanceEngine/notify. For
      `notifications.ts`, wrap every handler in `withTenant` keeping the `userId` filter.
      Files: `apps/api/src/routes/admin.ts`, `apps/api/src/routes/notifications.ts`.
      Verify: `npm run build -w @campusgate/api` compiles.

- [ ] 11. Update mocked integration-test doubles for the new DB surface.
      The mocked suites (`analytics.integration.test.ts`, `tenant-boundary.integration.test.ts`,
      and any other `vi.mock("@campusgate/db")` suite whose routes now call `withTenant`/
      `privilegedPrisma`) must add to the mock factory: a `withTenant` implementation that
      invokes `fn(mockedPrisma)` (so handler DB calls land on the same mocked delegates the
      assertions use), a `privilegedPrisma` object exposing the same delegates the migrated
      pre-auth/platform handlers use, and a `Prisma` stub if imported. Preserve every
      existing assertion (e.g. `tenant-boundary` still asserts `gatePass.findFirst` /
      `gatePass.findMany` were called with the institution-scoped `where`, and that
      SUPER_ADMIN is blocked). Do NOT weaken assertions; only add the new mock exports and,
      where a handler moved from `prisma` to `privilegedPrisma`, point the assertion at the
      correct mock object.
      Files: `apps/api/src/routes/__tests__/analytics.integration.test.ts`,
      `apps/api/src/routes/__tests__/tenant-boundary.integration.test.ts` (and any other
      mocked route suite that breaks).
      Verify: `npm run test -w @campusgate/api` — the full vitest run is green EXCEPT the
      live escape suite (covered in item 12). Investigate every failure; do not skip tests.

- [ ] 12. Full build + full test suite (incl. live escape suite) green.
      Files: none (verification gate).
      Verify: `npm run build -w @campusgate/api` succeeds, then
      `npm run test -w @campusgate/api` — ALL suites pass, including
      `tenant-escape.integration.test.ts` 6/6 (requires the live Supabase `campass_app` +
      `DIRECT_URL` creds already present in `apps/api/.env`). If the escape suite cannot
      reach Supabase from the environment, record that explicitly and run the live manual
      verification (item 13) instead.

- [ ] 13. Live end-to-end verification against the running app.
      Start the API (`npm run dev -w @campusgate/api`, which loads `apps/api/.env`). With
      `PRIVILEGED_DATABASE_URL` set to the postgres session-pooler URL (or relying on the
      `DIRECT_URL` fallback), confirm the B-2 fixes:
      a. **Login 401 → 200:** `POST /api/auth/login` with a valid seeded user returns 200 +
         token (previously 401 because `user.findUnique` returned NULL under RLS).
      b. **Tenant read scoping:** with an ADMIN token, `GET /api/admin/stats` and
         `GET /api/admin/users` return that institution's data (non-empty, correctly
         scoped); with a STUDENT token, `GET /api/student/reasons` + `GET /api/student/dashboard`
         return the student's own tenant data.
      c. **Tenant write path:** `POST /api/student/gate-pass` creates a pass (RLS WITH CHECK
         satisfied via `withTenant`), then HOD `POST /api/hod/approve` approves it and a
         `notification` row is written for the student (notify ran on `tx`).
      d. **Platform cross-tenant:** with a SUPER_ADMIN token, `GET /api/platform/stats` and
         `GET /api/platform/institutions` return cross-tenant aggregates (privilegedPrisma
         bypasses RLS); `GET /api/student/reasons` with the SUPER_ADMIN token still 403s
         (tenant-role guard unchanged).
      Verify: all of a–d behave as described; capture the login status-code change as the
      headline proof. Record results in the FEAT/loop findings.

## Live verification plan (restated for the coder)

The Definition of Done for B-2 is: login returns 200 (not 401); tenant admin/student
endpoints return correctly scoped data; a tenant write path (request → approve → notify)
succeeds under RLS; the cross-tenant escape suite still passes 6/6; and `npm run build -w
@campusgate/api` + `npm run test -w @campusgate/api` are both green. Items 12 and 13 above
are that plan — execute them as the final gates. Do NOT weaken RLS, grant `campass_app`
BYPASSRLS, or modify the B-1 migration to make anything pass.

## Notes / assumptions

- Assumption: `User`, `Session`, and `SecurityEvent` are NOT in the RLS-forced table set
  (the escape setup's `RLS_TABLES` list confirms `users` IS listed, but auth-bootstrap and
  `/me`/session routes legitimately operate pre-tenant-context or on the caller's own row,
  so routing them through `privilegedPrisma` is the approved Option A). If the coder finds
  `users` RLS blocks a route that should be tenant-scoped post-auth, prefer `privilegedPrisma`
  only for the documented auth-bootstrap/platform set and `withTenant` everywhere else, per
  the classification table — do not broaden privilegedPrisma usage silently.
- Interactive-transaction latency: wrapping whole handlers in `withTenant` means each
  request holds one transaction for its duration. This matches the proven `withTenant`
  shape and the escape suite; no change to the pattern. If a long-running handler (e.g.
  `students/export.xlsx` building a workbook) should not hold the tx while serializing,
  fetch the rows inside `withTenant` and build the file outside the callback.

---

## B-2 IMPLEMENTATION + VERIFICATION RESULTS (completed)

### Route classification (as implemented)
- **privilegedPrisma (RLS-bypass, postgres/owner role):**
  - `middleware/auth.ts` authenticate: session revocation findFirst, background
    session.update(lastActiveAt), user+institution findUnique (pre-tenant-context).
  - `routes/ws.ts` /connect: user status findUnique (pre-tenant-context handshake).
  - `routes/auth.ts` (auth-bootstrap, no authenticated tenant yet): /departments,
    /login, /register, /me, /logout, /sessions, DELETE /sessions/:id,
    /sessions/revoke-all. (register's notifyInstitutionAdmins fan-out runs in
    withTenant(department.institutionId, tx) so notification writes satisfy RLS.)
  - `routes/platform.ts` (SUPER_ADMIN, cross-tenant by design): /stats, /institutions
    (GET+POST incl. the institution+admin $transaction), PUT /institutions/:id/status.
  Rationale: these run before any tenant context or are intentionally cross-tenant;
  as campass_app under RLS they would fail closed (login's user lookup -> NULL -> 401).
- **withTenant(request.user.institutionId, tx) (RLS-subject campass_app):**
  - student.ts, hod.ts, guard.ts, admin.ts (all tenant-admin handlers),
    notifications.ts. institutionId always comes from the verified JWT
    (request.user.institutionId), never from client input. Guard mark-exit/mark-return
    flatten their former prisma.$transaction onto the outer withTenant tx (no nested
    interactive tx); their post-response fire-and-forget blocks each open their own
    withTenant so the notify + reliability-snapshot writes satisfy RLS WITH CHECK.

### How tx was threaded into services
Each DB-touching service fn/method gained a trailing optional `db: Prisma.TransactionClient = prisma`
and uses `db.` internally, forwarding `db` to nested calls:
- services/authz.ts: getStudentInTenant/getHodInTenant/getGuardInTenant/getTenantPassById.
- services/allowance-engine.ts: computeActualDuration, getOrCreatePolicy,
  getOrCreateInstitutionConfig, getRemainingAllowance, getEnforcementDecision.
- services/reliability-engine.ts: computeScore, recordSnapshot, getScoreTrend.
- services/notifications.ts: notifyUser/notifyInstitution/notifyInstitutionAdmins/
  notifyDepartmentHods (threaded through the fan-out so notification.create runs on tx).
Tenant handlers pass `tx`; default param keeps mocked service tests passing unchanged.
pass-lifecycle.ts unchanged (pure). broadcastToInstitution unchanged (WS only).

### @campusgate/db changes
- Added `privilegedPrisma` singleton (datasource URL override) + `DbClient` type.
  URL selection: PRIVILEGED_DATABASE_URL ?? DIRECT_URL ?? DATABASE_URL (documented).
- withTenant: UNCHANGED RLS shape (still sets app.current_institution_id transaction-
  local). Added only interactive-transaction options maxWait:15000/timeout:30000 so
  multi-query tenant handlers (e.g. admin dashboards ~9 counts) do not hit Prisma's
  5s default over the remote Supabase pooler. No RLS/semantic change.

### Verification (ACTUALLY RUN)
- `npm run build` at repo root: PASS (db + api + web, 3/3 tasks).
- `cd apps/api && npx vitest run`: 109/109 PASS, incl.
  tenant-escape.integration.test.ts 6/6 (live Supabase campass_app vs postgres).
- LIVE end-to-end against Supabase (built dist/server.js, PRIVILEGED_DATABASE_URL set
  locally = DIRECT_URL):
  - GET /api/health -> 200.
  - POST /api/auth/login admin@demo.edu/admin123 -> 200 WITH token (was 401 under RLS).
  - GET /api/admin/stats (ADMIN token) -> 200, tenant-scoped real data
    (totalStudents:1, totalHods:1, totalGuards:1, totalGates:2).
  - POST /api/auth/login bhavishya@demo.edu/student123 -> 200; GET /api/student/dashboard
    -> 200 with the student's own record; GET /api/student/reasons -> 12 tenant reasons.
  - TENANT WRITE: POST /api/student/gate-pass -> 201 (CG-2026-... PENDING) [withTenant
    write satisfied RLS WITH CHECK]; HOD POST /api/hod/approve -> APPROVED + qrToken;
    student notification PASS_APPROVED persisted (unread-count=1) proving notify ran on tx.
  - PLATFORM cross-tenant: SUPER_ADMIN GET /api/platform/stats -> 200 (2 institutions),
    privilegedPrisma bypassed RLS.
  Background server stopped; temp smoke files removed.

### ENV the user must set
- LOCAL (apps/api/.env, gitignored): PRIVILEGED_DATABASE_URL = the postgres SESSION
  POOLER URL (port 5432), same value as DIRECT_URL. If unset, falls back to DIRECT_URL
  then DATABASE_URL.
- PRODUCTION (Railway API service variables): add PRIVILEGED_DATABASE_URL = Supabase
  postgres session-pooler URL (Connect -> Session pooler, port 5432, role `postgres`),
  alongside DATABASE_URL (campass_app transaction pooler, 6543, ?pgbouncer=true) and
  DIRECT_URL (postgres session pooler, 5432). Never point PRIVILEGED_DATABASE_URL at
  campass_app. Vercel (web) needs no DB env; it only needs the API/frontend URLs.
