"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { PermissionKey } from "@campusgate/shared";
import { Can } from "@/components/auth/Can";

export interface SectionNavItem {
  href: string;
  label: string;
  permission: PermissionKey;
}

function isActive(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  if (href === "/library" && pathname.startsWith("/library/titles")) return true;
  if (href === "/admissions" && pathname.startsWith("/admissions/applications")) return true;
  if (
    href === "/faculty-mgmt" &&
    pathname.startsWith("/faculty-mgmt/") &&
    !pathname.startsWith("/faculty-mgmt/workload-policy") &&
    !pathname.startsWith("/faculty-mgmt/me")
  ) {
    return true;
  }
  if (href === "/hr" && pathname.startsWith("/hr/employees")) return true;
  // Route detail pages belong to the Routes tab; /hostel is exact-only (every other page has its own link).
  if (href === "/transport" && pathname.startsWith("/transport/routes")) return true;
  // Inventory: each section tab matches its own detail routes.
  if (href === "/inventory/assets" && pathname.startsWith("/inventory/assets/")) return true;
  if (href === "/inventory/stock" && pathname.startsWith("/inventory/stock/")) return true;
  if (href === "/inventory/audits" && pathname.startsWith("/inventory/audits/")) return true;
  // Service Requests: the Queue tab owns the triage detail; Types owns its field-config detail.
  if (
    href === "/service-requests" &&
    pathname.startsWith("/service-requests/") &&
    !pathname.startsWith("/service-requests/types") &&
    !pathname.startsWith("/service-requests/reports") &&
    !pathname.startsWith("/service-requests/me") &&
    !pathname.startsWith("/service-requests/raise")
  ) {
    return true;
  }
  if (href === "/service-requests/types" && pathname.startsWith("/service-requests/types/")) return true;
  // Documents: the Documents tab owns the detail + access-log routes; Retention and Report own their own.
  if (
    href === "/documents" &&
    pathname.startsWith("/documents/") &&
    !pathname.startsWith("/documents/retention-policies") &&
    !pathname.startsWith("/documents/report")
  ) {
    return true;
  }
  return false;
}

export function SectionNav({ items }: { items: SectionNavItem[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Section" className="flex flex-wrap gap-2">
      {items.map((item) => (
        <Can key={item.href} permission={item.permission}>
          <Link
            href={item.href}
            aria-current={isActive(pathname, item.href) ? "page" : undefined}
            className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
              isActive(pathname, item.href)
                ? "bg-primary-600 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {item.label}
          </Link>
        </Can>
      ))}
    </nav>
  );
}

export const LIBRARY_STAFF_NAV: SectionNavItem[] = [
  { href: "/library", label: "Titles", permission: "library.books.view" },
  { href: "/library/circulation", label: "Circulation", permission: "library.books.view" },
  { href: "/library/reservations", label: "Reservations", permission: "library.books.view" },
  { href: "/library/fines", label: "Fines", permission: "library.fines.manage" },
];

export const LIBRARY_STUDENT_NAV: SectionNavItem[] = [
  { href: "/library/catalogue", label: "Browse catalogue", permission: "library.view_own" },
  { href: "/library/my", label: "My library", permission: "library.view_own" },
];

export const ADMISSIONS_STAFF_NAV: SectionNavItem[] = [
  { href: "/admissions", label: "Applications", permission: "admissions.applications.view" },
  { href: "/admissions/campaigns", label: "Campaigns", permission: "admissions.applications.view" },
];

export const FACULTY_STAFF_NAV: SectionNavItem[] = [
  { href: "/faculty-mgmt", label: "Directory", permission: "faculty.directory.view" },
  { href: "/faculty-mgmt/workload-policy", label: "Workload policy", permission: "faculty.workload.manage" },
];

export const HR_STAFF_NAV: SectionNavItem[] = [
  { href: "/hr", label: "Employees", permission: "hr.directory.view" },
  { href: "/hr/leave", label: "Leave requests", permission: "hr.leave.manage" },
  { href: "/hr/leave/policies", label: "Leave policies", permission: "hr.leave.manage" },
  { href: "/hr/attendance", label: "Attendance", permission: "hr.attendance.manage" },
  { href: "/hr/attendance/shifts", label: "Shifts", permission: "hr.attendance.manage" },
  { href: "/hr/reports", label: "Reports", permission: "hr.reports.view" },
];

export const HOSTEL_STAFF_NAV: SectionNavItem[] = [
  { href: "/hostel", label: "Overview", permission: "hostel.view" },
  { href: "/hostel/buildings", label: "Buildings", permission: "hostel.view" },
  { href: "/hostel/rooms", label: "Rooms", permission: "hostel.view" },
  { href: "/hostel/allocations", label: "Allocations", permission: "hostel.view" },
  { href: "/hostel/check-events", label: "Check-in/out", permission: "hostel.view" },
  { href: "/hostel/leave", label: "Leave", permission: "hostel.view" },
  { href: "/hostel/maintenance", label: "Maintenance", permission: "hostel.view" },
];

export const TRANSPORT_STAFF_NAV: SectionNavItem[] = [
  { href: "/transport", label: "Routes", permission: "transport.view" },
  { href: "/transport/vehicles", label: "Vehicles", permission: "transport.view" },
  { href: "/transport/drivers", label: "Drivers", permission: "transport.view" },
  { href: "/transport/enrollments", label: "Enrollments", permission: "transport.view" },
  { href: "/transport/maintenance", label: "Maintenance", permission: "transport.view" },
  { href: "/transport/reports", label: "Reports", permission: "transport.view" },
];

export const INVENTORY_STAFF_NAV: SectionNavItem[] = [
  { href: "/inventory", label: "Overview", permission: "inventory.view" },
  { href: "/inventory/categories", label: "Categories", permission: "inventory.view" },
  { href: "/inventory/assets", label: "Assets", permission: "inventory.view" },
  { href: "/inventory/maintenance", label: "Maintenance", permission: "inventory.view" },
  { href: "/inventory/stock", label: "Stock", permission: "inventory.view" },
  { href: "/inventory/audits", label: "Audits", permission: "inventory.view" },
  { href: "/inventory/reports", label: "Reports", permission: "inventory.view" },
];

export const SERVICE_REQUESTS_STAFF_NAV: SectionNavItem[] = [
  { href: "/service-requests", label: "Queue", permission: "service_requests.view" },
  { href: "/service-requests/types", label: "Types", permission: "service_requests.view" },
  { href: "/service-requests/reports", label: "Reports", permission: "service_requests.view" },
];

export const DOCUMENTS_STAFF_NAV: SectionNavItem[] = [
  { href: "/documents", label: "Documents", permission: "documents.view_own" },
  { href: "/documents/retention-policies", label: "Retention", permission: "documents.retention.manage" },
  { href: "/documents/report", label: "Report", permission: "documents.admin.view_all" },
];
