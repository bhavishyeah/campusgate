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
  Pencil,
  Plus,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Course {
  id: string;
  name: string;
  code: string;
}

interface StudentRow {
  name: string;
  email: string;
  enrollmentNo: string;
  rollNumber: string;
  courseCode: string;
  program: string;
  semester: number;
  section: string;
  dob: string;
  phone: string;
  address: string;
}

interface ImportResult {
  created: number;
  skipped: number;
  errors: string[];
}

type Step = "upload" | "map" | "resolve" | "preview" | "result";

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
  courseCode: string | null;
  program: string | null;
  semester: string | null;
  section: string | null;
  dob: string | null;
  phone: string | null;
  address: string | null;
}

const ALL_FIELDS: { key: keyof ColumnMapping; label: string; required: boolean }[] = [
  { key: "name", label: "Name", required: true },
  { key: "email", label: "Email", required: true },
  { key: "enrollmentNo", label: "Enrollment Number", required: true },
  { key: "rollNumber", label: "Roll Number", required: false },
  { key: "courseCode", label: "Course Code", required: true },
  { key: "program", label: "Program / Course Name", required: true },
  { key: "semester", label: "Semester", required: true },
  { key: "section", label: "Section", required: false },
  { key: "dob", label: "Date of Birth", required: false },
  { key: "phone", label: "Phone Number", required: false },
  { key: "address", label: "Address", required: false },
];

