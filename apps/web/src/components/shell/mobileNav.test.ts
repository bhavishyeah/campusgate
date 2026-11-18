import { describe, it, expect } from "vitest";
import { ROLE_PERMISSIONS } from "@campusgate/shared";
import { GATE_PASS_NAV, NAV, visibleNavItems } from "./navItems";
import { sheetNavItems } from "./mobileNav";

const active = () => "active" as const;
const perms = (role: string) => [...(ROLE_PERMISSIONS[role] ?? [])];
const hrefs = (items: { href: string }[]) => items.map((i) => i.href);

describe("mobile More sheet list", () => {
  it("is the same shared NAV the desktop sidebar renders", () => {
    expect(sheetNavItems(false)).toBe(NAV);
    expect(sheetNavItems(true)).toEqual([...GATE_PASS_NAV, ...NAV]);
  });
  it("for a STUDENT yields the same visible entries as desktop, including the self-service links", () => {
    const mobile = visibleNavItems(sheetNavItems(false), perms("STUDENT"), active, "STUDENT");
    const desktop = visibleNavItems(NAV, perms("STUDENT"), active, "STUDENT");
    expect(hrefs(mobile)).toEqual(hrefs(desktop));
    expect(hrefs(mobile)).toEqual(
      expect.arrayContaining(["/fees/me", "/exams", "/library/my", "/hostel/me", "/transport/me", "/service-requests/me", "/service-requests/raise"]),
    );
  });
  it("excludes entries a STUDENT cannot open", () => {
    const out = hrefs(visibleNavItems(sheetNavItems(true), perms("STUDENT"), active, "STUDENT"));
    for (const h of ["/fees", "/hr", "/hostel", "/transport", "/inventory", "/hod", "/admin", "/guard"]) {
      expect(out).not.toContain(h);
    }
    expect(out[0]).toBe("/student");
  });
});
