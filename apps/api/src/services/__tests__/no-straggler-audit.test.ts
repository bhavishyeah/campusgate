import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ─── no-straggler audit meta-test (design §4.4 / §9.1) ──────────────────────
// After the FEAT-002 migration every direct `tx.auditLog.create(...)` write has
// been replaced by the single `recordAuditEvent` writer. This static-parse test
// guards against a regression:
//   (1) ZERO `auditLog.create` occurrences under apps/api/src/routes/** (the 28
//       migrated sites). The scope also covers services/** — harmless, it is 0
//       there — to catch a future straggler written anywhere in the app.
//   (2) audit_events is append-only: `auditEvent.update` / `auditEvent.delete` /
//       `auditEvent.deleteMany` must NEVER appear anywhere under apps/api/src.
//
// Test files themselves are excluded (a mocked `prisma.auditLog.create` spy in a
// *.test.ts is legitimate and not a production write site).

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, "../..");

function tsSourceFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      // Exclude test files: a mocked auditLog.create spy there is legitimate.
      if (entry.includes(".test.ts") || entry.includes(".property.test.ts")) continue;
      // Exclude test-infrastructure helpers under any __tests__ directory: their
      // setup/teardown legitimately deletes rows (e.g. the escape-suite cleanup
      // removing seeded audit_events) and is not a production write site.
      if (full.split(/[\\/]/).includes("__tests__")) continue;
      out.push(full);
    }
  }
  walk(root);
  return out;
}

describe("no straggler audit writes", () => {
  it("has zero tx.auditLog.create occurrences under routes/** and services/**", () => {
    const roots = [join(SRC_ROOT, "routes"), join(SRC_ROOT, "services")];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of tsSourceFiles(root)) {
        const text = readFileSync(file, "utf8");
        if (/\bauditLog\.create\b/.test(text)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never mutates or deletes audit_events anywhere under src", () => {
    const offenders: string[] = [];
    for (const file of tsSourceFiles(SRC_ROOT)) {
      const text = readFileSync(file, "utf8");
      if (/\bauditEvent\.(update|delete|deleteMany)\b/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
