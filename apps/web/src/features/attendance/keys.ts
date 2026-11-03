// features/attendance/keys.ts

export const attendanceKeys = {
  sessions: () => ["attendance", "sessions"] as const,
  session: (id: string) => ["attendance", "sessions", id] as const,

  corrections: (status?: string) =>
    ["attendance", "corrections", status ?? "all"] as const,

  report: (sectionId: string, termId: string) =>
    ["attendance", "report", sectionId, termId] as const,
} as const;
