"use client";

import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pagination } from "@/components/ui-ext/Pagination";
import { stopLabel } from "@/features/transport/format";
import { formatDate } from "@/features/hr/format";
import { slicePage } from "@/lib/paging";
import type { EnrollmentRow } from "@/features/transport/types";

const SIZE = 50;

/** Active enrollments only; always paged client-side by 50. */
export function RosterTable({ rows }: { rows: EnrollmentRow[] }) {
  const [page, setPage] = useState(1);
  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Route</TableHead>
            <TableHead>Student</TableHead>
            <TableHead>Enrollment no</TableHead>
            <TableHead>Stop</TableHead>
            <TableHead>Enrolled on</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {slicePage(rows, page, SIZE).map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                {r.route.code} - {r.route.name}
              </TableCell>
              <TableCell className="font-medium">{r.student.name}</TableCell>
              <TableCell>{r.student.enrollmentNo ?? "-"}</TableCell>
              <TableCell>{stopLabel(r.stop)}</TableCell>
              <TableCell>{formatDate(r.enrolledAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Pagination page={Math.min(page, Math.max(1, Math.ceil(rows.length / SIZE)))} pageSize={SIZE} total={rows.length} onPage={setPage} />
    </div>
  );
}
