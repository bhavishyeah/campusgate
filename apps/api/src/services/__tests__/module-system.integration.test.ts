/**
 * Module-system dependency / suspend-revoke / audit-persistence integration suite
 * (design §9.2). Runs against the REAL Supabase instance through the SAME two
 * connections the escape suite uses (campass_app = RLS-subject appClient via
 * withTenant; postgres = RLS-bypass owner adminClient), imported from the
 * escape-setup helper so DATABASE_URL is pinned to campass_app BEFORE
 * @campusgate/db loads.
 *
 * It proves the state machine end-to-end at the DB layer:
 *   - dependency validation blocks activation until every dep is ACTIVE (using
 *     the DECLARED `examinations` edges), including the SUSPENDED-dependency 409 and
 *     SUSPENDED->ACTIVE reactivation re-running the same predicate;
 *   - the reverse-edge affectedDependents warning set (ACTIVE + SUSPENDED);
 *   - audit metadata serializes the dependent set to scalars that SURVIVE
 *     sanitizeMetadata (re-read the persisted audit_events row);
 *   - platform revoke's dependent scan is tenant-scoped (never cross-tenant).
 *
 * SELF-CONTAINED under a DISTINCT prefix (MODSYS_TEST_); seeds + tears down its
 * own institutions. Requires live Supabase + campass_app credentials.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appClient, adminClient, disconnect } from "../../routes/__tests__/helpers/tenant-escape-setup.js";
import {
  activate,
  suspend,
  entitle,
  revoke,
  affectedDependents,
  missingDependencies,
  type ModuleStateRow,
} from "../module-system.js";
import type { ModuleKey } from "@campusgate/shared";

type WithTenant = <T>(institutionId: string, fn: (tx: any) => Promise<T>) => Promise<T>;
let withTenant: WithTenant;

const PFX = "MODSYS_TEST_";
const id = (s: string) => `${PFX}${s}`;

const instA = id("inst_A");
const instB = id("inst_B");
const userA = id("user_A");
const userB = id("user_B");

/** Seed an institution + one ADMIN user (actor for audit rows). */
async function seedTenant(key: "A" | "B") {
  const instId = key === "A" ? instA : instB;
  const uId = key === "A" ? userA : userB;
  await adminClient.institution.create({
    data: { id: instId, name: `${PFX}Inst ${key}`, code: id(`CODE_${key}`), status: "ACTIVE" },
  });
  await adminClient.user.create({
    data: { id: uId, email: `${PFX.toLowerCase()}${key.toLowerCase()}@example.test`, role: "ADMIN", institutionId: instId },
  });
}

/** Directly upsert a module row in a given state via the RLS-bypassing admin client. */
async function seedModule(institutionId: string, moduleKey: ModuleKey, state: "ENTITLED" | "ACTIVE" | "SUSPENDED") {
  await adminClient.institutionModule.create({
    data: {
      id: id(`${institutionId}_${moduleKey}`),
      institutionId,
      moduleKey,
      state,
      entitledAt: new Date(),
      activatedAt: state === "ACTIVE" ? new Date() : null,
      suspendedAt: state === "SUSPENDED" ? new Date() : null,
    },
  });
}

async function clearModules() {
  await adminClient.institutionModule.deleteMany({ where: { institutionId: { startsWith: PFX } } });
}

async function teardownAll() {
  await adminClient.institutionModule.deleteMany({ where: { institutionId: { startsWith: PFX } } });
  await adminClient.$executeRawUnsafe(`ALTER TABLE "audit_events" DISABLE TRIGGER "audit_events_no_update_delete"`);
  try {
    await adminClient.auditEvent.deleteMany({ where: { institutionId: { startsWith: PFX } } });
  } finally {
    await adminClient.$executeRawUnsafe(`ALTER TABLE "audit_events" ENABLE TRIGGER "audit_events_no_update_delete"`);
  }
  await adminClient.user.deleteMany({ where: { institutionId: { startsWith: PFX } } });
  await adminClient.institution.deleteMany({ where: { id: { startsWith: PFX } } });
}

