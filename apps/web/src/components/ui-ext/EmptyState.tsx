import type { LucideIcon } from "lucide-react";

/**
 * Shared empty-state block (lucide icon + label + muted description + optional
 * action node). Mirrors the NotificationBell empty idiom.
 */
export function EmptyState({
  icon: Icon,
  label,
  description,
  action,
}: {
  icon: LucideIcon;
  label: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center py-12 px-4 text-center"
    >
      <Icon className="w-10 h-10 text-gray-400" aria-hidden="true" />
      <p className="mt-4 text-sm font-medium text-gray-900">{label}</p>
      {description && (
        <p className="mt-1 text-sm text-gray-500 max-w-sm">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
