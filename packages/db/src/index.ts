import { PrismaClient, Prisma } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
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
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_institution_id', $1, true)`,
      institutionId,
    );
    return fn(tx);
  });
}
