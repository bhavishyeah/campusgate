# Test database (live-DB integration suites)

The live-DB suites (`apps/api/vitest.live-db-suites.ts`) create and delete real rows. They run **only** against a dedicated Supabase TEST project, never production.

## Why

- **Production isolation.** Earlier runs read `apps/api/.env` and `packages/db/.env`, which point at production, and left test institutions there.
- **Pool contention.** The free tier's session pooler allows about 15 clients (`EMAXCONNSESSION`). Test runs competed with the production API for those slots. The limit now applies to the test project alone.

## One-time setup

1. Create a second free Supabase project, in the same region as production. Free accounts can have more than one project.
2. In the test project's SQL editor, run `packages/db/test-project/001-create-app-role.sql` after replacing `__SET_A_STRONG_PASSWORD__`. The Prisma migrations only grant to `campass_app` if it already exists, so this must happen before step 4.
3. Copy the templates and fill them from Dashboard > Connect (the same place `.env.example` points to):
   - `apps/api/.env.test.example` to `apps/api/.env.test`: `DATABASE_URL` is `campass_app.<ref>` over the transaction pooler (6543, `?pgbouncer=true`).
   - `packages/db/.env.test.example` to `packages/db/.env.test`: `DIRECT_URL` is `postgres.<ref>` over the session pooler (5432); also set `DATABASE_URL`.
   - Both files are git-ignored (`**/.env.test*`); only the `.example` files are tracked.
4. Apply the migrations: `npm run db:migrate:test` (from the repo root).
5. Verify: `npm run db:check:test`. It connects read-only and prints the ref, whether `campass_app` exists with `rolsuper=false` and `rolbypassrls=false`, applied vs local migration count, and whether the storage variables are set.
6. Optional, only for `storage.smoke`: create a `documents` bucket in the test project and add `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (and optionally `SUPABASE_STORAGE_BUCKET`) to `apps/api/.env.test`. Without them the smoke suite is skipped. The other suites use an in-memory object store.

`npm run db:migrate:test -w @campusgate/db -- --dry-run` prints the project ref and host that would be used, without connecting.

## Running suites

```
cd apps/api
npx vitest run --config vitest.integration.config.ts hostel.behavioral   # one suite
npm run test:integration                                                 # all live suites, serial
```

`npm test` (the fast run) never loads the test environment and needs no database.

## How the guard works

Every live suite imports `apps/api/src/routes/__tests__/helpers/live-test-env.ts` (directly, or through `tenant-escape-setup.ts`). On import it:

- Reads only `apps/api/.env.test` and `packages/db/.env.test`. If either is missing it throws an error naming the file and keys. It never falls back to `.env`.
- Extracts the project ref from every loaded URL: pooler user `postgres.<ref>` / `campass_app.<ref>`, direct host `db.<ref>.supabase.co`, or `https://<ref>.supabase.co`.
- Throws before any connection if a URL references a protected ref. Protected refs are the production ref (a constant in `live-test-env-core.ts`) plus any in the comma-separated `CG_PROTECTED_PROJECT_REFS` environment variable. The check also does a plain substring match, so an unusual URL shape cannot slip past.
- Throws if the app and admin URLs reference different projects.
- Prints `live tests -> project <ref> (test)` and the host (never credentials).

There is no flag to bypass the production ref. Someone who really needs to must edit the code.

The suites then call `pinLiveTestEnv()` before `@campusgate/db` loads, which sets `DATABASE_URL` (app role), `PRIVILEGED_DATABASE_URL` and `DIRECT_URL` (owner), and the `SUPABASE_*` storage variables (or removes them if the test file has none, so a production value in your shell cannot leak in).

`migrate-test.mjs` applies the same rules (`packages/db/test-project/guard.mjs`) and sets `DATABASE_URL`/`DIRECT_URL` explicitly in the Prisma child process.

## Seed data

No suite needs `db:seed` or any hand-made rows. The migrations insert the permission catalogue, the template roles (`institutionId` NULL: STUDENT, GUARD, HOD, ADMIN, SUPER_ADMIN, FACULTY, ACCOUNTANT, LIBRARIAN, EMPLOYEE, and the rest) and their `role_permissions`. The suites look template roles up by key (for example `ADMIN`, `FACULTY`, `HOD`, `LIBRARIAN`, `STUDENT`, `EMPLOYEE`) and create their own prefixed institutions, users and data, then delete them. None references Demo University or seeded users such as `admin@demo.edu` (those appear only in mocked fast suites). `packages/db/src/seed.ts` is idempotent; it creates the demo/platform tenant and tops up the catalogue, and is not part of test setup. If a suite fails with a missing role or permission on a fresh project, run it only with the test `.env.test` values, never against production.

## Free-tier notes

- A free project auto-pauses after about 7 days of inactivity. Restore it from the dashboard before running tests; a paused project shows up as connection failures (P1001).
- The 15-slot pooler limit applies to the test project only. Suites run serially (`fileParallelism: false`), so keep it that way.
