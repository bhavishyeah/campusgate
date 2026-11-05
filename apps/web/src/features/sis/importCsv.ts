/**
 * Client-side CSV helpers for the admin bulk student import UI.
 *
 * This feature is FRONTEND-ONLY: it parses a CSV in the browser, maps rows to
 * the EXISTING backend contract (bulkImportStudentSchema), validates each row,
 * and posts chunks of <=500 to POST /api/admin/students/bulk-import as
 * { students: Row[] }. Nothing here reimplements the server's resolve/upsert
 * semantics — it only shapes and validates the request.
 *
 * The parser is adapted from scripts/bulk-students.mjs (no new dependency).
 */

// ─── Contract ────────────────────────────────────────────────────────────────

/** Max rows the server accepts per request (over this => 400). */
export const BULK_IMPORT_MAX = 500;

/**
 * The EXACT template header row, in order. `courseCode` holds the DEPARTMENT
 * CODE (e.g. 512 for BCA); `semester` must become an integer in the request.
 */
export const TEMPLATE_HEADERS = [
  "email",
  "name",
  "enrollmentNo",
  "courseCode",
  "program",
  "semester",
  "section",
  "rollNumber",
  "dob",
  "phone",
  "address",
] as const;

/**
 * One row of the bulk-import request. Mirrors packages/shared
 * bulkImportStudentSchema EXACTLY — semester is a real JS number, there is NO
 * departmentId / admissionDate / programId field.
 */
export interface BulkImportStudentRow {
  email: string;
  name: string;
  enrollmentNo: string;
  courseCode: string;
  program: string;
  semester: number;
  rollNumber?: string;
  section?: string;
  dob?: string;
  phone?: string;
  address?: string;
}

/** Aggregate response from the bulk-import endpoint (summed across chunks). */
export interface BulkImportResult {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Minimal RFC-4180-ish CSV parser: handles quoted fields, embedded commas,
 * escaped double-quotes (""), and CRLF/LF line endings. No external dependency.
 * Adapted from scripts/bulk-students.mjs.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((v) => v !== "")) rows.push(row);
  }
  return rows;
}

/** A parsed record keyed by header name, with its human (1-based) line number. */
export interface CsvRecord {
  __line: number;
  [header: string]: string | number;
}

/**
 * Turn raw parsed rows into header-keyed records. The first row is the header;
 * each value is trimmed. `__line` is the 1-based spreadsheet line (header = 1).
 */
export function rowsToRecords(rows: string[][]): {
  header: string[];
  records: CsvRecord[];
} {
  if (rows.length === 0) return { header: [], records: [] };
  const header = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r, idx) => {
    const o: CsvRecord = { __line: idx + 2 };
    header.forEach((h, i) => {
      o[h] = (r[i] ?? "").trim();
    });
    return o;
  });
  return { header, records };
}

// ─── Row build + validation ───────────────────────────────────────────────────

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** A record that passed/failed client validation, with its built request row. */
export interface ValidatedRow {
  line: number;
  row: BulkImportStudentRow;
  problems: string[];
  valid: boolean;
}

function str(rec: CsvRecord, key: string): string {
  const v = rec[key];
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/**
 * Build one request row from a parsed record and validate it against the
 * backend contract. CRITICAL: `semester` is coerced to a Number because CSV
 * values are strings; sending a string fails server validation on every row.
 */
export function buildRow(rec: CsvRecord): ValidatedRow {
  const semesterRaw = str(rec, "semester");
  const semester = Number(semesterRaw);

  const row: BulkImportStudentRow = {
    email: str(rec, "email"),
    name: str(rec, "name"),
    enrollmentNo: str(rec, "enrollmentNo"),
    courseCode: str(rec, "courseCode"),
    program: str(rec, "program"),
    semester,
  };
  // Optional fields: only include when non-empty (keeps the body tidy and
  // avoids sending empty strings the server would otherwise store).
  const rollNumber = str(rec, "rollNumber");
  const section = str(rec, "section");
  const dob = str(rec, "dob");
  const phone = str(rec, "phone");
  const address = str(rec, "address");
  if (rollNumber) row.rollNumber = rollNumber;
  if (section) row.section = section;
  if (dob) row.dob = dob;
  if (phone) row.phone = phone;
  if (address) row.address = address;

  const problems: string[] = [];
  if (!row.email) problems.push("missing email");
  else if (!EMAIL_RE.test(row.email)) problems.push(`invalid email "${row.email}"`);
  if (!row.name) problems.push("missing name");
  if (!row.enrollmentNo) problems.push("missing enrollmentNo");
  if (!row.courseCode) problems.push("missing courseCode (department code)");
  if (!row.program) problems.push("missing program");
  if (!semesterRaw) {
    problems.push("missing semester");
  } else if (!Number.isInteger(semester) || semester < 1 || semester > 12) {
    problems.push(`semester must be an integer 1..12 (got "${semesterRaw}")`);
  }

  return {
    line: rec.__line,
    row,
    problems,
    valid: problems.length === 0,
  };
}

/** Build + validate every record. */
export function buildRows(records: CsvRecord[]): ValidatedRow[] {
  return records.map(buildRow);
}

// ─── Chunking + aggregation ────────────────────────────────────────────────────

/** Split rows into chunks of at most `size` (default 500) for the API cap. */
export function chunkRows<T>(rows: T[], size: number = BULK_IMPORT_MAX): T[][] {
  if (size < 1) throw new Error("chunk size must be >= 1");
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

/** Sum the counts and concatenate the errors across per-chunk responses. */
export function aggregateResults(results: BulkImportResult[]): BulkImportResult {
  return results.reduce<BulkImportResult>(
    (acc, r) => ({
      created: acc.created + (r.created ?? 0),
      updated: acc.updated + (r.updated ?? 0),
      skipped: acc.skipped + (r.skipped ?? 0),
      errors: acc.errors.concat(r.errors ?? []),
    }),
    { created: 0, updated: 0, skipped: 0, errors: [] },
  );
}
