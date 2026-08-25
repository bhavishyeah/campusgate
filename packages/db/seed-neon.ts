import pg from "pg";
const { Client } = pg;
import bcrypt from "bcrypt";

const DATABASE_URL =
  "postgresql://neondb_owner:npg_3WVXghnMNCD6@ep-misty-pond-azqx1rtc-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb";

async function main() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log("🌱 Seeding Neon database...");

  // Institution
  const instRes = await client.query(`
    INSERT INTO "institutions" ("id", "name", "code", "domain", "settings")
    VALUES ('inst_demo', 'Demo University', 'DEMO', 'demo.edu', '{}')
    ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name"
    RETURNING "id"
  `);
  const instId = instRes.rows[0].id;
  console.log("  ✓ Institution");

  // Courses
  const coursesToCreate = [
    { id: "course_110", name: "B.Com/B.Com (Hons)", code: "110" },
    { id: "course_501", name: "B.Tech (Computer Science & Engineering)", code: "501" },
    { id: "course_502", name: "B.Tech (Electronics & Computer Engineering)", code: "502" },
    { id: "course_504", name: "B.Tech (Electrical Engineering)", code: "504" },
    { id: "course_510", name: "Bachelor of Business Administration (BBA)", code: "510" },
    { id: "course_512", name: "Bachelor of Computer Applications (BCA)", code: "512" },
    { id: "course_513", name: "Bachelor of Hotel Management (BHM)", code: "513" },
    { id: "course_601", name: "B.Sc Animation", code: "601" },
    { id: "course_602", name: "B.Sc IT", code: "602" },
  ];

  for (const c of coursesToCreate) {
    await client.query(`
      INSERT INTO "departments" ("id", "name", "code", "institutionId")
      VALUES ($1, $2, $3, $4)
      ON CONFLICT ("institutionId", "code") DO NOTHING
    `, [c.id, c.name, c.code, instId]);
  }
  console.log("  ✓ Courses (9 created)");

  // Gates
  await client.query(`
    INSERT INTO "gates" ("id", "name", "location", "institutionId")
    VALUES ('gate_main', 'Main Gate', 'Front Entrance', $1)
    ON CONFLICT ("institutionId", "name") DO NOTHING
  `, [instId]);
  await client.query(`
    INSERT INTO "gates" ("id", "name", "location", "institutionId")
    VALUES ('gate_side', 'Side Gate', 'Parking Side', $1)
    ON CONFLICT ("institutionId", "name") DO NOTHING
  `, [instId]);
  console.log("  ✓ Gates");

  // Exit reasons
  const reasons = [
    { id: "reason_personal", label: "Personal Work", requiresNote: false },
    { id: "reason_medical", label: "Medical", requiresNote: false },
    { id: "reason_family", label: "Family Emergency", requiresNote: false },
    { id: "reason_official", label: "Official Work", requiresNote: false },
    { id: "reason_home", label: "Home Visit", requiresNote: false },
    { id: "reason_other", label: "Other", requiresNote: true },
  ];
  for (const r of reasons) {
    await client.query(`
      INSERT INTO "exit_reasons" ("id", "label", "requiresNote", "institutionId")
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
    `, [r.id, r.label, r.requiresNote, instId]);
  }
  console.log("  ✓ Exit reasons");

  // Users
  const adminPw = await bcrypt.hash("admin123", 12);
  const hodPw = await bcrypt.hash("hod123", 12);
  const guardPw = await bcrypt.hash("guard123", 12);
  const studentPw = await bcrypt.hash("student123", 12);

  // Admin
  await client.query(`
    INSERT INTO "users" ("id", "email", "passwordHash", "role", "accountStatus", "institutionId")
    VALUES ('user_admin', 'admin@demo.edu', $1, 'ADMIN', 'ACTIVE', $2)
    ON CONFLICT ("email") DO NOTHING
  `, [adminPw, instId]);
  console.log("  ✓ Admin (admin@demo.edu / admin123)");

  // HOD
  await client.query(`
    INSERT INTO "users" ("id", "email", "passwordHash", "role", "accountStatus", "institutionId")
    VALUES ('user_hod', 'hod.bca@demo.edu', $1, 'HOD', 'ACTIVE', $2)
    ON CONFLICT ("email") DO NOTHING
  `, [hodPw, instId]);
  await client.query(`
    INSERT INTO "hod_profiles" ("id", "userId", "name", "departmentId")
    VALUES ('hod_bca', 'user_hod', 'Dr. Sharma', 'course_512')
    ON CONFLICT ("userId") DO NOTHING
  `);
  console.log("  ✓ HOD (hod.bca@demo.edu / hod123)");

  // Guard
  await client.query(`
    INSERT INTO "users" ("id", "email", "passwordHash", "role", "accountStatus", "institutionId")
    VALUES ('user_guard', 'guard@demo.edu', $1, 'GUARD', 'ACTIVE', $2)
    ON CONFLICT ("email") DO NOTHING
  `, [guardPw, instId]);
  await client.query(`
    INSERT INTO "guard_profiles" ("id", "userId", "name")
    VALUES ('guard_main', 'user_guard', 'Rajesh Kumar')
    ON CONFLICT ("userId") DO NOTHING
  `);
  await client.query(`
    INSERT INTO "guard_gate_assignments" ("id", "guardId", "gateId")
    VALUES ('gga_1', 'guard_main', 'gate_main')
    ON CONFLICT ("guardId", "gateId") DO NOTHING
  `);
  console.log("  ✓ Guard (guard@demo.edu / guard123)");

  // Student
  await client.query(`
    INSERT INTO "users" ("id", "email", "passwordHash", "role", "accountStatus", "institutionId")
    VALUES ('user_student', 'bhavishya@demo.edu', $1, 'STUDENT', 'ACTIVE', $2)
    ON CONFLICT ("email") DO NOTHING
  `, [studentPw, instId]);
  await client.query(`
    INSERT INTO "student_profiles" ("id", "userId", "enrollmentNo", "name", "departmentId", "program", "semester", "section")
    VALUES ('student_1', 'user_student', 'BCA2024001', 'Bhavishya Verma', 'course_512', 'BCA', 4, 'A')
    ON CONFLICT ("userId") DO NOTHING
  `);
  console.log("  ✓ Student (bhavishya@demo.edu / student123)");

  await client.end();
  console.log("\n✅ Seed complete!");
}

main().catch((e) => {
  console.error("❌ Failed:", e.message);
  process.exit(1);
});
