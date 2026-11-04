"use client";

import { useState } from "react";
import { Clock } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { SectionNav, HR_STAFF_NAV } from "@/components/ui-ext/SectionNav";
import { ShiftFormDialog } from "@/components/hr/ShiftFormDialog";
import { useShifts } from "@/features/hr/hooks";
import { formatMinute } from "@/features/hr/format";
import type { Shift } from "@/features/hr/types";

export default function ShiftsPage() {
  return (
    <RouteGuard requirePermission="hr.attendance.manage">
      <ShiftsInner />
    </RouteGuard>
  );
}

function ShiftsInner() {
  const shifts = useShifts();
  const [dialog, setDialog] = useState<{ shift?: Shift } | null>(null);
  const rows = shifts.data?.shifts ?? [];

  return (
    <div className="space-y-6">
      <SectionNav items={HR_STAFF_NAV} />
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Shifts</h1>
          <p className="text-sm text-gray-500">Working-hour templates used when recording attendance.</p>
        </div>
        <Can permission="hr.attendance.manage">
          <Button onClick={() => setDialog({})}>Add shift</Button>
        </Can>
      </div>
      {!shifts.allowed ? (
        <NoAccess what="shifts" />
      ) : shifts.isLoading ? (
        <TableSkeleton />
      ) : shifts.isError ? (
        <ErrorBlock error={shifts.error} onRetry={() => void shifts.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={Clock} label="No shifts yet" />
      ) : (
        <div className="card p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Start</TableHead>
                <TableHead>End</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell>{formatMinute(s.startMinute)}</TableCell>
                  <TableCell>{formatMinute(s.endMinute)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{s.active ? "Active" : "Inactive"}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Can permission="hr.attendance.manage">
                      <Button variant="outline" size="sm" onClick={() => setDialog({ shift: s })}>
                        Edit
                      </Button>
                    </Can>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Can permission="hr.attendance.manage">
        {dialog ? (
          <ShiftFormDialog
            key={dialog.shift?.id ?? "new"}
            open
            onOpenChange={(o) => !o && setDialog(null)}
            shift={dialog.shift}
          />
        ) : null}
      </Can>
    </div>
  );
}
