import pg from "pg";
const { Client } = pg;

const DATABASE_URL =
  "postgresql://neondb_owner:npg_3WVXghnMNCD6@ep-misty-pond-azqx1rtc-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb";

async function main() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log("Connected to Neon");

  await client.query(`
    ALTER TABLE "student_profiles" ADD COLUMN IF NOT EXISTS "rollNumber" TEXT;
    ALTER TABLE "student_profiles" ADD COLUMN IF NOT EXISTS "dob" TEXT;
    ALTER TABLE "student_profiles" ADD COLUMN IF NOT EXISTS "phone" TEXT;
    ALTER TABLE "student_profiles" ADD COLUMN IF NOT EXISTS "address" TEXT;
  `);

  console.log("Done — added rollNumber, dob, phone, address columns");
  await client.end();
}

main().catch((e) => {
  console.error("Failed:", e.message);
  process.exit(1);
});
