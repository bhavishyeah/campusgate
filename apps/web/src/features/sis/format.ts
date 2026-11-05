import type { StudentProfile } from "./types";

/**
 * Resolve the Program column for a student row.
 *
 * The LIST endpoint returns the free-text `program` string column but does NOT
 * hydrate the structured Program relation (`structuredProgram`), which is only
 * present on the detail endpoint. Prefer the structured name when available
 * (detail views), fall back to the free-text program, and only show a dash when
 * neither is present.
 */
export function programLabel(
  student: Pick<StudentProfile, "program" | "structuredProgram">,
): string {
  const structured = student.structuredProgram?.name?.trim();
  if (structured) return structured;
  const flat = student.program?.trim();
  if (flat) return flat;
  return "—";
}
