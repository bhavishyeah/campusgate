/**
 * TanStack Query key factory for the students (SIS) domain.
 * Mirror of feesKeys in features/fees/keys.ts.
 */
export const sisKeys = {
  list: (params: object) => ["students", params] as const,
  detail: (id: string) => ["students", id] as const,
  history: (id: string) => ["students", id, "history"] as const,
} as const;
