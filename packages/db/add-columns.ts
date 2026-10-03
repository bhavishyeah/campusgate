import pg from "pg";
const { Client } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

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
