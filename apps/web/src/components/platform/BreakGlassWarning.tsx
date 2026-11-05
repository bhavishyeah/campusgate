import { ShieldAlert } from "lucide-react";

/**
 * Persistent banner for break-glass tenant reads. It states plainly that this
 * access is audited and echoes the grant's purpose and target institution so
 * the operator always sees why the break-glass is in effect.
 */
export function BreakGlassWarning({
  purpose,
  institutionLabel,
}: {
  purpose: string;
  institutionLabel: string;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-warning-500 bg-warning-50 px-4 py-3 text-sm text-warning-800"
    >
      <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning-600" />
      <div className="space-y-1">
        <p className="font-semibold">
          Break-glass access — this access is audited.
        </p>
        <p>
          Reading tenant data for <strong>{institutionLabel}</strong>. Every view
          is recorded against this grant.
        </p>
        <p className="text-warning-700">Purpose: {purpose}</p>
      </div>
    </div>
  );
}
