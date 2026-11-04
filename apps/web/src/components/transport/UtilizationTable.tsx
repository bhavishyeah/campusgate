"use client";

import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pagination } from "@/components/ui-ext/Pagination";
import { utilizationLabel } from "@/features/transport/format";
import { slicePage } from "@/lib/paging";
import type { UtilizationRow } from "@/features/transport/types";

const SIZE = 50;

export function UtilizationTable({ rows }: { rows: UtilizationRow[] }) {
  const [page, setPage] = useState(1);
  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Route code</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Capacity</TableHead>
            <TableHead>Enrolled</TableHead>
            <TableHead>Utilization</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {slicePage(rows, page, SIZE).map((r) => (
            <TableRow key={r.routeId}>
              <TableCell className="font-medium">{r.code}</TableCell>
              <TableCell>{r.name}</TableCell>
              <TableCell>{r.capacity === null ? "No active vehicle" : r.capacity}</TableCell>
              <TableCell>{r.enrolled}</TableCell>
              <TableCell>{utilizationLabel(r)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {rows.length > SIZE ? <Pagination page={page} pageSize={SIZE} total={rows.length} onPage={setPage} /> : null}
    </div>
  );
}
