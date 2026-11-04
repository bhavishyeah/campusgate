import { Scale } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { leaveTypeLabel } from "@/features/hr/labels";
import type { LeaveBalance } from "@/features/hr/types";

export function BalanceTable({ balances }: { balances: LeaveBalance[] }) {
  if (balances.length === 0) {
    return <EmptyState icon={Scale} label="No leave balances" description="Balances exist only for active leave policies." />;
  }
  return (
    <div className="card p-0 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Leave type</TableHead>
            <TableHead>Entitlement</TableHead>
            <TableHead>Taken</TableHead>
            <TableHead>Remaining</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {balances.map((b) => (
            <TableRow key={`${b.leaveType}-${b.periodYear}`}>
              <TableCell>{leaveTypeLabel[b.leaveType] ?? b.leaveType}</TableCell>
              <TableCell>{b.entitlement}</TableCell>
              <TableCell>{b.taken}</TableCell>
              <TableCell>{b.remaining}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
