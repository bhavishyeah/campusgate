/**
 * Pure fail-closed access decision for the platform surface. Absence of any
 * signal NEVER yields 'allow': only hydrated + hasSession + isSuper reaches it.
 */
export type PlatformAccess = "skeleton" | "redirect" | "noaccess" | "allow";

export function decidePlatformAccess({
  hydrated,
  hasSession,
  isSuper,
}: {
  hydrated: boolean;
  hasSession: boolean;
  isSuper: boolean;
}): PlatformAccess {
  if (!hydrated) return "skeleton";
  if (!hasSession) return "redirect";
  if (!isSuper) return "noaccess";
  return "allow";
}
