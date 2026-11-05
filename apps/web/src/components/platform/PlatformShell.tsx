"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Building2,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  ScrollText,
  ShieldCheck,
} from "lucide-react";
import { useAuthStore } from "@/stores/auth";
import { MfaEnrollment } from "@/components/MfaEnrollment";

interface NavLink {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV_LINKS: NavLink[] = [
  { href: "/platform", label: "Dashboard", icon: LayoutDashboard },
  { href: "/platform/institutions", label: "Institutions", icon: Building2 },
  { href: "/platform/support-grants", label: "Support grants", icon: LifeBuoy },
  { href: "/platform/audit", label: "Audit", icon: ScrollText },
];

function isActive(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  // The Dashboard link is exact-only; every deeper route owns its own section.
  if (href === "/platform") return false;
  return pathname.startsWith(`${href}/`) || pathname.startsWith(`${href}?`);
}

/**
 * Chrome for the platform (super-admin) surface. Deliberately NOT the tenant
 * AppShell — no module probes, no tenant nav. A light header, a side nav, an
 * Enable-MFA entry, and Sign out.
 */
export function PlatformShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const logout = useAuthStore((s) => s.logout);
  const [showMfa, setShowMfa] = useState(false);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3">
        <h1 className="text-sm font-bold text-primary-800">
          CAMPUSGATE Platform / Super Admin
        </h1>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => setShowMfa(true)}
            className="flex items-center gap-2 text-sm text-gray-600 hover:text-primary-700"
          >
            <ShieldCheck className="h-4 w-4" />
            Enable MFA
          </button>
          <button
            type="button"
            onClick={() => {
              logout();
              router.replace("/login");
            }}
            className="flex items-center gap-2 text-sm text-gray-600 hover:text-danger-600"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </header>
      <div className="mx-auto flex max-w-7xl gap-6 p-4 md:p-8">
        <nav aria-label="Platform" className="w-48 shrink-0 space-y-1">
          {NAV_LINKS.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ${
                  active
                    ? "bg-primary-50 text-primary-800"
                    : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            );
          })}
        </nav>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
      <MfaEnrollment open={showMfa} onClose={() => setShowMfa(false)} />
    </div>
  );
}
