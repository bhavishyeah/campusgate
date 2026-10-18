import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PERMISSION_KEYS, ROLE_PERMISSIONS } from "@campusgate/shared";

// ─── FEAT-004 catalogue-sync CI meta-test (design §3.1 step 2b / §9) ────────
// The identity_rbac_b2 migration hand-transcribes the permission catalogue and
// the role→permission map from @campusgate/shared. This static-parse test reads
// that migration.sql, extracts its embedded permission keys and (roleKey,
// permissionKey) pairs, and asserts set-equality against PERMISSIONS +
// ROLE_PERMISSIONS. Any drift (a key added to shared but not the migration, or
// vice-versa) fails the build — the migration-seeded catalogue, the seed, and
// the signed-token permission set must provably agree.
//
// Pinned by name to the exact migration file (per FEAT-002 finding): changing
// the migration directory requires updating MIGRATION_DIR here deliberately.

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_DIR = "20261018171747_identity_rbac_b2";
const MIGRATION_PATH = resolve(
  __dirname,
  "../../../../../packages/db/prisma/migrations",
  MIGRATION_DIR,
  "migration.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf8");

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
function extractPermissionKeys(): string[] {
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
function extractRolePermissionPairs(): Array<[string, string]> {
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

describe("catalogue-sync: identity_rbac_b2 migration ↔ @campusgate/shared", () => {
  it("permission keys in the migration equal PERMISSION_KEYS (set-equality)", () => {
    const migrationKeys = extractPermissionKeys();
    // No duplicates in the migration seed.
    expect(new Set(migrationKeys).size).toBe(migrationKeys.length);
    expect([...migrationKeys].sort()).toEqual([...PERMISSION_KEYS].sort());
  });

  it("(roleKey, permissionKey) pairs in the migration equal ROLE_PERMISSIONS (set-equality)", () => {
    const migrationPairs = extractRolePermissionPairs();

    // No duplicate pairs in the migration seed.
    const migrationPairKeys = migrationPairs.map(([r, p]) => `${r}::${p}`);
    expect(new Set(migrationPairKeys).size).toBe(migrationPairKeys.length);

    const sharedPairKeys: string[] = [];
    for (const roleKey of Object.keys(ROLE_PERMISSIONS)) {
      for (const permKey of ROLE_PERMISSIONS[roleKey]) {
        sharedPairKeys.push(`${roleKey}::${permKey}`);
      }
    }

    expect(migrationPairKeys.sort()).toEqual(sharedPairKeys.sort());
  });

  it("every migration permission key is a known catalogue key (no dangling)", () => {
    const known = new Set(PERMISSION_KEYS);
    for (const [, permKey] of extractRolePermissionPairs()) {
      expect(known.has(permKey), `dangling permission key in migration: ${permKey}`).toBe(true);
    }
  });

  it("fails on injected drift (guards the guard): a fabricated key is NOT silently accepted", () => {
    // Prove the comparison is real: injecting a key the migration does not have
    // must break set-equality. This is a self-check of the test's own logic.
    const migrationKeys = extractPermissionKeys();
    const withDrift = [...migrationKeys, "campus_movement.fabricated.drift"];
    expect([...withDrift].sort()).not.toEqual([...PERMISSION_KEYS].sort());
  });
});
