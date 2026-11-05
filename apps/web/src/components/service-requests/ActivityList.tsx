import { activityLabel } from "@/features/service-requests/format";
import { formatDateTime } from "@/features/hr/format";
import type { Activity } from "@/features/service-requests/types";

export function ActivityList({ activities }: { activities: Activity[] }) {
  if (activities.length === 0) return <p className="text-sm text-gray-500">No activity yet.</p>;
  return (
    <ul className="space-y-2">
      {activities.map((a) => (
        <li key={a.id} className="rounded-md border border-gray-200 px-3 py-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium">{activityLabel(a)}</span>
            <span className="text-xs text-gray-500">{formatDateTime(a.createdAt)}</span>
          </div>
          {a.body ? <p className="mt-1 text-gray-700">{a.body}</p> : null}
        </li>
      ))}
    </ul>
  );
}
