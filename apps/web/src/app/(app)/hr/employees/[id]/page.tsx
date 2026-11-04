"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { UserX } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { SectionNav, HR_STAFF_NAV } from "@/components/ui-ext/SectionNav";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { AttendanceRecordDialog } from "@/components/hr/AttendanceRecordDialog";
import { AttendanceTable } from "@/components/hr/AttendanceTable";
import { BalanceTable } from "@/components/hr/BalanceTable";
import { ContractsPanel } from "@/components/hr/ContractsPanel";
import { EmployeeFormDialog } from "@/components/hr/EmployeeFormDialog";
import { LeaveApplyDialog } from "@/components/hr/LeaveApplyDialog";
import { LeaveTable } from "@/components/hr/LeaveTable";
import { HrStatusBadge } from "@/components/hr/StatusBadges";
import { ApiError } from "@/lib/api";
import {
  useApplyLeaveForEmployee,
  useEmployee,
  useEmployeeAttendance,
  useEmployeeLeave,
  useLeaveBalance,
} from "@/features/hr/hooks";
import { formatDate, todayIsoDate, toDateInput } from "@/features/hr/format";
import { displayName, employmentTypeLabel } from "@/features/hr/labels";
import type { AttendanceRow } from "@/features/hr/types";

export default function EmployeeDetailPage() {
  return (
    <RouteGuard requirePermission="hr.directory.view">
      <EmployeeDetailInner />
    </RouteGuard>
  );
}

const ATTENDANCE_STEP = 30;

function EmployeeDetailInner() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const employee = useEmployee(id);
  const [tab, setTab] = useState("overview");
  const [editOpen, setEditOpen] = useState(false);

  const notFound = employee.error instanceof ApiError && employee.error.status === 404;

  let body: React.ReactNode;
  if (!employee.allowed) {
    body = <NoAccess what="employee records" />;
  } else if (employee.isLoading) {
    body = <TableSkeleton />;
  } else if (notFound) {
    body = <EmptyState icon={UserX} label="Employee not found." />;
  } else if (employee.isError) {
    body = <ErrorBlock error={employee.error} onRetry={() => void employee.refetch()} />;
  } else if (employee.data) {
    const e = employee.data;
    body = (
      <>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">{displayName(e.user)}</h1>
            <p className="text-sm text-gray-500">
              {e.user.name ? `${e.user.email} · ` : ""}
              {e.employeeNo} <HrStatusBadge kind="employee" status={e.status} />
            </p>
          </div>
          <Can permission="hr.employees.manage">
            <Button variant="outline" onClick={() => setEditOpen(true)}>
              Edit
            </Button>
          </Can>
        </div>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="contracts">Contracts</TabsTrigger>
            <TabsTrigger value="leave">Leave</TabsTrigger>
            <TabsTrigger value="attendance">Attendance</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {[
                ["Designation", e.designation ?? "-"],
                ["Employment type", employmentTypeLabel[e.employmentType] ?? e.employmentType],
                ["Department", e.department?.name ?? "-"],
                ["Joining date", formatDate(e.joiningDate)],
                ["Linked user", e.user.email],
                ["Created", formatDate(e.createdAt)],
                ["Last updated", formatDate(e.updatedAt)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-gray-500">{label}</dt>
                  <dd className="text-sm font-medium text-gray-900">{value}</dd>
                </div>
              ))}
            </dl>
          </TabsContent>
          <TabsContent value="contracts">
            <ContractsPanel employeeId={id} enabled={tab === "contracts"} />
          </TabsContent>
          <TabsContent value="leave">
            <LeaveTab employeeId={id} enabled={tab === "leave"} />
          </TabsContent>
          <TabsContent value="attendance">
            <AttendanceTab employeeId={id} employeeLabel={displayName(e.user)} enabled={tab === "attendance"} />
          </TabsContent>
        </Tabs>
        <Can permission="hr.employees.manage">
          {editOpen ? <EmployeeFormDialog open onOpenChange={setEditOpen} employee={e} /> : null}
        </Can>
      </>
    );
  } else {
    body = null;
  }

  return (
    <div className="space-y-6">
      <SectionNav items={HR_STAFF_NAV} />
      <Link href="/hr" className="text-sm text-primary-600 underline">
        Back to employees
      </Link>
      {body}
    </div>
  );
}

