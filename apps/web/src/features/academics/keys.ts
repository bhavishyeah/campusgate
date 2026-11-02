/**
 * TanStack Query key factory for the academics domain.
 * Mirror of feesKeys in features/fees/keys.ts.
 *
 * Filter parameters are included in query keys so that different filter
 * combinations produce distinct cache entries.
 * useSessions passes { status } and usePrograms passes { departmentId, status }
 * as discriminators to prevent stale cached results being served across filter
 * changes.
 */
export const academicsKeys = {
  // sessions — all cache entries sit under the ["academics", "sessions"] prefix
  sessions: (filter?: { status?: string }) =>
    ["academics", "sessions", filter ?? {}] as const,
  session: (id: string) => ["academics", "sessions", id] as const,
  terms: (sessionId: string) =>
    ["academics", "sessions", sessionId, "terms"] as const,
  // programs
  programs: (filter?: { departmentId?: string; status?: string }) =>
    ["academics", "programs", filter ?? {}] as const,
  program: (id: string) => ["academics", "programs", id] as const,
  // calendar — sessionId filter is client-side only (see useCalendar in hooks.ts)
  // Only startDate/endDate are sent to the API; sessionId is not a valid query param.
  calendar: (params: { startDate?: string; endDate?: string }) =>
    ["academics", "calendar", params] as const,
} as const;
