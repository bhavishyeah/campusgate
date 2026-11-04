import { describe, it, expect } from "vitest";
import { ROLE_PERMISSIONS } from "@campusgate/shared";
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

  it("sends a pure ACCOUNTANT with fees.view to /fees", () => {
    expect(landingRoute(["ACCOUNTANT"], ["fees.view"])).toBe("/fees");
  });

  it("sends a non-legacy fees.view_own-only holder to /fees/me", () => {
    expect(landingRoute(["PARENT"], ["fees.view_own"])).toBe("/fees/me");
  });

  it("falls back to /app for an authenticated user with no known landing", () => {
    expect(landingRoute([], [])).toBe("/app");
  });

  it("sends a LIBRARIAN to /library", () => {
    expect(landingRoute(["LIBRARIAN"], ["library.books.view", "library.issue"])).toBe("/library");
  });

  it("sends an ADMISSION_OFFICER to /admissions", () => {
    expect(
      landingRoute(["ADMISSION_OFFICER"], ["admissions.applications.view", "admissions.campaigns.manage"]),
    ).toBe("/admissions");
  });

  it("sends the seeded APPLICANT to /admissions/my, never /student", () => {
    expect(landingRoute(["APPLICANT"], ["admissions.view_own"])).toBe("/admissions/my");
  });

  it("keeps a GatePass STUDENT on /student even holding library.view_own", () => {
    expect(landingRoute(["STUDENT"], ["library.view_own", "fees.view_own"])).toBe("/student");
  });

  it("keeps an ADMIN on /admin even holding all library and admissions staff keys", () => {
    expect(
      landingRoute(
        ["ADMIN"],
        [
          "library.books.view", "library.books.manage", "library.issue", "library.return",
          "library.reservations.manage", "library.fines.manage",
          "admissions.campaigns.manage", "admissions.applications.view", "admissions.applications.manage",
          "admissions.applications.review", "admissions.offers.manage", "admissions.enroll",
        ],
      ),
    ).toBe("/admin");
  });

  it("keeps a fees ACCOUNTANT on /fees even holding library.books.view", () => {
    expect(landingRoute(["ACCOUNTANT"], ["fees.view", "library.books.view"])).toBe("/fees");
  });

  it("sends a non-legacy library.view_own-only holder to /library/my", () => {
    expect(landingRoute(["PARENT"], ["library.view_own"])).toBe("/library/my");
  });

  it("falls back to /app for a holder of only library.issue", () => {
    expect(landingRoute([], ["library.issue"])).toBe("/app");
  });

  // ── 3c. Faculty Management / HR landings ──
  const HR_STAFF = [
    "hr.employees.manage", "hr.contracts.manage", "hr.leave.manage",
    "hr.attendance.manage", "hr.reports.view", "hr.directory.view",
  ];
  const FACULTY_STAFF = [
    "faculty.qualifications.manage", "faculty.workload.manage",
    "faculty.teaching_history.manage", "faculty.directory.view",
  ];
  it("sends an HR_MANAGER to /hr", () => {
    expect(landingRoute(["HR_MANAGER"], [...HR_STAFF, "documents.download"])).toBe("/hr");
  });
  it("sends an EMPLOYEE to /hr/me", () => {
    expect(landingRoute(["EMPLOYEE"], ["hr.view_own", "documents.download"])).toBe("/hr/me");
  });
  it("sends a non-legacy faculty.directory.view holder to /faculty-mgmt", () => {
    expect(landingRoute(["DEAN"], ["faculty.directory.view"])).toBe("/faculty-mgmt");
  });
  it("sends the real FACULTY role permissions to /faculty-mgmt/me", () => {
    expect(landingRoute(["FACULTY"], ROLE_PERMISSIONS.FACULTY ?? [])).toBe("/faculty-mgmt/me");
  });
  it("keeps ADMIN on /admin and HOD on /hod despite faculty/HR keys", () => {
    expect(landingRoute(["ADMIN"], [...HR_STAFF, ...FACULTY_STAFF])).toBe("/admin");
    expect(landingRoute(["HOD"], FACULTY_STAFF)).toBe("/hod");
  });
  it("keeps fees and library holders on their landings even with hr.directory.view", () => {
    expect(landingRoute(["ACCOUNTANT"], ["fees.view", "hr.directory.view"])).toBe("/fees");
    expect(landingRoute(["LIBRARIAN"], ["library.books.view", "hr.directory.view"])).toBe("/library");
  });
  it("falls back to /app for a holder of only hr.employees.manage", () => {
    expect(landingRoute([], ["hr.employees.manage"])).toBe("/app");
  });
  it("prefers /hr/me over /faculty-mgmt/me when both own-keys are held", () => {
    expect(landingRoute([], ["faculty.view_own", "hr.view_own"])).toBe("/hr/me");
  });
});
