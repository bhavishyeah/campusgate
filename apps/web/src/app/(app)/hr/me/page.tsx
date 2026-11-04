"use client";

import { useState } from "react";
import { UserX } from "lucide-react";
import { toast } from "sonner";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmDialog } from "@/components/ui-ext/ConfirmDialog";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { SimpleSelect } from "@/components/ui-ext/SimpleSelect";
import { AttendanceTable } from "@/components/hr/AttendanceTable";
import { BalanceTable } from "@/components/hr/BalanceTable";
import { LeaveApplyDialog } from "@/components/hr/LeaveApplyDialog";
import { LeaveTable } from "@/components/hr/LeaveTable";
import { HrStatusBadge } from "@/components/hr/StatusBadges";
import { ApiError } from "@/lib/api";
import {
  useApplyLeave,
  useCancelMyLeave,
  useMyAttendance,
  useMyContracts,
  useMyEmployee,
  useMyLeave,
  useMyLeaveBalance,
} from "@/features/hr/hooks";
import { formatDate } from "@/features/hr/format";
import { contractTypeLabel, displayName, employmentTypeLabel } from "@/features/hr/labels";
import { formatSalary } from "@/features/hr/money";
import { selfLeaveActions } from "@/features/hr/transitions";
import type { LeaveApplication } from "@/features/hr/types";

export default function MyEmploymentPage() {
  return (
    <RouteGuard requirePermission="hr.view_own">
      <MyEmploymentInner />
    </RouteGuard>
  );
}

function MyEmploymentInner() {
  const me = useMyEmployee();
  const [tab, setTab] = useState("employment");
  const noRecord = me.error instanceof ApiError && me.error.status === 404;

  let body: React.ReactNode;
  if (!me.allowed) {
    body = <NoAccess what="your employment record" />;
  } else if (me.isLoading) {
    body = <TableSkeleton />;
  } else if (noRecord) {
    body = <EmptyState icon={UserX} label="No employee record is linked to your account." />;
  } else if (me.isError) {
    body = <ErrorBlock error={me.error} onRetry={() => void me.refetch()} />;
  } else if (me.data) {
    const e = me.data;
    body = (
      <>
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">{displayName(e.user)}</h1>
          <p className="text-sm text-gray-500">
            {e.user.name ? `${e.user.email} · ` : ""}
            {e.employeeNo} · {e.designation ?? "No designation"} <HrStatusBadge kind="employee" status={e.status} />
          </p>
        </div>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="employment">Employment</TabsTrigger>
            <TabsTrigger value="contracts">Contracts</TabsTrigger>
            <TabsTrigger value="leave">Leave</TabsTrigger>
            <TabsTrigger value="attendance">Attendance</TabsTrigger>
          </TabsList>
          <TabsContent value="employment">
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {[
                ["Employment type", employmentTypeLabel[e.employmentType] ?? e.employmentType],
                ["Department", e.department?.name ?? "-"],
                ["Joining date", formatDate(e.joiningDate)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-gray-500">{label}</dt>
                  <dd className="text-sm font-medium text-gray-900">{value}</dd>
                </div>
              ))}
            </dl>
          </TabsContent>
          <TabsContent value="contracts">
            <MyContracts enabled={tab === "contracts"} />
          </TabsContent>
          <TabsContent value="leave">
            <MyLeave enabled={tab === "leave"} />
          </TabsContent>
          <TabsContent value="attendance">
            <MyAttendance enabled={tab === "attendance"} />
          </TabsContent>
        </Tabs>
      </>
    );
  } else {
    body = null;
  }

  return <div className="space-y-6">{body}</div>;
}

function MyContracts({ enabled }: { enabled: boolean }) {
  const contracts = useMyContracts(enabled);
  const rows = contracts.data?.contracts ?? [];
  if (!contracts.allowed) return <NoAccess what="your contracts" />;
  if (contracts.isLoading) return <TableSkeleton />;
  if (contracts.isError) return <ErrorBlock error={contracts.error} onRetry={() => void contracts.refetch()} />;
  if (rows.length === 0) return <EmptyState icon={UserX} label="No contracts yet" />;
  return (
    <div className="card p-0 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Start</TableHead>
            <TableHead>End</TableHead>
            <TableHead>Salary</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((c) => (
            <TableRow key={c.id}>
              <TableCell>{contractTypeLabel[c.contractType] ?? c.contractType}</TableCell>
              <TableCell>
                <HrStatusBadge kind="contract" status={c.status} />
              </TableCell>
              <TableCell>{formatDate(c.startDate)}</TableCell>
              <TableCell>{formatDate(c.endDate)}</TableCell>
              <TableCell>{formatSalary(c.salaryAmount)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function MyLeave({ enabled }: { enabled: boolean }) {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(String(thisYear));
  const [applyOpen, setApplyOpen] = useState(false);
  const [cancelling, setCancelling] = useState<LeaveApplication | null>(null);
  const balance = useMyLeaveBalance(Number(year), enabled);
  const leave = useMyLeave(enabled);
  const apply = useApplyLeave();
  const cancel = useCancelMyLeave();

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
        <Can permission="hr.view_own">
          <Button onClick={() => setApplyOpen(true)}>Apply for leave</Button>
        </Can>
      </div>
      {!balance.allowed ? (
        <NoAccess what="your leave balance" />
      ) : balance.isLoading ? (
        <TableSkeleton />
      ) : balance.isError ? (
        <ErrorBlock error={balance.error} onRetry={() => void balance.refetch()} />
      ) : (
        <BalanceTable balances={balance.data?.balances ?? []} />
      )}
      {!leave.allowed ? (
        <NoAccess what="your leave applications" />
      ) : leave.isLoading ? (
        <TableSkeleton />
      ) : leave.isError ? (
        <ErrorBlock error={leave.error} onRetry={() => void leave.refetch()} />
      ) : (
        <LeaveTable
          rows={leave.data?.leaveApplications ?? []}
          renderActions={(r) =>
            selfLeaveActions(r.status).length > 0 ? (
              <Can permission="hr.view_own">
                <Button variant="outline" size="sm" onClick={() => setCancelling(r)}>
                  Cancel request
                </Button>
              </Can>
            ) : null
          }
        />
      )}
      <Can permission="hr.view_own">
        {applyOpen ? (
          <LeaveApplyDialog
            open
            onOpenChange={setApplyOpen}
            title="Apply for leave"
            submit={(body) => apply.mutateAsync(body)}
            pending={apply.isPending}
          />
        ) : null}
        <ConfirmDialog
          open={cancelling !== null}
          onOpenChange={(o) => !o && setCancelling(null)}
          title="Cancel leave request"
          description="Cancel this leave request?"
          confirmLabel="Cancel request"
          destructive
          pending={cancel.isPending}
          onConfirm={() => {
            if (!cancelling) return;
            cancel.mutate(cancelling.id, {
              onSuccess: () => toast.success("Leave request cancelled."),
              onSettled: () => setCancelling(null),
            });
          }}
        />
      </Can>
    </div>
  );
}

function MyAttendance({ enabled }: { enabled: boolean }) {
  const attendance = useMyAttendance(enabled);
  if (!attendance.allowed) return <NoAccess what="your attendance" />;
  if (attendance.isLoading) return <TableSkeleton />;
  if (attendance.isError) return <ErrorBlock error={attendance.error} onRetry={() => void attendance.refetch()} />;
  return <AttendanceTable rows={attendance.data?.attendance ?? []} />;
}
