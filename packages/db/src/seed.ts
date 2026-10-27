import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
import { PERMISSIONS, ROLE_PERMISSIONS } from "@campusgate/shared";

/**
 * The seed writes to RLS-forced tenant tables (departments, gates, profiles, and
 * the B-2 institution_memberships / membership_roles) WITHOUT a tenant context,
 * so it must run on a connection that bypasses RLS — the `postgres` owner role
 * over the SESSION pooler (DIRECT_URL, port 5432).
 *
 * It must NOT default to DATABASE_URL: in this repo packages/db/.env's
 * DATABASE_URL is `postgres` over the TRANSACTION pooler (port 6543,
 * pgbouncer=true), and RLS is still ENFORCED on that path even for the owner
 * role — every FORCE-RLS insert fails closed with a 42501 policy violation
 * (verified). The privileged escape-suite adminClient uses DIRECT_URL for the
 * same reason. Fall back to DATABASE_URL only so a non-pooled deploy that sets
 * just DATABASE_URL to a direct owner connection still seeds.
 */
const seedDatabaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

const prisma = new PrismaClient(
  seedDatabaseUrl ? { datasources: { db: { url: seedDatabaseUrl } } } : undefined,
);

/** Human-friendly template role names, keyed by the template role key. */
const TEMPLATE_ROLE_NAMES: Record<string, string> = {
  STUDENT: "Student",
  GUARD: "Guard",
  HOD: "HOD",
  ADMIN: "Admin",
  SUPER_ADMIN: "Super Admin",
};

/**
 * Idempotently seed the RBAC catalogue + template roles + role→permission map
 * from the single @campusgate/shared source (design §3.2). Mirrors the
 * in-migration seed (ON CONFLICT DO NOTHING) so a fresh/dev DB resolves
 * permissions even if it was built with `migrate deploy` and no pre-existing
 * users. Template roles use find-first-then-create (NOT a NULL composite upsert)
 * so they never trip the roles_key_template_unique partial index.
 */
async function seedRbacCatalogue(): Promise<Map<string, string>> {
  // (i) Permissions — bulk insert, skipping ones already present (idempotent).
  //     createMany + skipDuplicates keeps this to a single round trip, which
  //     matters over the slow remote pooler.
  await prisma.permission.createMany({
    data: PERMISSIONS.map((p) => ({ key: p.key, module: p.module, description: p.description })),
    skipDuplicates: true,
  });
  const permissions = await prisma.permission.findMany({ select: { id: true, key: true } });
  const permIdByKey = new Map(permissions.map((p) => [p.key, p.id]));

  // (ii) Template roles (institutionId: null) — find-first-then-create (NOT a
  //      NULL composite upsert, which could trip roles_key_template_unique).
  const roleIdByKey = new Map<string, string>();
  for (const key of Object.keys(ROLE_PERMISSIONS)) {
    const existing = await prisma.role.findFirst({ where: { key, institutionId: null } });
    const role =
      existing ??
      (await prisma.role.create({
        data: { key, name: TEMPLATE_ROLE_NAMES[key] ?? key, institutionId: null },
      }));
    roleIdByKey.set(key, role.id);
  }

  // (iii) role_permissions — bulk insert the (roleId, permissionId) links,
  //       skipping existing (idempotent, one round trip).
  const links: { roleId: string; permissionId: string }[] = [];
  for (const [roleKey, permKeys] of Object.entries(ROLE_PERMISSIONS)) {
    const roleId = roleIdByKey.get(roleKey)!;
    for (const permKey of permKeys) {
      const permissionId = permIdByKey.get(permKey);
      if (permissionId) links.push({ roleId, permissionId });
    }
  }
  await prisma.rolePermission.createMany({ data: links, skipDuplicates: true });

  console.log("  ✓ RBAC catalogue seeded (permissions, template roles, role_permissions)");
  return roleIdByKey;
}

/**
 * Idempotently ensure a demo user has one ACTIVE membership + one membership-role
 * bound to the template role matching the user's legacy role enum. superadmin is
 * excluded by the caller (no tenant membership).
 */
async function ensureMembership(
  userId: string,
  institutionId: string,
  roleKey: string,
  roleIdByKey: Map<string, string>,
): Promise<void> {
  const membership = await prisma.institutionMembership.upsert({
    where: { userId_institutionId: { userId, institutionId } },
    update: {},
    create: { userId, institutionId, membershipStatus: "ACTIVE", permissionsVersion: 0 },
  });

  const roleId = roleIdByKey.get(roleKey);
  if (!roleId) return;

  await prisma.membershipRole.upsert({
    where: { membershipId_roleId: { membershipId: membership.id, roleId } },
    update: {},
    create: { membershipId: membership.id, roleId, institutionId },
  });
}

