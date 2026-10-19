import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_KEYS,
  AUDIT_ACTION_KEY_SET,
  LEGACY_AUDIT_ACTION_MAP,
} from "@campusgate/shared";

// ─── FEAT-001 audit-action catalogue meta-test (design §4.1 / §4.4) ──────────
// The audit-action catalogue is the single source of truth for the generic
// `audit_events.action` string. Unlike the permission catalogue it has no pg
// enum / seeded rows, so there is no migration mirror; this test instead pins
// the catalogue's shape and the complete legacy enum → key mapping.

const KEY_RE = /^[a-z_]+(\.[a-z_]+)+$/;

describe("audit-action catalogue: key shape + uniqueness", () => {
  it("every key matches <module>.<action> (lower snake, dot-separated)", () => {
    for (const def of AUDIT_ACTIONS) {
      expect(def.key, `bad key shape: ${def.key}`).toMatch(KEY_RE);
    }
  });

  it("has no duplicate keys", () => {
    expect(new Set(AUDIT_ACTION_KEYS).size).toBe(AUDIT_ACTION_KEYS.length);
  });

  it("AUDIT_ACTION_KEY_SET equals the set of AUDIT_ACTION_KEYS", () => {
    expect(AUDIT_ACTION_KEY_SET.size).toBe(AUDIT_ACTION_KEYS.length);
    for (const key of AUDIT_ACTION_KEYS) {
      expect(AUDIT_ACTION_KEY_SET.has(key)).toBe(true);
    }
  });
});

describe("legacy AuditAction enum → catalogue-key map (design §4.4)", () => {
  const entries = Object.entries(LEGACY_AUDIT_ACTION_MAP);

  it("has exactly 28 entries (one per live AuditAction enum value)", () => {
    expect(entries.length).toBe(28);
  });

  it("maps each legacy value to exactly one target", () => {
    // Record keys are unique by construction; assert each target is a single
    // non-empty string (one target each).
    for (const [legacy, target] of entries) {
      expect(typeof target, `missing target for ${legacy}`).toBe("string");
      expect(target.length).toBeGreaterThan(0);
    }
  });

  it("every mapped target is a known catalogue key", () => {
    for (const [legacy, target] of entries) {
      expect(
        AUDIT_ACTION_KEY_SET.has(target),
        `unknown target "${target}" for legacy ${legacy}`,
      ).toBe(true);
    }
  });
});
