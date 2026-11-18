import { Wallet, GraduationCap, Users, BookOpen, ClipboardList, FileCheck, Library, BookMarked, ClipboardCheck, FilePlus2, Contact, Briefcase, UserCircle, IdCard, Building2, BedDouble, BusFront, Bus, Boxes, PackageSearch, ListChecks, Megaphone, FileText, FolderOpen, Home, Inbox, Scan, LayoutDashboard, type LucideIcon } from "lucide-react";
import type { ModuleKey, PermissionKey } from "@campusgate/shared";
import { canAny } from "@/lib/authz";
import type { ModuleActiveStatus } from "@/features/modules/useModuleActive";
export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  anyOf: PermissionKey[];
  module?: ModuleKey;
  legacyRole?: string;
}

export const NAV: NavItem[] = [
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
  // â”€â”€ Academics (NEW) â€” foundational/permission-only, NOT module-gated.
  // anyOf uses academics.sessions.manage, academics.programs.manage,
  // academics.calendar.manage only. academics.view is intentionally excluded
  // (MUST-FIX 1): the API grants academics.view for Sessions read but Programs
  // and Calendar are gated by their respective .manage keys, so including
  // academics.view here would show the nav but 403 HOD users on those routes.
  {
    href: "/academics/sessions",
    label: "Academics",
    icon: GraduationCap,
    anyOf: [
      "academics.sessions.manage",
      "academics.programs.manage",
      "academics.calendar.manage",
    ],
  },
  // â”€â”€ Students (NEW) â€” foundational/permission-only, NOT module-gated.
  {
    href: "/sis/students",
    label: "Students",
    icon: Users,
    anyOf: [
      "students.view",
      "students.create",
      "students.update",
      "students.deactivate",
    ],
  },
  // â”€â”€ Classes â€” foundational/permission-only, NOT module-gated.
  // The API does not call requireModuleActive for classes.* routes.
  // Following the academics precedent: omitting module means
  // useNavItemVisible skips the "item.module && inactive" branch entirely.
  {
    href: "/classes/sections",
    label: "Classes",
    icon: BookOpen,
    anyOf: ["classes.sections.manage", "classes.faculty.assign", "classes.timetable.manage", "classes.view"],
    // No module field â€” classes API is permission-gated only, never module-gated.
  },
  // â”€â”€ Attendance â€” module-gated: attendance API calls requireModuleActive("attendance").
  {
    href: "/attendance/sessions",
    label: "Attendance",
    icon: ClipboardList,
    anyOf: ["attendance.view", "attendance.mark", "attendance.correct"],
    module: "attendance",
  },
  // â”€â”€ Examinations â€” module-gated: exams.* routes call requireModuleActive("examinations").
  // anyOf includes exams.results.view_own so students reach /exams/my-results.
  {
    href: "/exams",
    label: "Examinations",
    icon: FileCheck,
    anyOf: ["exams.manage", "exams.results.view", "exams.results.view_own", "exams.marks.enter"],
    module: "examinations",
  },
  // â”€â”€ Library â€” module-gated. Each anyOf holds only the key that opens the target page.
  { href: "/library", label: "Library", icon: Library, anyOf: ["library.books.view"], module: "library" },
  { href: "/library/my", label: "My Library", icon: BookMarked, anyOf: ["library.view_own"], module: "library" },
  // â”€â”€ Admissions â€” module-gated.
  {
    href: "/admissions",
    label: "Admissions",
    icon: ClipboardCheck,
    anyOf: ["admissions.applications.view"],
    module: "admissions",
  },
  {
    href: "/admissions/my",
    label: "My Application",
    icon: FilePlus2,
    anyOf: ["admissions.view_own"],
    module: "admissions",
  },
  // â”€â”€ Faculty Management / HR â€” module-gated. Each anyOf holds only the key that opens the target page.
  { href: "/faculty-mgmt", label: "Faculty", icon: Contact, anyOf: ["faculty.directory.view"], module: "faculty_management" },
  { href: "/faculty-mgmt/me", label: "My Faculty Profile", icon: UserCircle, anyOf: ["faculty.view_own"], module: "faculty_management" },
  { href: "/hr", label: "HR", icon: Briefcase, anyOf: ["hr.directory.view"], module: "hr_management" },
  { href: "/hr/me", label: "My Employment", icon: IdCard, anyOf: ["hr.view_own"], module: "hr_management" },
  // â”€â”€ Hostel / Transport â€” module-gated. Each anyOf holds only the key that opens the target page.
  { href: "/hostel", label: "Hostel", icon: Building2, anyOf: ["hostel.view"], module: "hostel" },
  { href: "/hostel/me", label: "My Hostel", icon: BedDouble, anyOf: ["hostel.view_own"], module: "hostel" },
  { href: "/transport", label: "Transport", icon: BusFront, anyOf: ["transport.view"], module: "transport" },
  { href: "/transport/me", label: "My Transport", icon: Bus, anyOf: ["transport.view_own"], module: "transport" },
  // â”€â”€ Inventory / Service Requests â€” module-gated. Each anyOf holds only the key that opens the target page.
  { href: "/inventory", label: "Inventory", icon: Boxes, anyOf: ["inventory.view"], module: "inventory" },
  { href: "/inventory/me", label: "My Assets", icon: PackageSearch, anyOf: ["inventory.view_own"], module: "inventory" },
  { href: "/service-requests", label: "Service Requests", icon: ClipboardList, anyOf: ["service_requests.view"], module: "service_requests" },
  { href: "/service-requests/me", label: "My Requests", icon: ListChecks, anyOf: ["service_requests.request_own"], module: "service_requests" },
  { href: "/service-requests/raise", label: "Raise a Request", icon: Megaphone, anyOf: ["service_requests.request_own"], module: "service_requests" },
  // â”€â”€ Documents â€” module-gated. Each anyOf holds only keys that open the target page.
  { href: "/documents", label: "Documents", icon: FileText, anyOf: ["documents.view_own", "documents.admin.view_all"], module: "documents" },
  { href: "/documents/retention-policies", label: "Document Admin", icon: FolderOpen, anyOf: ["documents.retention.manage"], module: "documents" },
];


