import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD");

export const createSessionSchema = z
  .object({
    name: z.string().min(1, "Name is required").max(120),
    structureType: z.enum(["SEMESTER", "TRIMESTER", "ANNUAL"]),
    startDate: isoDate,
    endDate: isoDate,
  })
  .refine((d) => d.endDate > d.startDate, {
    message: "End date must be after start date",
    path: ["endDate"],
  });
export type CreateSessionInput = z.infer<typeof createSessionSchema>;

const addTermObject = z.object({
  name: z.string().min(1, "Name is required").max(120),
  ordinal: z.number({ coerce: true }).int().min(1, "Ordinal must be ≥ 1"),
  startDate: isoDate,
  endDate: isoDate,
});

export const addTermSchema = addTermObject.refine(
  (d) => d.endDate > d.startDate,
  {
    message: "End date must be after start date",
    path: ["endDate"],
  },
);
export type AddTermInput = z.infer<typeof addTermSchema>;

// Partial of the base object (refine is dropped — fields are individually optional).
export const editTermSchema = addTermObject.partial();
export type EditTermInput = z.infer<typeof editTermSchema>;

export const createProgramSchema = z.object({
  departmentId: z.string().min(1, "Department is required"),
  name: z.string().min(1, "Name is required").max(120),
  code: z.string().min(1, "Code is required").max(20).toUpperCase(),
  duration: z.number({ coerce: true }).int().min(1),
  durationUnit: z.enum(["YEARS", "SEMESTERS", "MONTHS"]),
});
export type CreateProgramInput = z.infer<typeof createProgramSchema>;
