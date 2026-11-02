import { z } from "zod";

export const deactivateStudentSchema = z.object({
  status: z.enum(["SUSPENDED", "WITHDRAWN", "GRADUATED", "ON_LEAVE"]),
  reason: z.string().max(500).optional(),
});
export type DeactivateStudentInput = z.infer<typeof deactivateStudentSchema>;
