"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/auth";
import { connectSocket } from "@/lib/socket";
import { NotificationBell } from "@/components/NotificationBell";
import { ModuleLinks } from "@/components/shell/ModuleLinks";
import { SidebarFooter, SidebarHeader, SidebarNavLink } from "@/components/shell/SidebarParts";
import { MobileTab, MobileTabBar } from "@/components/shell/MobileMoreSheet";
import { useSidebarCollapsed } from "@/components/shell/useSidebarCollapsed";
import { SIDEBAR_ID, contentOffsetClass, sidebarWidthClass } from "@/components/shell/sidebarState";
import {
  LayoutDashboard,
  Users,
  DoorOpen,
  Building,
  FileText,
  Shield,
  Upload,
  Clock3,
  BarChart3,
  Siren,
} from "lucide-react";
import { usePathname } from "next/navigation";
const navItems = [
  { href: "/admin", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/admin/users", icon: Users, label: "Users" },
  { href: "/admin/import", icon: Upload, label: "CSV Import" },
  { href: "/admin/departments", icon: Building, label: "Courses" },
  { href: "/admin/gates", icon: DoorOpen, label: "Gates" },
  { href: "/admin/shifts", icon: Clock3, label: "Guard Shifts" },
  { href: "/admin/analytics", icon: BarChart3, label: "Analytics" },
  { href: "/admin/emergency", icon: Siren, label: "Emergency" },
  { href: "/admin/reasons", icon: FileText, label: "Exit Reasons" },
  { href: "/admin/audit", icon: Shield, label: "Audit Log" },
];
// Mobile bottom bar shows these; every other admin link is in the More sheet.
const MOBILE_TAB_HREFS = ["/admin", "/admin/users", "/admin/gates", "/admin/analytics"];
const mobileTabs = navItems.filter((i) => MOBILE_TAB_HREFS.includes(i.href));
const mobileMore = navItems.filter((i) => !MOBILE_TAB_HREFS.includes(i.href));
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, token, logout, hydrated } = useAuthStore();
  const { collapsed, toggle } = useSidebarCollapsed();
  useEffect(() => {
    if (!hydrated) return;
    if (!token || !user || user.role !== "ADMIN") {
      router.replace("/login");
      return;
    }
    connectSocket();
  }, [token, user, router, hydrated]);
  if (!hydrated || !token || !user) return null;
  const handleLogout = () => {
    logout();
    router.replace("/login");
  };
  return (
    <div className={`min-h-screen bg-gray-50 pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-0 transition-[padding] duration-200 ${contentOffsetClass(collapsed)}`}>
      {/* Sidebar */}
      <aside id={SIDEBAR_ID} className={`hidden md:flex md:flex-col md:fixed md:inset-y-0 md:left-0 ${sidebarWidthClass(collapsed)} transition-[width] duration-200 overflow-hidden bg-gray-900 text-white`}>
        <SidebarHeader title="CAMPUSGATE" subtitle="Admin Panel" collapsed={collapsed} onToggle={toggle} variant="dark" />
        <nav className={`flex-1 overflow-y-auto space-y-1 ${collapsed ? "px-2" : "px-3"}`}>
          {navItems.map((item) => (
            <SidebarNavLink
              key={item.href}
              href={item.href}
              label={item.label}
              icon={item.icon}
              active={pathname === item.href}
              collapsed={collapsed}
              variant="dark"
              activeTone="bg-primary-600 text-white"
            />
          ))}
        <ModuleLinks variant="dark" collapsed={collapsed} />
        </nav>
        <SidebarFooter collapsed={collapsed} onSignOut={handleLogout} variant="dark" />
      </aside>
      {/* Mobile bottom nav: primary tabs + More (remaining admin links, Campus services, Sign Out) */}
      <MobileTabBar extraLinks={mobileMore} extraHeading="Admin" onSignOut={handleLogout}>
        {mobileTabs.map((item) => (
          <MobileTab key={item.href} {...item} active={pathname === item.href} />
        ))}
      </MobileTabBar>
      {/* Top bar */}
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-2 flex items-center justify-between">
        <span className="md:hidden font-bold text-primary-800">CAMPUSGATE</span>
        <span className="hidden md:block text-sm text-gray-500">{user.email}</span>
        <NotificationBell />
      </header>
      <main className="p-4 md:p-8">{children}</main>
    </div>
  );
}
