"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Upload, FileDown, FileSpreadsheet, ArrowLeft } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { InlineError } from "@/components/ui-ext/InlineError";
import { ConfirmDialog } from "@/components/ui-ext/ConfirmDialog";
import { Pagination } from "@/components/ui-ext/Pagination";
import { ApiError } from "@/lib/api";
import { useBulkImportStudents } from "@/features/sis/hooks";
import {
  BULK_IMPORT_MAX,
  TEMPLATE_HEADERS,
  buildRows,
  parseCsv,
  rowsToRecords,
  type BulkImportResult,
  type ValidatedRow,
} from "@/features/sis/importCsv";

// Department CODE reference for the demo tenant — these go in the `courseCode`
// column (the server resolves the department BY CODE).
const DEPARTMENT_CODES: Array<{ code: string; name: string }> = [
  { code: "110", name: "B.Com" },
  { code: "501", name: "B.Tech CSE" },
  { code: "502", name: "B.Tech ECE" },
  { code: "504", name: "B.Tech EE" },
  { code: "510", name: "BBA" },
  { code: "512", name: "BCA" },
  { code: "513", name: "BHM" },
  { code: "601", name: "B.Sc Animation" },
  { code: "602", name: "B.Sc IT" },
];

const PREVIEW_PAGE_SIZE = 20;
const ERROR_PAGE_SIZE = 25;

export default function ImportStudentsPage() {
  return (
    <RouteGuard requirePermission="admin.students.import">
      <ImportStudentsInner />
    </RouteGuard>
  );
}

