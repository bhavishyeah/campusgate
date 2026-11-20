-- CAMPASS notification foundation: Web Push device subscriptions + per-category
-- push preferences.
--
-- TWO new TENANT-OWNED tables (push_subscriptions, notification_preferences).
-- Unlike account_tokens (pre-auth, owner-only) these are read and written only in
-- a known tenant (request routes and the push dispatcher), so they get the standard
-- ENABLE + FORCE RLS pair {tenant_isolation_select, tenant_isolation_modify} and
-- campass_app grants. campass_app stays NOSUPERUSER NOBYPASSRLS.
--
-- Hand-authored (Prisma models neither the CHECKs, RLS nor the guarded grants).
-- STRICTLY ADDITIVE: only CREATEs new objects, no change to `notifications` or any
-- other existing table (the composite FK briefly locks users while it is added;
-- the new tables are empty). It never edits an existing migration directory.
--
-- NotificationCategory deliberately has NO EMERGENCY member: an emergency push
-- can never be stored as disabled.
--
-- Ordering (house style, lettered):
--   a. CREATE TYPE the category enum.
--   b. CREATE TABLEs + PK.
--   c. unique / lookup indexes.
--   d. composite same-tenant FKs to users(id, institutionId).
--   e. CHECKs.
--   f. ENABLE + FORCE RLS, standard policy pair.
--   g. guarded campass_app GRANTs + guarded REVOKEs for anon/authenticated.
--   h. no catalogue seed, no new permissions.

-- a. enum
CREATE TYPE "NotificationCategory" AS ENUM (
    'GATEPASS', 'FEES', 'EXAMS', 'ATTENDANCE', 'LIBRARY', 'ADMISSIONS', 'ANNOUNCEMENTS', 'SYSTEM'
);

-- b. tables
CREATE TABLE "push_subscriptions" (
    "id"            TEXT NOT NULL,
    "userId"        TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "endpoint"      TEXT NOT NULL,
    "p256dh"        TEXT NOT NULL,
    "auth"          TEXT NOT NULL,
    "userAgent"     TEXT,
    "deviceLabel"   TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "failureCount"  INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_preferences" (
    "id"            TEXT NOT NULL,
    "userId"        TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "category"      "NotificationCategory" NOT NULL,
    "pushEnabled"   BOOLEAN NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- c. indexes (one browser endpoint is one device, globally unique)
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");
CREATE UNIQUE INDEX "push_subscriptions_id_institutionId_key" ON "push_subscriptions"("id", "institutionId");
CREATE INDEX "push_subscriptions_userId_idx" ON "push_subscriptions"("userId");
CREATE INDEX "push_subscriptions_institutionId_idx" ON "push_subscriptions"("institutionId");

CREATE UNIQUE INDEX "notification_preferences_userId_category_key" ON "notification_preferences"("userId", "category");
CREATE UNIQUE INDEX "notification_preferences_id_institutionId_key" ON "notification_preferences"("id", "institutionId");
CREATE INDEX "notification_preferences_institutionId_idx" ON "notification_preferences"("institutionId");

-- d. composite same-tenant FKs (use the existing users_id_institutionId_key)
ALTER TABLE "push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_userId_institutionId_fkey"
    FOREIGN KEY ("userId", "institutionId") REFERENCES "users"("id", "institutionId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_preferences"
    ADD CONSTRAINT "notification_preferences_userId_institutionId_fkey"
    FOREIGN KEY ("userId", "institutionId") REFERENCES "users"("id", "institutionId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- e. CHECKs
ALTER TABLE "push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_endpoint_chk" CHECK ("endpoint" ~ '^https://' AND char_length("endpoint") <= 2048),
    ADD CONSTRAINT "push_subscriptions_p256dh_chk" CHECK (char_length("p256dh") BETWEEN 80 AND 100),
    ADD CONSTRAINT "push_subscriptions_auth_chk" CHECK (char_length("auth") BETWEEN 16 AND 32),
    ADD CONSTRAINT "push_subscriptions_failureCount_chk" CHECK ("failureCount" >= 0);

-- f. RLS: ENABLE + FORCE with the fail-closed nullif-guarded policy pair.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['push_subscriptions', 'notification_preferences'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS "tenant_isolation_select" ON %I', t);
    EXECUTE format(
      'CREATE POLICY "tenant_isolation_select" ON %I FOR SELECT '
      || 'USING ("institutionId" = nullif(current_setting(''app.current_institution_id'', true), ''''))',
      t);

    EXECUTE format('DROP POLICY IF EXISTS "tenant_isolation_modify" ON %I', t);
    EXECUTE format(
      'CREATE POLICY "tenant_isolation_modify" ON %I FOR ALL '
      || 'USING ("institutionId" = nullif(current_setting(''app.current_institution_id'', true), '''')) '
      || 'WITH CHECK ("institutionId" = nullif(current_setting(''app.current_institution_id'', true), ''''))',
      t);
  END LOOP;
END
$$;

-- g. grants (guarded + idempotent; roles may not exist locally). Subscriptions are
--    deleted on 404/410, logout and device removal; preferences are never deleted
--    (toggling back writes pushEnabled = true). Never grant BYPASSRLS.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "push_subscriptions" TO "campass_app";
    GRANT SELECT, INSERT, UPDATE ON "notification_preferences" TO "campass_app";
    -- Default privileges may have granted more; RLS does not cover TRUNCATE, and preferences are never deleted.
    REVOKE DELETE, TRUNCATE ON "notification_preferences" FROM "campass_app";
    REVOKE TRUNCATE ON "push_subscriptions" FROM "campass_app";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "push_subscriptions", "notification_preferences" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "push_subscriptions", "notification_preferences" FROM authenticated;
  END IF;
END
$$;
