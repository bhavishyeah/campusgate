import { describe, it, expect } from "vitest";
import { can, canAny, hasRole, hasAnyRole } from "@/lib/authz";

const perms = ["fees.view", "fees.collect"];
const roles = ["ACCOUNTANT", "ADMIN"];

describe("can", () => {
  it("is true when the permission is held", () => {
    expect(can("fees.view", perms)).toBe(true);
  });

  it("is false when the permission is absent", () => {
    expect(can("fees.view_own", perms)).toBe(false);
  });
});

describe("canAny", () => {
  it("is true when at least one permission is held", () => {
    expect(canAny(["fees.view_own", "fees.collect"], perms)).toBe(true);
  });

  it("is false when none are held", () => {
    expect(canAny(["fees.view_own", "fees.refund"], perms)).toBe(false);
  });
});

describe("hasRole", () => {
  it("is true when the role is present", () => {
    expect(hasRole("ADMIN", roles)).toBe(true);
  });

  it("is false when the role is absent", () => {
    expect(hasRole("STUDENT", roles)).toBe(false);
  });
});

describe("hasAnyRole", () => {
  it("is true when at least one role matches", () => {
    expect(hasAnyRole(["STUDENT", "ADMIN"], roles)).toBe(true);
  });

  it("is false when none match", () => {
    expect(hasAnyRole(["STUDENT", "GUARD"], roles)).toBe(false);
  });
});
