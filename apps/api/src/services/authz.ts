import { prisma } from "@campusgate/db";

export async function getStudentInTenant(userId: string, institutionId: string) {
  return prisma.studentProfile.findFirst({
    where: { userId, user: { institutionId } },
  });
}

export async function getHodInTenant(userId: string, institutionId: string) {
  return prisma.hodProfile.findFirst({
    where: { userId, user: { institutionId } },
  });
}

export async function getGuardInTenant(userId: string, institutionId: string) {
  return prisma.guardProfile.findFirst({
    where: { userId, user: { institutionId } },
  });
}

export async function getTenantPassById(passId: string, institutionId: string) {
  return prisma.gatePass.findFirst({
    where: {
      id: passId,
      student: { user: { institutionId } },
    },
  });
}
