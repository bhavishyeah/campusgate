import { PrismaClient, Prisma } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  privilegedPrisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * Privileged Prisma client that connects as the Postgres owner/`postgres` role
 * and therefore BYPASSES the Row-Level-Security policies enforced on the
 * `campass_app` runtime role (see the `tenancy_isolation_rls` migration).
 *
 * Use this client ONLY for queries that legitimately run OUTSIDE a tenant
 * context and must not fail closed under RLS:
 *   - Auth-bootstrap / pre-token lookups (login, register, the public
 *     `/departments` list, the session + user+institution reads in the
 *     `authenticate` middleware and the WebSocket `/connect` handshake).
 *   - Platform / SUPER_ADMIN routes that are cross-tenant by design.
 * Every tenant-scoped read/write MUST still go through `withTenant` on the
 * base `prisma` client — never through `privilegedPrisma`.
 *
 * Connection-string selection + fallback (documented in apps/api/.env.example):
 *   1. PRIVILEGED_DATABASE_URL  — preferred; the dedicated privileged URL.
 *   2. DIRECT_URL               — fallback; the postgres session-pooler URL
 *                                 (same shape/role as the privileged URL), so
 *                                 the app keeps working without a new secret.
 *   3. DATABASE_URL             — last-resort fallback so that tests which only
 *                                 set DATABASE_URL (mocked suites, the escape
 *                                 harness) can import this module without
 *                                 crashing. NOTE: if this falls back to the
 *                                 `campass_app` URL it will NOT bypass RLS — the
 *                                 privileged URL/`DIRECT_URL` MUST point at the
 *                                 postgres/owner role in any real deployment,
 *                                 never at `campass_app`.
 */
const privilegedDatabaseUrl =
  process.env.PRIVILEGED_DATABASE_URL ??
  process.env.DIRECT_URL ??
  process.env.DATABASE_URL;

export const privilegedPrisma =
  globalForPrisma.privilegedPrisma ??
  new PrismaClient({
    datasources: privilegedDatabaseUrl
      ? { db: { url: privilegedDatabaseUrl } }
      : undefined,
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production")
  globalForPrisma.privilegedPrisma = privilegedPrisma;

/**
 * A client capable of running model-delegate queries. Satisfied by both the
 * base `PrismaClient` (and `privilegedPrisma`) and the interactive-transaction
 * client (`Prisma.TransactionClient`) handed to `withTenant` callbacks. Service
 * functions accept this so they can run inside a tenant transaction (`tx`) or,
 * by default, on the module-level `prisma`.
 */
export type DbClient = PrismaClient | Prisma.TransactionClient;

export * from "@prisma/client";
export type { PrismaClient } from "@prisma/client";

/**
 * Run `fn` inside a transaction whose first statement pins the tenant context.
 *
 * The RLS policies (see the `tenancy_isolation_rls` migration) read
 * `current_setting('app.current_institution_id', true)`. Setting it with
 * `set_config(..., true)` makes the value transaction-local, so it cannot leak
 * to the next request that reuses a pooled connection (verified under the
 * Supabase transaction pooler, port 6543, `pgbouncer=true`).
 *
 * Every tenant-scoped read/write MUST go through this helper. A query run on the
 * base client outside a transaction has no tenant GUC set and, under the RLS
 * policies, returns zero rows / rejects writes (fail-closed).
 *
 * `institutionId` must come from the authenticated request context (the verified
 * JWT/membership), never from a client-supplied body, param, or route value.
 *
 * NOTE: route wiring is deferred to B-2; this helper is exported but not yet used
 * by any route.
 */
export async function withTenant<T>(
  institutionId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_institution_id', $1, true)`,
        institutionId,
      );
      return fn(tx);
    },
    {
      // A whole tenant request runs inside this interactive transaction. The
      // Prisma default (5s) is too tight for handlers that issue several queries
      // over the remote Supabase pooler (e.g. dashboards doing ~9 counts) on a
      // cold connection. Widen the window; this does not change RLS semantics,
      // only how long the tenant-scoped transaction may run before Prisma aborts.
      maxWait: 15000,
      timeout: 30000,
    },
  );
}
