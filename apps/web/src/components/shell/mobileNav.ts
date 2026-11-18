import type { LucideIcon } from "lucide-react";
import { GATE_PASS_NAV, NAV, type NavItem } from "./navItems";

/** A legacy-portal link shown in the mobile sheet (not permission-gated; the portal layout already guards it). */
export interface SheetLink {
  href: string;
  label: string;
  icon: LucideIcon;
}

/**
 * The shared nav list the mobile "More" sheet renders. Same source as the desktop
 * sidebar (NAV, plus the Gate Pass home links for the module shell); visibility is
 * applied per item with the same isNavItemVisible rule.
 */
export function sheetNavItems(includeGatePass: boolean): NavItem[] {
  return includeGatePass ? [...GATE_PASS_NAV, ...NAV] : NAV;
}