function LeaveTab({ employeeId, enabled }: { employeeId: string; enabled: boolean }) {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(String(thisYear));
  const [applyOpen, setApplyOpen] = useState(false);
  const balance = useLeaveBalance(employeeId, Number(year), enabled);
  const leave = useEmployeeLeave(employeeId, enabled);
  const apply = useApplyLeaveForEmployee(employeeId);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div className="w-32">
          <SimpleSelect
            ariaLabel="Year"
            value={year}
            onChange={setYear}
            options={[thisYear - 1, thisYear, thisYear + 1].map((y) => ({ value: String(y), label: String(y) }))}
          />
        </div>
        <Can permission="hr.leave.manage">
          <Button onClick={() => setApplyOpen(true)}>Apply leave for employee</Button>
        </Can>
      </div>
      {!balance.allowed ? (
        <NoAccess what="leave balances" />
      ) : balance.isLoading ? (
        <TableSkeleton />
      ) : balance.isError ? (
        <ErrorBlock error={balance.error} onRetry={() => void balance.refetch()} />
      ) : (
        <BalanceTable balances={balance.data?.balances ?? []} />
      )}
      {!leave.allowed ? (
        <NoAccess what="leave applications" />
      ) : leave.isLoading ? (
        <TableSkeleton />
      ) : leave.isError ? (
        <ErrorBlock error={leave.error} onRetry={() => void leave.refetch()} />
      ) : (
        <LeaveTable rows={leave.data?.leaveApplications ?? []} />
      )}
      <Can permission="hr.leave.manage">
        {applyOpen ? (
          <LeaveApplyDialog
            open
            onOpenChange={setApplyOpen}
            title="Apply leave for employee"
            submit={(body) => apply.mutateAsync(body)}
            pending={apply.isPending}
          />
        ) : null}
      </Can>
    </div>
  );
}

function AttendanceTab({
  employeeId,
  employeeLabel,
  enabled,
}: {
  employeeId: string;
  employeeLabel: string;
  enabled: boolean;
}) {
  const attendance = useEmployeeAttendance(employeeId, enabled);
  const [visible, setVisible] = useState(ATTENDANCE_STEP);
  const [recordDate, setRecordDate] = useState(todayIsoDate());
  const [dialog, setDialog] = useState<{ date: string; existing?: AttendanceRow } | null>(null);
  const rows = attendance.data?.attendance ?? [];

  return (
    <div className="space-y-3">
      <Can permission="hr.attendance.manage">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label htmlFor="record-date" className="text-sm font-medium">
              Date
            </label>
            <Input
              id="record-date"
              type="date"
              value={recordDate}
              onChange={(ev) => setRecordDate(ev.target.value)}
              className="w-44"
            />
          </div>
          <Button disabled={!recordDate} onClick={() => setDialog({ date: recordDate })}>
            Record attendance
          </Button>
        </div>
      </Can>
      {!attendance.allowed ? (
        <NoAccess what="attendance" />
      ) : attendance.isLoading ? (
        <TableSkeleton />
      ) : attendance.isError ? (
        <ErrorBlock error={attendance.error} onRetry={() => void attendance.refetch()} />
      ) : (
        <>
          <AttendanceTable
            rows={rows.slice(0, visible)}
            renderActions={(r) => (
              <Can permission="hr.attendance.manage">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDialog({ date: toDateInput(r.attendanceDate), existing: r })}
                >
                  Correct
                </Button>
              </Can>
            )}
          />
          {rows.length > visible ? (
            <Button variant="outline" size="sm" onClick={() => setVisible((v) => v + ATTENDANCE_STEP)}>
              Show more
            </Button>
          ) : null}
        </>
      )}
      <Can permission="hr.attendance.manage">
        {dialog ? (
          <AttendanceRecordDialog
            key={`${dialog.date}-${dialog.existing?.id ?? "new"}`}
            open
            onOpenChange={(o) => !o && setDialog(null)}
            employeeId={employeeId}
            employeeLabel={employeeLabel}
            date={dialog.date}
            existing={dialog.existing}
          />
        ) : null}
      </Can>
    </div>
  );
}
