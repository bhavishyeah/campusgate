-- CAMPASS account lifecycle: password reset + account activation tokens.
--
-- ONE new OWNER-ONLY table (account_tokens). Reset/activation are pre-auth, so
-- the table is reachable only through the owner client (privilegedPrisma). It
-- is deliberately NOT given tenant RLS policies and campass_app gets no grants.
-- RLS is ENABLED (not FORCED) with NO policy as a backstop: anon, authenticated
-- and campass_app see zero rows even if a later blanket GRANT re-adds a
-- privilege, while the owner/BYPASSRLS client keeps working.
--
-- Hand-authored (Prisma models neither the partial indexes, the CHECKs, RLS nor
-- the guarded REVOKEs). STRICTLY ADDITIVE: only CREATEs new objects, no data
-- rewrite, no change to any existing table (the FK takes a brief lock on users
-- while it is added; the new table is empty). It never edits an existing
-- migration directory and campass_app stays NOSUPERUSER NOBYPASSRLS.
--
-- Ordering (house style, lettered):
--   a. CREATE TYPE the purpose enum.
--   b. CREATE TABLE + PK.
--   c. unique / partial unique / lookup indexes.
--   d. composite same-tenant FK to users(id, institutionId).
--   e. CHECKs.
--   f. ENABLE RLS (no policy) + guarded REVOKEs.
--   g. no catalogue seed, no new permissions.

-- a. enum
CREATE TYPE "AccountTokenPurpose" AS ENUM ('PASSWORD_RESET', 'ACCOUNT_ACTIVATION');

-- b. table
CREATE TABLE "account_tokens" (
    "id"              TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "institutionId"   TEXT NOT NULL,
    "purpose"         "AccountTokenPurpose" NOT NULL,
    "tokenHash"       TEXT NOT NULL,
    "expiresAt"       TIMESTAMP(3) NOT NULL,
    "emailSentAt"     TIMESTAMP(3),
    "failedAt"        TIMESTAMP(3),
    "failureReason"   TEXT,
    "usedAt"          TIMESTAMP(3),
    "supersededAt"    TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_tokens_pkey" PRIMARY KEY ("id")
);

-- c. indexes
CREATE UNIQUE INDEX "account_tokens_tokenHash_key" ON "account_tokens"("tokenHash");
CREATE INDEX "account_tokens_userId_purpose_createdAt_idx" ON "account_tokens"("userId", "purpose", "createdAt");
CREATE INDEX "account_tokens_institutionId_idx" ON "account_tokens"("institutionId");
-- At most one live (unused, unsuperseded) token per user and purpose.
CREATE UNIQUE INDEX "account_tokens_live_user_purpose_key"
    ON "account_tokens"("userId", "purpose")
    WHERE "usedAt" IS NULL AND "supersededAt" IS NULL;
-- Budget count (rolling 24h) and failure cool-down lookups.
CREATE INDEX "account_tokens_emailSentAt_idx" ON "account_tokens"("emailSentAt") WHERE "emailSentAt" IS NOT NULL;
CREATE INDEX "account_tokens_failedAt_idx" ON "account_tokens"("userId", "failedAt") WHERE "failedAt" IS NOT NULL;

-- d. composite same-tenant FK (uses the existing users_id_institutionId_key)
ALTER TABLE "account_tokens"
    ADD CONSTRAINT "account_tokens_userId_institutionId_fkey"
    FOREIGN KEY ("userId", "institutionId") REFERENCES "users"("id", "institutionId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- e. CHECKs
ALTER TABLE "account_tokens"
    ADD CONSTRAINT "account_tokens_tokenHash_format_chk" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "account_tokens_expiry_chk" CHECK ("expiresAt" > "createdAt"),
    ADD CONSTRAINT "account_tokens_failure_chk" CHECK ("failureReason" IS NULL OR "failedAt" IS NOT NULL);

-- f. RLS enabled with NO policy + guarded revokes (roles may not exist locally)
ALTER TABLE "account_tokens" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campass_app') THEN
    REVOKE ALL ON "account_tokens" FROM campass_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "account_tokens" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "account_tokens" FROM authenticated;
  END IF;
END
$$;
