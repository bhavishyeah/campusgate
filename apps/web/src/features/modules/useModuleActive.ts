import { useQuery } from "@tanstack/react-query";
import type { ModuleKey } from "@campusgate/shared";
import { api, ApiError } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { can } from "@/lib/authz";

export type ModuleActiveStatus = "active" | "inactive" | "forbidden" | "unknown";

/**
 * Attempt-and-degrade module probe. Picks the cheapest authoritative GET the
 * user is actually permitted to call and classifies the result. Only the
 * explicit "inactive" ("Module not active") signal suppresses nav; a
 * permission-denied "forbidden" never hides a capable user's entry.
 */
export function useModuleActive(moduleKey: ModuleKey): ModuleActiveStatus {
  const permissions = useAuthStore((s) => s.permissions);

  // Choose a probe matching a permission the user holds.
  let probePath: string | null = null;
  if (moduleKey === "fees") {
    if (can("fees.view", permissions)) probePath = "/api/fees/structures";
    else if (can("fees.view_own", permissions)) probePath = "/api/fees/me/outstanding";
  }
  if (moduleKey === "attendance") {
    if (can("attendance.view", permissions))         probePath = "/api/attendance/sessions";
    else if (can("attendance.mark", permissions))    probePath = "/api/attendance/sessions";
    else if (can("attendance.correct", permissions)) probePath = "/api/attendance/corrections";
    // attendance.view_own (student) is NOT included in the Attendance staff nav item.
  }

  if (moduleKey === "examinations") {
    if (can("exams.results.view", permissions)) probePath = "/api/exams";
    else if (can("exams.results.view_own", permissions)) probePath = "/api/exams/me/results";
    else if (can("exams.marks.enter", permissions)) probePath = "/api/exams/my-marking";
  }

  if (moduleKey === "library") {
    if (can("library.books.view", permissions)) probePath = "/api/library/titles?pageSize=1";
    else if (can("library.view_own", permissions)) probePath = "/api/library/catalogue?pageSize=1";
  }

  if (moduleKey === "admissions") {
    if (can("admissions.applications.view", permissions)) probePath = "/api/admissions/campaigns?pageSize=1";
    else if (can("admissions.view_own", permissions)) probePath = "/api/admissions/campaigns/open?pageSize=1";
  }

  if (moduleKey === "faculty_management") {
    if (can("faculty.directory.view", permissions)) probePath = "/api/faculty?pageSize=1";
    else if (can("faculty.view_own", permissions)) probePath = "/api/faculty/me/profile";
  }
  if (moduleKey === "hr_management") {
    if (can("hr.directory.view", permissions)) probePath = "/api/hr/employees?pageSize=1";
    else if (can("hr.view_own", permissions)) probePath = "/api/hr/me/employee";
  }

  if (moduleKey === "hostel") {
    if (can("hostel.view", permissions)) probePath = "/api/hostel/buildings?pageSize=1";
    else if (can("hostel.view_own", permissions)) probePath = "/api/hostel/me/occupancy";
  }
  if (moduleKey === "transport") {
    if (can("transport.view", permissions)) probePath = "/api/transport/vehicles?pageSize=1";
    else if (can("transport.view_own", permissions)) probePath = "/api/transport/me/enrollments";
  }
  const query = useQuery<ModuleActiveStatus, never>({
    queryKey: ["module-active", moduleKey],
    enabled: probePath !== null,
    staleTime: 5 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      try {
        await api.get(probePath as string);
        return "active";
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          const message: string = err.data?.error ?? "";
          if (message.startsWith("Module not active")) return "inactive";
          return "forbidden";
        }
        // 5xx / network / no error body — let the screen surface its own error.
        return "unknown";
      }
    },
  });

  // No permitted probe => treat as unknown (show nav, screen handles errors).
  if (probePath === null) return "unknown";
  return query.data ?? "unknown";
}
