import { describe, it, expect } from "vitest";
import { ROLE_PERMISSIONS, type PermissionKey } from "@campusgate/shared";
import { FACULTY_STAFF_NAV, HR_STAFF_NAV } from "@/components/ui-ext/SectionNav";

interface PageAccessRow {
  route: string;
  guard: PermissionKey;
  queryKeys: PermissionKey[];
  role: string;
}

/**
 * Mirrors the nav / SectionNav / landing / page guards. A typo here fails
 * `tsc` (PermissionKey) and a drift from the actual permission set fails the
 * assertions below.
 */
export const PAGE_ACCESS: PageAccessRow[] = [
  // Library staff (LIBRARIAN, ADMIN)
  { route: "/library", guard: "library.books.view", queryKeys: ["library.books.view"], role: "LIBRARIAN" },
  { route: "/library", guard: "library.books.view", queryKeys: ["library.books.view"], role: "ADMIN" },
  { route: "/library/titles/[id]", guard: "library.books.view", queryKeys: ["library.books.view", "library.books.manage", "library.issue"], role: "LIBRARIAN" },
  { route: "/library/circulation", guard: "library.books.view", queryKeys: ["library.books.view", "library.issue", "library.return"], role: "LIBRARIAN" },
  { route: "/library/reservations", guard: "library.books.view", queryKeys: ["library.books.view", "library.reservations.manage"], role: "LIBRARIAN" },
  { route: "/library/fines", guard: "library.fines.manage", queryKeys: ["library.fines.manage", "library.issue"], role: "LIBRARIAN" },
  // Library student (STUDENT)
  { route: "/library/catalogue", guard: "library.view_own", queryKeys: ["library.view_own"], role: "STUDENT" },
  { route: "/library/my", guard: "library.view_own", queryKeys: ["library.view_own"], role: "STUDENT" },
  // Admissions staff (ADMISSION_OFFICER, ADMIN)
  { route: "/admissions", guard: "admissions.applications.view", queryKeys: ["admissions.applications.view"], role: "ADMISSION_OFFICER" },
  { route: "/admissions", guard: "admissions.applications.view", queryKeys: ["admissions.applications.view"], role: "ADMIN" },
  { route: "/admissions/campaigns", guard: "admissions.applications.view", queryKeys: ["admissions.applications.view", "admissions.campaigns.manage"], role: "ADMISSION_OFFICER" },
  { route: "/admissions/applications/[id]", guard: "admissions.applications.view", queryKeys: ["admissions.applications.view", "admissions.applications.manage", "admissions.applications.review", "admissions.offers.manage", "admissions.enroll"], role: "ADMISSION_OFFICER" },
  // Applicant (APPLICANT)
  { route: "/admissions/my", guard: "admissions.view_own", queryKeys: ["admissions.view_own"], role: "APPLICANT" },
  { route: "/admissions/apply/[campaignId]", guard: "admissions.view_own", queryKeys: ["admissions.view_own"], role: "APPLICANT" },
  { route: "/admissions/my/[id]", guard: "admissions.view_own", queryKeys: ["admissions.view_own"], role: "APPLICANT" },
  // Faculty Management staff (ADMIN, HOD)
  ...(["ADMIN", "HOD"] as const).flatMap((role): PageAccessRow[] => [
    { route: "/faculty-mgmt", guard: "faculty.directory.view", queryKeys: ["faculty.directory.view"], role },
    { route: "/faculty-mgmt/[id]", guard: "faculty.directory.view", queryKeys: ["faculty.directory.view", "faculty.qualifications.manage", "faculty.workload.manage", "faculty.teaching_history.manage"], role },
    { route: "/faculty-mgmt/workload-policy", guard: "faculty.workload.manage", queryKeys: ["faculty.workload.manage"], role },
  ]),
  // Faculty self (FACULTY)
  { route: "/faculty-mgmt/me", guard: "faculty.view_own", queryKeys: ["faculty.view_own"], role: "FACULTY" },
  // HR staff (ADMIN, HR_MANAGER)
  ...(["ADMIN", "HR_MANAGER"] as const).flatMap((role): PageAccessRow[] => [
    { route: "/hr", guard: "hr.directory.view", queryKeys: ["hr.directory.view", "hr.employees.manage"], role },
    { route: "/hr/employees/[id]", guard: "hr.directory.view", queryKeys: ["hr.directory.view", "hr.employees.manage", "hr.contracts.manage", "hr.leave.manage", "hr.attendance.manage"], role },
    { route: "/hr/leave", guard: "hr.leave.manage", queryKeys: ["hr.leave.manage", "hr.directory.view"], role },
    { route: "/hr/leave/policies", guard: "hr.leave.manage", queryKeys: ["hr.leave.manage", "hr.directory.view"], role },
    { route: "/hr/attendance", guard: "hr.attendance.manage", queryKeys: ["hr.attendance.manage", "hr.directory.view"], role },
    { route: "/hr/attendance/shifts", guard: "hr.attendance.manage", queryKeys: ["hr.attendance.manage", "hr.directory.view"], role },
    { route: "/hr/reports", guard: "hr.reports.view", queryKeys: ["hr.reports.view"], role },
  ]),
  // HR self (EMPLOYEE)
  { route: "/hr/me", guard: "hr.view_own", queryKeys: ["hr.view_own"], role: "EMPLOYEE" },
];

