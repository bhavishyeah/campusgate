import { describe, expect, it } from "vitest";
import {
  MODULES,
  MODULE_KEYS,
  MODULE_KEY_SET,
  MODULE_DEPENDENCIES,
  type ModuleKey,
} from "@campusgate/shared";

// ─── module registry + dependency-graph meta-test (design §9.4) ──────────────
// The module registry and its dependency graph are the single source of truth
// for the CAMPASS booster model. This pins key uniqueness, set consistency, that
// every graph key/value is a known MODULE_KEY, and that the graph is ACYCLIC — a
// cycle would make the depended-on modules impossible to activate.

describe("module registry: keys", () => {
  it("MODULE_KEYS has no duplicates", () => {
    expect(new Set(MODULE_KEYS).size).toBe(MODULE_KEYS.length);
  });

  it("MODULE_KEY_SET equals the set of MODULE_KEYS", () => {
    expect(MODULE_KEY_SET.size).toBe(MODULE_KEYS.length);
    for (const key of MODULE_KEYS) expect(MODULE_KEY_SET.has(key)).toBe(true);
  });

  it("MODULES keys equal MODULE_KEYS (same source)", () => {
    expect(MODULES.map((m) => m.key).sort()).toEqual([...MODULE_KEYS].sort());
  });
});

describe("module dependency graph", () => {
  it("every graph key is a known MODULE_KEY", () => {
    for (const key of Object.keys(MODULE_DEPENDENCIES)) {
      expect(MODULE_KEY_SET.has(key), `unknown graph key ${key}`).toBe(true);
    }
  });

  it("declares an entry for every MODULE_KEY", () => {
    for (const key of MODULE_KEYS) {
      expect(MODULE_DEPENDENCIES[key], `missing graph entry for ${key}`).toBeDefined();
    }
  });

  it("every dependency value is a known MODULE_KEY", () => {
    for (const deps of Object.values(MODULE_DEPENDENCIES)) {
      for (const dep of deps) {
        expect(MODULE_KEY_SET.has(dep), `unknown dependency ${dep}`).toBe(true);
      }
    }
  });

  it("attendance declares no gated-module dependencies (foundational-not-gated)", () => {
    expect(MODULE_DEPENDENCIES.attendance).toEqual([]);
  });

  it("examinations still declares its three foundational edges", () => {
    expect([...MODULE_DEPENDENCIES.examinations].sort()).toEqual(
      ["academic_sessions", "class_course", "student_enrollment"].sort(),
    );
  });

  it("is acyclic (DFS)", () => {
    const WHITE = 0;
    const GREY = 1;
    const BLACK = 2;
    const color = new Map<ModuleKey, number>(MODULE_KEYS.map((k) => [k, WHITE]));

    const visit = (node: ModuleKey): boolean => {
      color.set(node, GREY);
      for (const dep of MODULE_DEPENDENCIES[node] ?? []) {
        const c = color.get(dep);
        if (c === GREY) return false; // back-edge => cycle
        if (c === WHITE && !visit(dep)) return false;
      }
      color.set(node, BLACK);
      return true;
    };

    for (const key of MODULE_KEYS) {
      if (color.get(key) === WHITE) {
        expect(visit(key), `cycle reachable from ${key}`).toBe(true);
      }
    }
  });
});
