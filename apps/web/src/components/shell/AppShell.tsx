"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Wallet, LogOut, ShieldCheck, type LucideIcon } from "lucide-react";
import type { ModuleKey, PermissionKey } from "@campusgate/shared";
import { useAuthStore } from "@/stores/auth";
import { connectSocket } from "@/lib/socket";
import { canAny } from "@/lib/authz";
import { useModuleActive } from "@/features/modules/useModuleActive";
import { NotificationBell } from "@/components/NotificationBell";
import { MfaEnrollment } from "@/components/MfaEnrollment";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  anyOf: PermissionKey[];
  module?: ModuleKey;
}

const NAV: NavItem[] = [
  {
    href: "/fees",
    label: "Fees",
    icon: Wallet,
    anyOf: ["fees.view", "fees.charges.manage", "fees.structures.manage", "fees.collect"],
    module: "fees",
  },
  {
    href: "/fees/me",
    label: "My Fees",
    icon: Wallet,
    anyOf: ["fees.view_own"],
    module: "fees",
  },
];

/** Returns whether a nav item should render, respecting permission + module state. */
function useNavItemVisible(item: NavItem, perms: string[]): boolean {
  // Hooks must run unconditionally; useModuleActive internally skips the probe
  // when there's no permitted probe path and returns "unknown".
  const moduleStatus = useModuleActive(item.module ?? "fees");
  if (!canAny(item.anyOf, perms)) return false;
  if (item.module && moduleStatus === "inactive") return false;
  return true;
}

function SidebarLink({
  item,
  perms,
  pathname,
}: {
  item: NavItem;
  perms: string[];
  pathname: string;
}) {
  const visible = useNavItemVisible(item, perms);
  if (!visible) return null;
  const isActive = pathname.startsWith(item.href);
  return (
    <Link
      href={item.href}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
        isActive ? "bg-primary-50 text-primary-700" : "text-gray-600 hover:bg-gray-100"
      }`}
    >
      <item.icon className="w-5 h-5" />
      {item.label}
    </Link>
  );
}

function MobileLink({
  item,
  perms,
  pathname,
}: {
  item: NavItem;
  perms: string[];
  pathname: string;
}) {
  const visible = useNavItemVisible(item, perms);
  if (!visible) return null;
  const isActive = pathname.startsWith(item.href);
  return (
    <Link
      href={item.href}
      className={`flex flex-col items-center gap-1 px-3 py-1 rounded-lg ${
        isActive ? "bg-primary-50 text-primary-700" : "text-gray-500"
      }`}
    >
      <item.icon className="w-5 h-5" />
      <span className="text-xs">{item.label}</span>
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  const roles = useAuthStore((s) => s.roles);
  const permissions = useAuthStore((s) => s.permissions);
  const logout = useAuthStore((s) => s.logout);
  const [mfaOpen, setMfaOpen] = useState(false);

  useEffect(() => {
    connectSocket();
  }, []);

  const handleLogout = () => {
    logout();
    router.replace("/login");
  };

  const roleBadge = roles[0]; // coarse display label only — order-dependent, never an auth input

  return (
    <div className="min-h-screen bg-gray-50 pb-20 md:pb-0 md:pl-64">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex md:flex-col md:fixed md:inset-y-0 md:left-0 md:w-64 bg-white border-r border-gray-200">
        <div className="p-6">
          <h1 className="text-xl font-bold text-primary-800">CAMPUSGATE</h1>
          <p className="text-xs text-gray-500 mt-1">Institution</p>
        </div>

        <nav className="flex-1 px-3 space-y-1">
          {NAV.map((item) => (
            <SidebarLink key={item.href} item={item} perms={permissions} pathname={pathname} />
          ))}
        </nav>

        <div className="p-4 border-t border-gray-200">
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 text-sm text-gray-600 hover:text-danger-600 transition-colors w-full"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-50">
        <div className="flex justify-around items-center py-2">
          {NAV.map((item) => (
            <MobileLink key={item.href} item={item} perms={permissions} pathname={pathname} />
          ))}
        </div>
      </nav>

      {/* Top bar */}
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-2 flex items-center justify-between gap-3">
        <span className="md:hidden font-bold text-primary-800">CAMPUSGATE</span>
        <span className="hidden md:block text-sm text-gray-500">Institution</span>
        <div className="flex items-center gap-3">
          {user && (
            <div className="hidden sm:flex items-center gap-2">
              <span className="text-sm text-gray-700">{user.email}</span>
              {roleBadge && (
                <span className="rounded-full bg-primary-50 text-primary-700 text-xs font-medium px-2 py-0.5">
                  {roleBadge}
                </span>
              )}
            </div>
          )}
          <NotificationBell />
          <button
            onClick={() => setMfaOpen(true)}
            className="flex items-center gap-1 text-sm text-gray-600 hover:text-primary-700 transition-colors"
            aria-label="Set up two-factor authentication"
          >
            <ShieldCheck className="w-5 h-5" />
            <span className="hidden md:inline">MFA</span>
          </button>
        </div>
      </header>

      {/* Main content */}
      <main className="p-4 md:p-8">{children}</main>

      <MfaEnrollment open={mfaOpen} onClose={() => setMfaOpen(false)} />
    </div>
  );
}
