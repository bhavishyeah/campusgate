"use client";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { Users } from "lucide-react";

export default function FacultyAssignmentsPage() {
  return (
    <RouteGuard>
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-gray-900">Faculty Assignments</h1>
        <EmptyState
          icon={Users}
          label="Coming soon"
          description="The faculty assignments list requires a backend endpoint (GET /api/classes/faculty/assignments) that is not yet available."
        />
      </div>
    </RouteGuard>
  );
}
