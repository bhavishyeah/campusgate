import { describe, it, expect } from "vitest";
import { ROLE_PERMISSIONS, type PermissionKey } from "@campusgate/shared";
import {
  DOCUMENTS_STAFF_NAV,
  FACULTY_STAFF_NAV,
  HOSTEL_STAFF_NAV,
  HR_STAFF_NAV,
  INVENTORY_STAFF_NAV,
  SERVICE_REQUESTS_STAFF_NAV,
  TRANSPORT_STAFF_NAV,
} from "@/components/ui-ext/SectionNav";

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
  // Hostel staff (ADMIN, WARDEN)
  ...(["ADMIN", "WARDEN"] as const).flatMap((role): PageAccessRow[] => [
    { route: "/hostel", guard: "hostel.view", queryKeys: ["hostel.view"], role },
    { route: "/hostel/buildings", guard: "hostel.view", queryKeys: ["hostel.view", "hostel.buildings.manage"], role },
    { route: "/hostel/rooms", guard: "hostel.view", queryKeys: ["hostel.view", "hostel.buildings.manage"], role },
    { route: "/hostel/allocations", guard: "hostel.view", queryKeys: ["hostel.view", "hostel.allocations.manage"], role },
    { route: "/hostel/check-events", guard: "hostel.view", queryKeys: ["hostel.view"], role },
    { route: "/hostel/leave", guard: "hostel.view", queryKeys: ["hostel.view", "hostel.leave.manage"], role },
    { route: "/hostel/maintenance", guard: "hostel.view", queryKeys: ["hostel.view", "hostel.maintenance.manage"], role },
  ]),
  // Hostel self (STUDENT)
  { route: "/hostel/me", guard: "hostel.view_own", queryKeys: ["hostel.view_own"], role: "STUDENT" },
  // Transport staff (ADMIN, TRANSPORT_MANAGER)
  ...(["ADMIN", "TRANSPORT_MANAGER"] as const).flatMap((role): PageAccessRow[] => [
    { route: "/transport", guard: "transport.view", queryKeys: ["transport.view", "transport.routes.manage"], role },
    { route: "/transport/routes/[id]", guard: "transport.view", queryKeys: ["transport.view", "transport.routes.manage", "transport.assignments.manage"], role },
    { route: "/transport/vehicles", guard: "transport.view", queryKeys: ["transport.view", "transport.vehicles.manage"], role },
    { route: "/transport/drivers", guard: "transport.view", queryKeys: ["transport.view", "transport.drivers.manage"], role },
    { route: "/transport/enrollments", guard: "transport.view", queryKeys: ["transport.view", "transport.enrollments.manage"], role },
    { route: "/transport/maintenance", guard: "transport.view", queryKeys: ["transport.view", "transport.maintenance.manage"], role },
    { route: "/transport/reports", guard: "transport.view", queryKeys: ["transport.view"], role },
  ]),
  // Transport self (STUDENT)
  { route: "/transport/me", guard: "transport.view_own", queryKeys: ["transport.view_own"], role: "STUDENT" },
  // Inventory staff (ADMIN, INVENTORY_MANAGER)
  ...(["ADMIN", "INVENTORY_MANAGER"] as const).flatMap((role): PageAccessRow[] => [
    { route: "/inventory", guard: "inventory.view", queryKeys: ["inventory.view"], role },
    { route: "/inventory/categories", guard: "inventory.view", queryKeys: ["inventory.view", "inventory.categories.manage"], role },
    { route: "/inventory/assets", guard: "inventory.view", queryKeys: ["inventory.view", "inventory.assets.manage"], role },
    { route: "/inventory/assets/[id]", guard: "inventory.view", queryKeys: ["inventory.view", "inventory.assets.manage", "inventory.maintenance.manage", "inventory.disposals.manage", "inventory.stock.manage"], role },
    { route: "/inventory/maintenance", guard: "inventory.view", queryKeys: ["inventory.view", "inventory.maintenance.manage"], role },
    { route: "/inventory/stock", guard: "inventory.view", queryKeys: ["inventory.view"], role },
    { route: "/inventory/stock/[assetId]", guard: "inventory.view", queryKeys: ["inventory.view", "inventory.stock.manage"], role },
    { route: "/inventory/audits", guard: "inventory.view", queryKeys: ["inventory.view", "inventory.audits.manage"], role },
    { route: "/inventory/audits/[id]", guard: "inventory.view", queryKeys: ["inventory.view", "inventory.audits.manage"], role },
    { route: "/inventory/reports", guard: "inventory.view", queryKeys: ["inventory.view"], role },
  ]),
  // Inventory self (INVENTORY_MANAGER only — ADMIN excluded by design)
  { route: "/inventory/me", guard: "inventory.view_own", queryKeys: ["inventory.view_own"], role: "INVENTORY_MANAGER" },
  // Service Requests staff (ADMIN, SERVICE_AGENT)
  ...(["ADMIN", "SERVICE_AGENT"] as const).flatMap((role): PageAccessRow[] => [
    { route: "/service-requests", guard: "service_requests.view", queryKeys: ["service_requests.view"], role },
    { route: "/service-requests/[id]", guard: "service_requests.view", queryKeys: ["service_requests.view", "service_requests.assign.manage", "service_requests.requests.handle", "service_requests.requests.approve"], role },
    { route: "/service-requests/types", guard: "service_requests.view", queryKeys: ["service_requests.view", "service_requests.types.manage"], role },
    { route: "/service-requests/types/[id]", guard: "service_requests.view", queryKeys: ["service_requests.view", "service_requests.types.manage"], role },
    { route: "/service-requests/reports", guard: "service_requests.view", queryKeys: ["service_requests.view"], role },
  ]),
  // Service Requests self (STUDENT)
  { route: "/service-requests/me", guard: "service_requests.request_own", queryKeys: ["service_requests.request_own"], role: "STUDENT" },
  { route: "/service-requests/me/[id]", guard: "service_requests.request_own", queryKeys: ["service_requests.request_own"], role: "STUDENT" },
  { route: "/service-requests/raise", guard: "service_requests.request_own", queryKeys: ["service_requests.request_own"], role: "STUDENT" },
  // Documents — single-key-guarded staff pages (DOCUMENT_MANAGER, ADMIN).
  ...(["DOCUMENT_MANAGER", "ADMIN"] as const).flatMap((role): PageAccessRow[] => [
    { route: "/documents/retention-policies", guard: "documents.retention.manage", queryKeys: ["documents.retention.manage"], role },
    { route: "/documents/report", guard: "documents.admin.view_all", queryKeys: ["documents.admin.view_all"], role },
    { route: "/documents/[id]/access-log", guard: "documents.audit.view", queryKeys: ["documents.audit.view"], role },
  ]),
  // Documents list/detail — OR-gated (self-rendered NoAccess, no single-key guard).
  // Each row asserts the role holds ONE of the coarse OR keys it reaches the page with.
  { route: "/documents", guard: "documents.view_own", queryKeys: ["documents.view_own"], role: "FACULTY" },
  { route: "/documents", guard: "documents.admin.view_all", queryKeys: ["documents.admin.view_all"], role: "DOCUMENT_MANAGER" },
  { route: "/documents", guard: "documents.admin.view_all", queryKeys: ["documents.admin.view_all"], role: "ADMIN" },
  { route: "/documents/[id]", guard: "documents.view_own", queryKeys: ["documents.view_own"], role: "FACULTY" },
  { route: "/documents/[id]", guard: "documents.admin.view_all", queryKeys: ["documents.admin.view_all"], role: "DOCUMENT_MANAGER" },
  // A grantee role reaches the detail via the baseline download key.
  { route: "/documents/[id]", guard: "documents.download", queryKeys: ["documents.download"], role: "WARDEN" },
];

