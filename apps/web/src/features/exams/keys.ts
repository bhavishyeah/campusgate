/** TanStack Query key factory for the examinations domain. */
export const examsKeys = {
  exams: () => ["exams", "list"] as const,
  exam: (id: string) => ["exams", "exam", id] as const,
  schedules: (id: string) => ["exams", "exam", id, "schedules"] as const,
  candidates: (id: string) => ["exams", "exam", id, "candidates"] as const,
  assessments: (id: string) => ["exams", "exam", id, "assessments"] as const,
  marks: (id: string) => ["exams", "exam", id, "marks"] as const,
  results: (id: string) => ["exams", "exam", id, "results"] as const,
  distribution: (id: string) =>
    ["exams", "exam", id, "results", "distribution"] as const,
  rollups: (id: string) => ["exams", "exam", id, "results", "rollups"] as const,
  gradingSchemes: () => ["exams", "grading-schemes"] as const,
  myResults: () => ["exams", "me", "results"] as const,
  myResult: (examId: string) => ["exams", "me", "results", examId] as const,
  // Faculty marking (exams.marks.enter only)
  myMarking: () => ["exams", "me", "marking"] as const,
  marksSheet: (id: string) => ["exams", "marks-sheet", id] as const,
  // Own branch (not under "results") so myResult("history") cannot collide.
  myHistory: () => ["exams", "me", "history"] as const,
} as const;
