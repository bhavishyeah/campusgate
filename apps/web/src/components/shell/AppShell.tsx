"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { GATE_PASS_NAV, NAV, type NavItem } from "./navItems";
import { useNavItemVisible } from "./ModuleLinks";
import { SidebarFooter, SidebarHeader, SidebarNavLink } from "./SidebarParts";
import { MobileTabBar } from "./MobileMoreSheet";
import { useSidebarCollapsed } from "./useSidebarCollapsed";
import { SIDEBAR_ID, contentOffsetClass, sidebarWidthClass } from "./sidebarState";
import { useAuthStore } from "@/stores/auth";
import { connectSocket } from "@/lib/socket";
import { NotificationBell } from "@/components/NotificationBell";
import { PushPrompt } from "@/components/push/PushPrompt";
import { MfaEnrollment } from "@/components/MfaEnrollment";
/** Gate Pass home links first (visible only to their legacy role), then the module NAV. */
const SHELL_NAV: NavItem[] = [...GATE_PASS_NAV, ...NAV];
function SidebarLink({
  item,
  perms,
  pathname,
  collapsed,
}: {
  item: NavItem;
  perms: string[];
  pathname: string;
  collapsed: boolean;
}) {
  const visible = useNavItemVisible(item, perms);
  if (!visible) return null;
  return (
    <SidebarNavLink
      href={item.href}
      label={item.label}
      icon={item.icon}
      active={pathname.startsWith(item.href)}
      collapsed={collapsed}
    />
  );
}
/** Bottom-bar tab for a Gate Pass home link (the full list lives in the More sheet). */
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
      className={`flex flex-col items-center justify-center gap-1 min-h-[44px] min-w-[44px] px-3 py-1 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
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
  const { collapsed, toggle } = useSidebarCollapsed();
  useEffect(() => {
    connectSocket();
  }, []);
  const handleLogout = () => {
    logout();
    router.replace("/login");
  };
  const roleBadge = roles[0]; // coarse display label only — order-dependent, never an auth input
  return (
    <div className={`min-h-screen bg-gray-50 pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-0 transition-[padding] duration-200 ${contentOffsetClass(collapsed)}`}>
      {/* Desktop sidebar */}
      <aside id={SIDEBAR_ID} className={`hidden md:flex md:flex-col md:fixed md:inset-y-0 md:left-0 ${sidebarWidthClass(collapsed)} transition-[width] duration-200 overflow-hidden bg-white border-r border-gray-200`}>
        <SidebarHeader title="CAMPUSGATE" subtitle="Institution" collapsed={collapsed} onToggle={toggle} />
        <nav className={`flex-1 overflow-y-auto space-y-1 ${collapsed ? "px-2" : "px-3"}`}>
          {SHELL_NAV.map((item) => (
            <SidebarLink key={`${item.href}:${item.label}`} item={item} perms={permissions} pathname={pathname} collapsed={collapsed} />
          ))}
        </nav>
        <SidebarFooter collapsed={collapsed} onSignOut={handleLogout} />
      </aside>
      {/* Mobile bottom nav: Gate Pass home tab + More (full shared list) */}
      <MobileTabBar includeGatePass onSignOut={handleLogout}>
        {GATE_PASS_NAV.map((item) => (
          <MobileLink key={item.href} item={item} perms={permissions} pathname={pathname} />
        ))}
      </MobileTabBar>
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
      <PushPrompt />
      <main className="p-4 md:p-8">{children}</main>
      <MfaEnrollment open={mfaOpen} onClose={() => setMfaOpen(false)} />
    </div>
  );
}