// SectionNav items (every <Can permission> key used by the nav bars).
const SECTION_NAV_KEYS: { key: PermissionKey; role: string }[] = [
  { key: "library.books.view", role: "LIBRARIAN" },
  { key: "library.fines.manage", role: "LIBRARIAN" },
  { key: "library.view_own", role: "STUDENT" },
  { key: "admissions.applications.view", role: "ADMISSION_OFFICER" },
  ...FACULTY_STAFF_NAV.map((i) => ({ key: i.permission, role: "HOD" })),
  ...HR_STAFF_NAV.map((i) => ({ key: i.permission, role: "HR_MANAGER" })),
];

// AppShell NAV anyOf keys.
const NAV_KEYS: { key: PermissionKey; role: string }[] = [
  { key: "library.books.view", role: "LIBRARIAN" },
  { key: "library.view_own", role: "STUDENT" },
  { key: "admissions.applications.view", role: "ADMISSION_OFFICER" },
  { key: "admissions.view_own", role: "APPLICANT" },
  { key: "faculty.directory.view", role: "HOD" },
  { key: "faculty.view_own", role: "FACULTY" },
  { key: "hr.directory.view", role: "HR_MANAGER" },
  { key: "hr.view_own", role: "EMPLOYEE" },
];

describe("PAGE_ACCESS table", () => {
  it("has every guard and queryKey held by its role", () => {
    for (const row of PAGE_ACCESS) {
      const held = ROLE_PERMISSIONS[row.role] ?? [];
      expect(held, `${row.role} must hold guard ${row.guard} for ${row.route}`).toContain(row.guard);
      for (const key of row.queryKeys) {
        expect(held, `${row.role} must hold ${key} for ${row.route}`).toContain(key);
      }
    }
  });

  it("has every SectionNav and NAV key held by its role", () => {
    for (const { key, role } of [...SECTION_NAV_KEYS, ...NAV_KEYS]) {
      expect(ROLE_PERMISSIONS[role] ?? [], `${role} must hold ${key}`).toContain(key);
    }
  });

  it("ADMIN lacks library.view_own and admissions.view_own", () => {
    const admin = ROLE_PERMISSIONS.ADMIN ?? [];
    expect(admin).not.toContain("library.view_own");
    expect(admin).not.toContain("admissions.view_own");
  });

  it("STUDENT lacks library.books.view", () => {
    expect(ROLE_PERMISSIONS.STUDENT ?? []).not.toContain("library.books.view");
  });

  it("APPLICANT holds no staff admissions key", () => {
    const applicant = ROLE_PERMISSIONS.APPLICANT ?? [];
    const staffKeys: PermissionKey[] = [
      "admissions.campaigns.manage",
      "admissions.applications.view",
      "admissions.applications.manage",
      "admissions.applications.review",
      "admissions.offers.manage",
      "admissions.enroll",
    ];
    for (const key of staffKeys) expect(applicant).not.toContain(key);
  });

  it("every ADMIN SectionNav link key is held by ADMIN", () => {
    for (const item of [...FACULTY_STAFF_NAV, ...HR_STAFF_NAV]) {
      expect(ROLE_PERMISSIONS.ADMIN ?? [], `ADMIN must hold ${item.permission}`).toContain(item.permission);
    }
  });
  it("own-record keys are not held by staff roles", () => {
    expect(ROLE_PERMISSIONS.ADMIN ?? []).not.toContain("faculty.view_own");
    expect(ROLE_PERMISSIONS.ADMIN ?? []).not.toContain("hr.view_own");
    expect(ROLE_PERMISSIONS.HOD ?? []).not.toContain("faculty.view_own");
    expect(ROLE_PERMISSIONS.HR_MANAGER ?? []).not.toContain("hr.view_own");
  });
  it("FACULTY holds no faculty staff or hr key", () => {
    const faculty = ROLE_PERMISSIONS.FACULTY ?? [];
    for (const key of faculty) {
      expect(key.startsWith("hr."), `FACULTY must not hold ${key}`).toBe(false);
      expect(
        key.startsWith("faculty.") && key !== "faculty.view_own",
        `FACULTY must not hold ${key}`,
      ).toBe(false);
    }
  });
  it("HR_MANAGER holds no faculty key", () => {
    for (const key of ROLE_PERMISSIONS.HR_MANAGER ?? []) {
      expect(key.startsWith("faculty."), `HR_MANAGER must not hold ${key}`).toBe(false);
    }
  });
  it("EMPLOYEE lacks hr.directory.view", () => {
    expect(ROLE_PERMISSIONS.EMPLOYEE ?? []).not.toContain("hr.directory.view");
  });
  it("HOD holds no hr staff key", () => {
    for (const key of ROLE_PERMISSIONS.HOD ?? []) {
      expect(key.startsWith("hr."), `HOD must not hold ${key}`).toBe(false);
    }
  });
});
