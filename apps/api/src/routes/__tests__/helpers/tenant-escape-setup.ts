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
  membershipId: string;
  membershipRoleId: string;
  institutionModuleId: string;
  // FEAT-003 academics tables (design §10.1). The append-only revision table is
  // NOT seeded here (the trigger blocks even adminClient — audit_events precedent).
  academicSessionId: string;
  academicTermId: string;
  programId: string;
  calendarDayId: string;
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
        msg.includes("ECONNRESET") ||
        msg.includes("max clients reached") ||
        msg.includes("EMAXCONNSESSION");
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
  const membershipId = id(`mbr_${key}`);
  const membershipRoleId = id(`mrl_${key}`);
  const institutionModuleId = id(`imod_${key}`);
  const academicSessionId = id(`asess_${key}`);
  const academicTermId = id(`aterm_${key}`);
  const programId = id(`prog_${key}`);
  const calendarDayId = id(`acd_${key}`);

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

  // Membership + membership-role (the B-2 tenant-owned RBAC tables). The
  // membership-role binds to the global STUDENT template role (institutionId
  // null, seeded by the identity_rbac_b2 migration / seed). Created via the
  // RLS-bypassing adminClient so the read-escape test can later prove the
  // campass_app client CANNOT see the other tenant's row.
  const studentTemplateRole = await adminClient.role.findFirst({
    where: { key: "STUDENT", institutionId: null },
    select: { id: true },
  });
  if (!studentTemplateRole) {
    throw new Error(
      "STUDENT template role not found — run the identity_rbac_b2 migration + seed before the escape suite",
    );
  }

  await adminClient.institutionMembership.create({
    data: { id: membershipId, userId, institutionId, membershipStatus: "ACTIVE" },
  });

  await adminClient.membershipRole.create({
    data: {
      id: membershipRoleId,
      membershipId,
      roleId: studentTemplateRole.id,
      institutionId,
    },
  });

  // The new tenant-owned module-system table. Seeded via the RLS-bypassing
  // adminClient so the read-escape test can later prove the campass_app client
  // CANNOT see the other tenant's row.
  await adminClient.institutionModule.create({
    data: {
      id: institutionModuleId,
      institutionId,
      moduleKey: "campus_movement",
      state: "ACTIVE",
      entitledAt: new Date(),
      activatedAt: new Date(),
    },
  });

  // FEAT-003 academics tenant-owned tables (design §10.1). Seeded via the
  // RLS-bypassing adminClient so the read-escape tests can later prove the
  // campass_app client CANNOT see the other tenant's rows. A session (+1 term),
  // a program under the seeded department, and ONE department-scoped calendar
  // entry are created. The append-only academic_calendar_day_revisions table is
  // deliberately NOT seeded here (the BEFORE UPDATE OR DELETE trigger blocks even
  // adminClient in the shared teardown — exactly the audit_events precedent); its
  // escape behaviour is covered by the self-contained calendar-revision test.
  const sessionStart = new Date("2026-07-01T00:00:00.000Z");
  const sessionEnd = new Date("2027-06-30T00:00:00.000Z");

  await adminClient.academicSession.create({
    data: {
      id: academicSessionId,
      institutionId,
      name: `${PREFIX}Session ${key}`,
      structureType: "SEMESTER",
      status: "UPCOMING",
      startDate: sessionStart,
      endDate: sessionEnd,
    },
  });

  await adminClient.academicTerm.create({
    data: {
      id: academicTermId,
      institutionId,
      academicSessionId,
      name: `${PREFIX}Term ${key}`,
      ordinal: 1,
      status: "UPCOMING",
      startDate: sessionStart,
      endDate: new Date("2026-12-31T00:00:00.000Z"),
    },
  });

  await adminClient.program.create({
    data: {
      id: programId,
      institutionId,
      departmentId,
      name: `${PREFIX}Program ${key}`,
      code: id(`PROG_${key}`),
      duration: 6,
      durationUnit: "TERMS",
    },
  });

  await adminClient.academicCalendarDay.create({
    data: {
      id: calendarDayId,
      institutionId,
      date: new Date("2026-09-01T00:00:00.000Z"),
      dayType: "EXAM_DAY",
      note: `${PREFIX}dept-scoped ${key}`,
      departmentId,
      academicSessionId,
    },
  });

  return {
    institutionId,
    departmentId,
    userId,
    studentProfileId,
    reasonId,
    gateId,
    gatePassId,
    membershipId,
    membershipRoleId,
    institutionModuleId,
    academicSessionId,
    academicTermId,
    programId,
    calendarDayId,
  };
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
  // B-2 tenant-owned RBAC tables first (child -> parent), so the new RESTRICT
  // composite FKs (membership_roles -> institution_memberships -> users) do not
  // block the user/department/institution deletes below.
  // NOTE: the escape suite itself seeds no audit_events / support_grants rows
  // (the FEAT-003 superadmin-security integration suite is self-contained under
  // its own prefix and cleans up its own rows). Nothing to delete here for the
  // two new tables.
  await withRetry(() => adminClient.membershipRole.deleteMany({ where }));
  await withRetry(() => adminClient.institutionMembership.deleteMany({ where }));
  // institution_modules: child-first (before the institution delete) because the
  // tenant-root FK is ON DELETE RESTRICT.
  await withRetry(() => adminClient.institutionModule.deleteMany({ where }));
  // FEAT-003 academics MUTABLE tables, child-first so the composite RESTRICT FKs
  // do not block: calendar days (dept-scoped -> departments RESTRICT) + terms
  // (-> sessions RESTRICT) before the sessions, programs (-> departments RESTRICT)
  // before the departments, and all before the institution. The append-only
  // academic_calendar_day_revisions table is intentionally NOT deleted here (the
  // trigger blocks even adminClient; the suite seeds no revision rows — the
  // audit_events precedent).
  await withRetry(() => adminClient.academicCalendarDay.deleteMany({ where }));
  await withRetry(() => adminClient.academicTerm.deleteMany({ where }));
  await withRetry(() => adminClient.academicSession.deleteMany({ where }));
  await withRetry(() => adminClient.program.deleteMany({ where }));
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

