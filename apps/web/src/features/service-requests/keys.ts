/** Every request parameter of a query is part of its key. */
export const serviceRequestKeys = {
  all: ["service-requests"] as const,
  types: () => ["service-requests", "types"] as const,
  activeTypes: () => ["service-requests", "types", "active"] as const,
  typeFields: (typeId: string) => ["service-requests", "types", "fields", typeId] as const,
  queue: (f: { status?: string; requestTypeId?: string; assigneeUserId?: string; overdue?: boolean; page: number }) =>
    ["service-requests", "queue", f] as const,
  queueAll: () => ["service-requests", "queue"] as const,
  request: (id: string) => ["service-requests", "request", id] as const,
  myRequests: (f: { status?: string; requestTypeId?: string; page: number }) =>
    ["service-requests", "me", "list", f] as const,
  myRequest: (id: string) => ["service-requests", "me", "detail", id] as const,
  myAll: () => ["service-requests", "me"] as const,
  reportOverdue: (atRiskHours: number) => ["service-requests", "reports", "overdue", { atRiskHours }] as const,
  reportVolume: () => ["service-requests", "reports", "volume"] as const,
  reportSla: () => ["service-requests", "reports", "sla"] as const,
  reportFeedback: () => ["service-requests", "reports", "feedback"] as const,
  reportsAll: () => ["service-requests", "reports"] as const,
  userLookup: (q: string) => ["service-requests", "user-lookup", q] as const,
} as const;