describe("module-system (real DB, RLS enforced)", () => {
  beforeAll(async () => {
    const db = (await import("@campusgate/db")) as any;
    withTenant = db.withTenant;
    await teardownAll();
    await seedTenant("A");
    await seedTenant("B");
  }, 120_000);

  afterAll(async () => {
    await teardownAll();
    await disconnect();
  }, 120_000);

  // ── pure helpers (no DB) ───────────────────────────────────────────────────
  it("missingDependencies lists absent/ENTITLED/SUSPENDED deps, excludes ACTIVE", () => {
    // examinations is the multi-dep exemplar: it declares
    // [academic_sessions, class_course, student_enrollment].
    const rows = new Map<string, ModuleStateRow>([
      ["academic_sessions", { moduleKey: "academic_sessions", state: "ACTIVE" }],
      ["class_course", { moduleKey: "class_course", state: "SUSPENDED" }],
      // student_enrollment absent
    ]);
    expect(missingDependencies("examinations", rows).sort()).toEqual(
      ["class_course", "student_enrollment"].sort(),
    );
  });

  it("affectedDependents returns ACTIVE + SUSPENDED dependents of a module", () => {
    // examinations + fees are the two dependents exercised; both declare edges
    // onto foundational keys. academic_sessions has one dependent: examinations.
    const rows = new Map<string, ModuleStateRow>([
      ["examinations", { moduleKey: "examinations", state: "ACTIVE" }],
    ]);
    expect(affectedDependents("student_enrollment", rows).sort()).toEqual(
      ["examinations"].sort(),
    );
  });

  // ── dependency validation through withTenant (RLS-enforced) ─────────────────
  it("activation is BLOCKED (DEPS_UNMET) until every declared dep is ACTIVE", async () => {
    await clearModules();
    // examinations requires academic_sessions + class_course + student_enrollment
    await seedModule(instA, "examinations", "ENTITLED");
    await seedModule(instA, "academic_sessions", "ENTITLED"); // not ACTIVE yet

    const blocked = await withTenant(instA, (tx) => activate(tx, instA, "examinations", userA));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok && blocked.reason === "DEPS_UNMET") {
      expect(blocked.missingDependencies.sort()).toEqual(
        ["academic_sessions", "class_course", "student_enrollment"].sort(),
      );
    } else {
      throw new Error("expected DEPS_UNMET");
    }

    // Activate the three deps, then examinations activates.
    await seedModule(instA, "class_course", "ENTITLED");
    await seedModule(instA, "student_enrollment", "ENTITLED");
    for (const dep of ["academic_sessions", "class_course", "student_enrollment"] as const) {
      const r = await withTenant(instA, (tx) => activate(tx, instA, dep, userA));
      expect(r.ok).toBe(true);
    }

    const ok = await withTenant(instA, (tx) => activate(tx, instA, "examinations", userA));
    expect(ok.ok).toBe(true);
    const row = await adminClient.institutionModule.findUnique({
      where: { institutionId_moduleKey: { institutionId: instA, moduleKey: "examinations" } },
    });
    expect(row!.state).toBe("ACTIVE");
    expect(row!.activatedAt).not.toBeNull();
  }, 60_000);

  it("a SUSPENDED dependency causes a 409 (not ACTIVE is the bar) and blocks reactivation", async () => {
    await clearModules();
    await seedModule(instA, "fees", "SUSPENDED"); // fees depends on student_management
    await seedModule(instA, "student_management", "SUSPENDED"); // dep is SUSPENDED

    // reactivate fees (SUSPENDED -> ACTIVE) must fail: dep is not ACTIVE
    const blocked = await withTenant(instA, (tx) => activate(tx, instA, "fees", userA));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok && blocked.reason === "DEPS_UNMET") {
      expect(blocked.missingDependencies).toContain("student_management");
    } else {
      throw new Error("expected DEPS_UNMET with student_management");
    }

    // activate the dep, then fees reactivation (SUSPENDED -> ACTIVE) succeeds
    const depOk = await withTenant(instA, (tx) => activate(tx, instA, "student_management", userA));
    expect(depOk.ok).toBe(true);
    const feesOk = await withTenant(instA, (tx) => activate(tx, instA, "fees", userA));
    expect(feesOk.ok).toBe(true);
    const row = await adminClient.institutionModule.findUnique({
      where: { institutionId_moduleKey: { institutionId: instA, moduleKey: "fees" } },
    });
    expect(row!.state).toBe("ACTIVE");
    expect(row!.suspendedAt).toBeNull(); // cleared on reactivation
  }, 60_000);

  // ── suspend + audit persistence of the dependent set ────────────────────────
  it("suspend warns ACTIVE+SUSPENDED dependents, and the audit row persists them as scalars", async () => {
    await clearModules();
    // academic_sessions ACTIVE with examinations SUSPENDED (examinations depends
    // on it). The dependent set includes SUSPENDED dependents, proving the
    // ACTIVE+SUSPENDED membership rule.
    await seedModule(instA, "academic_sessions", "ACTIVE");
    await seedModule(instA, "examinations", "SUSPENDED");

    const result = await withTenant(instA, async (tx) => {
      const r = await suspend(tx, instA, "academic_sessions", userA);
      if (r.ok) {
        const { recordAuditEvent } = await import("../audit.js");
        await recordAuditEvent(
          {
            action: "admin.module.suspended",
            result: "SUCCESS",
            actorUserId: userA,
            actorRoleKey: "ADMIN",
            institutionId: instA,
            resourceType: "InstitutionModule",
            resourceId: "academic_sessions",
            metadata: {
              moduleKey: "academic_sessions",
              affectedDependents: r.affectedDependents.join(","),
              affectedDependentsCount: r.affectedDependents.length,
            },
          },
          tx,
        );
      }
      return r;
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.affectedDependents.sort()).toEqual(["examinations"].sort());
    }

    // Re-read the PERSISTED audit row: the joined scalar + count survived sanitizeMetadata.
    const audit = await adminClient.auditEvent.findFirst({
      where: { institutionId: instA, action: "admin.module.suspended", resourceId: "academic_sessions" },
      orderBy: { timestamp: "desc" },
    });
    expect(audit).toBeTruthy();
    const meta = audit!.metadata as Record<string, unknown>;
    expect(typeof meta.affectedDependents).toBe("string");
    expect((meta.affectedDependents as string).split(",").sort()).toEqual(["examinations"].sort());
    expect(meta.affectedDependentsCount).toBe(1);
  }, 60_000);

  it("suspend with no dependents persists affectedDependents='' and count=0", async () => {
    await clearModules();
    await seedModule(instA, "campus_movement", "ACTIVE"); // no dependents in the graph

    await withTenant(instA, async (tx) => {
      const r = await suspend(tx, instA, "campus_movement", userA);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.affectedDependents).toEqual([]);
        const { recordAuditEvent } = await import("../audit.js");
        await recordAuditEvent(
          {
            action: "admin.module.suspended",
            result: "SUCCESS",
            actorUserId: userA,
            actorRoleKey: "ADMIN",
            institutionId: instA,
            resourceType: "InstitutionModule",
            resourceId: "campus_movement",
            metadata: {
              moduleKey: "campus_movement",
              affectedDependents: r.affectedDependents.join(","),
              affectedDependentsCount: r.affectedDependents.length,
            },
          },
          tx,
        );
      }
    });

    const audit = await adminClient.auditEvent.findFirst({
      where: { institutionId: instA, action: "admin.module.suspended", resourceId: "campus_movement" },
      orderBy: { timestamp: "desc" },
    });
    const meta = audit!.metadata as Record<string, unknown>;
    expect(meta.affectedDependents).toBe("");
    expect(meta.affectedDependentsCount).toBe(0);
  }, 60_000);

  // ── platform revoke dependent-scan is tenant-scoped ─────────────────────────
  it("platform revoke's dependent scan is tenant-scoped: A's revoke lists only A's dependent", async () => {
    await clearModules();
    // Same fees -> student_management edge ACTIVE in BOTH institutions.
    await seedModule(instA, "student_management", "ACTIVE");
    await seedModule(instA, "fees", "ACTIVE");
    await seedModule(instB, "student_management", "ACTIVE");
    await seedModule(instB, "fees", "ACTIVE");

    // revoke student_management from A on the RLS-BYPASSING owner client (the
    // production role for privilegedPrisma — in this harness DATABASE_URL is
    // pinned to campass_app so privilegedPrisma would fall back to the RLS-subject
    // role with no tenant GUC and see zero rows; adminClient is the real
    // cross-tenant-capable connection the platform path uses). The guard must
    // consider ONLY A's rows via the mandatory where:{institutionId} filter.
    const result = await revoke(adminClient, instA, "student_management");
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "HAS_DEPENDENTS") {
      expect(result.blockingDependents.map((d) => d.moduleKey)).toEqual(["fees"]);
      // exactly one dependent — B's fees did not leak into A's scan
      expect(result.blockingDependents).toHaveLength(1);
    } else {
      throw new Error("expected HAS_DEPENDENTS");
    }

    // Clearing A's fees lets the revoke proceed (B untouched throughout).
    await adminClient.institutionModule.delete({
      where: { institutionId_moduleKey: { institutionId: instA, moduleKey: "fees" } },
    });
    const ok = await revoke(adminClient, instA, "student_management");
    expect(ok.ok).toBe(true);
    // B's rows still present.
    const bStillThere = await adminClient.institutionModule.count({ where: { institutionId: instB } });
    expect(bStillThere).toBe(2);
  }, 60_000);
});
