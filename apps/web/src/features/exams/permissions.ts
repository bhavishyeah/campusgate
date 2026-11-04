import type { PermissionKey } from "@campusgate/shared";

/**
 * Typed permission constants for the examinations module. Each value is checked
 * against the shared PermissionKey union at compile time, so a typo or a key
 * that does not exist in the catalogue fails typecheck.
 */
export const EXAM_PERM = {
  manage: "exams.manage",
  gradingManage: "exams.grading.manage",
  candidatesManage: "exams.candidates.manage",
  marksEnter: "exams.marks.enter",
  moderate: "exams.moderate",
  publish: "exams.results.publish",
  view: "exams.results.view",
  viewOwn: "exams.results.view_own",
} as const satisfies Record<string, PermissionKey>;
