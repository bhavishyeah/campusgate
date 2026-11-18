"use client";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { SIDEBAR_ID, toggleLabel } from "./sidebarState";

/** Desktop-only collapse/expand button for the sidebar with id SIDEBAR_ID. */
export function SidebarToggle({
  collapsed,
  onToggle,
  variant = "light",
}: {
  collapsed: boolean;
  onToggle: () => void;
  variant?: "light" | "dark";
}) {
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const label = toggleLabel(collapsed);
  const tone = variant === "dark" ? "text-gray-300 hover:bg-gray-800" : "text-gray-500 hover:bg-gray-100";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      title={label}
      aria-expanded={!collapsed}
      aria-controls={SIDEBAR_ID}
      className={`hidden md:inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${tone}`}
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}
