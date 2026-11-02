import { useQuery } from "@tanstack/react-query";
import type { ModuleKey } from "@campusgate/shared";
import { api, ApiError } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { can } from "@/lib/authz";

export type ModuleActiveStatus = "active" | "inactive" | "forbidden" | "unknown";

/**
 * Attempt-and-degrade module probe. Picks the cheapest authoritative GET the
 * user is actually permitted to call and classifies the result. Only the
 * explicit "inactive" ("Module not active") signal suppresses nav; a
 * permission-denied "forbidden" never hides a capable user's entry.
 */
export function useModuleActive(moduleKey: ModuleKey): ModuleActiveStatus {
  const permissions = useAuthStore((s) => s.permissions);

  // Choose a probe matching a permission the user holds (fees only for now).
  let probePath: string | null = null;
  if (moduleKey === "fees") {
    if (can("fees.view", permissions)) probePath = "/api/fees/structures";
    else if (can("fees.view_own", permissions)) probePath = "/api/fees/me/outstanding";
  }

  const query = useQuery<ModuleActiveStatus, never>({
    queryKey: ["module-active", moduleKey],
    enabled: probePath !== null,
    staleTime: 5 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      try {
        await api.get(probePath as string);
        return "active";
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          const message: string = err.data?.error ?? "";
          if (message.startsWith("Module not active")) return "inactive";
          return "forbidden";
        }
        // 5xx / network / no error body — let the screen surface its own error.
        return "unknown";
      }
    },
  });

  // No permitted probe => treat as unknown (show nav, screen handles errors).
  if (probePath === null) return "unknown";
  return query.data ?? "unknown";
}
