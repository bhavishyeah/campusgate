"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/auth";
import { connectSocket } from "@/lib/socket";
import { NotificationBell } from "@/components/NotificationBell";
import { PushPrompt } from "@/components/push/PushPrompt";
import { ModuleLinks } from "@/components/shell/ModuleLinks";
import { SidebarFooter, SidebarHeader, SidebarNavLink } from "@/components/shell/SidebarParts";
import { MobileTab, MobileTabBar } from "@/components/shell/MobileMoreSheet";
import { useSidebarCollapsed } from "@/components/shell/useSidebarCollapsed";
import { SIDEBAR_ID, contentOffsetClass, sidebarWidthClass } from "@/components/shell/sidebarState";
import { Inbox, CheckSquare, Clock } from "lucide-react";
import { usePathname } from "next/navigation";
const navItems = [
  { href: "/hod", icon: Inbox, label: "Pending" },
  { href: "/hod/approved", icon: CheckSquare, label: "Approved" },
  { href: "/hod/history", icon: Clock, label: "History" },
];
export default function HodLayout({
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
    if (!token || !user || user.role !== "HOD") {
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
      {/* Desktop sidebar */}
      <aside id={SIDEBAR_ID} className={`hidden md:flex md:flex-col md:fixed md:inset-y-0 md:left-0 ${sidebarWidthClass(collapsed)} transition-[width] duration-200 overflow-hidden bg-white border-r border-gray-200`}>
        <SidebarHeader title="CAMPUSGATE" subtitle="HOD Panel" collapsed={collapsed} onToggle={toggle} />
        <nav className={`flex-1 overflow-y-auto space-y-1 ${collapsed ? "px-2" : "px-3"}`}>
          {navItems.map((item) => (
            <SidebarNavLink
              key={item.href}
              href={item.href}
              label={item.label}
              icon={item.icon}
              active={pathname === item.href}
              collapsed={collapsed}
            />
          ))}
        <ModuleLinks collapsed={collapsed} />
        </nav>
        <SidebarFooter
          collapsed={collapsed}
          onSignOut={handleLogout}
          initial={user.profile?.name?.[0] || "H"}
          name={user.profile?.name || user.email}
          sub="HOD"
        />
      </aside>
      {/* Mobile bottom nav: primary tabs + More (Campus services) */}
      <MobileTabBar onSignOut={handleLogout}>
        {navItems.map((item) => (
          <MobileTab key={item.href} {...item} active={pathname === item.href} />
        ))}
      </MobileTabBar>
      {/* Top bar */}
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-2 flex items-center justify-between">
        <span className="md:hidden font-bold text-primary-800">CAMPUSGATE</span>
        <span className="hidden md:block text-sm text-gray-500">
          {user.profile?.name || user.email}
        </span>
        <NotificationBell />
      </header>
      <PushPrompt />
      <main className="p-4 md:p-8">{children}</main>
    </div>
  );
}
