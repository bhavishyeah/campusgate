import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROLE_PERMISSIONS, type PermissionKey } from "@campusgate/shared";
import {
  ACADEMICS_STAFF_NAV,
  ATTENDANCE_STAFF_NAV,
  FEES_STAFF_NAV,
  isActive,
  type SectionNavItem,
} from "@/components/ui-ext/SectionNav";

const APP_DIR = join(process.cwd(), "src", "app", "(app)");

/** Static (non-dynamic) page routes under a module folder, e.g. "/fees/ledger". */
function staticRoutes(module: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, route: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!name.startsWith("[")) walk(full, `${route}/${name}`);
      } else if (name === "page.tsx") {
        out.push(route);
      }
    }
  };
  walk(join(APP_DIR, module), `/${module}`);
  return out.sort();
}

// Permission each page's content/API requires (fees pages carry no RouteGuard; the API gate is the source).
const EXPECTED: Record<string, PermissionKey> = {
  "/fees": "fees.view",
  "/fees/charges": "fees.charges.manage",
  "/fees/ledger": "fees.view",
  "/fees/payments": "fees.view",
  "/fees/receipts": "fees.view",
  "/fees/reconciliation": "fees.view",
  "/academics/sessions": "academics.sessions.manage",
  "/academics/programs": "academics.programs.manage",
  "/attendance/sessions": "attendance.view",
  "/attendance/corrections": "attendance.correct",
  "/attendance/report": "attendance.view",
};

const NAVS: { name: string; items: SectionNavItem[]; role: string }[] = [
  { name: "FEES_STAFF_NAV", items: FEES_STAFF_NAV, role: "ACCOUNTANT" },
  { name: "ACADEMICS_STAFF_NAV", items: ACADEMICS_STAFF_NAV, role: "ADMIN" },
  { name: "ATTENDANCE_STAFF_NAV", items: ATTENDANCE_STAFF_NAV, role: "ADMIN" },
];

describe("early-module SectionNav arrays", () => {
  it("every entry's permission equals the permission its page requires", () => {
    for (const { name, items } of NAVS) {
      for (const item of items) {
        expect(EXPECTED[item.href], `${name} ${item.href} has no expected permission`).toBeDefined();
        expect(item.permission, `${name} ${item.href}`).toBe(EXPECTED[item.href]);
      }
    }
  });

  it("every entry's permission is held by the staff role that uses it", () => {
    for (const { name, items, role } of NAVS) {
      for (const item of items) {
        expect(ROLE_PERMISSIONS[role] ?? [], `${name}: ${role} must hold ${item.permission}`).toContain(item.permission);
      }
    }
  });

  it("every staff page of fees (except the student /fees/me) is in FEES_STAFF_NAV", () => {
    const hrefs = FEES_STAFF_NAV.map((i) => i.href).sort();
    expect(staticRoutes("fees").filter((r) => r !== "/fees/me")).toEqual(hrefs);
  });

  it("every static academics and attendance page (except redirect/detail) is in its nav", () => {
    expect(staticRoutes("academics").filter((r) => r !== "/academics")).toEqual(
      ACADEMICS_STAFF_NAV.map((i) => i.href).sort(),
    );
    expect(staticRoutes("attendance")).toEqual(ATTENDANCE_STAFF_NAV.map((i) => i.href).sort());
  });

  it("has no duplicate hrefs", () => {
    for (const { items } of NAVS) {
      const hrefs = items.map((i) => i.href);
      expect(new Set(hrefs).size).toBe(hrefs.length);
    }
  });
});

describe("isActive for early modules", () => {
  it("keeps Structures active on the fees structure detail route only", () => {
    expect(isActive("/fees", "/fees")).toBe(true);
    expect(isActive("/fees/structures/abc", "/fees")).toBe(true);
    expect(isActive("/fees/ledger", "/fees")).toBe(false);
    expect(isActive("/fees/me", "/fees")).toBe(false);
    expect(isActive("/fees/structures/abc", "/fees/ledger")).toBe(false);
  });

  it("keeps academics and attendance tabs active on their detail routes", () => {
    expect(isActive("/academics/sessions/s1/terms/t1", "/academics/sessions")).toBe(true);
    expect(isActive("/academics/programs/p1", "/academics/programs")).toBe(true);
    expect(isActive("/academics/programs/p1", "/academics/sessions")).toBe(false);
    expect(isActive("/attendance/sessions/x/mark", "/attendance/sessions")).toBe(true);
    expect(isActive("/attendance/report", "/attendance/sessions")).toBe(false);
  });
});