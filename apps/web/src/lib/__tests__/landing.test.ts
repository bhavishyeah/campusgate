import { describe, it, expect } from "vitest";
import { landingRoute } from "@/lib/landing";

describe("landingRoute", () => {
  it("sends a SUPER_ADMIN to /platform", () => {
    expect(landingRoute(["SUPER_ADMIN"], [])).toBe("/platform");
  });

  it("keeps a GatePass STUDENT on /student even with fees.view_own (ordering fix)", () => {
    expect(landingRoute(["STUDENT"], ["fees.view_own"])).toBe("/student");
  });

  it("keeps an ADMIN on /admin even with the fees staff perms", () => {
    expect(
      landingRoute(["ADMIN"], ["fees.view", "fees.charges.manage"]),
    ).toBe("/admin");
  });

  it("sends a pure ACCOUNTANT with fees.view to /app/fees", () => {
    expect(landingRoute(["ACCOUNTANT"], ["fees.view"])).toBe("/app/fees");
  });

  it("sends a non-legacy fees.view_own-only holder to /app/fees/me", () => {
    expect(landingRoute(["PARENT"], ["fees.view_own"])).toBe("/app/fees/me");
  });

  it("falls back to /app for an authenticated user with no known landing", () => {
    expect(landingRoute([], [])).toBe("/app");
  });
});