// SectionNav items (every <Can permission> key used by the nav bars).
const SECTION_NAV_KEYS: { key: PermissionKey; role: string }[] = [
  { key: "library.books.view", role: "LIBRARIAN" },
  { key: "library.fines.manage", role: "LIBRARIAN" },
  { key: "library.view_own", role: "STUDENT" },
  { key: "admissions.applications.view", role: "ADMISSION_OFFICER" },
  ...FACULTY_STAFF_NAV.map((i) => ({ key: i.permission, role: "HOD" })),
  ...HR_STAFF_NAV.map((i) => ({ key: i.permission, role: "HR_MANAGER" })),
  ...HOSTEL_STAFF_NAV.map((i) => ({ key: i.permission, role: "WARDEN" })),
  ...TRANSPORT_STAFF_NAV.map((i) => ({ key: i.permission, role: "TRANSPORT_MANAGER" })),
  ...INVENTORY_STAFF_NAV.map((i) => ({ key: i.permission, role: "INVENTORY_MANAGER" })),
  ...SERVICE_REQUESTS_STAFF_NAV.map((i) => ({ key: i.permission, role: "SERVICE_AGENT" })),
  // Documents section nav: the Documents (view_own) tab is the FACULTY owner tab;
  // the Retention/Report tabs belong to DOCUMENT_MANAGER (which lacks view_own).
  ...DOCUMENTS_STAFF_NAV.map((i) => ({
    key: i.permission,
    role: i.permission === "documents.view_own" ? "FACULTY" : "DOCUMENT_MANAGER",
  })),
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
  { key: "hostel.view", role: "WARDEN" },
  { key: "hostel.view_own", role: "STUDENT" },
  { key: "transport.view", role: "TRANSPORT_MANAGER" },
  { key: "transport.view_own", role: "STUDENT" },
  { key: "inventory.view", role: "INVENTORY_MANAGER" },
  { key: "inventory.view_own", role: "INVENTORY_MANAGER" },
  { key: "service_requests.view", role: "SERVICE_AGENT" },
  { key: "service_requests.request_own", role: "STUDENT" },
  // Documents AppShell nav anyOf keys.
  { key: "documents.view_own", role: "FACULTY" },
  { key: "documents.admin.view_all", role: "DOCUMENT_MANAGER" },
  { key: "documents.retention.manage", role: "DOCUMENT_MANAGER" },
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
    for (const item of [...FACULTY_STAFF_NAV, ...HR_STAFF_NAV, ...HOSTEL_STAFF_NAV, ...TRANSPORT_STAFF_NAV]) {
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

  it("ADMIN lacks the hostel and transport own keys", () => {
    expect(ROLE_PERMISSIONS.ADMIN ?? []).not.toContain("hostel.view_own");
    expect(ROLE_PERMISSIONS.ADMIN ?? []).not.toContain("transport.view_own");
  });
  it("WARDEN lacks every transport key and hostel.view_own", () => {
    const held = ROLE_PERMISSIONS.WARDEN ?? [];
    expect(held).not.toContain("hostel.view_own");
    for (const key of held) expect(key.startsWith("transport."), `WARDEN must not hold ${key}`).toBe(false);
  });
  it("TRANSPORT_MANAGER lacks every hostel key and transport.view_own", () => {
    const held = ROLE_PERMISSIONS.TRANSPORT_MANAGER ?? [];
    expect(held).not.toContain("transport.view_own");
    for (const key of held) expect(key.startsWith("hostel."), `TRANSPORT_MANAGER must not hold ${key}`).toBe(false);
  });
  it("STUDENT holds only the two own keys of hostel/transport", () => {
    const keys = (ROLE_PERMISSIONS.STUDENT ?? []).filter((k) => k.startsWith("hostel.") || k.startsWith("transport."));
    expect([...keys].sort()).toEqual(["hostel.view_own", "transport.view_own"]);
  });
  it("other roles hold no hostel or transport key", () => {
    for (const role of ["HOD", "FACULTY", "ACCOUNTANT", "LIBRARIAN", "HR_MANAGER", "EMPLOYEE", "ADMISSION_OFFICER", "APPLICANT"]) {
      for (const key of ROLE_PERMISSIONS[role] ?? []) {
        expect(key.startsWith("hostel.") || key.startsWith("transport."), `${role} must not hold ${key}`).toBe(false);
      }
    }
  });

  it("ADMIN lacks inventory.view_own and service_requests.request_own", () => {
    const admin = ROLE_PERMISSIONS.ADMIN ?? [];
    expect(admin).not.toContain("inventory.view_own");
    expect(admin).not.toContain("service_requests.request_own");
  });
  it("INVENTORY_MANAGER holds no service_requests key", () => {
    for (const key of ROLE_PERMISSIONS.INVENTORY_MANAGER ?? []) {
      expect(key.startsWith("service_requests."), `INVENTORY_MANAGER must not hold ${key}`).toBe(false);
    }
  });
  it("SERVICE_AGENT holds no inventory key and no request_own", () => {
    const held = ROLE_PERMISSIONS.SERVICE_AGENT ?? [];
    expect(held).not.toContain("service_requests.request_own");
    for (const key of held) expect(key.startsWith("inventory."), `SERVICE_AGENT must not hold ${key}`).toBe(false);
  });
  it("STUDENT holds no inventory/service-request key other than request_own", () => {
    const keys = (ROLE_PERMISSIONS.STUDENT ?? []).filter((k) => k.startsWith("inventory.") || k.startsWith("service_requests."));
    expect([...keys].sort()).toEqual(["service_requests.request_own"]);
  });
  it("other roles hold no inventory or service_requests key", () => {
    for (const role of ["HOD", "FACULTY", "ACCOUNTANT", "LIBRARIAN", "WARDEN", "TRANSPORT_MANAGER", "HR_MANAGER", "EMPLOYEE"]) {
      for (const key of ROLE_PERMISSIONS[role] ?? []) {
        expect(key.startsWith("inventory.") || key.startsWith("service_requests."), `${role} must not hold ${key}`).toBe(false);
      }
    }
  });
  it("every ADMIN inventory/service-request SectionNav key is held by ADMIN", () => {
    for (const item of [...INVENTORY_STAFF_NAV, ...SERVICE_REQUESTS_STAFF_NAV]) {
      expect(ROLE_PERMISSIONS.ADMIN ?? [], `ADMIN must hold ${item.permission}`).toContain(item.permission);
    }
  });
});