"use client";

import { useState } from "react";
import { BarChart2 } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { InlineError } from "@/components/ui-ext/InlineError";
import { ApiError } from "@/lib/api";
import { useSectionReport } from "@/features/attendance/hooks";

export default function AttendanceReportPage() {
  return (
    <RouteGuard>
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-gray-900">Attendance Report</h1>
        <Can
          permission="attendance.view"
          fallback={
            <EmptyState
              icon={BarChart2}
              label="Permission required"
              description="You need the attendance.view permission to access section reports."
            />
          }
        >
          <ReportFilterAndTable />
        </Can>
      </div>
    </RouteGuard>
  );
}

function ReportFilterAndTable() {
  const [sectionIdInput, setSectionIdInput] = useState("");
  const [termIdInput, setTermIdInput] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [termId, setTermId] = useState("");

  const { data, isLoading, isError, error } = useSectionReport(sectionId, termId);

  function handleView() {
    setSectionId(sectionIdInput.trim());
    setTermId(termIdInput.trim());
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-end flex-wrap">
        <div className="space-y-1">
          <label className="text-sm font-medium text-gray-700">Section ID</label>
          <Input
            placeholder="Section ID"
            value={sectionIdInput}
            onChange={(e) => setSectionIdInput(e.target.value)}
            className="w-56"
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium text-gray-700">Academic Term ID</label>
          <Input
            placeholder="Term ID"
            value={termIdInput}
            onChange={(e) => setTermIdInput(e.target.value)}
            className="w-56"
          />
        </div>
        <Button onClick={handleView} disabled={!sectionIdInput || !termIdInput}>
          View Report
        </Button>
      </div>

      {!sectionId || !termId ? null : isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      ) : isError ? (
        <InlineError
          message={error instanceof ApiError ? error.message : "Failed to load report."}
        />
      ) : !data || data.perStudent.length === 0 ? (
        <EmptyState
          icon={BarChart2}
          label="No data"
          description="No attendance data found for this section and term."
        />
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-gray-500">
            Threshold: {data.thresholdPercent}% — {data.lowAttendance.length} student(s) below threshold.
          </p>
          <div className="card p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Student ID</TableHead>
                  <TableHead>Attendance Rate (%)</TableHead>
                  <TableHead>Low Attendance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.perStudent.map((entry) => {
                  const isLow = data.lowAttendance.some((l) => l.studentId === entry.studentId);
                  return (
                    <TableRow key={entry.studentId}>
                      <TableCell className="font-mono text-xs">{entry.studentId}</TableCell>
                      <TableCell>{entry.rate.toFixed(1)}%</TableCell>
                      <TableCell>
                        {isLow && (
                          <Badge variant="destructive">Below threshold</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
