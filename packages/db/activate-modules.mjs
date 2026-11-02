import { privilegedPrisma as db } from './dist/index.js';

// Activate all Phase 8-9 modules for Demo University. These are all
// foundational-not-gated (deps=[]) so activation has no prerequisite-module
// ordering. ENTITLED -> ACTIVE. Idempotent (upsert on the (institutionId,
// moduleKey) unique). This is a legitimate production setup action: the demo
// tenant should have every module turned on.
const DEMO_INSTITUTION_ID = 'cmvdnz1ob0001uihgz50icv5t'; // "Demo University"
const MODULES = [
  'examinations',
  'faculty_management',
  'hr_management',
  'hostel',
  'transport',
  'inventory',
  'service_requests',
  'documents',
];

try {
  const now = new Date();
  for (const key of MODULES) {
    await db.institutionModule.upsert({
      where: { institutionId_moduleKey: { institutionId: DEMO_INSTITUTION_ID, moduleKey: key } },
      update: { state: 'ACTIVE', activatedAt: now },
      create: {
        institutionId: DEMO_INSTITUTION_ID,
        moduleKey: key,
        state: 'ACTIVE',
        entitledAt: now,
        activatedAt: now,
      },
    });
    console.log(`  activated ${key}`);
  }
  // show final state
  const mods = await db.$queryRawUnsafe(
    `SELECT "moduleKey", state FROM institution_modules WHERE "institutionId"=$1 ORDER BY "moduleKey"`,
    DEMO_INSTITUTION_ID);
  console.log('\nDemo University modules now:');
  for (const m of mods) console.log(`   ${m.moduleKey.padEnd(22)} ${m.state}`);
} catch (e) {
  console.error('ERR:', e.message);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
