import { describe, it, expect } from "vitest";
import { ROLE_PERMISSIONS, type PermissionKey } from "@campusgate/shared";

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
];

// SectionNav items (every <Can permission> key used by the nav bars).
const SECTION_NAV_KEYS: { key: PermissionKey; role: string }[] = [
  { key: "library.books.view", role: "LIBRARIAN" },
  { key: "library.fines.manage", role: "LIBRARIAN" },
  { key: "library.view_own", role: "STUDENT" },
  { key: "admissions.applications.view", role: "ADMISSION_OFFICER" },
];

// AppShell NAV anyOf keys.
const NAV_KEYS: { key: PermissionKey; role: string }[] = [
  { key: "library.books.view", role: "LIBRARIAN" },
  { key: "library.view_own", role: "STUDENT" },
  { key: "admissions.applications.view", role: "ADMISSION_OFFICER" },
  { key: "admissions.view_own", role: "APPLICANT" },
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
});
