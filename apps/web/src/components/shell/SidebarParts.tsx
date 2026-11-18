"use client";
import Link from "next/link";
import { LogOut, type LucideIcon } from "lucide-react";
import { SidebarToggle } from "./SidebarToggle";

export type SidebarVariant = "light" | "dark";

/** Brand block + collapse toggle. Collapsed: only the toggle, centered. */
export function SidebarHeader({
  title,
  subtitle,
  collapsed,
  onToggle,
  variant = "light",
}: {
  title: string;
  subtitle: string;
  collapsed: boolean;
  onToggle: () => void;
  variant?: SidebarVariant;
}) {
  const dark = variant === "dark";
  return (
    <div className={`flex items-center ${collapsed ? "justify-center p-3" : "justify-between p-6"}`}>
      {!collapsed && (
        <div className="min-w-0">
          <h1 className={`text-xl font-bold ${dark ? "" : "text-primary-800"}`}>{title}</h1>
          <p className={`text-xs mt-1 ${dark ? "text-gray-400" : "text-gray-500"}`}>{subtitle}</p>
        </div>
      )}
      <SidebarToggle collapsed={collapsed} onToggle={onToggle} variant={variant} />
    </div>
  );
}

/** One sidebar link. Collapsed: icon only with title + aria-label. */
export function SidebarNavLink({
  href,
  label,
  icon: Icon,
  active,
  collapsed = false,
  variant = "light",
  activeTone,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  collapsed?: boolean;
  variant?: SidebarVariant;
  /** Overrides the active-state classes (admin uses a solid primary). */
  activeTone?: string;
}) {
  const dark = variant === "dark";
  const tone = active
    ? (activeTone ?? (dark ? "bg-gray-800 text-white" : "bg-primary-50 text-primary-700"))
    : dark
      ? "text-gray-300 hover:bg-gray-800"
      : "text-gray-600 hover:bg-gray-100";
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      aria-label={collapsed ? label : undefined}
      aria-current={active ? "page" : undefined}
      className={`flex items-center rounded-lg text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
        collapsed ? "justify-center h-10 px-0" : "gap-3 px-3 py-2"
      } ${tone}`}
    >
      <Icon className="w-5 h-5 shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
}

/** Avatar/name block + sign-out. Collapsed: avatar and an icon-only sign-out. */
export function SidebarFooter({
  collapsed,
  onSignOut,
  variant = "light",
  initial,
  name,
  sub,
}: {
  collapsed: boolean;
  onSignOut: () => void;
  variant?: SidebarVariant;
  initial?: string;
  name?: string;
  sub?: string;
}) {
  const dark = variant === "dark";
  const signOutTone = dark ? "text-gray-400 hover:text-white" : "text-gray-600 hover:text-danger-600";
  return (
    <div className={`border-t ${dark ? "border-gray-700" : "border-gray-200"} ${collapsed ? "p-2" : "p-4"}`}>
      {initial !== undefined && (
        <div className={`flex items-center ${collapsed ? "justify-center mb-2" : "gap-3 mb-3"}`}>
          <div
            className="w-8 h-8 shrink-0 rounded-full bg-primary-100 flex items-center justify-center"
            title={collapsed ? name : undefined}
          >
            <span className="text-sm font-medium text-primary-700">{initial}</span>
          </div>
          {!collapsed && (
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{name}</p>
              {sub && <p className="text-xs text-gray-500 truncate">{sub}</p>}
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={onSignOut}
        title={collapsed ? "Sign Out" : undefined}
        aria-label="Sign Out"
        className={`flex items-center text-sm transition-colors w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 rounded-lg ${signOutTone} ${
          collapsed ? "justify-center h-10" : "gap-2"
        }`}
      >
        <LogOut className="w-4 h-4" />
        {!collapsed && "Sign Out"}
      </button>
    </div>
  );
}