async function main() {
  console.log("🌱 Seeding CAMPUSGATE database...");

  // Create platform institution for SUPER_ADMIN scope
  const platformInstitution = await prisma.institution.upsert({
    where: { code: "PLATFORM" },
    update: {},
    create: {
      name: "CAMPUSGATE Platform",
      code: "PLATFORM",
      domain: "platform.local",
      settings: {},
    },
  });

  // Create institution
  const institution = await prisma.institution.upsert({
    where: { code: "DEMO" },
    update: {},
    create: {
      name: "Demo University",
      code: "DEMO",
      domain: "demo.edu",
      settings: {
        maxPassDurationHours: 8,
        allowedExitStart: "08:00",
        allowedExitEnd: "20:00",
      },
    },
  });

  console.log("  ✓ Institution created");

  // Create courses
  const courses = [
    { name: "B.Com/B.Com (Hons)", code: "110" },
    { name: "B.Tech (Computer Science & Engineering)", code: "501" },
    { name: "B.Tech (Electronics & Computer Engineering)", code: "502" },
    { name: "B.Tech (Electrical Engineering)", code: "504" },
    { name: "Bachelor of Business Administration (BBA)", code: "510" },
    { name: "Bachelor of Computer Applications (BCA)", code: "512" },
    { name: "Bachelor of Hotel Management (BHM)", code: "513" },
    { name: "B.Sc Animation", code: "601" },
    { name: "B.Sc IT", code: "602" },
  ];

  let bca: any;
  let btechCse: any;
  for (const c of courses) {
    const created = await prisma.department.upsert({
      where: { institutionId_code: { institutionId: institution.id, code: c.code } },
      update: {},
      create: { name: c.name, code: c.code, institutionId: institution.id },
    });
    if (c.code === "512") bca = created;
    if (c.code === "501") btechCse = created;
  }

  console.log("  ✓ Courses created (9)");

  // Create gates
  const mainGate = await prisma.gate.upsert({
    where: { institutionId_name: { institutionId: institution.id, name: "Main Gate" } },
    update: {},
    create: { name: "Main Gate", location: "Front Entrance", institutionId: institution.id },
  });

  const sideGate = await prisma.gate.upsert({
    where: { institutionId_name: { institutionId: institution.id, name: "Side Gate" } },
    update: {},
    create: { name: "Side Gate", location: "Parking Side", institutionId: institution.id },
  });

  console.log("  ✓ Gates created");

  // Create exit reasons
  const reasons = [
    { label: "Personal Work", requiresNote: false },
    { label: "Medical", requiresNote: false },
    { label: "Family Emergency", requiresNote: false },
    { label: "Official Work", requiresNote: false },
    { label: "Home Visit", requiresNote: false },
    { label: "Other", requiresNote: true },
  ];

  for (const r of reasons) {
    await prisma.exitReason.upsert({
      where: { id: `${institution.id}-${r.label}` },
      update: {},
      create: { ...r, institutionId: institution.id },
    });
  }
  console.log("  ✓ Exit reasons created");

  // Create super admin user
  const superAdminPassword = await bcrypt.hash("superadmin123", 12);
  await prisma.user.upsert({
    where: { email: "superadmin@campusgate.local" },
    update: {},
    create: {
      email: "superadmin@campusgate.local",
      passwordHash: superAdminPassword,
      role: "SUPER_ADMIN",
      accountStatus: "ACTIVE",
      institutionId: platformInstitution.id,
    },
  });
  console.log("  ✓ Super admin user created (superadmin@campusgate.local / superadmin123)");

  // Create admin user
  const adminPassword = await bcrypt.hash("admin123", 12);
  const admin = await prisma.user.upsert({
    where: { email: "admin@demo.edu" },
    update: {},
    create: {
      email: "admin@demo.edu",
      passwordHash: adminPassword,
      role: "ADMIN",
      accountStatus: "ACTIVE",
      institutionId: institution.id,
    },
  });
  console.log("  ✓ Admin user created (admin@demo.edu / admin123)");

  // Create HOD
  const hodPassword = await bcrypt.hash("hod123", 12);
  const hodUser = await prisma.user.upsert({
    where: { email: "hod.bca@demo.edu" },
    update: {},
    create: {
      email: "hod.bca@demo.edu",
      passwordHash: hodPassword,
      role: "HOD",
      accountStatus: "ACTIVE",
      institutionId: institution.id,
      hodProfile: {
        create: { name: "Dr. Sharma", departmentId: bca.id, institutionId: institution.id },
      },
    },
  });
  console.log("  ✓ HOD user created (hod.bca@demo.edu / hod123)");

  // Create Guard
  const guardPassword = await bcrypt.hash("guard123", 12);
  const guardUser = await prisma.user.upsert({
    where: { email: "guard@demo.edu" },
    update: {},
    create: {
      email: "guard@demo.edu",
      passwordHash: guardPassword,
      role: "GUARD",
      accountStatus: "ACTIVE",
      institutionId: institution.id,
      guardProfile: {
        create: {
          name: "Rajesh Kumar",
          institutionId: institution.id,
          assignedGates: {
            create: [{ gateId: mainGate.id, institutionId: institution.id }],
          },
        },
      },
    },
  });
  console.log("  ✓ Guard user created (guard@demo.edu / guard123)");

  // Create Student
  const studentPassword = await bcrypt.hash("student123", 12);
  const studentUser = await prisma.user.upsert({
    where: { email: "bhavishya@demo.edu" },
    update: {},
    create: {
      email: "bhavishya@demo.edu",
      passwordHash: studentPassword,
      role: "STUDENT",
      accountStatus: "ACTIVE",
      institutionId: institution.id,
      studentProfile: {
        create: {
          name: "Bhavishya Verma",
          enrollmentNo: "BCA2024001",
          departmentId: bca.id,
          institutionId: institution.id,
          program: "BCA",
          semester: 4,
          section: "A",
        },
      },
    },
  });
  console.log("  ✓ Student user created (bhavishya@demo.edu / student123)");

  // ─── RBAC: catalogue + template roles + per-user memberships (design §3.2) ──
  const roleIdByKey = await seedRbacCatalogue();

  // Each demo tenant user gets a membership + membership-role bound to its role.
  // superadmin@campusgate.local is platform-only — NO membership, NO membership-role.
  await ensureMembership(admin.id, admin.institutionId, "ADMIN", roleIdByKey);
  await ensureMembership(hodUser.id, hodUser.institutionId, "HOD", roleIdByKey);
  await ensureMembership(guardUser.id, guardUser.institutionId, "GUARD", roleIdByKey);
  await ensureMembership(studentUser.id, studentUser.institutionId, "STUDENT", roleIdByKey);
  console.log("  ✓ Demo user memberships ensured (superadmin excluded)");

  // ─── Module system: campus_movement ENTITLED+ACTIVE for the demo tenant ─────
  // Mirrors the module_system migration's backfill so a fresh/dev DB has the
  // only operational Phase-0 module ACTIVE for the demo tenant (otherwise the
  // now-wired requireModuleActive guard would 403 every GatePass route). Upsert
  // against the demo `institution` object the seed itself created — NOT the
  // PLATFORM institution, which is never module-gated.
  await prisma.institutionModule.upsert({
    where: { institutionId_moduleKey: { institutionId: institution.id, moduleKey: "campus_movement" } },
    update: {},
    create: {
      institutionId: institution.id,
      moduleKey: "campus_movement",
      state: "ACTIVE",
      entitledAt: new Date(),
      activatedAt: new Date(),
    },
  });
  console.log("  ✓ campus_movement module entitled + activated for demo tenant");

  // ─── Academics: session + terms + programs + calendar (Phase 1, FEAT-001) ───
  // Idempotent demo data for the new academic substrate. All upserts/find-first
  // are keyed on natural uniques so re-running the seed never duplicates. No
  // revision rows are seeded (the revision table is append-only history).
  const session = await prisma.academicSession.upsert({
    where: { institutionId_name: { institutionId: institution.id, name: "2026-2027" } },
    update: {},
    create: {
      institutionId: institution.id,
      name: "2026-2027",
      structureType: "SEMESTER",
      status: "ACTIVE",
      startDate: new Date("2026-07-01"),
      endDate: new Date("2027-06-30"),
    },
  });

  const term1 = await prisma.academicTerm.upsert({
    where: { academicSessionId_ordinal: { academicSessionId: session.id, ordinal: 1 } },
    update: {},
    create: {
      institutionId: institution.id,
      academicSessionId: session.id,
      name: "Semester 1",
      ordinal: 1,
      status: "ACTIVE",
      startDate: new Date("2026-07-01"),
      endDate: new Date("2026-12-31"),
    },
  });

  await prisma.academicTerm.upsert({
    where: { academicSessionId_ordinal: { academicSessionId: session.id, ordinal: 2 } },
    update: {},
    create: {
      institutionId: institution.id,
      academicSessionId: session.id,
      name: "Semester 2",
      ordinal: 2,
      status: "UPCOMING",
      startDate: new Date("2027-01-01"),
      endDate: new Date("2027-06-30"),
    },
  });
  console.log("  ✓ Academic session 2026-2027 (ACTIVE) + two terms created");

  const bcaProgram = await prisma.program.upsert({
    where: { institutionId_code: { institutionId: institution.id, code: "BCA" } },
    update: {},
    create: {
      institutionId: institution.id,
      departmentId: bca.id,
      name: "Bachelor of Computer Applications",
      code: "BCA",
      duration: 6,
      durationUnit: "TERMS",
      status: "ACTIVE",
    },
  });

  await prisma.program.upsert({
    where: { institutionId_code: { institutionId: institution.id, code: "BTECH-CSE" } },
    update: {},
    create: {
      institutionId: institution.id,
      departmentId: btechCse.id,
      name: "B.Tech (Computer Science & Engineering)",
      code: "BTECH-CSE",
      duration: 6,
      durationUnit: "TERMS",
      status: "ACTIVE",
    },
  });
  console.log("  ✓ Programs created (BCA, BTECH-CSE)");

  // Calendar entries: two institution-wide (departmentId null) + one BCA-scoped,
  // linked to the active session. The partial unique indexes aren't expressible
  // as a Prisma compound-unique, so resolve via findFirst + create/update.
  const calendarEntries: Array<{
    date: Date;
    dayType: "HOLIDAY" | "WORKING_DAY" | "EXAM_DAY";
    note: string;
    departmentId: string | null;
  }> = [
    { date: new Date("2026-08-15"), dayType: "HOLIDAY", note: "Independence Day", departmentId: null },
    { date: new Date("2026-09-05"), dayType: "WORKING_DAY", note: "Regular working day", departmentId: null },
    { date: new Date("2026-11-20"), dayType: "EXAM_DAY", note: "BCA mid-semester exam", departmentId: bca.id },
  ];

  for (const entry of calendarEntries) {
    const existing = await prisma.academicCalendarDay.findFirst({
      where: { institutionId: institution.id, date: entry.date, departmentId: entry.departmentId },
    });
    if (existing) {
      await prisma.academicCalendarDay.update({
        where: { id: existing.id },
        data: {
          dayType: entry.dayType,
          note: entry.note,
          academicSessionId: session.id,
        },
      });
    } else {
      await prisma.academicCalendarDay.create({
        data: {
          institutionId: institution.id,
          date: entry.date,
          dayType: entry.dayType,
          note: entry.note,
          departmentId: entry.departmentId,
          academicSessionId: session.id,
        },
      });
    }
  }
  console.log("  ✓ Academic calendar entries created (2 institution-wide, 1 BCA-scoped)");

  // ─── SIS: link demo students to the structured academic context (Phase 2) ───
  // Best-effort generalization of the live demo students onto the Phase-1
  // structures: set academicSessionId/currentTermId to the active 2026-2027
  // Semester 1, and programId to the matching Program (BCA for BCA-department
  // students), leaving status=ACTIVE (the column default). Keyed by the known
  // enrollmentNo so it is idempotent and touches only demo rows. Then seed ONE
  // ENROLLED history row per demo student via a findFirst-guarded create (NEVER
  // upsert — the append-only trigger forbids update). No StudentDocument rows.
  const demoStudentLinks: Array<{ enrollmentNo: string; programId: string }> = [
    { enrollmentNo: "BCA2024001", programId: bcaProgram.id },
  ];

  for (const link of demoStudentLinks) {
    const student = await prisma.studentProfile.findUnique({
      where: { enrollmentNo: link.enrollmentNo },
    });
    if (!student) continue;

    await prisma.studentProfile.update({
      where: { id: student.id },
      data: {
        academicSessionId: session.id,
        currentTermId: term1.id,
        programId: link.programId,
      },
    });

    const existingHistory = await prisma.studentProfileHistory.findFirst({
      where: { studentProfileId: student.id, changeType: "ENROLLED" },
    });
    if (!existingHistory) {
      await prisma.studentProfileHistory.create({
        data: {
          institutionId: institution.id,
          studentProfileId: student.id,
          changeType: "ENROLLED",
          newStatus: student.status,
          newProgramId: link.programId,
          newProgramText: student.program,
          newSemester: student.semester,
          newDepartmentId: student.departmentId,
          newSessionId: session.id,
          newTermId: term1.id,
          actorUserId: admin.id,
          reason: "Seed: demo enrollment into 2026-2027 Semester 1",
        },
      });
    }
  }
  console.log("  ✓ Demo students linked to 2026-2027 Semester 1 + ENROLLED history seeded");

  console.log("\n✅ Seed completed successfully!");
  console.log("\n📋 Login credentials:");
  console.log("   Admin:   admin@demo.edu / admin123");
  console.log("   HOD:     hod.bca@demo.edu / hod123");
  console.log("   Guard:   guard@demo.edu / guard123");
  console.log("   Student: bhavishya@demo.edu / student123");
  console.log("   Super:   superadmin@campusgate.local / superadmin123");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
