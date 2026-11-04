import { CalendarOff } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { HrStatusBadge } from "@/components/hr/StatusBadges";
import { formatDate } from "@/features/hr/format";
import { displayName, leaveTypeLabel } from "@/features/hr/labels";
import type { LeaveApplication, LeaveQueueRow } from "@/features/hr/types";

type Row = LeaveApplication | LeaveQueueRow;

function hasEmployee(r: Row): r is LeaveQueueRow {
  return "employee" in r;
}

/** Leave applications. `renderActions` adds an Actions column (callers wrap controls in <Can>). */
export function LeaveTable({
  rows,
  showEmployee,
  renderActions,
  emptyLabel = "No leave applications",
}: {
  rows: Row[];
  showEmployee?: boolean;
  renderActions?: (row: Row) => React.ReactNode;
  emptyLabel?: string;
}) {
  if (rows.length === 0) return <EmptyState icon={CalendarOff} label={emptyLabel} />;
  return (
    <div className="card p-0 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            {showEmployee ? <TableHead>Employee</TableHead> : null}
            <TableHead>Type</TableHead>
            <TableHead>Dates</TableHead>
            <TableHead>Days</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Review note</TableHead>
            <TableHead>Reviewed</TableHead>
            {renderActions ? <TableHead className="text-right">Actions</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              {showEmployee ? (
                <TableCell>
                  {hasEmployee(r) ? (
                    <>
                      <div className="font-medium">{displayName(r.employee)}</div>
                      <div className="text-xs text-gray-500">{r.employee.employeeNo}</div>
                    </>
                  ) : (
                    "-"
                  )}
                </TableCell>
              ) : null}
              <TableCell>{leaveTypeLabel[r.leaveType] ?? r.leaveType}</TableCell>
              <TableCell>
                {formatDate(r.startDate)} to {formatDate(r.endDate)}
              </TableCell>
              <TableCell>{r.days}</TableCell>
              <TableCell>
                <HrStatusBadge kind="leave" status={r.status} />
              </TableCell>
              <TableCell className="max-w-[14rem] truncate" title={r.reason}>
                {r.reason}
              </TableCell>
              <TableCell>{r.reviewNote ?? "-"}</TableCell>
              <TableCell>{formatDate(r.reviewedAt)}</TableCell>
              {renderActions ? <TableCell className="text-right">{renderActions(r)}</TableCell> : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
