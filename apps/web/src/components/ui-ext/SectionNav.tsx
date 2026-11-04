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
