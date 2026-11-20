import type { PushUrgency } from "./sender.js";

export type PushCategory =
  | "GATEPASS"
  | "FEES"
  | "EXAMS"
  | "ATTENDANCE"
  | "LIBRARY"
  | "ADMISSIONS"
  | "ANNOUNCEMENTS"
  | "SYSTEM";
export type NotificationCategoryOrEmergency = PushCategory | "EMERGENCY";
export type NotificationPriority = "NORMAL" | "HIGH" | "EMERGENCY";

const EXACT: Record<string, NotificationCategoryOrEmergency> = {
  EMERGENCY_DECLARED: "EMERGENCY",
  EMERGENCY_RESOLVED: "EMERGENCY",
  PASS_APPROVED: "GATEPASS",
  PASS_REJECTED: "GATEPASS",
  PASS_REVOKED: "GATEPASS",
  PASS_EXPIRED: "GATEPASS",
  GATE_EXIT: "GATEPASS",
  GATE_RETURN: "GATEPASS",
  NEW_REQUEST: "GATEPASS",
  REGISTRATION_PENDING: "SYSTEM",
};

const PREFIX: Record<string, NotificationCategoryOrEmergency> = {
  gatepass: "GATEPASS",
  guardian: "GATEPASS", // reserved for the parents phase
  fees: "FEES",
  fee: "FEES",
  payment: "FEES",
  exams: "EXAMS",
  exam: "EXAMS",
  results: "EXAMS",
  attendance: "ATTENDANCE",
  library: "LIBRARY",
  admissions: "ADMISSIONS",
  notice: "ANNOUNCEMENTS", // reserved for the notice board
  circular: "ANNOUNCEMENTS",
  announcement: "ANNOUNCEMENTS",
};

/** Exact table first, then the prefix before the first `.` (case-insensitive), else SYSTEM. */
export function categoryForType(type: string): NotificationCategoryOrEmergency {
  const exact = EXACT[type];
  if (exact) return exact;
  const dot = type.indexOf(".");
  if (dot > 0) {
    const hit = PREFIX[type.slice(0, dot).toLowerCase()];
    if (hit) return hit;
  }
  return "SYSTEM";
}

export function priorityFor(type: string, category: NotificationCategoryOrEmergency): NotificationPriority {
  if (type === "EMERGENCY_DECLARED") return "EMERGENCY";
  if (type === "EMERGENCY_RESOLVED" || category === "GATEPASS") return "HIGH";
  return "NORMAL";
}

export function urgencyFor(priority: NotificationPriority): PushUrgency {
  return priority === "NORMAL" ? "normal" : "high";
}

export function ttlSecondsFor(priority: NotificationPriority): number {
  if (priority === "EMERGENCY") return 86_400;
  if (priority === "HIGH") return 21_600;
  return 10_800;
}
