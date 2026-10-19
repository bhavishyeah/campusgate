// Module-system state machine (design §3/§4/§8.4). The SINGLE owner of the
// (institution, module) state-machine invariant: legal transitions only, and
// dependency satisfaction before ACTIVE. Every entry point (the tenant activate
// route now, future callers later) shares this one implementation so the
// inductive transitive-dependency guarantee (§3) cannot be bypassed — there is
// deliberately NO force-activate path here.
//
// All functions run on a passed DbClient (a withTenant transaction client for
// tenant writes, or privilegedPrisma for platform writes), so the dependency
// read and the state write are atomic within one caller transaction.

import type { DbClient } from "@campusgate/db";
import { MODULE_DEPENDENCIES, type ModuleKey } from "@campusgate/shared";

/** The subset of an institution_modules row the state machine reasons over. */
export interface ModuleStateRow {
  moduleKey: string;
  state: "ENTITLED" | "ACTIVE" | "SUSPENDED";
}

export type EntitleResult = { ok: true } | { ok: false; reason: "ALREADY_ENTITLED" };
export type RevokeResult =
  | { ok: true; affectedDependents: ModuleKey[] }
  | { ok: false; reason: "NOT_ENTITLED" }
  | { ok: false; reason: "HAS_DEPENDENTS"; blockingDependents: { moduleKey: ModuleKey; state: string }[] };
export type ActivateResult =
  | { ok: true }
  | { ok: false; reason: "NOT_ENTITLED" }
  | { ok: false; reason: "DEPS_UNMET"; missingDependencies: ModuleKey[] };
export type SuspendResult =
  | { ok: true; affectedDependents: ModuleKey[] }
  | { ok: false; reason: "NOT_ACTIVE" };

/**
 * Dependency-satisfaction (design §3). A declared dependency SATISFIES activation
 * iff the institution has a row for it AND that row's state is ACTIVE. The result
 * lists EVERY declared dependency whose row is absent OR whose state is not ACTIVE
 * (i.e. ENTITLED or SUSPENDED). Applied identically to ENTITLED->ACTIVE and
 * SUSPENDED->ACTIVE, direct-deps only (transitive closure is satisfied by
 * induction — see module header).
 */
export function missingDependencies(
  moduleKey: ModuleKey,
  rowsByKey: ReadonlyMap<string, ModuleStateRow>,
): ModuleKey[] {
  const required = MODULE_DEPENDENCIES[moduleKey] ?? [];
  return required.filter((dep) => rowsByKey.get(dep)?.state !== "ACTIVE");
}

/**
 * Reverse-edge dependent set (design §4). The modules that DECLARE `moduleKey` as
 * a dependency AND are currently ACTIVE or SUSPENDED for this institution.
 * SUSPENDED is included deliberately (finding 2): a SUSPENDED dependent can be
 * reactivated later, and reactivation re-requires every dependency ACTIVE — so a
 * suspend/revoke of a dependency must surface it as affected, never silently.
 */
export function affectedDependents(
  moduleKey: ModuleKey,
  rowsByKey: ReadonlyMap<string, ModuleStateRow>,
): ModuleKey[] {
  const out: ModuleKey[] = [];
  for (const [key, deps] of Object.entries(MODULE_DEPENDENCIES) as [ModuleKey, readonly ModuleKey[]][]) {
    if (!deps.includes(moduleKey)) continue;
    const row = rowsByKey.get(key);
    if (row && (row.state === "ACTIVE" || row.state === "SUSPENDED")) out.push(key);
  }
  return out;
}

/** Build a (moduleKey -> row) map from a findMany result. */
function indexRows(rows: ModuleStateRow[]): Map<string, ModuleStateRow> {
  return new Map(rows.map((r) => [r.moduleKey, r]));
}

/**
 * entitle (platform): absent -> ENTITLED. Idempotent — re-granting an already
 * entitled/active/suspended module is a no-op (returns ALREADY_ENTITLED).
 */
export async function entitle(
  db: DbClient,
  institutionId: string,
  moduleKey: ModuleKey,
  actorUserId: string,
): Promise<EntitleResult> {
  const existing = await db.institutionModule.findUnique({
    where: { institutionId_moduleKey: { institutionId, moduleKey } },
    select: { id: true },
  });
  if (existing) return { ok: false, reason: "ALREADY_ENTITLED" };

  await db.institutionModule.create({
    data: {
      institutionId,
      moduleKey,
      state: "ENTITLED",
      entitledAt: new Date(),
      entitledByUserId: actorUserId,
    },
  });
  return { ok: true };
}

