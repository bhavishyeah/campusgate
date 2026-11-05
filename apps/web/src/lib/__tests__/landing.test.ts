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
    expect(landingRoute(["FACULTY"], [...(ROLE_PERMISSIONS.FACULTY ?? [])])).toBe("/faculty-mgmt/me");
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

  // ── 3d. Hostel / Transport landings ──
  it("sends the real WARDEN permissions to /hostel", () => {
    expect(landingRoute(["WARDEN"], [...(ROLE_PERMISSIONS.WARDEN ?? [])])).toBe("/hostel");
  });
  it("sends the real TRANSPORT_MANAGER permissions to /transport", () => {
    expect(landingRoute(["TRANSPORT_MANAGER"], [...(ROLE_PERMISSIONS.TRANSPORT_MANAGER ?? [])])).toBe("/transport");
  });
  it("prefers /hostel when both staff keys are held", () => {
    expect(landingRoute([], ["transport.view", "hostel.view"])).toBe("/hostel");
  });
  it("sends non-legacy own-key holders to the self pages", () => {
    expect(landingRoute(["PARENT"], ["hostel.view_own"])).toBe("/hostel/me");
    expect(landingRoute(["PARENT"], ["transport.view_own"])).toBe("/transport/me");
    expect(landingRoute([], ["hostel.view_own", "transport.view_own"])).toBe("/hostel/me");
  });
  it("keeps STUDENT on /student and ADMIN on /admin with the real permissions", () => {
    expect(landingRoute(["STUDENT"], [...(ROLE_PERMISSIONS.STUDENT ?? [])])).toBe("/student");
    expect(landingRoute(["ADMIN"], [...(ROLE_PERMISSIONS.ADMIN ?? [])])).toBe("/admin");
  });
  it("keeps earlier landings ahead of hostel/transport", () => {
    expect(landingRoute(["ACCOUNTANT"], ["fees.view", "hostel.view"])).toBe("/fees");
    expect(landingRoute(["LIBRARIAN"], ["library.books.view", "transport.view"])).toBe("/library");
    expect(landingRoute([], ["hr.directory.view", "hostel.view"])).toBe("/hr");
    expect(landingRoute([], ["faculty.view_own", "hostel.view"])).toBe("/faculty-mgmt/me");
  });
  it("falls back to /app for a holder of only hostel.allocations.manage", () => {
    expect(landingRoute([], ["hostel.allocations.manage"])).toBe("/app");
  });

  // ── 3e. Inventory / Service Requests landings ──
  it("sends the real INVENTORY_MANAGER permissions to /inventory", () => {
    expect(landingRoute(["INVENTORY_MANAGER"], [...(ROLE_PERMISSIONS.INVENTORY_MANAGER ?? [])])).toBe("/inventory");
  });
  it("sends the real SERVICE_AGENT permissions to /service-requests", () => {
    expect(landingRoute(["SERVICE_AGENT"], [...(ROLE_PERMISSIONS.SERVICE_AGENT ?? [])])).toBe("/service-requests");
  });
  it("prefers /inventory when both inventory.view and service_requests.view are held", () => {
    expect(landingRoute([], ["service_requests.view", "inventory.view"])).toBe("/inventory");
  });
  it("sends non-legacy own/self-only holders to the self pages", () => {
    expect(landingRoute(["PARENT"], ["inventory.view_own"])).toBe("/inventory/me");
    expect(landingRoute(["PARENT"], ["service_requests.request_own"])).toBe("/service-requests/me");
  });
  it("keeps STUDENT on /student even holding service_requests.request_own (real perms)", () => {
    expect(landingRoute(["STUDENT"], [...(ROLE_PERMISSIONS.STUDENT ?? [])])).toBe("/student");
  });
  it("keeps ADMIN on /admin even holding all inventory + service_requests staff keys", () => {
    expect(landingRoute(["ADMIN"], [...(ROLE_PERMISSIONS.ADMIN ?? [])])).toBe("/admin");
  });
  it("keeps earlier landings ahead of inventory/service_requests", () => {
    expect(landingRoute(["ACCOUNTANT"], ["fees.view", "inventory.view"])).toBe("/fees");
    expect(landingRoute(["LIBRARIAN"], ["library.books.view", "service_requests.view"])).toBe("/library");
    expect(landingRoute([], ["hr.directory.view", "inventory.view"])).toBe("/hr");
    expect(landingRoute([], ["faculty.view_own", "service_requests.view"])).toBe("/faculty-mgmt/me");
    expect(landingRoute(["WARDEN"], ["hostel.view", "inventory.view"])).toBe("/hostel");
    expect(landingRoute(["TRANSPORT_MANAGER"], ["transport.view", "service_requests.view"])).toBe("/transport");
  });
  it("falls back to /app for a holder of only inventory.assets.manage (no inventory.view)", () => {
    expect(landingRoute([], ["inventory.assets.manage"])).toBe("/app");
  });

  // ── 3f. Documents landings (APPEND-only; no existing role's landing changes) ──
  it("sends the real DOCUMENT_MANAGER permissions to /documents", () => {
    expect(landingRoute(["DOCUMENT_MANAGER"], [...(ROLE_PERMISSIONS.DOCUMENT_MANAGER ?? [])])).toBe("/documents");
  });
  it("sends a bare documents.admin.view_all holder to /documents", () => {
    expect(landingRoute([], ["documents.admin.view_all"])).toBe("/documents");
  });
  it("sends a bare documents.view_own holder to /documents", () => {
    expect(landingRoute([], ["documents.view_own"])).toBe("/documents");
  });
  it("does NOT land on /documents for the baseline documents.download key alone", () => {
    expect(landingRoute([], ["documents.download"])).toBe("/app");
  });
  it("keeps every existing role's landing unchanged by the documents block", () => {
    // FACULTY holds documents.view_own but is resolved earlier (3c) to its faculty home.
    expect(landingRoute(["FACULTY"], [...(ROLE_PERMISSIONS.FACULTY ?? [])])).toBe("/faculty-mgmt/me");
    expect(landingRoute(["STUDENT"], [...(ROLE_PERMISSIONS.STUDENT ?? [])])).toBe("/student");
    expect(landingRoute(["ADMIN"], [...(ROLE_PERMISSIONS.ADMIN ?? [])])).toBe("/admin");
    // ACCOUNTANT carries the baseline documents.download yet stays on /fees.
    expect(landingRoute(["ACCOUNTANT"], ["fees.view", "documents.download"])).toBe("/fees");
  });
});