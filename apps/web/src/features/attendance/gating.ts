import { can } from "@/lib/authz";

/**
 * Access decision for the Attendance Sessions screen.
 *
 * The server gates GET /api/attendance/sessions on `attendance.view` ONLY —
 * there is no mark-scoped list fallback. A mark-only FACULTY (holds
 * `attendance.mark` but NOT `attendance.view`) must therefore NOT fire the list
 * query (it would 403 and render as an error banner); they see a clean guidance
 * state and mark attendance from their class roster instead.
 */
export interface AttendanceSessionsAccess {
  /** True when the user may list sessions (holds attendance.view). Gates the query's `enabled`. */
  canList: boolean;
  /** True when the user can mark but cannot list — render guidance, not an error. */
  markOnly: boolean;
}

export function attendanceSessionsAccess(perms: string[]): AttendanceSessionsAccess {
  const canList = can("attendance.view", perms);
  const markOnly = !canList && can("attendance.mark", perms);
  return { canList, markOnly };
}