/**
 * revoke (platform): ENTITLED/ACTIVE/SUSPENDED -> NOT_ENTITLED (row deleted,
 * absence = not entitled). Blocks (HAS_DEPENDENTS) if any module in this
 * institution that is ACTIVE or SUSPENDED declares `moduleKey` as a dependency,
 * so a dependent is never left permanently un-reactivatable (§6.1). Domain data
 * is never touched (history preserved per §5.5).
 */
export async function revoke(
  db: DbClient,
  institutionId: string,
  moduleKey: ModuleKey,
): Promise<RevokeResult> {
  const rows = await db.institutionModule.findMany({
    where: { institutionId },
    select: { moduleKey: true, state: true },
  });
  const rowsByKey = indexRows(rows as ModuleStateRow[]);

  if (!rowsByKey.has(moduleKey)) return { ok: false, reason: "NOT_ENTITLED" };

  const dependents = affectedDependents(moduleKey, rowsByKey);
  if (dependents.length > 0) {
    const blockingDependents = dependents.map((k) => ({
      moduleKey: k,
      state: rowsByKey.get(k)!.state,
    }));
    return { ok: false, reason: "HAS_DEPENDENTS", blockingDependents };
  }

  await db.institutionModule.delete({
    where: { institutionId_moduleKey: { institutionId, moduleKey } },
  });
  return { ok: true, affectedDependents: dependents };
}

/**
 * activate (tenant): ENTITLED->ACTIVE or SUSPENDED->ACTIVE. Requires the row to
 * exist and not already be ACTIVE; applies the §3 satisfaction predicate (direct
 * deps only). On success: state=ACTIVE, activatedAt=now, actor recorded,
 * suspendedAt cleared.
 *
 * Future required-config seam (§3/§6.2): a future module with required activation
 * config plugs a `requiredConfigSatisfied(moduleKey, settings)` check in HERE —
 * immediately after the dependency predicate passes and before the state flips —
 * reading the row's `settings` JSON. No Phase-0 module declares required config
 * (A5), so no check is implemented now; this is the single named extension point.
 */
export async function activate(
  db: DbClient,
  institutionId: string,
  moduleKey: ModuleKey,
  actorUserId: string,
): Promise<ActivateResult> {
  const rows = await db.institutionModule.findMany({
    where: { institutionId },
    select: { moduleKey: true, state: true },
  });
  const rowsByKey = indexRows(rows as ModuleStateRow[]);

  const target = rowsByKey.get(moduleKey);
  if (!target) return { ok: false, reason: "NOT_ENTITLED" };

  const missing = missingDependencies(moduleKey, rowsByKey);
  if (missing.length > 0) return { ok: false, reason: "DEPS_UNMET", missingDependencies: missing };

  // (future seam: requiredConfigSatisfied(moduleKey, target settings) here)

  await db.institutionModule.update({
    where: { institutionId_moduleKey: { institutionId, moduleKey } },
    data: {
      state: "ACTIVE",
      activatedAt: new Date(),
      activatedByUserId: actorUserId,
      suspendedAt: null,
    },
  });
  return { ok: true };
}

/**
 * suspend (tenant): ACTIVE->SUSPENDED in place (history preserved — the row is
 * updated, never deleted). Computes the reverse-edge dependent warning set so the
 * blast radius is explicit, never a silent break (§5.5).
 */
export async function suspend(
  db: DbClient,
  institutionId: string,
  moduleKey: ModuleKey,
  actorUserId: string,
): Promise<SuspendResult> {
  const rows = await db.institutionModule.findMany({
    where: { institutionId },
    select: { moduleKey: true, state: true },
  });
  const rowsByKey = indexRows(rows as ModuleStateRow[]);

  const target = rowsByKey.get(moduleKey);
  if (!target || target.state !== "ACTIVE") return { ok: false, reason: "NOT_ACTIVE" };

  const dependents = affectedDependents(moduleKey, rowsByKey);

  await db.institutionModule.update({
    where: { institutionId_moduleKey: { institutionId, moduleKey } },
    data: {
      state: "SUSPENDED",
      suspendedAt: new Date(),
      suspendedByUserId: actorUserId,
    },
  });
  return { ok: true, affectedDependents: dependents };
}
