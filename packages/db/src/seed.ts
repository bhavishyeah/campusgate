import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding CAMPUSGATE database...");

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
  for (const c of courses) {
    const created = await prisma.department.upsert({
      where: { institutionId_code: { institutionId: institution.id, code: c.code } },
      update: {},
      create: { name: c.name, code: c.code, institutionId: institution.id },
    });
    if (c.code === "512") bca = created;
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
        create: { name: "Dr. Sharma", departmentId: bca.id },
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
          assignedGates: {
            create: [{ gateId: mainGate.id }],
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
          program: "BCA",
          semester: 4,
          section: "A",
        },
      },
    },
  });
  console.log("  ✓ Student user created (bhavishya@demo.edu / student123)");

  console.log("\n✅ Seed completed successfully!");
  console.log("\n📋 Login credentials:");
  console.log("   Admin:   admin@demo.edu / admin123");
  console.log("   HOD:     hod.bca@demo.edu / hod123");
  console.log("   Guard:   guard@demo.edu / guard123");
  console.log("   Student: bhavishya@demo.edu / student123");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
