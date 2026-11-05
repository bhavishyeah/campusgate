/** Every request parameter of a query is part of its key (inventory precedent). */
export const documentsKeys = {
  all: ["documents"] as const,
  list: (f: { scope?: "mine" | "all"; status?: string; category?: string; ownerUserId?: string; page: number }) =>
    ["documents", "list", f] as const,
  detail: (id: string) => ["documents", "detail", id] as const,
  retentionPolicies: () => ["documents", "retention-policies"] as const,
  report: () => ["documents", "report"] as const,
  accessLog: (id: string) => ["documents", "access-log", id] as const,
  userLookup: (q: string) => ["documents", "user-lookup", q] as const,
} as const;
