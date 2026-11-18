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
import { SidebarToggle } from "@/components/shell/SidebarToggle";
import { useSidebarCollapsed } from "@/components/shell/useSidebarCollapsed";
import { SIDEBAR_ID } from "@/components/shell/sidebarState";

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
  const { collapsed, toggle } = useSidebarCollapsed();

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
            aria-label="Enable MFA"
            className="flex items-center gap-2 text-sm text-gray-600 hover:text-primary-700"
          >
            <ShieldCheck className="h-4 w-4" />
            <span className="hidden sm:inline">Enable MFA</span>
          </button>
          <button
            type="button"
            onClick={() => {
              logout();
              router.replace("/login");
            }}
            aria-label="Sign out"
            className="flex items-center gap-2 text-sm text-gray-600 hover:text-danger-600"
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </header>
      <div className="mx-auto flex max-w-7xl flex-col gap-3 p-4 md:flex-row md:gap-6 md:p-8">
        <nav
          id={SIDEBAR_ID}
          aria-label="Platform"
          className={`flex gap-1 overflow-x-auto md:block md:shrink-0 md:space-y-1 md:overflow-visible transition-[width] duration-200 ${
            collapsed ? "md:w-12" : "md:w-48"
          }`}
        >
          <div className={`hidden md:flex ${collapsed ? "justify-center" : "justify-end"}`}>
            <SidebarToggle collapsed={collapsed} onToggle={toggle} />
          </div>
          {NAV_LINKS.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                title={collapsed ? label : undefined}
                aria-label={collapsed ? label : undefined}
                className={`flex min-h-[44px] shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 md:min-h-0 ${
                  collapsed ? "md:justify-center md:px-0" : ""
                } ${
                  active
                    ? "bg-primary-50 text-primary-800"
                    : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className={collapsed ? "md:hidden" : ""}>{label}</span>
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