const REQUIRED_FIELDS = ALL_FIELDS.filter((f) => f.required).map((f) => f.key);

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
    courseCode: find(["coursecode", "deptcode", "departmentcode", "code"]),
    program: find(["course", "program", "prog", "coursename"]),
    semester: find(["semester", "sem"]),
    section: find(["section", "sec"]),
    dob: find(["dob", "dateofbirth", "birth", "birthday"]),
    phone: find(["phone", "mobile", "contact", "cell"]),
    address: find(["address", "addr"]),
  };
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function AdminImportPage() {
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({
    name: null, email: null, enrollmentNo: null, rollNumber: null,
    courseCode: null, program: null, semester: null, section: null,
    dob: null, phone: null, address: null,
  });
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseResolution, setCourseResolution] = useState<Record<string, string>>({});
  const [newCourseName, setNewCourseName] = useState("");
  const [newCourseCode, setNewCourseCode] = useState("");
  const [creatingCourse, setCreatingCourse] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState("");
  const [editingCell, setEditingCell] = useState<{ row: number; col: keyof StudentRow } | null>(null);

  // Load courses
  useEffect(() => {
    api.get<Course[]>("/api/admin/departments").then(setCourses).catch(() => {});
  }, []);

  // ─── File handling ─────────────────────────────────────────────────────────

  const handleFile = useCallback((f: File) => {
    setError("");
    if (!f.name.endsWith(".csv")) { setError("Please upload a .csv file"); return; }
    if (f.size > 5 * 1024 * 1024) { setError("File size must be under 5 MB"); return; }

    setFile(f);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const { headers: h, rows: r } = parseCSV(text);
      if (h.length < 3) { setError("CSV must have at least 3 columns"); return; }
      if (r.length === 0) { setError("CSV has no data rows"); return; }
      setHeaders(h);
      setRawRows(r);
      setMapping(autoMapColumns(h));
      setStep("map");
    };
    reader.readAsText(f);
  }, []);

  const handleDrop = (e: React.DragEvent) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); };
  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) handleFile(f); };

  // ─── Mapping → Build students → Course resolution ──────────────────────────

  const mappingValid = REQUIRED_FIELDS.every((f) => mapping[f as keyof ColumnMapping] !== null);

  const buildStudents = (): StudentRow[] => {
    return rawRows.map((row) => {
      const getVal = (field: keyof ColumnMapping): string => {
        const col = mapping[field];
        if (!col) return "";
        const idx = headers.indexOf(col);
        return idx >= 0 ? (row[idx] || "").trim() : "";
      };
      return {
        name: getVal("name"),
        email: getVal("email"),
        enrollmentNo: getVal("enrollmentNo"),
        rollNumber: getVal("rollNumber"),
        courseCode: getVal("courseCode"),
        program: getVal("program"),
        semester: parseInt(getVal("semester")) || 1,
        section: getVal("section"),
        dob: getVal("dob"),
        phone: getVal("phone"),
        address: getVal("address"),
      };
    });
  };

  const proceedToResolve = () => {
    const built = buildStudents();
    setStudents(built);

    // Find unique course codes from CSV
    const uniqueCodes = [...new Set(built.map((s) => s.courseCode).filter(Boolean))];

    // Auto-resolve: match CSV codes against existing courses
    const resolution: Record<string, string> = {};
    for (const csvCode of uniqueCodes) {
      const match = courses.find(
        (c) => c.code.toLowerCase() === csvCode.toLowerCase() ||
               c.name.toLowerCase().includes(csvCode.toLowerCase()) ||
               csvCode.toLowerCase().includes(c.code.toLowerCase())
      );
      if (match) {
        resolution[csvCode] = match.code;
      } else {
        resolution[csvCode] = ""; // unresolved
      }
    }
    setCourseResolution(resolution);
    setStep("resolve");
  };

  const allResolved = Object.values(courseResolution).every((v) => v !== "");

  // ─── Apply resolution to students ─────────────────────────────────────────

  const applyResolution = () => {
    const resolved = students.map((s) => ({
      ...s,
      courseCode: courseResolution[s.courseCode] || s.courseCode,
    }));
    setStudents(resolved);
    setStep("preview");
  };

  // ─── Create course inline ──────────────────────────────────────────────────

  const handleCreateCourse = async (csvValue: string) => {
    if (!newCourseName || !newCourseCode) return;
    setCreatingCourse(csvValue);
    try {
      const created = await api.post<Course>("/api/admin/departments", {
        name: newCourseName,
        code: newCourseCode.toUpperCase(),
      });
      setCourses((prev) => [...prev, created]);
      setCourseResolution((prev) => ({ ...prev, [csvValue]: created.code }));
      setNewCourseName("");
      setNewCourseCode("");
    } catch (err: any) {
      setError(err.message || "Failed to create course");
    } finally {
      setCreatingCourse(null);
    }
  };

  // ─── Editable cell ─────────────────────────────────────────────────────────

  const updateCell = (rowIdx: number, col: keyof StudentRow, value: string) => {
    setStudents((prev) => {
      const copy = [...prev];
      copy[rowIdx] = { ...copy[rowIdx], [col]: col === "semester" ? parseInt(value) || 1 : value };
      return copy;
    });
  };

  // ─── Submit ────────────────────────────────────────────────────────────────

  const handleImport = async () => {
    setImporting(true);
    setError("");
    try {
      const payload = students.map((s) => ({
        ...s,
        semester: Number(s.semester) || 1,
        rollNumber: s.rollNumber || undefined,
        section: s.section || undefined,
        dob: s.dob || undefined,
        phone: s.phone || undefined,
        address: s.address || undefined,
      }));
      const res = await api.post<ImportResult>("/api/admin/students/bulk-import", { students: payload });
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
    setStep("upload"); setFile(null); setHeaders([]); setRawRows([]);
    setStudents([]); setResult(null); setError(""); setCourseResolution({});
    setMapping({ name: null, email: null, enrollmentNo: null, rollNumber: null, courseCode: null, program: null, semester: null, section: null, dob: null, phone: null, address: null });
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  const STEPS: Step[] = ["upload", "map", "resolve", "preview", "result"];

  return (
    <div className="max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-2">CSV Student Import</h1>
      <p className="text-sm text-gray-500 mb-6">
        Upload a CSV, map columns, resolve course codes, review, and import.
      </p>

      {/* Progress */}
      <div className="flex items-center gap-1 mb-8 text-xs flex-wrap">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-1">
            {i > 0 && <ArrowRight className="w-3 h-3 text-gray-300" />}
            <span className={`px-2 py-1 rounded-full font-medium ${step === s ? "bg-primary-100 text-primary-700" : "bg-gray-100 text-gray-500"}`}>
              {i + 1}. {s.charAt(0).toUpperCase() + s.slice(1)}
            </span>
          </div>
        ))}
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-danger-50 border border-danger-500 text-danger-700 px-4 py-3 rounded-lg text-sm mb-4">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError("")} aria-label="Dismiss"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* ─── STEP 1: Upload ─────────────────────────────────────────── */}
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
            <p className="text-lg font-medium text-gray-700 mb-1">Drop CSV file here or click to browse</p>
            <p className="text-sm text-gray-500">Maximum 500 rows, 5 MB.</p>
          </div>
          <input id="csv-input" type="file" accept=".csv" className="hidden" onChange={handleFileInput} />
        </div>
      )}

      {/* ─── STEP 2: Column Mapping ────────────────────────────────── */}
      {step === "map" && (
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <FileSpreadsheet className="w-5 h-5 text-primary-600" />
            <div>
              <h2 className="font-semibold text-gray-900">Map CSV Columns</h2>
              <p className="text-xs text-gray-500">{file?.name} — {rawRows.length} rows detected</p>
            </div>
          </div>

          <div className="space-y-3">
            {ALL_FIELDS.map((field) => (
              <div key={field.key} className="flex items-center gap-4">
                <label htmlFor={`map-${field.key}`} className="w-44 text-sm font-medium text-gray-700 shrink-0">
                  {field.label}{field.required && <span className="text-danger-500 ml-0.5">*</span>}
                </label>
                <select
                  id={`map-${field.key}`}
                  className="input flex-1"
                  value={mapping[field.key] || ""}
                  onChange={(e) => setMapping({ ...mapping, [field.key]: e.target.value || null })}
                >
                  <option value="">— Skip —</option>
                  {headers.map((h) => (<option key={h} value={h}>{h}</option>))}
                </select>
              </div>
            ))}
          </div>

          <div className="flex gap-3 mt-6">
            <button className="btn-secondary" onClick={reset}>Back</button>
            <button className="btn-primary flex-1" disabled={!mappingValid} onClick={proceedToResolve}>
              Next: Resolve Course Codes
            </button>
          </div>
          {!mappingValid && <p className="text-xs text-danger-600 mt-2">Map all required fields (*)</p>}
        </div>
      )}

      {/* ─── STEP 3: Course Code Resolution ────────────────────────── */}
      {step === "resolve" && (
        <div className="card">
          <h2 className="font-semibold text-gray-900 mb-1">Resolve Course Codes</h2>
          <p className="text-xs text-gray-500 mb-4">
            Match each CSV course code to an existing course. Create new courses if needed.
          </p>

          <div className="space-y-3">
            {Object.entries(courseResolution).map(([csvValue, resolved]) => {
              const isResolved = resolved !== "";
              return (
                <div key={csvValue} className={`border rounded-lg p-3 ${isResolved ? "border-success-300 bg-success-50/30" : "border-warning-300 bg-warning-50/30"}`}>
                  <div className="flex items-center gap-4 flex-wrap">
                    <div className="shrink-0">
                      <p className="text-xs text-gray-500">CSV Value</p>
                      <p className="font-mono font-medium text-gray-900">{csvValue}</p>
                    </div>
                    <ArrowRight className="w-4 h-4 text-gray-400 shrink-0" />
                    <div className="flex-1 min-w-[200px]">
                      <select
                        className="input"
                        value={resolved}
                        onChange={(e) => setCourseResolution((prev) => ({ ...prev, [csvValue]: e.target.value }))}
                      >
                        <option value="">— Select course —</option>
                        {courses.map((c) => (
                          <option key={c.id} value={c.code}>{c.name} ({c.code})</option>
                        ))}
                      </select>
                    </div>
                    {isResolved ? (
                      <CheckCircle className="w-5 h-5 text-success-500 shrink-0" />
                    ) : (
                      <AlertCircle className="w-5 h-5 text-warning-500 shrink-0" />
                    )}
                  </div>

                  {/* Inline create course */}
                  {!isResolved && (
                    <div className="mt-3 pt-3 border-t border-warning-200">
                      <p className="text-xs text-gray-600 mb-2">Course not found? Create it:</p>
                      <div className="flex gap-2 items-end flex-wrap">
                        <input
                          className="input text-sm flex-1 min-w-[150px]"
                          placeholder="Course name"
                          value={creatingCourse === csvValue ? newCourseName : ""}
                          onFocus={() => setCreatingCourse(csvValue)}
                          onChange={(e) => { setCreatingCourse(csvValue); setNewCourseName(e.target.value); }}
                        />
                        <input
                          className="input text-sm w-24 uppercase"
                          placeholder="Code"
                          value={creatingCourse === csvValue ? newCourseCode : ""}
                          onFocus={() => setCreatingCourse(csvValue)}
                          onChange={(e) => { setCreatingCourse(csvValue); setNewCourseCode(e.target.value); }}
                        />
                        <button
                          className="btn-primary text-sm flex items-center gap-1 whitespace-nowrap"
                          onClick={() => handleCreateCourse(csvValue)}
                          disabled={!newCourseName || !newCourseCode || creatingCourse !== csvValue}
                        >
                          <Plus className="w-3 h-3" /> Create
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex gap-3 mt-6">
            <button className="btn-secondary" onClick={() => setStep("map")}>Back</button>
            <button className="btn-primary flex-1" disabled={!allResolved} onClick={applyResolution}>
              Next: Preview & Edit
            </button>
          </div>
          {!allResolved && <p className="text-xs text-warning-600 mt-2">Resolve all course codes to proceed</p>}
        </div>
      )}

      {/* ─── STEP 4: Editable Preview ──────────────────────────────── */}
      {step === "preview" && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-semibold text-gray-900">Preview & Edit — {students.length} students</h2>
              <p className="text-xs text-gray-500">Click any cell to edit. Scroll horizontally for all fields.</p>
            </div>
            <span className="flex items-center gap-1 text-xs text-gray-500">
              <Pencil className="w-3 h-3" /> Click to edit
            </span>
          </div>

          <div className="overflow-x-auto -mx-6 px-6">
            <table className="w-full text-xs border-collapse">
              <caption className="sr-only">Editable student data preview</caption>
              <thead>
                <tr className="bg-gray-50">
                  <th scope="col" className="px-2 py-2 text-left font-medium text-gray-600 border">#</th>
                  <th scope="col" className="px-2 py-2 text-left font-medium text-gray-600 border">Name</th>
                  <th scope="col" className="px-2 py-2 text-left font-medium text-gray-600 border">Email</th>
                  <th scope="col" className="px-2 py-2 text-left font-medium text-gray-600 border">Enrollment</th>
                  <th scope="col" className="px-2 py-2 text-left font-medium text-gray-600 border">Roll No</th>
                  <th scope="col" className="px-2 py-2 text-left font-medium text-gray-600 border">Course Code</th>
                  <th scope="col" className="px-2 py-2 text-left font-medium text-gray-600 border">Program</th>
                  <th scope="col" className="px-2 py-2 text-left font-medium text-gray-600 border">Sem</th>
                  <th scope="col" className="px-2 py-2 text-left font-medium text-gray-600 border">Section</th>
                  <th scope="col" className="px-2 py-2 text-left font-medium text-gray-600 border">DOB</th>
                  <th scope="col" className="px-2 py-2 text-left font-medium text-gray-600 border">Phone</th>
                  <th scope="col" className="px-2 py-2 text-left font-medium text-gray-600 border">Address</th>
                </tr>
              </thead>
              <tbody>
                {students.map((s, i) => {
                  const cols: (keyof StudentRow)[] = ["name", "email", "enrollmentNo", "rollNumber", "courseCode", "program", "semester", "section", "dob", "phone", "address"];
                  return (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-2 py-1 border text-gray-400">{i + 1}</td>
                      {cols.map((col) => {
                        const isEditing = editingCell?.row === i && editingCell?.col === col;
                        const value = String(s[col] ?? "");
                        return (
                          <td
                            key={col}
                            className="px-2 py-1 border cursor-pointer hover:bg-primary-50 min-w-[80px] max-w-[200px]"
                            onClick={() => setEditingCell({ row: i, col })}
                          >
                            {isEditing ? (
                              <input
                                className="w-full border-none bg-white outline-none text-xs p-0"
                                autoFocus
                                value={value}
                                onChange={(e) => updateCell(i, col, e.target.value)}
                                onBlur={() => setEditingCell(null)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === "Escape") setEditingCell(null);
                                }}
                              />
                            ) : (
                              <span className={`truncate block ${!value ? "text-gray-300 italic" : ""}`}>
                                {value || "—"}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex gap-3 mt-6">
            <button className="btn-secondary" onClick={() => setStep("resolve")}>Back</button>
            <button className="btn-primary flex-1" disabled={importing} onClick={handleImport}>
              {importing ? `Importing ${students.length} students...` : `Import ${students.length} Students`}
            </button>
          </div>
        </div>
      )}

      {/* ─── STEP 5: Result ────────────────────────────────────────── */}
      {step === "result" && result && (
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <CheckCircle className="w-8 h-8 text-success-500" />
            <h2 className="text-lg font-semibold text-gray-900">Import Complete</h2>
          </div>

          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="bg-success-50 rounded-lg p-4 text-center">
              <p className="text-2xl font-bold text-success-700">{result.created}</p>
              <p className="text-xs text-success-600">Created</p>
            </div>
            <div className="bg-gray-100 rounded-lg p-4 text-center">
              <p className="text-2xl font-bold text-gray-700">{result.skipped}</p>
              <p className="text-xs text-gray-600">Skipped</p>
            </div>
          </div>

          {result.errors.length > 0 && (
            <div className="bg-warning-50 border border-warning-500 rounded-lg p-4 mb-4">
              <p className="text-sm font-medium text-warning-600 mb-2">Issues ({result.errors.length}):</p>
              <ul className="text-xs text-warning-600 space-y-1 max-h-40 overflow-y-auto">
                {result.errors.map((err, i) => (<li key={i}>• {err}</li>))}
              </ul>
            </div>
          )}

          <p className="text-sm text-gray-600 mb-4">
            Default password for each student is their enrollment number.
          </p>

          <button className="btn-primary w-full" onClick={reset}>Import Another File</button>
        </div>
      )}
    </div>
  );
}