/**
 * Links from the module shell back to each legacy GatePass portal home. Each is
 * gated by a permission that role holds (and no other legacy role does) plus the
 * legacy User.role the legacy layout requires. FIRST in the shell for those roles.
 */
export const GATE_PASS_NAV: NavItem[] = [
  { href: "/student", label: "Gate Pass", icon: Home, anyOf: ["campus_movement.pass.view_own"], module: "campus_movement", legacyRole: "STUDENT" },
  { href: "/hod", label: "Gate Pass", icon: Inbox, anyOf: ["campus_movement.pass.view_department"], module: "campus_movement", legacyRole: "HOD" },
  { href: "/guard", label: "Gate Pass", icon: Scan, anyOf: ["campus_movement.gate.verify"], module: "campus_movement", legacyRole: "GUARD" },
  { href: "/admin", label: "Gate Pass Admin", icon: LayoutDashboard, anyOf: ["campus_movement.analytics.view"], module: "campus_movement", legacyRole: "ADMIN" },
];

/** Pure visibility rule shared by the shell and the legacy portals' module links. */
export function isNavItemVisible(
  item: NavItem,
  perms: string[],
  moduleStatus: ModuleActiveStatus,
  legacyRole?: string,
): boolean {
  if (!canAny(item.anyOf, perms)) return false;
  if (item.legacyRole && item.legacyRole !== legacyRole) return false;
  if (item.module && moduleStatus === "inactive") return false;
  return true;
}

/** Pure filter used by tests; statusOf is the module probe result per module. */
export function visibleNavItems(
  items: NavItem[],
  perms: string[],
  statusOf: (m: ModuleKey) => ModuleActiveStatus,
  legacyRole?: string,
): NavItem[] {
  return items.filter((i) => isNavItemVisible(i, perms, i.module ? statusOf(i.module) : "unknown", legacyRole));
}