/**
 * Count remaining test rows across the seeded tables (teardown assertion).
 *
 * Run SEQUENTIALLY (not Promise.all): the postgres session pooler caps at 15
 * clients, and firing every count concurrently alongside teardown connections
 * trips `EMAXCONNSESSION: max clients reached in session mode`. One at a time
 * (with transient-error retry) keeps well under the cap and is plenty fast for a
 * teardown assertion.
 */
export async function countRemainingTestRows(): Promise<number> {
  const where = { institutionId: { startsWith: PREFIX } };
  const counters: Array<() => Promise<number>> = [
    () => adminClient.membershipRole.count({ where }),
    () => adminClient.institutionMembership.count({ where }),
    () => adminClient.institutionModule.count({ where }),
    // FEAT-003 academics mutable tables (the revision table is append-only and
    // not seeded here, so it is not counted — audit_events precedent).
    () => adminClient.academicCalendarDay.count({ where }),
    () => adminClient.academicTerm.count({ where }),
    () => adminClient.academicSession.count({ where }),
    () => adminClient.program.count({ where }),
    () => adminClient.gatePass.count({ where }),
    () => adminClient.studentProfile.count({ where }),
    () => adminClient.user.count({ where }),
    () => adminClient.department.count({ where }),
    () => adminClient.exitReason.count({ where }),
    () => adminClient.gate.count({ where }),
    () => adminClient.institution.count({ where: { id: { startsWith: PREFIX } } }),
  ];
  let total = 0;
  for (const count of counters) {
    total += await withRetry(count);
  }
  return total;
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
  "institution_memberships",
  "membership_roles",
  // FEAT-003 new tables (design §9.3).
  "audit_events",
  "support_grants",
  // Module-system table (design §9.1) — uses the default policy pair.
  "institution_modules",
  // FEAT-003 academics tables (design §9/§10.1). sessions/terms/programs use the
  // default modify pair; the revision table is append-only (EXPECTED_POLICIES).
  "academic_sessions",
  "academic_terms",
  "programs",
  "academic_calendar_day_revisions",
] as const;

/**
 * Per-table expected RLS policy-name set (design §9.3). The standard tenant pair
 * is {tenant_isolation_select, tenant_isolation_modify}; the two FEAT-003 tables
 * are special cases. NO inert *_platform_all TO-postgres policy is listed (they
 * are not created — a BYPASSRLS role ignores them). Only load-bearing policies
 * that bind campass_app appear here.
 */
export const EXPECTED_POLICIES: Record<string, readonly string[]> = {
  audit_events: ["tenant_isolation_select", "audit_events_tenant_insert"],
  support_grants: ["support_grants_tenant_read"],
  // FEAT-003: the calendar-revision table is append-only (design §4.3/§10.1) —
  // the audit_events pair, NOT the default modify pair.
  academic_calendar_day_revisions: [
    "tenant_isolation_select",
    "academic_calendar_day_revisions_tenant_insert",
  ],
};

/** The default policy pair every non-special table must carry. */
export const DEFAULT_POLICIES = [
  "tenant_isolation_select",
  "tenant_isolation_modify",
] as const;
