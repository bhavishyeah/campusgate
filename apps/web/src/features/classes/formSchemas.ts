// features/classes/formSchemas.ts
import { z } from "zod";

// ─── Class Sections ──────────────────────────────────────────────────────────

export const createSectionSchema = z.object({
  programId:         z.string().min(1, "Program is required"),
  academicSessionId: z.string().min(1, "Session is required"),
  academicTermId:    z.string().min(1, "Term is required"),
  label:             z.string().max(120).optional(),
  capacity:          z.number({ coerce: true }).int().positive().optional(),
  status:            z.enum(["PLANNED", "ACTIVE", "CLOSED", "CANCELLED"]).optional(),
});
export type CreateSectionInput = z.infer<typeof createSectionSchema>;

export const editSectionSchema = z.object({
  label:    z.string().max(120).optional(),
  capacity: z.number({ coerce: true }).int().positive().optional(),
  status:   z.enum(["PLANNED", "ACTIVE", "CLOSED", "CANCELLED"]).optional(),
});
export type EditSectionInput = z.infer<typeof editSectionSchema>;

// ─── Faculty Assignment ───────────────────────────────────────────────────────

export const assignFacultySchema = z.object({
  facultyId:            z.string().min(1, "Faculty is required"),
  subjectId:            z.string().min(1, "Subject is required"),
  academicTermId:       z.string().min(1, "Term is required"),
  classSectionId:       z.string().optional(),
  role:                 z.enum(["PRIMARY", "SUBSTITUTE", "ASSISTANT"]).default("PRIMARY"),
  replacesAssignmentId: z.string().optional(),
});
export type AssignFacultyInput = z.infer<typeof assignFacultySchema>;

// ─── Timetable ───────────────────────────────────────────────────────────────

export const createTimetableSchema = z.object({
  academicTermId: z.string().min(1, "Term is required"),
  name:           z.string().min(1, "Name is required").max(120),
});
export type CreateTimetableInput = z.infer<typeof createTimetableSchema>;
