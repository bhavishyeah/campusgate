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
  FACULTY: "Faculty",
  LIBRARIAN: "Librarian",
  ADMISSION_OFFICER: "Admission Officer",
  APPLICANT: "Applicant",
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

  // ─── Classes: course + subject + section + enrollment + faculty + timetable ──
  // Phase-3 demo data (FEAT-004, design §15). All upserts / find-first-then-create
  // keyed on business uniques so re-running the seed never duplicates. Built on
  // the existing demo institution + ACTIVE 2026-2027 session + Semester 1 term +
  // BCA program + the seeded BCA student (BCA2024001) — the enrollment references
  // that SHARED StudentProfile (single identity, no second student). No
  // ScheduleRevision rows are seeded (append-only history — the trigger forbids
  // anything but genuine INSERTs; mirrors student_profile_history).
  const course = await prisma.course.upsert({
    where: { institutionId_code: { institutionId: institution.id, code: "BCA-S1-CORE" } },
    update: {},
    create: {
      institutionId: institution.id,
      programId: bcaProgram.id,
      academicTermId: term1.id,
      name: "BCA Semester 1 Core",
      code: "BCA-S1-CORE",
      status: "ACTIVE",
    },
  });

  const subject = await prisma.subject.upsert({
    where: { institutionId_code: { institutionId: institution.id, code: "CS101" } },
    update: {},
    create: {
      institutionId: institution.id,
      courseId: course.id,
      name: "Data Structures",
      code: "CS101",
      credits: 4,
      contactHoursPerWeek: 4,
      status: "ACTIVE",
    },
  });
  console.log("  ✓ Course BCA-S1-CORE + Subject CS101 Data Structures created");

  // ClassSection: the composite business unique is
  // (institutionId, programId, academicSessionId, academicTermId, label) — not a
  // single Prisma named unique, so resolve via findFirst + create (idempotent).
  let section = await prisma.classSection.findFirst({
    where: {
      institutionId: institution.id,
      programId: bcaProgram.id,
      academicSessionId: session.id,
      academicTermId: term1.id,
      label: "A",
    },
  });
  if (!section) {
    section = await prisma.classSection.create({
      data: {
        institutionId: institution.id,
        programId: bcaProgram.id,
        academicSessionId: session.id,
        academicTermId: term1.id,
        label: "A",
        capacity: 60,
        status: "ACTIVE",
      },
    });
  }
  console.log("  ✓ ClassSection BCA/2026-2027/Semester 1/A (capacity 60, ACTIVE) created");

  // ClassEnrollment of the seeded BCA2024001 student into section A, referencing
  // the SHARED StudentProfile (no second student). Idempotent on the
  // (classSectionId, studentId) unique.
  const demoStudent = await prisma.studentProfile.findUnique({
    where: { enrollmentNo: "BCA2024001" },
  });
  if (demoStudent) {
    await prisma.classEnrollment.upsert({
      where: {
        classSectionId_studentId: { classSectionId: section.id, studentId: demoStudent.id },
      },
      update: {},
      create: {
        institutionId: institution.id,
        classSectionId: section.id,
        studentId: demoStudent.id,
        status: "ENROLLED",
      },
    });
    console.log("  ✓ Demo student BCA2024001 enrolled into section A (ENROLLED)");
  }

  // One pure-faculty User (legacy role = GUARD, the inert non-actor value per
  // design A3 — teaching capability comes from the FACULTY template role on the
  // membership, not the enum) + a FacultyProfile (dept BCA) + the FACULTY role on
  // its membership.
  const facultyPassword = await bcrypt.hash("faculty123", 12);
  const facultyUser = await prisma.user.upsert({
    where: { email: "faculty.cs@demo.edu" },
    update: {},
    create: {
      email: "faculty.cs@demo.edu",
      passwordHash: facultyPassword,
      role: "GUARD",
      accountStatus: "ACTIVE",
      institutionId: institution.id,
    },
  });

  const facultyProfile = await prisma.facultyProfile.upsert({
    where: { userId: facultyUser.id },
    update: {},
    create: {
      institutionId: institution.id,
      userId: facultyUser.id,
      name: "Prof. Anita Rao",
      departmentId: bca.id,
      status: "ACTIVE",
    },
  });
  await ensureMembership(facultyUser.id, facultyUser.institutionId, "FACULTY", roleIdByKey);
  console.log("  ✓ Faculty user created (faculty.cs@demo.edu / faculty123) + FacultyProfile + FACULTY role");

  // PRIMARY FacultyAssignment (CS101, section A, Semester 1). No single Prisma
  // named unique for this tuple, so resolve via findFirst + create (idempotent).
  const existingAssignment = await prisma.facultyAssignment.findFirst({
    where: {
      institutionId: institution.id,
      facultyId: facultyProfile.id,
      subjectId: subject.id,
      classSectionId: section.id,
      academicTermId: term1.id,
      status: "ACTIVE",
    },
  });
  if (!existingAssignment) {
    await prisma.facultyAssignment.create({
      data: {
        institutionId: institution.id,
        facultyId: facultyProfile.id,
        subjectId: subject.id,
        classSectionId: section.id,
        academicTermId: term1.id,
        role: "PRIMARY",
        status: "ACTIVE",
      },
    });
  }
  console.log("  ✓ PRIMARY FacultyAssignment (CS101, section A, Semester 1) created");

  // One PUBLISHED Timetable (Semester 1) with a conflict-free ScheduledClass set
  // (Mon/Wed 09:00-10:00 startTime=540 endTime=600, room R-101). No single Prisma
  // named unique for (term, name), so resolve via findFirst + create.
  let timetable = await prisma.timetable.findFirst({
    where: {
      institutionId: institution.id,
      academicTermId: term1.id,
      name: "Semester 1 Timetable",
    },
  });
  if (!timetable) {
    timetable = await prisma.timetable.create({
      data: {
        institutionId: institution.id,
        academicTermId: term1.id,
        name: "Semester 1 Timetable",
        status: "PUBLISHED",
        publishedAt: new Date(),
      },
    });
  }

  // Conflict-free recurring slots: Mon + Wed, 09:00-10:00, room R-101, CS101,
  // section A, the seeded faculty. Keyed per (timetable, section, subject,
  // faculty, dayOfWeek, startTime) via findFirst so a re-run never duplicates.
  const slotDays: Array<"MON" | "WED"> = ["MON", "WED"];
  for (const day of slotDays) {
    const existingSlot = await prisma.scheduledClass.findFirst({
      where: {
        institutionId: institution.id,
        timetableId: timetable.id,
        classSectionId: section.id,
        subjectId: subject.id,
        facultyId: facultyProfile.id,
        dayOfWeek: day,
        startTime: 540,
      },
    });
    if (!existingSlot) {
      await prisma.scheduledClass.create({
        data: {
          institutionId: institution.id,
          timetableId: timetable.id,
          classSectionId: section.id,
          subjectId: subject.id,
          facultyId: facultyProfile.id,
          academicTermId: term1.id,
          room: "R-101",
          dayOfWeek: day,
          startTime: 540,
          endTime: 600,
          status: "SCHEDULED",
        },
      });
    }
  }
  console.log("  ✓ PUBLISHED Semester 1 Timetable + conflict-free Mon/Wed CS101 slots (R-101) created");

  // ─── Attendance: module ACTIVE for the demo tenant + a sample FINALIZED session ─
  // Mirrors the campus_movement upsert so a fresh DB has the attendance module
  // ACTIVE (attendance is a gated module; routes carry requireModuleActive).
  await prisma.institutionModule.upsert({
    where: { institutionId_moduleKey: { institutionId: institution.id, moduleKey: "attendance" } },
    update: {},
    create: {
      institutionId: institution.id,
      moduleKey: "attendance",
      state: "ACTIVE",
      entitledAt: new Date(),
      activatedAt: new Date(),
    },
  });
  console.log("  ✓ attendance module entitled + activated for demo tenant");

  // One sample FINALIZED AttendanceSession against the seeded Mon CS101 slot,
  // the enrolled BCA student marked PRESENT. Keyed on @@unique([scheduledClassId,
  // date]) so re-runs never duplicate. The `date` is a MON at UTC midnight so it
  // satisfies the recurrence rule the open-session handler enforces.
  const monSlot = await prisma.scheduledClass.findFirst({
    where: {
      institutionId: institution.id,
      timetableId: timetable.id,
      classSectionId: section.id,
      subjectId: subject.id,
      facultyId: facultyProfile.id,
      dayOfWeek: "MON",
      startTime: 540,
    },
  });
  if (monSlot && demoStudent) {
    // Pick a fixed MON date at UTC midnight (2026-11-02 is a Monday).
    const sessionDate = new Date(Date.UTC(2026, 10, 2));
    let attendanceSession = await prisma.attendanceSession.findFirst({
      where: {
        institutionId: institution.id,
        scheduledClassId: monSlot.id,
        date: sessionDate,
      },
    });
    if (!attendanceSession) {
      attendanceSession = await prisma.attendanceSession.create({
        data: {
          institutionId: institution.id,
          scheduledClassId: monSlot.id,
          academicTermId: term1.id,
          date: sessionDate,
          status: "FINALIZED",
          markedByFacultyId: facultyProfile.id,
          submittedAt: new Date(),
          finalizedAt: new Date(),
        },
      });
    }
    const existingRecord = await prisma.attendanceRecord.findFirst({
      where: {
        institutionId: institution.id,
        attendanceSessionId: attendanceSession.id,
        studentId: demoStudent.id,
      },
    });
    if (!existingRecord) {
      const record = await prisma.attendanceRecord.create({
        data: {
          institutionId: institution.id,
          attendanceSessionId: attendanceSession.id,
          studentId: demoStudent.id,
          status: "PRESENT",
        },
      });
      await prisma.attendanceRecordHistory.create({
        data: {
          institutionId: institution.id,
          attendanceRecordId: record.id,
          changeType: "MARKED",
          previousStatus: null,
          newStatus: "PRESENT",
          actorUserId: facultyUser.id,
        },
      });
    }
    console.log("  ✓ Sample FINALIZED AttendanceSession (Mon CS101) + BCA student PRESENT created");
  }

  // ─── Library: module ACTIVE + librarian + catalogue + one ACTIVE loan (Phase 5) ─
  // Mirrors the campus_movement / attendance module upserts so a fresh DB has the
  // library module ACTIVE (library is a gated module; routes carry
  // requireModuleActive("library")). All upserts / find-first-then-create keyed
  // on business uniques so re-running the seed never duplicates.
  await prisma.institutionModule.upsert({
    where: { institutionId_moduleKey: { institutionId: institution.id, moduleKey: "library" } },
    update: {},
    create: {
      institutionId: institution.id,
      moduleKey: "library",
      state: "ACTIVE",
      entitledAt: new Date(),
      activatedAt: new Date(),
    },
  });
  console.log("  ✓ library module entitled + activated for demo tenant");

  // Pure-librarian user (legacy role = GUARD, the inert non-actor value per the
  // FACULTY precedent — capability comes from the LIBRARIAN membership role, not
  // the enum). No profile table.
  const librarianPassword = await bcrypt.hash("library123", 12);
  const librarianUser = await prisma.user.upsert({
    where: { email: "librarian@demo.edu" },
    update: {},
    create: {
      email: "librarian@demo.edu",
      passwordHash: librarianPassword,
      role: "GUARD",
      accountStatus: "ACTIVE",
      institutionId: institution.id,
    },
  });
  await ensureMembership(librarianUser.id, librarianUser.institutionId, "LIBRARIAN", roleIdByKey);
  console.log("  ✓ Librarian user created (librarian@demo.edu / library123) + LIBRARIAN role");

  // Two BookTitles, each with multiple BookCopys (3 and 2), status=AVAILABLE.
  // Keyed on (institutionId, accessionNumber) for idempotency.
  const libraryTitles: Array<{
    title: string;
    author: string;
    isbn: string;
    category: string;
    accessionNumbers: string[];
  }> = [
    {
      title: "Introduction to Algorithms",
      author: "Cormen, Leiserson, Rivest, Stein",
      isbn: "9780262033848",
      category: "Computer Science",
      accessionNumbers: ["LIB-ITA-001", "LIB-ITA-002", "LIB-ITA-003"],
    },
    {
      title: "Clean Code",
      author: "Robert C. Martin",
      isbn: "9780132350884",
      category: "Software Engineering",
      accessionNumbers: ["LIB-CC-001", "LIB-CC-002"],
    },
  ];

  const seededCopies: Array<{ titleIndex: number; copyId: string }> = [];
  for (let ti = 0; ti < libraryTitles.length; ti += 1) {
    const t = libraryTitles[ti];
    // BookTitle has no single-column natural unique; resolve via findFirst on the
    // first accession number's copy, else create. Use the title's first copy as
    // the idempotency anchor via the (institutionId, accessionNumber) unique.
    const anchorCopy = await prisma.bookCopy.findUnique({
      where: {
        institutionId_accessionNumber: {
          institutionId: institution.id,
          accessionNumber: t.accessionNumbers[0],
        },
      },
      select: { bookTitleId: true },
    });
    let bookTitleId: string;
    if (anchorCopy) {
      bookTitleId = anchorCopy.bookTitleId;
    } else {
      const created = await prisma.bookTitle.create({
        data: {
          institutionId: institution.id,
          title: t.title,
          author: t.author,
          isbn: t.isbn,
          category: t.category,
          status: "ACTIVE",
        },
      });
      bookTitleId = created.id;
    }

    for (const accessionNumber of t.accessionNumbers) {
      const copy = await prisma.bookCopy.upsert({
        where: {
          institutionId_accessionNumber: { institutionId: institution.id, accessionNumber },
        },
        update: {},
        create: {
          institutionId: institution.id,
          bookTitleId,
          accessionNumber,
          condition: "GOOD",
          status: "AVAILABLE",
        },
      });
      seededCopies.push({ titleIndex: ti, copyId: copy.id });
    }
  }
  console.log("  ✓ Library catalogue seeded (2 titles, 5 copies)");

  // One ACTIVE loan: issue the first copy of the first title to the demo student
  // (BCA2024001, the shared StudentProfile), flipping that copy to ISSUED. Keyed
  // on a find-first ACTIVE loan for the copy so re-runs do not duplicate.
  if (demoStudent) {
    const firstCopy = seededCopies.find((c) => c.titleIndex === 0);
    if (firstCopy) {
      const existingLoan = await prisma.libraryLoan.findFirst({
        where: {
          institutionId: institution.id,
          bookCopyId: firstCopy.copyId,
          status: "ACTIVE",
        },
      });
      if (!existingLoan) {
        const issueDate = new Date();
        const dueDate = new Date(issueDate.getTime() + 14 * 24 * 60 * 60 * 1000);
        await prisma.libraryLoan.create({
          data: {
            institutionId: institution.id,
            bookCopyId: firstCopy.copyId,
            studentId: demoStudent.id,
            issuedByUserId: librarianUser.id,
            issueDate,
            dueDate,
            status: "ACTIVE",
          },
        });
        await prisma.bookCopy.update({
          where: { id: firstCopy.copyId },
          data: { status: "ISSUED" },
        });
      }
      console.log("  ✓ One ACTIVE library loan issued to demo student BCA2024001 (copy ISSUED)");
    }
  }

  // ─── Admissions: module ACTIVE + officer + OPEN campaign + applicant + app ──
  // Mirrors the campus_movement / attendance / library module upserts so a fresh
  // DB has the admissions module ACTIVE (admissions is a gated module; its
  // operational routes carry requireModuleActive("admissions")). All upserts /
  // find-first-then-create keyed on business uniques so re-running the seed never
  // duplicates — and NO StudentProfile is created for the applicant (design §2:
  // a profile is created only at enrollment).
  await prisma.institutionModule.upsert({
    where: { institutionId_moduleKey: { institutionId: institution.id, moduleKey: "admissions" } },
    update: {},
    create: {
      institutionId: institution.id,
      moduleKey: "admissions",
      state: "ACTIVE",
      entitledAt: new Date(),
      activatedAt: new Date(),
    },
  });
  console.log("  ✓ admissions module entitled + activated for demo tenant");

  // Admission-officer user (legacy role = GUARD, the inert non-actor value per
  // the FACULTY/LIBRARIAN precedent — capability comes from the ADMISSION_OFFICER
  // membership role, not the enum). No profile table.
  const officerPassword = await bcrypt.hash("officer123", 12);
  const officerUser = await prisma.user.upsert({
    where: { email: "admissions@demo.edu" },
    update: {},
    create: {
      email: "admissions@demo.edu",
      passwordHash: officerPassword,
      role: "GUARD",
      accountStatus: "ACTIVE",
      institutionId: institution.id,
    },
  });
  await ensureMembership(officerUser.id, officerUser.institutionId, "ADMISSION_OFFICER", roleIdByKey);
  console.log("  ✓ Admission officer created (admissions@demo.edu / officer123) + ADMISSION_OFFICER role");

  // One OPEN AdmissionCampaign targeting the seeded BCA program + the ACTIVE
  // 2026-2027 intake session. Minimal config (one required field + one required
  // doc type). Keyed on the (institutionId, name) business unique.
  const demoCampaign = await prisma.admissionCampaign.upsert({
    where: {
      institutionId_name: { institutionId: institution.id, name: "BCA Admissions 2026-2027" },
    },
    update: {},
    create: {
      institutionId: institution.id,
      name: "BCA Admissions 2026-2027",
      status: "OPEN",
      intakeSessionId: session.id,
      targetProgramId: bcaProgram.id,
      openAt: new Date("2026-05-01"),
      closeAt: new Date("2026-06-30"),
      config: { requiredFields: ["fullName"], requiredDocTypes: ["TRANSCRIPT"] },
    },
  });
  // Ensure the join row for the target program (idempotent on the composite unique).
  const existingCampaignProgram = await prisma.admissionCampaignProgram.findFirst({
    where: { institutionId: institution.id, campaignId: demoCampaign.id, programId: bcaProgram.id },
  });
  if (!existingCampaignProgram) {
    await prisma.admissionCampaignProgram.create({
      data: { institutionId: institution.id, campaignId: demoCampaign.id, programId: bcaProgram.id },
    });
  }
  console.log("  ✓ OPEN AdmissionCampaign 'BCA Admissions 2026-2027' created (BCA, 2026-2027 intake)");

  // Applicant identity: a User (role STUDENT inert) + ACTIVE membership + the
  // APPLICANT membership role. NO StudentProfile (design §1/§2). The applicant
  // display name travels on the Application.formData, not on the User.
  const applicantPassword = await bcrypt.hash("applicant123", 12);
  const applicantUser = await prisma.user.upsert({
    where: { email: "applicant@demo.edu" },
    update: {},
    create: {
      email: "applicant@demo.edu",
      passwordHash: applicantPassword,
      role: "STUDENT",
      accountStatus: "ACTIVE",
      institutionId: institution.id,
    },
  });
  await ensureMembership(applicantUser.id, applicantUser.institutionId, "APPLICANT", roleIdByKey);
  console.log("  ✓ Applicant identity created (applicant@demo.edu / applicant123) + APPLICANT role, NO StudentProfile");

  // One mid-lifecycle Application (UNDER_REVIEW) by the applicant into the demo
  // campaign + BCA program. Keyed on the (institutionId, campaignId,
  // applicantUserId) business unique so re-runs never duplicate.
  const existingApplication = await prisma.application.findFirst({
    where: {
      institutionId: institution.id,
      campaignId: demoCampaign.id,
      applicantUserId: applicantUser.id,
    },
  });
  if (!existingApplication) {
    await prisma.application.create({
      data: {
        institutionId: institution.id,
        campaignId: demoCampaign.id,
        applicantUserId: applicantUser.id,
        programId: bcaProgram.id,
        status: "UNDER_REVIEW",
        applicationNumber: "APP-DEMO-0001",
        submittedAt: new Date("2026-05-10"),
        formData: { fullName: "Asha Patel" },
      },
    });
  }
  console.log("  ✓ Demo Application (UNDER_REVIEW, APP-DEMO-0001) created for applicant, NO StudentProfile");

  console.log("\n✅ Seed completed successfully!");
  console.log("\n📋 Login credentials:");
  console.log("   Admin:     admin@demo.edu / admin123");
  console.log("   HOD:       hod.bca@demo.edu / hod123");
  console.log("   Guard:     guard@demo.edu / guard123");
  console.log("   Faculty:   faculty.cs@demo.edu / faculty123");
  console.log("   Librarian: librarian@demo.edu / library123");
  console.log("   Officer:   admissions@demo.edu / officer123");
  console.log("   Applicant: applicant@demo.edu / applicant123");
  console.log("   Student:   bhavishya@demo.edu / student123");
  console.log("   Super:     superadmin@campusgate.local / superadmin123");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
