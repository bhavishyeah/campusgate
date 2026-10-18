-- Tenancy B-1: multi-tenant isolation (institutionId + composite FKs + RLS).
--
-- This migration is hand-authored (Prisma does not model composite FKs, the
-- (id, institutionId) composite uniques used for them, RLS, or GRANTs natively).
-- Ordering is load-bearing:
--   1. add institutionId columns NULLABLE on the tables missing it;
--   2. backfill institutionId from the existing join chain (dependency order);
--   3. SET NOT NULL;
--   4. add (id, institutionId) composite uniques on referenced parents;
--   5. replace single-column FKs between tenant-owned tables with composite FKs;
--   6. ENABLE + FORCE RLS and create tenant_isolation policies;
--   7. idempotently (re)apply campass_app GRANTs (role already exists; never create it).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Add institutionId columns (NULLABLE first, so backfill can run).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "student_profiles"            ADD COLUMN "institutionId" TEXT;
ALTER TABLE "hod_profiles"                ADD COLUMN "institutionId" TEXT;
ALTER TABLE "guard_profiles"              ADD COLUMN "institutionId" TEXT;
ALTER TABLE "gate_passes"                 ADD COLUMN "institutionId" TEXT;
ALTER TABLE "gate_events"                 ADD COLUMN "institutionId" TEXT;
ALTER TABLE "guard_gate_assignments"      ADD COLUMN "institutionId" TEXT;
ALTER TABLE "emergency_overrides"         ADD COLUMN "institutionId" TEXT;
ALTER TABLE "reliability_score_snapshots" ADD COLUMN "institutionId" TEXT;
ALTER TABLE "notifications"               ADD COLUMN "institutionId" TEXT;
ALTER TABLE "audit_logs"                  ADD COLUMN "institutionId" TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Backfill institutionId from the existing join chain (dependency order).
--    Tier 1: derive directly from users.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE "student_profiles" sp
  SET "institutionId" = u."institutionId"
  FROM "users" u
  WHERE sp."userId" = u."id";

UPDATE "hod_profiles" hp
  SET "institutionId" = u."institutionId"
  FROM "users" u
  WHERE hp."userId" = u."id";

UPDATE "guard_profiles" gp
  SET "institutionId" = u."institutionId"
  FROM "users" u
  WHERE gp."userId" = u."id";

UPDATE "notifications" n
  SET "institutionId" = u."institutionId"
  FROM "users" u
  WHERE n."userId" = u."id";

UPDATE "audit_logs" al
  SET "institutionId" = u."institutionId"
  FROM "users" u
  WHERE al."actorId" = u."id";

-- Tier 2: derive from the Tier-1 profiles (now populated).
UPDATE "gate_passes" gpass
  SET "institutionId" = sp."institutionId"
  FROM "student_profiles" sp
  WHERE gpass."studentId" = sp."id";

UPDATE "reliability_score_snapshots" rs
  SET "institutionId" = sp."institutionId"
  FROM "student_profiles" sp
  WHERE rs."studentId" = sp."id";

UPDATE "guard_gate_assignments" gga
  SET "institutionId" = gp."institutionId"
  FROM "guard_profiles" gp
  WHERE gga."guardId" = gp."id";

-- Tier 3: derive from gate_passes (now populated).
UPDATE "gate_events" ge
  SET "institutionId" = gpass."institutionId"
  FROM "gate_passes" gpass
  WHERE ge."passId" = gpass."id";

UPDATE "emergency_overrides" eo
  SET "institutionId" = gpass."institutionId"
  FROM "gate_passes" gpass
  WHERE eo."gatePassId" = gpass."id";

