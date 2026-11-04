import { CalendarCheck } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { HrStatusBadge } from "@/components/hr/StatusBadges";
import { formatDate } from "@/features/hr/format";
import { attendanceSourceLabel } from "@/features/hr/labels";
import type { AttendanceRow } from "@/features/hr/types";

/** One employee's attendance, newest first. `renderActions` adds an Actions column. */
export function AttendanceTable({
  rows,
  renderActions,
}: {
  rows: AttendanceRow[];
  renderActions?: (row: AttendanceRow) => React.ReactNode;
}) {
  if (rows.length === 0) return <EmptyState icon={CalendarCheck} label="No attendance recorded" />;
  return (
    <div className="card p-0 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Source</TableHead>
            {renderActions ? <TableHead className="text-right">Actions</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>{formatDate(r.attendanceDate)}</TableCell>
              <TableCell>
                <HrStatusBadge kind="attendance" status={r.status} />
              </TableCell>
              <TableCell>{attendanceSourceLabel[r.source] ?? r.source}</TableCell>
              {renderActions ? <TableCell className="text-right">{renderActions(r)}</TableCell> : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
