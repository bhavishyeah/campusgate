export const libraryKeys = {
  all: ["library"] as const,
  titles: (f: { q?: string; category?: string; page: number }) => ["library", "titles", f] as const,
  titlesAll: () => ["library", "titles"] as const,
  title: (id: string) => ["library", "title", id] as const,
  titleAll: () => ["library", "title"] as const,
  catalogue: (f: { q?: string; category?: string; page: number }) => ["library", "catalogue", f] as const,
  catalogueAll: () => ["library", "catalogue"] as const,
  loans: (f: { status?: string; overdue?: boolean; studentId?: string; page: number }) =>
    ["library", "loans", f] as const,
  loansAll: () => ["library", "loans"] as const,
  reservations: (f: { status?: string; bookTitleId?: string; page: number }) =>
    ["library", "reservations", f] as const,
  reservationsAll: () => ["library", "reservations"] as const,
  studentLookup: (q: string) => ["library", "student-lookup", q] as const,
  fines: (status?: string) => ["library", "fines", status ?? "ALL"] as const,
  finesAll: () => ["library", "fines"] as const,
  summary: () => ["library", "reports", "summary"] as const,
  meAll: () => ["library", "me"] as const,
  meLoans: () => ["library", "me", "loans"] as const,
  meLoanHistory: () => ["library", "me", "loans", "history"] as const,
  meReservations: () => ["library", "me", "reservations"] as const,
  meFines: () => ["library", "me", "fines"] as const,
} as const;
