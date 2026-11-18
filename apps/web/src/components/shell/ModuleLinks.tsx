"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuthStore } from "@/stores/auth";
import { useModuleActive } from "@/features/modules/useModuleActive";
import { NAV, isNavItemVisible, type NavItem } from "./navItems";

/** Permission + module-active (+ legacy role) visibility for one nav item. */
export function useNavItemVisible(item: NavItem, perms: string[]): boolean {
  const legacyRole = useAuthStore((s) => s.user?.role);
  // Hooks must run unconditionally; useModuleActive internally skips the probe
  // when there's no permitted probe path and returns "unknown".
  const moduleStatus = useModuleActive(item.module ?? "fees");
  return isNavItemVisible(item, perms, item.module ? moduleStatus : "unknown", legacyRole);
}

function ModuleLink({ item, perms, variant }: { item: NavItem; perms: string[]; variant: "light" | "dark" }) {
  const pathname = usePathname();
  const visible = useNavItemVisible(item, perms);
  if (!visible) return null;
  const isActive = pathname.startsWith(item.href);
  const tone =
    variant === "dark"
      ? isActive
        ? "bg-gray-800 text-white"
        : "text-gray-300 hover:bg-gray-800"
      : isActive
        ? "bg-primary-50 text-primary-700"
        : "text-gray-600 hover:bg-gray-100";
  return (
    <Link
      href={item.href}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${tone}`}
    >
      <item.icon className="w-5 h-5" />
      {item.label}
    </Link>
  );
}

/**
 * "Campus services" group for the legacy GatePass portals' desktop sidebars.
 * Renders the SAME shared NAV list as AppShell, filtered per item by permission
 * and module-active state. Renders nothing for a role with no visible entries.
 */
export function ModuleLinks({ variant = "light" }: { variant?: "light" | "dark" }) {
  const permissions = useAuthStore((s) => s.permissions);
  const border = variant === "dark" ? "border-gray-700" : "border-gray-200";
  const heading = variant === "dark" ? "text-gray-500" : "text-gray-400";
  return (
    <div className={`mt-4 pt-4 border-t ${border}`} data-testid="module-links">
      <p className={`px-3 pb-2 text-xs font-semibold uppercase tracking-wide ${heading}`}>Campus services</p>
      <div className="space-y-1">
        {NAV.map((item) => (
          <ModuleLink key={item.href} item={item} perms={permissions} variant={variant} />
        ))}
      </div>
    </div>
  );
}