-- ─────────────────────────────────────────────────────────────────────────────
-- 2b. Fail loudly if any row could not be backfilled (orphan with no parent).
--     SET NOT NULL below would error, but this gives a clearer signal.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t   TEXT;
  cnt BIGINT;
  tables TEXT[] := ARRAY[
    'student_profiles','hod_profiles','guard_profiles','gate_passes','gate_events',
    'guard_gate_assignments','emergency_overrides','reliability_score_snapshots',
    'notifications','audit_logs'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE "institutionId" IS NULL', t) INTO cnt;
    IF cnt > 0 THEN
      RAISE EXCEPTION 'Backfill incomplete: % rows in % have a NULL institutionId (orphaned parent)', cnt, t;
    END IF;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. SET NOT NULL now that every row carries a tenant.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "student_profiles"            ALTER COLUMN "institutionId" SET NOT NULL;
ALTER TABLE "hod_profiles"                ALTER COLUMN "institutionId" SET NOT NULL;
ALTER TABLE "guard_profiles"              ALTER COLUMN "institutionId" SET NOT NULL;
ALTER TABLE "gate_passes"                 ALTER COLUMN "institutionId" SET NOT NULL;
ALTER TABLE "gate_events"                 ALTER COLUMN "institutionId" SET NOT NULL;
ALTER TABLE "guard_gate_assignments"      ALTER COLUMN "institutionId" SET NOT NULL;
ALTER TABLE "emergency_overrides"         ALTER COLUMN "institutionId" SET NOT NULL;
ALTER TABLE "reliability_score_snapshots" ALTER COLUMN "institutionId" SET NOT NULL;
ALTER TABLE "notifications"               ALTER COLUMN "institutionId" SET NOT NULL;
ALTER TABLE "audit_logs"                  ALTER COLUMN "institutionId" SET NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. institutionId indexes (match the Prisma @@index declarations).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX "student_profiles_institutionId_idx"            ON "student_profiles"("institutionId");
CREATE INDEX "hod_profiles_institutionId_idx"                ON "hod_profiles"("institutionId");
CREATE INDEX "guard_profiles_institutionId_idx"              ON "guard_profiles"("institutionId");
CREATE INDEX "gate_passes_institutionId_idx"                 ON "gate_passes"("institutionId");
CREATE INDEX "gate_events_institutionId_idx"                 ON "gate_events"("institutionId");
CREATE INDEX "guard_gate_assignments_institutionId_idx"      ON "guard_gate_assignments"("institutionId");
CREATE INDEX "emergency_overrides_institutionId_idx"         ON "emergency_overrides"("institutionId");
CREATE INDEX "reliability_score_snapshots_institutionId_idx" ON "reliability_score_snapshots"("institutionId");
CREATE INDEX "notifications_institutionId_idx"               ON "notifications"("institutionId");
CREATE INDEX "audit_logs_institutionId_idx"                  ON "audit_logs"("institutionId");

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. (id, institutionId) composite uniques on parents referenced by composite FKs.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "departments"      ADD CONSTRAINT "departments_id_institutionId_key"      UNIQUE ("id", "institutionId");
ALTER TABLE "users"            ADD CONSTRAINT "users_id_institutionId_key"            UNIQUE ("id", "institutionId");
ALTER TABLE "exit_reasons"     ADD CONSTRAINT "exit_reasons_id_institutionId_key"     UNIQUE ("id", "institutionId");
ALTER TABLE "gates"            ADD CONSTRAINT "gates_id_institutionId_key"            UNIQUE ("id", "institutionId");
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_id_institutionId_key" UNIQUE ("id", "institutionId");
ALTER TABLE "hod_profiles"     ADD CONSTRAINT "hod_profiles_id_institutionId_key"     UNIQUE ("id", "institutionId");
ALTER TABLE "guard_profiles"   ADD CONSTRAINT "guard_profiles_id_institutionId_key"   UNIQUE ("id", "institutionId");
ALTER TABLE "gate_passes"      ADD CONSTRAINT "gate_passes_id_institutionId_key"      UNIQUE ("id", "institutionId");

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Replace single-column FKs between tenant-owned tables with COMPOSITE FKs
--    that carry institutionId, so the DB refuses cross-tenant links (tenancy §4).
--    FKs to the tenant root (institutions.id) and cross-cutting actor FKs stay
--    single-column (recorded in the plan).
-- ─────────────────────────────────────────────────────────────────────────────

-- student_profiles.userId -> users(id, institutionId)
ALTER TABLE "student_profiles" DROP CONSTRAINT "student_profiles_userId_fkey";
ALTER TABLE "student_profiles"
  ADD CONSTRAINT "student_profiles_user_same_tenant_fkey"
  FOREIGN KEY ("userId", "institutionId") REFERENCES "users"("id", "institutionId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- student_profiles.departmentId -> departments(id, institutionId)
ALTER TABLE "student_profiles" DROP CONSTRAINT "student_profiles_departmentId_fkey";
ALTER TABLE "student_profiles"
  ADD CONSTRAINT "student_profiles_department_same_tenant_fkey"
  FOREIGN KEY ("departmentId", "institutionId") REFERENCES "departments"("id", "institutionId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- hod_profiles.userId -> users(id, institutionId)
ALTER TABLE "hod_profiles" DROP CONSTRAINT "hod_profiles_userId_fkey";
ALTER TABLE "hod_profiles"
  ADD CONSTRAINT "hod_profiles_user_same_tenant_fkey"
  FOREIGN KEY ("userId", "institutionId") REFERENCES "users"("id", "institutionId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- hod_profiles.departmentId -> departments(id, institutionId)
ALTER TABLE "hod_profiles" DROP CONSTRAINT "hod_profiles_departmentId_fkey";
ALTER TABLE "hod_profiles"
  ADD CONSTRAINT "hod_profiles_department_same_tenant_fkey"
  FOREIGN KEY ("departmentId", "institutionId") REFERENCES "departments"("id", "institutionId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- guard_profiles.userId -> users(id, institutionId)
ALTER TABLE "guard_profiles" DROP CONSTRAINT "guard_profiles_userId_fkey";
ALTER TABLE "guard_profiles"
  ADD CONSTRAINT "guard_profiles_user_same_tenant_fkey"
  FOREIGN KEY ("userId", "institutionId") REFERENCES "users"("id", "institutionId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- gate_passes.studentId -> student_profiles(id, institutionId)
ALTER TABLE "gate_passes" DROP CONSTRAINT "gate_passes_studentId_fkey";
ALTER TABLE "gate_passes"
  ADD CONSTRAINT "gate_passes_student_same_tenant_fkey"
  FOREIGN KEY ("studentId", "institutionId") REFERENCES "student_profiles"("id", "institutionId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- gate_passes.reasonId -> exit_reasons(id, institutionId)
ALTER TABLE "gate_passes" DROP CONSTRAINT "gate_passes_reasonId_fkey";
ALTER TABLE "gate_passes"
  ADD CONSTRAINT "gate_passes_reason_same_tenant_fkey"
  FOREIGN KEY ("reasonId", "institutionId") REFERENCES "exit_reasons"("id", "institutionId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- gate_passes.approvedById -> hod_profiles(id, institutionId) (NULLABLE; MATCH SIMPLE skips the check when approvedById is NULL)
ALTER TABLE "gate_passes" DROP CONSTRAINT "gate_passes_approvedById_fkey";
ALTER TABLE "gate_passes"
  ADD CONSTRAINT "gate_passes_approvedBy_same_tenant_fkey"
  FOREIGN KEY ("approvedById", "institutionId") REFERENCES "hod_profiles"("id", "institutionId")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- gate_events.passId -> gate_passes(id, institutionId)
ALTER TABLE "gate_events" DROP CONSTRAINT "gate_events_passId_fkey";
ALTER TABLE "gate_events"
  ADD CONSTRAINT "gate_events_pass_same_tenant_fkey"
  FOREIGN KEY ("passId", "institutionId") REFERENCES "gate_passes"("id", "institutionId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- gate_events.gateId -> gates(id, institutionId)
ALTER TABLE "gate_events" DROP CONSTRAINT "gate_events_gateId_fkey";
ALTER TABLE "gate_events"
  ADD CONSTRAINT "gate_events_gate_same_tenant_fkey"
  FOREIGN KEY ("gateId", "institutionId") REFERENCES "gates"("id", "institutionId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- gate_events.guardId -> guard_profiles(id, institutionId)
ALTER TABLE "gate_events" DROP CONSTRAINT "gate_events_guardId_fkey";
ALTER TABLE "gate_events"
  ADD CONSTRAINT "gate_events_guard_same_tenant_fkey"
  FOREIGN KEY ("guardId", "institutionId") REFERENCES "guard_profiles"("id", "institutionId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- guard_gate_assignments.guardId -> guard_profiles(id, institutionId)
ALTER TABLE "guard_gate_assignments" DROP CONSTRAINT "guard_gate_assignments_guardId_fkey";
ALTER TABLE "guard_gate_assignments"
  ADD CONSTRAINT "guard_gate_assignments_guard_same_tenant_fkey"
  FOREIGN KEY ("guardId", "institutionId") REFERENCES "guard_profiles"("id", "institutionId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- guard_gate_assignments.gateId -> gates(id, institutionId)
ALTER TABLE "guard_gate_assignments" DROP CONSTRAINT "guard_gate_assignments_gateId_fkey";
ALTER TABLE "guard_gate_assignments"
  ADD CONSTRAINT "guard_gate_assignments_gate_same_tenant_fkey"
  FOREIGN KEY ("gateId", "institutionId") REFERENCES "gates"("id", "institutionId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- guard_shifts.guardId -> guard_profiles(id, institutionId)  (guard_shifts already has institutionId)
ALTER TABLE "guard_shifts" DROP CONSTRAINT "guard_shifts_guardId_fkey";
ALTER TABLE "guard_shifts"
  ADD CONSTRAINT "guard_shifts_guard_same_tenant_fkey"
  FOREIGN KEY ("guardId", "institutionId") REFERENCES "guard_profiles"("id", "institutionId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- guard_shifts.gateId -> gates(id, institutionId)
ALTER TABLE "guard_shifts" DROP CONSTRAINT "guard_shifts_gateId_fkey";
ALTER TABLE "guard_shifts"
  ADD CONSTRAINT "guard_shifts_gate_same_tenant_fkey"
  FOREIGN KEY ("gateId", "institutionId") REFERENCES "gates"("id", "institutionId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- emergency_overrides.gatePassId -> gate_passes(id, institutionId)
ALTER TABLE "emergency_overrides" DROP CONSTRAINT "emergency_overrides_gatePassId_fkey";
ALTER TABLE "emergency_overrides"
  ADD CONSTRAINT "emergency_overrides_gatePass_same_tenant_fkey"
  FOREIGN KEY ("gatePassId", "institutionId") REFERENCES "gate_passes"("id", "institutionId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- reliability_score_snapshots.studentId -> student_profiles(id, institutionId)
ALTER TABLE "reliability_score_snapshots" DROP CONSTRAINT "reliability_score_snapshots_studentId_fkey";
ALTER TABLE "reliability_score_snapshots"
  ADD CONSTRAINT "reliability_score_snapshots_student_same_tenant_fkey"
  FOREIGN KEY ("studentId", "institutionId") REFERENCES "student_profiles"("id", "institutionId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- audit_logs.actorId -> users(id, institutionId)
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_actorId_fkey";
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_actor_same_tenant_fkey"
  FOREIGN KEY ("actorId", "institutionId") REFERENCES "users"("id", "institutionId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6b. New single-column FKs institutionId -> institutions(id) for the tables that
--     just gained institutionId (matches Prisma's Institution relation; the tenant
--     root link stays single-column, by design).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "student_profiles"
  ADD CONSTRAINT "student_profiles_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hod_profiles"
  ADD CONSTRAINT "hod_profiles_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "guard_profiles"
  ADD CONSTRAINT "guard_profiles_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gate_passes"
  ADD CONSTRAINT "gate_passes_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gate_events"
  ADD CONSTRAINT "gate_events_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "guard_gate_assignments"
  ADD CONSTRAINT "guard_gate_assignments_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "emergency_overrides"
  ADD CONSTRAINT "emergency_overrides_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reliability_score_snapshots"
  ADD CONSTRAINT "reliability_score_snapshots_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Row-Level Security: ENABLE + FORCE on every tenant-owned table and create the
--    standard tenant_isolation policies (tenancy §5.3). current_setting(..., true)
--    returns NULL when unset => "=" yields no rows => fail-closed.
--    institutions (tenant root), security_events (nullable tenant), sessions
--    (per-user auth state) are intentionally excluded (see plan).
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
  rls_tables TEXT[] := ARRAY[
    'departments','users','gates','exit_reasons','guard_shifts','emergency_alerts',
    'academic_calendar_days','institution_configs','allowance_policies',
    'student_profiles','hod_profiles','guard_profiles','gate_passes','gate_events',
    'guard_gate_assignments','emergency_overrides','reliability_score_snapshots',
    'notifications','audit_logs'
  ];
BEGIN
  FOREACH t IN ARRAY rls_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS "tenant_isolation_select" ON %I', t);
    EXECUTE format(
      'CREATE POLICY "tenant_isolation_select" ON %I FOR SELECT '
      || 'USING ("institutionId" = current_setting(''app.current_institution_id'', true))',
      t);

    EXECUTE format('DROP POLICY IF EXISTS "tenant_isolation_modify" ON %I', t);
    EXECUTE format(
      'CREATE POLICY "tenant_isolation_modify" ON %I FOR ALL '
      || 'USING ("institutionId" = current_setting(''app.current_institution_id'', true)) '
      || 'WITH CHECK ("institutionId" = current_setting(''app.current_institution_id'', true))',
      t);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. campass_app GRANTs (idempotent). The role ALREADY EXISTS in Supabase
--    (NOSUPERUSER NOBYPASSRLS). Never create it or set a password here. Guard the
--    grants so the migration still applies in an environment where it is absent.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    GRANT USAGE ON SCHEMA public TO "campass_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "campass_app";
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "campass_app";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "campass_app";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO "campass_app";
  END IF;
END $$;
