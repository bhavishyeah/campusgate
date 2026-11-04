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
