import { Lock } from "lucide-react";
import { EmptyState } from "@/components/ui-ext/EmptyState";

/** Shown when a query is disabled because the role lacks the permission. */
export function NoAccess({ what }: { what: string }) {
  return (
    <EmptyState
      icon={Lock}
      label="No access"
      description={`Your role can't view ${what}.`}
    />
  );
}
