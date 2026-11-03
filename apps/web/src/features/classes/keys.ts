// features/classes/keys.ts

/**
 * TanStack Query key factory for the classes domain.
 *
 * NOTE: classesKeys.sections() has NO filter parameter, because
 * GET /api/classes/sections accepts no ?status= query parameter.
 * Status filtering in Screen 1 is entirely client-side, so a single
 * shared cache entry is correct and intentional. This deviates from
 * academicsKeys.sessions({ status }) — that filter is server-side;
 * this one is not.
 */
export const classesKeys = {
  sections: () => ["classes", "sections"] as const,
  section: (id: string) => ["classes", "sections", id] as const,

  timetables: () => ["classes", "timetables"] as const,
  timetable: (id: string) => ["classes", "timetables", id] as const,

  courses: () => ["classes", "courses"] as const,
  course: (id: string) => ["classes", "courses", id] as const,
} as const;
