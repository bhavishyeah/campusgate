import { z } from "zod";

/**
 * Push notification categories a user can mute. EMERGENCY is deliberately NOT in
 * this list: emergency pushes cannot be disabled (the DB enum has no such member).
 */
export const NOTIFICATION_CATEGORIES = [
  "GATEPASS",
  "FEES",
  "EXAMS",
  "ATTENDANCE",
  "LIBRARY",
  "ADMISSIONS",
  "ANNOUNCEMENTS",
  "SYSTEM",
] as const;

export type NotificationCategoryKey = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_CATEGORY_LABELS: Record<NotificationCategoryKey, string> = {
  GATEPASS: "Gate passes",
  FEES: "Fees and payments",
  EXAMS: "Exams and results",
  ATTENDANCE: "Attendance",
  LIBRARY: "Library",
  ADMISSIONS: "Admissions",
  ANNOUNCEMENTS: "Notices and announcements",
  SYSTEM: "Account and system",
};

const base64url = /^[A-Za-z0-9_-]+$/;

/**
 * Structural checks only. The push-service host allowlist reads env, so it lives
 * in the API (services/push/endpoint.ts) and runs after this schema.
 */
export const pushSubscribeSchema = z.object({
  endpoint: z.string().min(1).max(2048),
  keys: z.object({
    p256dh: z.string().min(80).max(100).regex(base64url),
    auth: z.string().min(16).max(32).regex(base64url),
  }),
  label: z.string().max(200).optional(),
});

export const pushUnsubscribeSchema = z.object({
  endpoint: z.string().min(1).max(2048),
});

export const notificationPreferenceSchema = z.object({
  category: z.enum(NOTIFICATION_CATEGORIES),
  push: z.boolean(),
});

export type PushSubscribeInput = z.infer<typeof pushSubscribeSchema>;
export type PushUnsubscribeInput = z.infer<typeof pushUnsubscribeSchema>;
export type NotificationPreferenceInput = z.infer<typeof notificationPreferenceSchema>;
