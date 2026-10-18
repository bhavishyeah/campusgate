/**
 * Real-database setup for the cross-tenant escape suite (tenancy.md §7).
 *
 * This is the ONLY api test that hits the live Supabase instance. It uses two
 * connections:
 *   - appClient  : connects as `campass_app` (NOSUPERUSER NOBYPASSRLS) via the
 *                  transaction pooler (apps/api/.env DATABASE_URL). RLS enforces
 *                  for this role, so the escape tests exercise it through
 *                  `withTenant`.
 *   - adminClient: connects as `postgres` (bypasses RLS) via the session pooler
 *                  (packages/db/.env DIRECT_URL). Used ONLY in setup/teardown to
 *                  seed and delete the two test institutions and to inspect
 *                  pg_catalog in the meta-test.
 *
 * It seeds two institutions (A and B) with overlapping-shaped data so cross-tenant
 * IDs are plausible, and tears that data down afterwards (scoped by captured IDs /
 * the ESCAPE_TEST_ prefix — never a blanket delete).
 *
 * Secret values are read from the .env files into env vars and never printed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../../..");
const apiEnvPath = path.join(repoRoot, "apps", "api", ".env");
const dbEnvPath = path.join(repoRoot, "packages", "db", ".env");

/** Minimal .env parser (KEY="value" / KEY=value), ignores comments/blank lines. */
function parseEnv(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const apiEnv = parseEnv(apiEnvPath);
const dbEnv = parseEnv(dbEnvPath);

const appDatabaseUrl = apiEnv.DATABASE_URL; // campass_app (RLS-subject)
const adminDatabaseUrl = dbEnv.DIRECT_URL ?? dbEnv.DATABASE_URL; // postgres (RLS-bypass)

if (!appDatabaseUrl) throw new Error("apps/api/.env DATABASE_URL not found");
if (!adminDatabaseUrl) throw new Error("packages/db/.env DIRECT_URL not found");

// Pin the shared @campusgate/db singleton to the campass_app connection BEFORE it
// is imported, so `withTenant` runs through the RLS-subject role.
process.env.DATABASE_URL = appDatabaseUrl;

/** campass_app connection — the RLS-subject client the escape tests exercise. */
export const appClient = new PrismaClient({
  datasources: { db: { url: appDatabaseUrl } },
  log: ["error"],
});

/** postgres connection — bypasses RLS; setup/teardown + pg_catalog inspection only. */
export const adminClient = new PrismaClient({
  datasources: { db: { url: adminDatabaseUrl } },
  log: ["error"],
});

/** Unique marker so teardown deletes exactly what setup created. */
export const PREFIX = "ESCAPE_TEST_";

export interface SeededTenant {
  institutionId: string;
  departmentId: string;
  userId: string;
  studentProfileId: string;
  reasonId: string;
  gateId: string;
  gatePassId: string;
}

export const seeded: { A?: SeededTenant; B?: SeededTenant } = {};

function id(suffix: string): string {
  return `${PREFIX}${suffix}`;
}

/**
 * Retry a DB operation on transient connectivity errors only. The Supabase
 * session pooler (port 5432, used by adminClient) occasionally drops a
 * connection under concurrent load (Prisma P1001); that is a network hiccup, not
 * a logic failure, so setup/teardown retry rather than fail the suite spuriously.
 * This does NOT touch any test assertion.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const transient =
        msg.includes("Can't reach database server") ||
        msg.includes("P1001") ||
        msg.includes("Timed out") ||
        msg.includes("ECONNRESET");
      if (!transient || i === attempts - 1) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * Seed one institution with overlapping-shaped data using deterministic IDs so
 * cleanup is exact. Runs via adminClient (bypasses RLS).
 */
async function seedTenant(key: "A" | "B"): Promise<SeededTenant> {
  const institutionId = id(`inst_${key}`);
  const departmentId = id(`dept_${key}`);
  const userId = id(`user_${key}`);
  const studentProfileId = id(`student_${key}`);
  const reasonId = id(`reason_${key}`);
  const gateId = id(`gate_${key}`);
  const gatePassId = id(`pass_${key}`);

  await adminClient.institution.create({
    data: {
      id: institutionId,
      name: `${PREFIX}Institution ${key}`,
      code: id(`CODE_${key}`),
    },
  });

  await adminClient.department.create({
    data: { id: departmentId, name: `${PREFIX}Dept ${key}`, code: id(`D_${key}`), institutionId },
  });

  await adminClient.user.create({
    data: {
      id: userId,
      email: `${PREFIX.toLowerCase()}${key.toLowerCase()}@example.test`,
      role: "STUDENT",
      institutionId,
    },
  });

  await adminClient.studentProfile.create({
    data: {
      id: studentProfileId,
      userId,
      institutionId,
      enrollmentNo: id(`ENR_${key}`),
      name: `${PREFIX}Student ${key}`,
      departmentId,
      program: "TEST",
      semester: 1,
    },
  });

  await adminClient.exitReason.create({
    data: { id: reasonId, label: `${PREFIX}Reason ${key}`, institutionId },
  });

  await adminClient.gate.create({
    data: { id: gateId, name: `${PREFIX}Gate ${key}`, institutionId },
  });

  await adminClient.gatePass.create({
    data: {
      id: gatePassId,
      passNumber: id(`PASS_${key}`),
      institutionId,
      studentId: studentProfileId,
      reasonId,
      requestedExit: new Date(),
      expectedReturn: new Date(Date.now() + 3600_000),
    },
  });

  return { institutionId, departmentId, userId, studentProfileId, reasonId, gateId, gatePassId };
}

export async function seedBothTenants(): Promise<void> {
  // Clean any residue from a previous aborted run first (idempotent).
  await cleanup();
  seeded.A = await withRetry(() => seedTenant("A"));
  seeded.B = await withRetry(() => seedTenant("B"));
}

/** Delete exactly the ESCAPE_TEST_ rows, child-first to respect FKs. */
export async function cleanup(): Promise<void> {
  const where = { institutionId: { startsWith: PREFIX } };
  await withRetry(() => adminClient.gateEvent.deleteMany({ where }));
  await withRetry(() => adminClient.emergencyOverride.deleteMany({ where }));
  await withRetry(() => adminClient.gatePass.deleteMany({ where }));
  await withRetry(() => adminClient.reliabilityScoreSnapshot.deleteMany({ where }));
  await withRetry(() => adminClient.notification.deleteMany({ where }));
  await withRetry(() => adminClient.auditLog.deleteMany({ where }));
  await withRetry(() => adminClient.guardGateAssignment.deleteMany({ where }));
  await withRetry(() => adminClient.gate.deleteMany({ where }));
  await withRetry(() => adminClient.exitReason.deleteMany({ where }));
  await withRetry(() => adminClient.studentProfile.deleteMany({ where }));
  await withRetry(() => adminClient.hodProfile.deleteMany({ where }));
  await withRetry(() => adminClient.guardProfile.deleteMany({ where }));
  await withRetry(() => adminClient.user.deleteMany({ where }));
  await withRetry(() => adminClient.department.deleteMany({ where }));
  await withRetry(() =>
    adminClient.institution.deleteMany({ where: { id: { startsWith: PREFIX } } }),
  );
}

/** Count remaining test rows across the seeded tables (teardown assertion). */
export async function countRemainingTestRows(): Promise<number> {
  const where = { institutionId: { startsWith: PREFIX } };
  const counts = await Promise.all([
    adminClient.gatePass.count({ where }),
    adminClient.studentProfile.count({ where }),
    adminClient.user.count({ where }),
    adminClient.department.count({ where }),
    adminClient.exitReason.count({ where }),
    adminClient.gate.count({ where }),
    adminClient.institution.count({ where: { id: { startsWith: PREFIX } } }),
  ]);
  return counts.reduce((a, b) => a + b, 0);
}

export async function disconnect(): Promise<void> {
  await Promise.all([appClient.$disconnect(), adminClient.$disconnect()]);
}

/** Tables that MUST have RLS enabled + forced (tenancy plan RLS set). */
export const RLS_TABLES = [
  "departments",
  "users",
  "gates",
  "exit_reasons",
  "guard_shifts",
  "emergency_alerts",
  "academic_calendar_days",
  "institution_configs",
  "allowance_policies",
  "student_profiles",
  "hod_profiles",
  "guard_profiles",
  "gate_passes",
  "gate_events",
  "guard_gate_assignments",
  "emergency_overrides",
  "reliability_score_snapshots",
  "notifications",
  "audit_logs",
] as const;
