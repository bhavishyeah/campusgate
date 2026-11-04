import { History } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { assignmentRoleLabel, changeTypeLabel } from "@/features/faculty/labels";
import { formatDate } from "@/features/hr/format";
import type { TeachingHistoryRow } from "@/features/faculty/types";

/** Append-only ledger: no edit or delete controls. */
export function TeachingHistoryTable({ rows }: { rows: TeachingHistoryRow[] }) {
  if (rows.length === 0) {
    return <EmptyState icon={History} label="No teaching history yet" />;
  }
  return (
    <div className="card p-0 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Change</TableHead>
            <TableHead>Subject</TableHead>
            <TableHead>Section</TableHead>
            <TableHead>Term</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Effective date</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>{changeTypeLabel[r.changeType] ?? r.changeType}</TableCell>
              <TableCell>{r.subject ? `${r.subject.name} (${r.subject.code})` : "-"}</TableCell>
              <TableCell>{r.classSection?.label ?? "-"}</TableCell>
              <TableCell>{r.academicTerm?.name ?? "-"}</TableCell>
              <TableCell>{assignmentRoleLabel[r.role] ?? r.role}</TableCell>
              <TableCell>{formatDate(r.effectiveAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
