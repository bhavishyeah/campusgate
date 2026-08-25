"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import {
  Upload,
  FileSpreadsheet,
  AlertCircle,
  CheckCircle,
  X,
  ArrowRight,
} from "lucide-react";

// ─── CSV Parsing ─────────────────────────────────────────────────────────────

function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return { headers: [], rows: [] };

  const parseLine = (line: string): string[] => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  };

  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).map(parseLine);

  return { headers, rows };
}

// ─── Column Mapping ──────────────────────────────────────────────────────────

interface ColumnMapping {
  name: string | null;
  email: string | null;
  enrollmentNo: string | null;
  rollNumber: string | null;
  departmentCode: string | null;
  program: string | null;
  semester: string | null;
  section: string | null;
  dob: string | null;
  phone: string | null;
  address: string | null;
}

const REQUIRED_FIELDS = ["name", "email", "enrollmentNo", "departmentCode", "program", "semester"];
const ALL_FIELDS: { key: keyof ColumnMapping; label: string; required: boolean }[] = [
  { key: "name", label: "Name", required: true },
  { key: "email", label: "Email", required: true },
  { key: "enrollmentNo", label: "Enrollment Number", required: true },
  { key: "rollNumber", label: "Roll Number", required: false },
  { key: "departmentCode", label: "Department Code", required: true },
  { key: "program", label: "Program / Course", required: true },
  { key: "semester", label: "Semester", required: true },
  { key: "section", label: "Section", required: false },
  { key: "dob", label: "Date of Birth", required: false },
  { key: "phone", label: "Phone Number", required: false },
  { key: "address", label: "Address", required: false },
];

function autoMapColumns(headers: string[]): ColumnMapping {
  const lower = headers.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));

  const find = (patterns: string[]): string | null => {
    for (const pattern of patterns) {
      const idx = lower.findIndex((h) => h.includes(pattern));
      if (idx >= 0) return headers[idx];
    }
    return null;
  };

  return {
    name: find(["name", "studentname", "fullname"]),
    email: find(["email", "mail"]),
    enrollmentNo: find(["enrollment", "enroll", "enrolment"]),
    rollNumber: find(["roll", "rollno", "rollnumber"]),
    departmentCode: find(["department", "dept", "course", "program"]),
    program: find(["course", "program", "prog"]),
    semester: find(["semester", "sem"]),
    section: find(["section", "sec"]),
    dob: find(["dob", "dateofbirth", "birth", "birthday"]),
    phone: find(["phone", "mobile", "contact", "cell"]),
    address: find(["address", "addr"]),
  };
}

// ─── Component ───────────────────────────────────────────────────────────────

type Step = "upload" | "map" | "preview" | "result";

interface ImportResult {
  created: number;
  skipped: number;
  errors: string[];
}

