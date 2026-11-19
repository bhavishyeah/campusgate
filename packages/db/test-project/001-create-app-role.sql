-- CampusGate TEST project bootstrap, step 1 of 2: create the `campass_app` role.
--
-- Run ONCE in the TEST Supabase project's SQL editor (as `postgres`), BEFORE
-- `npm run db:migrate:test`. Never run this against the production project.
--
-- Why: the Prisma migrations only GRANT to campass_app inside
-- `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app')` guards and
-- never create the role (production's was created by hand). If the role does not
-- exist when migrations run, the grants are silently skipped and the app role
-- would have no table access.
--
-- Role contract (see packages/db/.env.example, apps/api/.env.example): the app role
-- is NOSUPERUSER NOBYPASSRLS, so tenant RLS actually enforces for it. Never give
-- it BYPASSRLS; the startup/webhook probes treat a BYPASSRLS app role as a
-- misconfiguration.
--
-- BEFORE RUNNING: replace __SET_A_STRONG_PASSWORD__ below with a strong password
-- (it goes into apps/api/.env.test DATABASE_URL). Avoid characters that need URL
-- encoding (@ : / ? # %) or URL-encode them in the connection string.
--
-- Supavisor (pooler) login username format: campass_app.<project-ref>
--   e.g. postgresql://campass_app.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true
--
-- Idempotent: re-running does not recreate the role. It resets the attributes to
-- the contract but does NOT change an existing password.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    CREATE ROLE campass_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '__SET_A_STRONG_PASSWORD__';
  ELSE
    ALTER ROLE campass_app LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

-- Baseline schema access. The migrations then grant table/sequence privileges
-- and set the default privileges for objects the owner creates later.
GRANT USAGE ON SCHEMA public TO campass_app;
