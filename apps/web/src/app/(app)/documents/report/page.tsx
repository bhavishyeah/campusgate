"use client";

import { useState } from "react";
import { toast } from "sonner";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { DOCUMENTS_STAFF_NAV, SectionNav } from "@/components/ui-ext/SectionNav";
import { downloadDocumentsReport, useDocumentReport } from "@/features/documents/hooks";
import { DOC_STATUS_LABEL } from "@/features/documents/labels";
import { describeApiError } from "@/lib/apiErrors";

export default function DocumentReportPage() {
  return (
    <RouteGuard requirePermission="documents.admin.view_all">
      <ReportInner />
    </RouteGuard>
  );
}

function ReportInner() {
  const report = useDocumentReport();
  const [exporting, setExporting] = useState(false);

  async function onExport() {
    setExporting(true);
    try {
      await downloadDocumentsReport();
    } catch (err) {
      toast.error(describeApiError(err));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <SectionNav items={DOCUMENTS_STAFF_NAV} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Documents report</h1>
          <p className="text-sm text-gray-500">Inventory by status, version totals and the purge queue.</p>
        </div>
        <Button variant="outline" onClick={() => void onExport()} disabled={exporting}>
          {exporting ? "Exporting…" : "Export XLSX"}
        </Button>
      </div>

      {!report.allowed ? (
        <NoAccess what="the documents report" />
      ) : report.isLoading ? (
        <TableSkeleton />
      ) : report.isError || !report.data ? (
        <ErrorBlock error={report.error} onRetry={() => void report.refetch()} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-gray-500">Total versions</p>
                <p className="text-2xl font-semibold text-gray-900">{report.data.totalVersions}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-gray-500">Download URL mints</p>
                <p className="text-2xl font-semibold text-gray-900">
                  {report.data.accessLog.totalDownloadUrlMints}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-gray-500">In purge queue</p>
                <p className="text-2xl font-semibold text-gray-900">{report.data.purgeQueue.length}</p>
              </CardContent>
            </Card>
          </div>

          <section>
            <h2 className="text-lg font-semibold text-gray-900">Inventory by status</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.data.inventory.map((row) => (
                  <TableRow key={row.status}>
                    <TableCell>{DOC_STATUS_LABEL[row.status] ?? row.status}</TableCell>
                    <TableCell>{row.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900">Purge queue</h2>
            {report.data.purgeQueue.length === 0 ? (
              <p className="text-sm text-gray-500">Nothing pending purge.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead>Retain until</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.data.purgeQueue.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">{row.title}</TableCell>
                      <TableCell>{row.retainUntil ? new Date(row.retainUntil).toLocaleDateString() : "-"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
