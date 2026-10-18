import { prisma, type Prisma } from "@campusgate/db";

/**
 * All helpers accept an optional `db` client (default: the module-level
 * `prisma`). Tenant routes pass the `withTenant` transaction client (`tx`) so
 * these lookups run inside the tenant RLS context; callers outside a tenant
 * context (and the mocked tests) transparently use the default `prisma`.
 */

export async function getStudentInTenant(
  userId: string,
  institutionId: string,
  db: Prisma.TransactionClient = prisma,
) {
  return db.studentProfile.findFirst({
    where: { userId, user: { institutionId } },
  });
}

export async function getHodInTenant(
  userId: string,
  institutionId: string,
  db: Prisma.TransactionClient = prisma,
) {
  return db.hodProfile.findFirst({
    where: { userId, user: { institutionId } },
  });
}

export async function getGuardInTenant(
  userId: string,
  institutionId: string,
  db: Prisma.TransactionClient = prisma,
) {
  return db.guardProfile.findFirst({
    where: { userId, user: { institutionId } },
  });
}

export async function getTenantPassById(
  passId: string,
  institutionId: string,
  db: Prisma.TransactionClient = prisma,
) {
  return db.gatePass.findFirst({
    where: {
      id: passId,
      student: { user: { institutionId } },
    },
  });
}
