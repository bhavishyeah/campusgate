"use client";

import { useState } from "react";
import { CalendarCheck } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { SectionNav, HR_STAFF_NAV } from "@/components/ui-ext/SectionNav";
import { AttendanceRecordDialog } from "@/components/hr/AttendanceRecordDialog";
import { HrStatusBadge } from "@/components/hr/StatusBadges";
import { ROSTER_PAGE_SIZE, useRoster, useShifts } from "@/features/hr/hooks";
import { todayIsoDate } from "@/features/hr/format";
import { attendanceSourceLabel, displayName } from "@/features/hr/labels";
import type { RosterRow } from "@/features/hr/types";

export default function AttendanceRosterPage() {
  return (
    <RouteGuard requirePermission="hr.attendance.manage">
      <AttendanceRosterInner />
    </RouteGuard>
  );
}

function AttendanceRosterInner() {
  const [date, setDate] = useState(todayIsoDate());
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<RosterRow | null>(null);
  const roster = useRoster(date, page);
  const shifts = useShifts();
  const shiftName = new Map((shifts.data?.shifts ?? []).map((s) => [s.id, s.name]));
  const rows = roster.data?.roster ?? [];

  const counts = { PRESENT: 0, ABSENT: 0, ON_LEAVE: 0, HALF_DAY: 0, NOT_RECORDED: 0 };
  for (const r of rows) {
    if (r.attendance) counts[r.attendance.status] += 1;
    else counts.NOT_RECORDED += 1;
  }

  return (
    <div className="space-y-6">
      <SectionNav items={HR_STAFF_NAV} />
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Attendance</h1>
        <p className="text-sm text-gray-500">Record or correct attendance for one day.</p>
      </div>
      <div className="space-y-1">
        <label htmlFor="roster-date" className="text-sm font-medium">
          Date
        </label>
        <Input
          id="roster-date"
          type="date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            setPage(1);
          }}
          className="w-44"
        />
        {date === "" ? <p className="text-sm text-gray-500">Choose a date to load the roster.</p> : null}
      </div>

      {!roster.allowed ? (
        <NoAccess what="the attendance roster" />
      ) : date === "" ? null : roster.isLoading ? (
        <TableSkeleton />
      ) : roster.isError ? (
        <ErrorBlock error={roster.error} onRetry={() => void roster.refetch()} />
      ) : !roster.data || rows.length === 0 ? (
        <EmptyState icon={CalendarCheck} label="No employees on the roster for this date." />
      ) : (
        <>
          <p className="text-sm text-gray-600" aria-label="Summary for this page">
            On this page: {counts.PRESENT} present, {counts.ABSENT} absent, {counts.ON_LEAVE} on leave,{" "}
            {counts.HALF_DAY} half day, {counts.NOT_RECORDED} not recorded.
          </p>
          <div className="card p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Designation</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Shift</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.employee.id}>
                    <TableCell>
                      <div className="font-medium">{displayName(r.employee)}</div>
                      <div className="text-xs text-gray-500">{r.employee.employeeNo}</div>
                    </TableCell>
                    <TableCell>{r.employee.designation ?? "-"}</TableCell>
                    <TableCell>
                      {r.attendance ? (
                        <HrStatusBadge kind="attendance" status={r.attendance.status} />
                      ) : (
                        <span className="text-gray-500">Not recorded</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {r.attendance ? (attendanceSourceLabel[r.attendance.source] ?? r.attendance.source) : "-"}
                    </TableCell>
                    <TableCell>
                      {r.attendance?.shiftId ? (shiftName.get(r.attendance.shiftId) ?? "-") : "-"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Can permission="hr.attendance.manage">
                        <Button variant="outline" size="sm" onClick={() => setDialog(r)}>
                          {r.attendance ? "Correct" : "Record"}
                        </Button>
                      </Can>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination page={roster.data.page} pageSize={ROSTER_PAGE_SIZE} total={roster.data.total} onPage={setPage} />
        </>
      )}

      <Can permission="hr.attendance.manage">
        {dialog ? (
          <AttendanceRecordDialog
            key={`${dialog.employee.id}-${date}`}
            open
            onOpenChange={(o) => !o && setDialog(null)}
            employeeId={dialog.employee.id}
            employeeLabel={displayName(dialog.employee)}
            date={date}
            existing={dialog.attendance}
          />
        ) : null}
      </Can>
    </div>
  );
}