function ImportStudentsInner() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [rows, setRows] = useState<ValidatedRow[] | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<BulkImportResult | null>(null);
  const [previewPage, setPreviewPage] = useState(1);
  const [errorPage, setErrorPage] = useState(1);

  const mutation = useBulkImportStudents();

  const validRows = useMemo(
    () => (rows ? rows.filter((r) => r.valid) : []),
    [rows],
  );
  const invalidRows = useMemo(
    () => (rows ? rows.filter((r) => !r.valid) : []),
    [rows],
  );

  function downloadTemplate() {
    // Header-only CSV generated client-side (no new dependency).
    const content = TEMPLATE_HEADERS.join(",") + "\r\n";
    const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = "students-import-template.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset downstream state whenever a new file is chosen.
    setResult(null);
    setParseError(null);
    setRows(null);
    setPreviewPage(1);
    setErrorPage(1);
    mutation.reset();
    if (!file) {
      setFileName(null);
      return;
    }
    setFileName(file.name);
    try {
      const text = await file.text();
      const { records } = rowsToRecords(parseCsv(text));
      if (records.length === 0) {
        setParseError("No data rows found in the file (only a header, or empty).");
        return;
      }
      setRows(buildRows(records));
    } catch {
      setParseError("Could not read the file. Make sure it is a valid .csv file.");
    }
  }

  function onConfirmImport() {
    setConfirmOpen(false);
    mutation.mutate(
      validRows.map((r) => r.row),
      { onSuccess: (res) => setResult(res) },
    );
  }

  const submitError =
    mutation.error instanceof ApiError
      ? mutation.error.message
      : mutation.error
        ? "The import failed. Please try again."
        : null;

  const previewTotal = rows?.length ?? 0;
  const pagedPreview = (rows ?? []).slice(
    (previewPage - 1) * PREVIEW_PAGE_SIZE,
    previewPage * PREVIEW_PAGE_SIZE,
  );
  const pagedErrors = (result?.errors ?? []).slice(
    (errorPage - 1) * ERROR_PAGE_SIZE,
    errorPage * ERROR_PAGE_SIZE,
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/sis/students"
            className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to students
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-gray-900">
            Import students
          </h1>
          <p className="text-sm text-gray-500">
            Upload a CSV to create students in bulk. Rows whose enrollment number
            already exists are <strong>updated in place</strong> (re-uploading the
            same file updates existing students rather than duplicating them).
          </p>
        </div>
      </div>

      {/* Step 1 — template + department codes */}
      <section className="card p-5 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-medium text-gray-900">
              1. Download the template
            </h2>
            <p className="text-sm text-gray-500">
              Columns: {TEMPLATE_HEADERS.join(", ")}. Put the department CODE in
              the <code>courseCode</code> column.
            </p>
          </div>
          <Button variant="outline" onClick={downloadTemplate}>
            <FileDown className="w-4 h-4" aria-hidden="true" /> Download template
          </Button>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Department codes (courseCode)
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {DEPARTMENT_CODES.map((d) => (
              <Badge key={d.code} variant="secondary">
                {d.code} — {d.name}
              </Badge>
            ))}
          </div>
        </div>
      </section>

      {/* Step 2 — pick a file */}
      <section className="card p-5 space-y-3">
        <div>
          <h2 className="text-base font-medium text-gray-900">
            2. Choose your CSV
          </h2>
          <p className="text-sm text-gray-500">
            Up to {BULK_IMPORT_MAX} rows per request are sent at a time; larger
            files are split automatically.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={onFileChange}
            className="block w-full text-sm text-gray-600 file:mr-4 file:rounded-md file:border-0 file:bg-primary-600 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-primary-700"
            aria-label="Choose a CSV file"
          />
        </div>
        {fileName && (
          <p className="text-sm text-gray-500">
            Selected: <span className="font-medium">{fileName}</span>
          </p>
        )}
        {parseError && <InlineError message={parseError} />}
      </section>

      {/* Step 3 — preview + submit */}
      {!rows && !result && !parseError && (
        <EmptyState
          icon={FileSpreadsheet}
          label="No file selected yet"
          description="Download the template, fill it in, then choose it above to preview and import."
        />
      )}

      {rows && !result && (
        <section className="card p-5 space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-medium text-gray-900">
                3. Review &amp; import
              </h2>
              <p className="text-sm text-gray-500">
                {validRows.length} valid · {invalidRows.length} invalid (of{" "}
                {rows.length}).{" "}
                {invalidRows.length > 0 &&
                  "Invalid rows are dropped; only valid rows are imported."}
              </p>
            </div>
            <Button
              onClick={() => setConfirmOpen(true)}
              disabled={validRows.length === 0 || mutation.isPending}
            >
              <Upload className="w-4 h-4" aria-hidden="true" />
              {mutation.isPending
                ? "Importing…"
                : `Import ${validRows.length} student${validRows.length === 1 ? "" : "s"}`}
            </Button>
          </div>

          {submitError && <InlineError message={submitError} />}

          <div className="card p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Line</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Enrollment</TableHead>
                  <TableHead>Course</TableHead>
                  <TableHead>Sem</TableHead>
                  <TableHead>Issues</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedPreview.map((r) => (
                  <TableRow key={r.line}>
                    <TableCell className="text-gray-500">{r.line}</TableCell>
                    <TableCell>
                      <Badge variant={r.valid ? "default" : "destructive"}>
                        {r.valid ? "Valid" : "Invalid"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-gray-600">{r.row.email || "—"}</TableCell>
                    <TableCell className="font-medium">{r.row.name || "—"}</TableCell>
                    <TableCell className="text-gray-600">
                      {r.row.enrollmentNo || "—"}
                    </TableCell>
                    <TableCell className="text-gray-600">
                      {r.row.courseCode || "—"}
                    </TableCell>
                    <TableCell className="text-gray-600">
                      {Number.isNaN(r.row.semester) ? "—" : r.row.semester}
                    </TableCell>
                    <TableCell className="text-danger-700 text-xs">
                      {r.problems.join("; ")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {previewTotal > PREVIEW_PAGE_SIZE && (
            <Pagination
              page={previewPage}
              pageSize={PREVIEW_PAGE_SIZE}
              total={previewTotal}
              onPage={setPreviewPage}
            />
          )}
        </section>
      )}

      {/* Step 4 — results */}
      {result && (
        <section className="card p-5 space-y-4">
          <h2 className="text-base font-medium text-gray-900">Import complete</h2>
          <div className="grid grid-cols-3 gap-4">
            <ResultStat label="Created" value={result.created} tone="success" />
            <ResultStat label="Updated" value={result.updated} tone="info" />
            <ResultStat label="Skipped" value={result.skipped} tone="muted" />
          </div>
          <p className="text-sm text-gray-500">
            Students matched by an existing enrollment number were counted under{" "}
            <strong>Updated</strong>, not skipped.
          </p>

          {result.errors.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-gray-900">
                Errors ({result.errors.length})
              </p>
              <ul className="max-h-72 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-danger-700 space-y-1">
                {pagedErrors.map((err, i) => (
                  <li key={(errorPage - 1) * ERROR_PAGE_SIZE + i}>{err}</li>
                ))}
              </ul>
              {result.errors.length > ERROR_PAGE_SIZE && (
                <Pagination
                  page={errorPage}
                  pageSize={ERROR_PAGE_SIZE}
                  total={result.errors.length}
                  onPage={setErrorPage}
                />
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-500">No errors reported.</p>
          )}

          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link href="/sis/students">View students</Link>
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setRows(null);
                setResult(null);
                setFileName(null);
                setParseError(null);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
            >
              Import another file
            </Button>
          </div>
        </section>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Import students"
        description={`About to import ${validRows.length} student${validRows.length === 1 ? "" : "s"}. Rows whose enrollment number already exists will be UPDATED in place.`}
        confirmLabel="Import"
        pending={mutation.isPending}
        onConfirm={onConfirmImport}
        onOpenChange={setConfirmOpen}
      />
    </div>
  );
}

function ResultStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "success" | "info" | "muted";
}) {
  const toneClass =
    tone === "success"
      ? "text-green-700"
      : tone === "info"
        ? "text-primary-700"
        : "text-gray-600";
  return (
    <div className="rounded-lg border border-gray-200 p-4 text-center">
      <p className={`text-3xl font-semibold ${toneClass}`}>{value}</p>
      <p className="mt-1 text-sm text-gray-500">{label}</p>
    </div>
  );
}
