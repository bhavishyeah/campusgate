import { Badge } from "@/components/ui/badge";
import { facultyStatusLabel } from "@/features/faculty/labels";
import type { FacultyProfile } from "@/features/faculty/types";

export function FacultyOverview({ profile }: { profile: FacultyProfile }) {
  const { identity } = profile;
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-gray-500">Name</dt>
          <dd className="text-sm font-medium text-gray-900">{identity.name}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Department</dt>
          <dd className="text-sm font-medium text-gray-900">{identity.department?.name ?? "-"}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Status</dt>
          <dd>
            <Badge variant="outline">{facultyStatusLabel[identity.status] ?? identity.status}</Badge>
          </dd>
        </div>
      </dl>
      <dl className="grid grid-cols-3 gap-4 text-center">
        <div className="card p-3">
          <dd className="text-xl font-semibold">{profile.qualifications.length}</dd>
          <dt className="text-xs text-gray-500">Qualifications</dt>
        </div>
        <div className="card p-3">
          <dd className="text-xl font-semibold">{profile.workloads.length}</dd>
          <dt className="text-xs text-gray-500">Workload terms</dt>
        </div>
        <div className="card p-3">
          <dd className="text-xl font-semibold">{profile.teachingHistory.length}</dd>
          <dt className="text-xs text-gray-500">History entries</dt>
        </div>
      </dl>
    </div>
  );
}
