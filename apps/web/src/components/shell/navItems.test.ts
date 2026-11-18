import { describe, it, expect } from "vitest";
import { ROLE_PERMISSIONS, type PermissionKey } from "@campusgate/shared";
import { GATE_PASS_NAV, NAV, visibleNavItems, type NavItem } from "./navItems";
import { landingRoute } from "@/lib/landing";

const active = () => "active" as const;
const inactive = () => "inactive" as const;

function hrefs(items: NavItem[]): string[] {
  return items.map((i) => i.href);
}
function permsOf(role: string): string[] {
  return [...(ROLE_PERMISSIONS[role] ?? [])];
}
/** Shell nav for a role: Gate Pass home links first, then module NAV. */
function shellFor(role: string, status = active): string[] {
  return hrefs(visibleNavItems([...GATE_PASS_NAV, ...NAV], permsOf(role), status, role));
}

// href -> permission its page's RouteGuard requires (self-service pages).
const GUARD_OF: Record<string, PermissionKey> = {
  "/fees/me": "fees.view_own",
  "/exams": "exams.results.view_own", // redirects to /exams/my-results for view_own-only users
  "/library/my": "library.view_own",
  "/hostel/me": "hostel.view_own",
  "/transport/me": "transport.view_own",
  "/service-requests/me": "service_requests.request_own",
  "/service-requests/raise": "service_requests.request_own",
};

describe("shared self-service nav for STUDENT", () => {
  const items = visibleNavItems(NAV, permsOf("STUDENT"), active, "STUDENT");

  it("yields exactly the student's destinations", () => {
    expect(hrefs(items)).toEqual(Object.keys(GUARD_OF));
  });

  it("each entry's permission matches its target page guard", () => {
    for (const item of items) {
      expect(item.anyOf).toContain(GUARD_OF[item.href]);
    }
  });

  it("hides module links when the module is inactive", () => {
    expect(visibleNavItems(NAV, permsOf("STUDENT"), inactive, "STUDENT")).toEqual([]);
  });
});

describe("permission gating", () => {
  it("a user without a module's permission does not get that link", () => {
    const perms = permsOf("STUDENT").filter((p) => p !== "hostel.view_own");
    const out = hrefs(visibleNavItems(NAV, perms, active, "STUDENT"));
    expect(out).not.toContain("/hostel/me");
    expect(out).toContain("/transport/me");
  });

  it("GUARD has no module destinations", () => {
    expect(hrefs(visibleNavItems(NAV, permsOf("GUARD"), active, "GUARD"))).toEqual([]);
  });

  it("HOD gets only links it holds keys for (no fees, no student self-service)", () => {
    const out = hrefs(visibleNavItems(NAV, permsOf("HOD"), active, "HOD"));
    expect(out).toEqual(expect.arrayContaining(["/classes/sections", "/attendance/sessions", "/exams", "/faculty-mgmt", "/sis/students"]));
    expect(out).not.toContain("/fees/me");
    expect(out).not.toContain("/hostel/me");
  });
});

describe("AppShell Gate Pass entries", () => {
  it("STUDENT gets Gate Pass -> /student first", () => {
    const out = shellFor("STUDENT");
    expect(out[0]).toBe("/student");
    expect(out).not.toContain("/hod");
    expect(out).not.toContain("/guard");
    expect(out).not.toContain("/admin");
  });

  it("HOD -> /hod, GUARD -> /guard, ADMIN -> /admin, each first", () => {
    expect(shellFor("HOD")[0]).toBe("/hod");
    expect(shellFor("GUARD")).toEqual(["/guard"]);
    expect(shellFor("ADMIN")[0]).toBe("/admin");
  });

  it("ACCOUNTANT (no campus_movement keys) gets no Gate Pass entry", () => {
    const out = shellFor("ACCOUNTANT");
    for (const h of ["/student", "/hod", "/guard", "/admin"]) expect(out).not.toContain(h);
    expect(out).toContain("/fees");
  });

  it("a Gate Pass link needs the matching legacy role as well as the key", () => {
    const out = hrefs(visibleNavItems(GATE_PASS_NAV, permsOf("STUDENT"), active, "FACULTY"));
    expect(out).toEqual([]);
  });

  it("keeps the module NAV order after the Gate Pass entries", () => {
    const all = shellFor("ADMIN");
    const navOnly = hrefs(visibleNavItems(NAV, permsOf("ADMIN"), active, "ADMIN"));
    expect(all.slice(1)).toEqual(navOnly);
  });
});

describe("landing is unchanged by cross-linking", () => {
  it("legacy roles still land on their GatePass homes", () => {
    expect(landingRoute(["STUDENT"], permsOf("STUDENT"))).toBe("/student");
    expect(landingRoute(["HOD"], permsOf("HOD"))).toBe("/hod");
    expect(landingRoute(["GUARD"], permsOf("GUARD"))).toBe("/guard");
    expect(landingRoute(["ADMIN"], permsOf("ADMIN"))).toBe("/admin");
  });
});
