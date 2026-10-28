import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PERMISSION_KEYS, ROLE_PERMISSIONS } from "@campusgate/shared";

// ─── catalogue-sync CI meta-test (design §3 / §9) ───────────────────────────
// The permission catalogue and the role→permission map from @campusgate/shared
// are hand-transcribed into the migration seed blocks. This static-parse test
// reads every migration that SEEDS those catalogues, extracts the embedded
// permission keys and (roleKey, permissionKey) pairs, UNIONS them (de-duped),
// and asserts set-equality of the union against PERMISSION_KEYS +
// ROLE_PERMISSIONS. Any drift (a key added to shared but to no migration, or
// vice-versa) fails the build — the migration-seeded catalogue, the seed, and
// the signed-token permission set must provably agree.
//
// Generalized (FEAT-001): the catalogue is now seeded across MORE than one
// migration — identity_rbac_b2 seeds the original 44 pairs; superadmin_security
// seeds the new admin.support.revoke permission + its ADMIN role_permissions
// pair. We parse BOTH and union. The frozen identity_rbac_b2 SQL is NOT edited.
// Changing/adding a seeding migration requires updating SEEDING_MIGRATION_DIRS
// here deliberately.

const __dirname = dirname(fileURLToPath(import.meta.url));

const SEEDING_MIGRATION_DIRS = [
  "20261018171747_identity_rbac_b2",
  "20261019053533_superadmin_security",
  "20261019093119_module_system",
  "20261027111710_phase1_academics",
  "20261027161616_phase2_sis",
  "20261028000000_phase3_classes",
];

function migrationSql(dir: string): string {
  const path = resolve(
    __dirname,
    "../../../../../packages/db/prisma/migrations",
    dir,
    "migration.sql",
  );
  return readFileSync(path, "utf8");
}

/** Slice the SQL between a start marker and an end marker (exclusive of end). */
function slice(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `start marker not found: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start);
  expect(end, `end marker not found: ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

// ── Extract the permission keys from the `INSERT INTO "permissions" ... VALUES`
//    block. Each row is ('perm_id', 'the.key', 'module', 'description'); the key
//    is the 2nd single-quoted literal.
function extractPermissionKeys(sql: string): string[] {
  const block = slice(sql, 'INSERT INTO "permissions"', 'ON CONFLICT');
  const keys: string[] = [];
  const rowRe = /\(\s*'[^']+'\s*,\s*'([^']+)'\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(block)) !== null) {
    keys.push(m[1]);
  }
  return keys;
}

// ── Extract the (roleKey, permissionKey) pairs from the role_permissions VALUES
//    tuple list: ('ROLE', 'the.key'). SQL comments (-- ...) are stripped so a
//    commented sample can never be mistaken for a row.
function extractRolePermissionPairs(sql: string): Array<[string, string]> {
  const block = slice(sql, 'INSERT INTO "role_permissions"', 'AS m(');
  const noComments = block.replace(/--[^\n]*/g, "");
  const pairs: Array<[string, string]> = [];
  const pairRe = /\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(noComments)) !== null) {
    pairs.push([m[1], m[2]]);
  }
  return pairs;
}

// Union the per-file extractions, asserting NO intra-file duplicates, and
// returning the de-duplicated union.
function unionPermissionKeys(): string[] {
  const union = new Set<string>();
  for (const dir of SEEDING_MIGRATION_DIRS) {
    const keys = extractPermissionKeys(migrationSql(dir));
    expect(new Set(keys).size, `duplicate permission key within ${dir}`).toBe(keys.length);
    for (const k of keys) union.add(k);
  }
  return [...union];
}

function unionRolePermissionPairKeys(): string[] {
  const union = new Set<string>();
  for (const dir of SEEDING_MIGRATION_DIRS) {
    const pairs = extractRolePermissionPairs(migrationSql(dir));
    const pairKeys = pairs.map(([r, p]) => `${r}::${p}`);
    expect(new Set(pairKeys).size, `duplicate role_permission pair within ${dir}`).toBe(
      pairKeys.length,
    );
    for (const pk of pairKeys) union.add(pk);
  }
  return [...union];
}

describe("catalogue-sync: seeding migrations ↔ @campusgate/shared", () => {
  it("permission keys (union over seeding migrations) equal PERMISSION_KEYS (set-equality)", () => {
    const migrationKeys = unionPermissionKeys();
    expect([...migrationKeys].sort()).toEqual([...PERMISSION_KEYS].sort());
  });

  it("(roleKey, permissionKey) pairs (union) equal ROLE_PERMISSIONS (set-equality)", () => {
    const migrationPairKeys = unionRolePermissionPairKeys();

    const sharedPairKeys: string[] = [];
    for (const roleKey of Object.keys(ROLE_PERMISSIONS)) {
      for (const permKey of ROLE_PERMISSIONS[roleKey]) {
        sharedPairKeys.push(`${roleKey}::${permKey}`);
      }
    }

    expect(migrationPairKeys.sort()).toEqual(sharedPairKeys.sort());
  });

  it("every migration permission pair key is a known catalogue key (no dangling)", () => {
    const known = new Set(PERMISSION_KEYS);
    for (const dir of SEEDING_MIGRATION_DIRS) {
      for (const [, permKey] of extractRolePermissionPairs(migrationSql(dir))) {
        expect(known.has(permKey), `dangling permission key in ${dir}: ${permKey}`).toBe(true);
      }
    }
  });

  it("fails on injected drift (guards the guard): a fabricated key is NOT silently accepted", () => {
    // Prove the comparison is real: injecting a key the migrations do not have
    // must break set-equality. This is a self-check of the test's own logic.
    const migrationKeys = unionPermissionKeys();
    const withDrift = [...migrationKeys, "campus_movement.fabricated.drift"];
    expect([...withDrift].sort()).not.toEqual([...PERMISSION_KEYS].sort());
  });
});
