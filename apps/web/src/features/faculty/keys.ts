export const facultyKeys = {
  all: ["faculty"] as const,
  list: (f: { q?: string; departmentId?: string; status?: string; page: number }) =>
    ["faculty", "list", f] as const,
  listAll: () => ["faculty", "list"] as const,
  lookups: () => ["faculty", "lookups"] as const,
  profile: (id: string) => ["faculty", "profile", id] as const,
  policy: () => ["faculty", "workload-policy"] as const,
  meProfile: () => ["faculty", "me", "profile"] as const,
} as const;
