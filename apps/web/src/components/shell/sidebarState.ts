export const SIDEBAR_STORAGE_KEY = "cg.sidebar.collapsed";
export const SIDEBAR_ID = "app-sidebar";

/** Safe parse of the stored value. Anything other than "1" (missing, garbage) means expanded. */
export function parseCollapsed(raw: string | null | undefined): boolean {
  return raw === "1";
}

export function serializeCollapsed(collapsed: boolean): string {
  return collapsed ? "1" : "0";
}

/** Full literal class names so Tailwind's scanner keeps them. */
export function sidebarWidthClass(collapsed: boolean): string {
  return collapsed ? "md:w-16" : "md:w-64";
}

/** Left padding that reserves room for the fixed sidebar. */
export function contentOffsetClass(collapsed: boolean): string {
  return collapsed ? "md:pl-16" : "md:pl-64";
}

export function toggleLabel(collapsed: boolean): string {
  return collapsed ? "Expand sidebar" : "Collapse sidebar";
}
