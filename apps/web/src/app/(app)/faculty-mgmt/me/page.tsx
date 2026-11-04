"use client";

import { UserX } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { FacultyOverview } from "@/components/faculty/FacultyOverview";
import { QualificationsTable } from "@/components/faculty/QualificationsTable";
import { TeachingHistoryTable } from "@/components/faculty/TeachingHistoryTable";
import { ApiError } from "@/lib/api";
import { useMyFacultyProfile } from "@/features/faculty/hooks";
import { formatHours } from "@/features/faculty/workload";

export default function MyFacultyProfilePage() {
  return (
    <RouteGuard requirePermission="faculty.view_own">
      <MyFacultyProfileInner />
    </RouteGuard>
  );
}

function MyFacultyProfileInner() {
  const me = useMyFacultyProfile();
  const notFaculty =
    me.error instanceof ApiError && me.error.status === 403 && me.error.message === "not a faculty member";

  let body: React.ReactNode;
  if (!me.allowed) {
    body = <NoAccess what="your faculty profile" />;
  } else if (me.isLoading) {
    body = <TableSkeleton />;
  } else if (notFaculty) {
    body = <EmptyState icon={UserX} label="No faculty record is linked to your account." />;
  } else if (me.isError) {
    body = <ErrorBlock error={me.error} onRetry={() => void me.refetch()} />;
  } else if (me.data) {
    const p = me.data;
    body = (
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="qualifications">Qualifications</TabsTrigger>
          <TabsTrigger value="workload">Workload</TabsTrigger>
          <TabsTrigger value="history">Teaching history</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <FacultyOverview profile={p} />
        </TabsContent>
        <TabsContent value="qualifications">
          <QualificationsTable rows={p.qualifications} />
        </TabsContent>
        <TabsContent value="workload">
          {p.workloads.length === 0 ? (
            <EmptyState icon={UserX} label="No workload recorded yet." />
          ) : (
            <div className="card p-0 overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Term</TableHead>
                    <TableHead>Teaching</TableHead>
                    <TableHead>Non-teaching</TableHead>
                    <TableHead>Total</TableHead>
                    <TableHead>Policy maximum</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {p.workloads.map((w) => (
                    <TableRow key={w.id}>
                      <TableCell>{w.academicTerm?.name ?? "-"}</TableCell>
                      <TableCell>{formatHours(w.teachingHours)}</TableCell>
                      <TableCell>{formatHours(w.nonTeachingHours)}</TableCell>
                      <TableCell>{formatHours(w.totalHours)}</TableCell>
                      <TableCell>
                        {w.policyMaxWeeklyHours === null ? "Not capped" : formatHours(w.policyMaxWeeklyHours)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
        <TabsContent value="history">
          <TeachingHistoryTable rows={p.teachingHistory} />
        </TabsContent>
      </Tabs>
    );
  } else {
    body = null;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">My faculty profile</h1>
        <p className="text-sm text-gray-500">Read-only view of your qualifications, workload and teaching history.</p>
      </div>
      {body}
    </div>
  );
}