export default function AdminImportPage() {
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({
    name: null,
    email: null,
    enrollmentNo: null,
    rollNumber: null,
    departmentCode: null,
    program: null,
    semester: null,
    section: null,
    dob: null,
    phone: null,
    address: null,
  });
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState("");

  // ─── File handling ─────────────────────────────────────────────────────────

  const handleFile = useCallback((f: File) => {
    setError("");
    if (!f.name.endsWith(".csv")) {
      setError("Please upload a .csv file");
      return;
    }
    if (f.size > 5 * 1024 * 1024) {
      setError("File size must be under 5 MB");
      return;
    }

    setFile(f);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const { headers: h, rows: r } = parseCSV(text);

      if (h.length < 3) {
        setError("CSV must have at least 3 columns");
        return;
      }
      if (r.length === 0) {
        setError("CSV has no data rows");
        return;
      }

      setHeaders(h);
      setRows(r);
      setMapping(autoMapColumns(h));
      setStep("map");
    };
    reader.readAsText(f);
  }, []);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
  };

  // ─── Mapping validation ────────────────────────────────────────────────────

  const mappingValid = REQUIRED_FIELDS.every(
    (f) => mapping[f as keyof ColumnMapping] !== null
  );

  // ─── Build import payload ──────────────────────────────────────────────────

  const buildPayload = () => {
    return rows.map((row) => {
      const getVal = (field: keyof ColumnMapping): string => {
        const col = mapping[field];
        if (!col) return "";
        const idx = headers.indexOf(col);
        return idx >= 0 ? (row[idx] || "").trim() : "";
      };

      const semStr = getVal("semester");
      const semester = parseInt(semStr) || 1;

      return {
        name: getVal("name"),
        email: getVal("email"),
        enrollmentNo: getVal("enrollmentNo"),
        rollNumber: getVal("rollNumber") || undefined,
        departmentCode: getVal("departmentCode"),
        program: getVal("program"),
        semester,
        section: getVal("section") || undefined,
        dob: getVal("dob") || undefined,
        phone: getVal("phone") || undefined,
        address: getVal("address") || undefined,
      };
    });
  };

  // ─── Submit ────────────────────────────────────────────────────────────────

  const handleImport = async () => {
    setImporting(true);
    setError("");

    try {
      const students = buildPayload();
      const res = await api.post<ImportResult>("/api/admin/students/bulk-import", {
        students,
      });
      setResult(res);
      setStep("result");
    } catch (err: any) {
      setError(err.message || "Import failed");
    } finally {
      setImporting(false);
    }
  };

  // ─── Reset ─────────────────────────────────────────────────────────────────

  const reset = () => {
    setStep("upload");
    setFile(null);
    setHeaders([]);
    setRows([]);
    setMapping({
      name: null,
      email: null,
      enrollmentNo: null,
      rollNumber: null,
      departmentCode: null,
      program: null,
      semester: null,
      section: null,
      dob: null,
      phone: null,
      address: null,
    });
    setResult(null);
    setError("");
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-2">
        CSV Student Import
      </h1>
      <p className="text-sm text-gray-500 mb-6">
        Upload a CSV file with student data to bulk-create accounts.
      </p>

      {/* Progress steps */}
      <div className="flex items-center gap-2 mb-8 text-sm">
        {(["upload", "map", "preview", "result"] as Step[]).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            {i > 0 && <ArrowRight className="w-4 h-4 text-gray-300" />}
            <span
              className={`px-3 py-1 rounded-full font-medium ${
                step === s
                  ? "bg-primary-100 text-primary-700"
                  : "bg-gray-100 text-gray-500"
              }`}
            >
              {i + 1}. {s.charAt(0).toUpperCase() + s.slice(1)}
            </span>
          </div>
        ))}
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-danger-50 border border-danger-500 text-danger-700 px-4 py-3 rounded-lg text-sm mb-4">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
          <button onClick={() => setError("")} className="ml-auto" aria-label="Dismiss">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ─── STEP 1: Upload ─────────────────────────────────────────────── */}
      {step === "upload" && (
        <div
          className="card border-2 border-dashed border-gray-300 hover:border-primary-400 transition-colors cursor-pointer"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          onClick={() => document.getElementById("csv-input")?.click()}
          role="button"
          aria-label="Upload CSV file"
        >
          <div className="flex flex-col items-center py-12">
            <Upload className="w-12 h-12 text-gray-400 mb-4" />
            <p className="text-lg font-medium text-gray-700 mb-1">
              Drop CSV file here or click to browse
            </p>
            <p className="text-sm text-gray-500">
              Maximum 500 rows, 5 MB. Required columns: name, email, enrollment
              number, department code, program, semester.
            </p>
          </div>
          <input
            id="csv-input"
            type="file"
            accept=".csv"
            className="hidden"
            onChange={handleFileInput}
          />
        </div>
      )}

      {/* ─── STEP 2: Column Mapping ────────────────────────────────────── */}
      {step === "map" && (
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <FileSpreadsheet className="w-5 h-5 text-primary-600" />
            <div>
              <h2 className="font-semibold text-gray-900">
                Map CSV Columns
              </h2>
              <p className="text-xs text-gray-500">
                {file?.name} — {rows.length} rows detected
              </p>
            </div>
          </div>

          <div className="space-y-3">
            {ALL_FIELDS.map((field) => (
              <div
                key={field.key}
                className="flex items-center gap-4"
              >
                <label
                  htmlFor={`map-${field.key}`}
                  className="w-44 text-sm font-medium text-gray-700 shrink-0"
                >
                  {field.label}
                  {field.required && (
                    <span className="text-danger-500 ml-0.5">*</span>
                  )}
                </label>
                <select
                  id={`map-${field.key}`}
                  className="input flex-1"
                  value={mapping[field.key] || ""}
                  onChange={(e) =>
                    setMapping({
                      ...mapping,
                      [field.key]: e.target.value || null,
                    })
                  }
                >
                  <option value="">— Skip —</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <div className="flex gap-3 mt-6">
            <button className="btn-secondary" onClick={reset}>
              Back
            </button>
            <button
              className="btn-primary flex-1"
              disabled={!mappingValid}
              onClick={() => setStep("preview")}
            >
              Preview Data
            </button>
          </div>

          {!mappingValid && (
            <p className="text-xs text-danger-600 mt-2">
              Please map all required fields (marked with *)
            </p>
          )}
        </div>
      )}

      {/* ─── STEP 3: Preview ───────────────────────────────────────────── */}
      {step === "preview" && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-900">
              Preview — {rows.length} students
            </h2>
            <span className="text-xs text-gray-500">
              Showing first {Math.min(rows.length, 10)} rows
            </span>
          </div>

          <div className="overflow-x-auto -mx-6 px-6">
            <table className="w-full text-xs">
              <caption className="sr-only">Preview of student data to import</caption>
              <thead>
                <tr className="bg-gray-50">
                  <th scope="col" className="px-3 py-2 text-left font-medium text-gray-600">Name</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium text-gray-600">Email</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium text-gray-600">Enrollment</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium text-gray-600">Dept Code</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium text-gray-600">Program</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium text-gray-600">Sem</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {buildPayload()
                  .slice(0, 10)
                  .map((student, i) => (
                    <tr key={i}>
                      <td className="px-3 py-2">{student.name || "—"}</td>
                      <td className="px-3 py-2">{student.email || "—"}</td>
                      <td className="px-3 py-2 font-mono">
                        {student.enrollmentNo || "—"}
                      </td>
                      <td className="px-3 py-2">{student.departmentCode || "—"}</td>
                      <td className="px-3 py-2">{student.program || "—"}</td>
                      <td className="px-3 py-2">{student.semester}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          {rows.length > 10 && (
            <p className="text-xs text-gray-500 mt-2 text-center">
              ...and {rows.length - 10} more
            </p>
          )}

          <div className="flex gap-3 mt-6">
            <button className="btn-secondary" onClick={() => setStep("map")}>
              Back
            </button>
            <button
              className="btn-primary flex-1"
              disabled={importing}
              onClick={handleImport}
            >
              {importing
                ? `Importing ${rows.length} students...`
                : `Import ${rows.length} Students`}
            </button>
          </div>
        </div>
      )}

      {/* ─── STEP 4: Result ────────────────────────────────────────────── */}
      {step === "result" && result && (
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <CheckCircle className="w-8 h-8 text-success-500" />
            <h2 className="text-lg font-semibold text-gray-900">
              Import Complete
            </h2>
          </div>

          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="bg-success-50 rounded-lg p-4 text-center">
              <p className="text-2xl font-bold text-success-700">
                {result.created}
              </p>
              <p className="text-xs text-success-600">Created</p>
            </div>
            <div className="bg-gray-100 rounded-lg p-4 text-center">
              <p className="text-2xl font-bold text-gray-700">
                {result.skipped}
              </p>
              <p className="text-xs text-gray-600">Skipped</p>
            </div>
          </div>

          {result.errors.length > 0 && (
            <div className="bg-warning-50 border border-warning-500 rounded-lg p-4 mb-4">
              <p className="text-sm font-medium text-warning-600 mb-2">
                Issues ({result.errors.length}):
              </p>
              <ul className="text-xs text-warning-600 space-y-1 max-h-40 overflow-y-auto">
                {result.errors.map((err, i) => (
                  <li key={i}>• {err}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-sm text-gray-600 mb-4">
            Each created student received a temporary password. They can sign in
            and will appear in the Users list.
          </p>

          <button className="btn-primary w-full" onClick={reset}>
            Import Another File
          </button>
        </div>
      )}
    </div>
  );
}
