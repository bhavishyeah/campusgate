"use client";
import { usePathname } from "next/navigation";
import { useAuthStore } from "@/stores/auth";
import { useModuleActive } from "@/features/modules/useModuleActive";
import { NAV, isNavItemVisible, type NavItem } from "./navItems";
import { SidebarNavLink } from "./SidebarParts";

/** Permission + module-active (+ legacy role) visibility for one nav item. */
export function useNavItemVisible(item: NavItem, perms: string[]): boolean {
  const legacyRole = useAuthStore((s) => s.user?.role);
  // Hooks must run unconditionally; useModuleActive internally skips the probe
  // when there's no permitted probe path and returns "unknown".
  const moduleStatus = useModuleActive(item.module ?? "fees");
  return isNavItemVisible(item, perms, item.module ? moduleStatus : "unknown", legacyRole);
}

function ModuleLink({ item, perms, variant, collapsed }: { item: NavItem; perms: string[]; variant: "light" | "dark"; collapsed: boolean }) {
  const pathname = usePathname();
  const visible = useNavItemVisible(item, perms);
  if (!visible) return null;
  return (
    <SidebarNavLink
      href={item.href}
      label={item.label}
      icon={item.icon}
      active={pathname.startsWith(item.href)}
      collapsed={collapsed}
      variant={variant}
    />
  );
}

/**
 * "Campus services" group for the legacy GatePass portals' desktop sidebars.
 * Renders the SAME shared NAV list as AppShell, filtered per item by permission
 * and module-active state. Collapsed: icon-only links, heading hidden.
 */
export function ModuleLinks({ variant = "light", collapsed = false }: { variant?: "light" | "dark"; collapsed?: boolean }) {
  const permissions = useAuthStore((s) => s.permissions);
  const border = variant === "dark" ? "border-gray-700" : "border-gray-200";
  const heading = variant === "dark" ? "text-gray-500" : "text-gray-400";
  return (
    <div className={`mt-4 pt-4 border-t ${border}`} data-testid="module-links">
      {!collapsed && (
        <p className={`px-3 pb-2 text-xs font-semibold uppercase tracking-wide ${heading}`}>Campus services</p>
      )}
      <div className="space-y-1">
        {NAV.map((item) => (
          <ModuleLink key={item.href} item={item} perms={permissions} variant={variant} collapsed={collapsed} />
        ))}
      </div>
    </div>
  );
}
