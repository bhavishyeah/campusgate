"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { BarChart3 } from "lucide-react";
import { toast } from "sonner";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Can } from "@/components/auth/Can";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { Pagination } from "@/components/ui-ext/Pagination";
import { SectionNav, HR_STAFF_NAV } from "@/components/ui-ext/SectionNav";
import { describeApiError } from "@/lib/apiErrors";
import { downloadReport, type ReportKind } from "@/features/hr/download";
import { reportRangeSchema, type ReportRangeValues } from "@/features/hr/formSchemas";
import { monthStartIsoDate, todayIsoDate } from "@/features/hr/format";
import { useAttendanceSummary, useLeaveSummary } from "@/features/hr/hooks";
import { leaveTypeLabel } from "@/features/hr/labels";

export default function HrReportsPage() {
  return (
    <RouteGuard requirePermission="hr.reports.view">
      <HrReportsInner />
    </RouteGuard>
  );
}

const SLICE = 50;
const SLICE_THRESHOLD = 200;

function DownloadButton({ kind, range }: { kind: ReportKind; range?: { from: string; to: string } }) {
  const [busy, setBusy] = useState(false);
  return (
    <Can permission="hr.reports.view">
      <Button
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await downloadReport(kind, range);
          } catch (err) {
            toast.error(describeApiError(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Downloading…" : "Download XLSX"}
      </Button>
    </Can>
  );
}

function usePagedSlice<T>(rows: T[]): { visible: T[]; page: number; setPage: (p: number) => void; paged: boolean } {
  const [page, setPage] = useState(1);
  const paged = rows.length > SLICE_THRESHOLD;
  const visible = paged ? rows.slice((page - 1) * SLICE, page * SLICE) : rows;
  return { visible, page, setPage, paged };
}

function HrReportsInner() {
  return (
    <div className="space-y-6">
      <SectionNav items={HR_STAFF_NAV} />
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Reports</h1>
        <p className="text-sm text-gray-500">Rows show employee numbers only.</p>
      </div>
      <Tabs defaultValue="leave">
        <TabsList>
          <TabsTrigger value="leave">Leave summary</TabsTrigger>
          <TabsTrigger value="attendance">Attendance summary</TabsTrigger>
        </TabsList>
        <TabsContent value="leave">
          <LeaveSummary />
        </TabsContent>
        <TabsContent value="attendance">
          <AttendanceSummary />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function LeaveSummary() {
  const summary = useLeaveSummary();
  const rows = summary.data?.rows ?? [];
  const { visible, page, setPage, paged } = usePagedSlice(rows);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-gray-600">{summary.data ? `Year ${summary.data.year}` : ""}</p>
        <DownloadButton kind="leave-summary" />
      </div>
      {!summary.allowed ? (
        <NoAccess what="HR reports" />
      ) : summary.isLoading ? (
        <TableSkeleton />
      ) : summary.isError ? (
        <ErrorBlock error={summary.error} onRetry={() => void summary.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={BarChart3} label="No leave data for this year." />
      ) : (
        <>
          <div className="card p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee no</TableHead>
                  <TableHead>Leave type</TableHead>
                  <TableHead>Year</TableHead>
                  <TableHead>Entitlement</TableHead>
                  <TableHead>Taken</TableHead>
                  <TableHead>Remaining</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((r) => (
                  <TableRow key={`${r.employeeId}-${r.leaveType}-${r.periodYear}`}>
                    <TableCell>{r.employeeNo}</TableCell>
                    <TableCell>{leaveTypeLabel[r.leaveType] ?? r.leaveType}</TableCell>
                    <TableCell>{r.periodYear}</TableCell>
                    <TableCell>{r.entitlement}</TableCell>
                    <TableCell>{r.taken}</TableCell>
                    <TableCell>{r.remaining}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {paged ? <Pagination page={page} pageSize={SLICE} total={rows.length} onPage={setPage} /> : null}
        </>
      )}
    </div>
  );
}

function AttendanceSummary() {
  const [range, setRange] = useState({ from: monthStartIsoDate(), to: todayIsoDate() });
  const form = useForm<ReportRangeValues>({
    resolver: zodResolver(reportRangeSchema),
    defaultValues: range,
  });
  const summary = useAttendanceSummary(range.from, range.to);
  const rows = summary.data?.rows ?? [];
  const { visible, page, setPage, paged } = usePagedSlice(rows);

  const onSubmit = form.handleSubmit((values) => {
    setRange(values);
    setPage(1);
  });

  return (
    <div className="space-y-3">
      <Form {...form}>
        <form onSubmit={onSubmit} className="flex flex-wrap items-start gap-3">
          <FormField
            control={form.control}
            name="from"
            render={({ field }) => (
              <FormItem>
                <FormLabel>From</FormLabel>
                <FormControl>
                  <Input type="date" {...field} className="w-44" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="to"
            render={({ field }) => (
              <FormItem>
                <FormLabel>To</FormLabel>
                <FormControl>
                  <Input type="date" {...field} className="w-44" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <div className="flex items-center gap-2 pt-6">
            <Button type="submit">Apply</Button>
            <DownloadButton kind="attendance-summary" range={range} />
          </div>
        </form>
      </Form>
      {!summary.allowed ? (
        <NoAccess what="HR reports" />
      ) : summary.isLoading ? (
        <TableSkeleton />
      ) : summary.isError ? (
        <ErrorBlock error={summary.error} onRetry={() => void summary.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={BarChart3} label="No attendance data for this range." />
      ) : (
        <>
          <div className="card p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee no</TableHead>
                  <TableHead>Present</TableHead>
                  <TableHead>Absent</TableHead>
                  <TableHead>On leave</TableHead>
                  <TableHead>Half day</TableHead>
                  <TableHead>Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((r) => (
                  <TableRow key={r.employeeId}>
                    <TableCell>{r.employeeNo}</TableCell>
                    <TableCell>{r.present}</TableCell>
                    <TableCell>{r.absent}</TableCell>
                    <TableCell>{r.onLeave}</TableCell>
                    <TableCell>{r.halfDay}</TableCell>
                    <TableCell>{r.total}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {paged ? <Pagination page={page} pageSize={SLICE} total={rows.length} onPage={setPage} /> : null}
        </>
      )}
    </div>
  );
}
