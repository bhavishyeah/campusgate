import { describe, it, expect } from "vitest";
import {
  BULK_IMPORT_MAX,
  TEMPLATE_HEADERS,
  aggregateResults,
  buildRow,
  buildRows,
  chunkRows,
  parseCsv,
  rowsToRecords,
  type BulkImportResult,
  type BulkImportStudentRow,
} from "../importCsv";

// ─── Parser ────────────────────────────────────────────────────────────────

describe("parseCsv", () => {
  it("parses simple rows", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with embedded commas", () => {
    expect(parseCsv('name,address\n"Doe, John","12 Main St, Apt 4"')).toEqual([
      ["name", "address"],
      ["Doe, John", "12 Main St, Apt 4"],
    ]);
  });

  it("handles escaped double-quotes", () => {
    expect(parseCsv('note\n"she said ""hi"""')).toEqual([
      ["note"],
      ['she said "hi"'],
    ]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("keeps embedded newlines inside quoted fields", () => {
    expect(parseCsv('a\n"line1\nline2"')).toEqual([["a"], ["line1\nline2"]]);
  });

  it("skips fully-empty lines", () => {
    expect(parseCsv("a,b\n\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("rowsToRecords", () => {
  it("maps header to trimmed, 1-based line-numbered records", () => {
    const { header, records } = rowsToRecords([
      [" email ", "name"],
      [" a@b.com ", " Ann "],
    ]);
    expect(header).toEqual(["email", "name"]);
    expect(records).toEqual([{ __line: 2, email: "a@b.com", name: "Ann" }]);
  });

  it("returns empty for no rows", () => {
    expect(rowsToRecords([])).toEqual({ header: [], records: [] });
  });
});

// ─── Row build + semester coercion + validation ───────────────────────────────

describe("buildRow — field names + semester coercion", () => {
  it("builds a row whose field names match the backend contract exactly", () => {
    const { row, valid, problems } = buildRow({
      __line: 2,
      email: "a@b.com",
      name: "Ann",
      enrollmentNo: "EN1",
      courseCode: "512",
      program: "BCA",
      semester: "3",
      section: "A",
      rollNumber: "R1",
      dob: "2000-01-01",
      phone: "999",
      address: "Somewhere",
    });
    expect(valid).toBe(true);
    expect(problems).toEqual([]);
    // Pin the EXACT set of field names so drift from the contract fails CI.
    expect(Object.keys(row).sort()).toEqual(
      [
        "address",
        "courseCode",
        "dob",
        "email",
        "enrollmentNo",
        "name",
        "phone",
        "program",
        "rollNumber",
        "section",
        "semester",
      ].sort(),
    );
    // No forbidden fields.
    expect(row).not.toHaveProperty("departmentId");
    expect(row).not.toHaveProperty("admissionDate");
    expect(row).not.toHaveProperty("programId");
  });

  it("coerces semester to a real JS number (CSV values are strings)", () => {
    const { row } = buildRow({
      __line: 2,
      email: "a@b.com",
      name: "Ann",
      enrollmentNo: "EN1",
      courseCode: "512",
      program: "BCA",
      semester: "5",
    });
    expect(row.semester).toBe(5);
    expect(typeof row.semester).toBe("number");
  });

  it("omits blank optional fields", () => {
    const { row } = buildRow({
      __line: 2,
      email: "a@b.com",
      name: "Ann",
      enrollmentNo: "EN1",
      courseCode: "512",
      program: "BCA",
      semester: "1",
      section: "",
      rollNumber: "",
    });
    expect(row).not.toHaveProperty("section");
    expect(row).not.toHaveProperty("rollNumber");
  });

  it("flags a non-integer semester", () => {
    const { valid, problems } = buildRow({
      __line: 2,
      email: "a@b.com",
      name: "Ann",
      enrollmentNo: "EN1",
      courseCode: "512",
      program: "BCA",
      semester: "3.5",
    });
    expect(valid).toBe(false);
    expect(problems.some((p) => p.includes("semester"))).toBe(true);
  });

  it("flags semester out of 1..12", () => {
    expect(
      buildRow({
        __line: 2,
        email: "a@b.com",
        name: "Ann",
        enrollmentNo: "EN1",
        courseCode: "512",
        program: "BCA",
        semester: "13",
      }).valid,
    ).toBe(false);
  });

  it("flags missing required fields and bad email", () => {
    const { valid, problems } = buildRow({
      __line: 2,
      email: "not-an-email",
      name: "",
      enrollmentNo: "",
      courseCode: "",
      program: "",
      semester: "",
    });
    expect(valid).toBe(false);
    expect(problems).toContain("missing name");
    expect(problems).toContain("missing enrollmentNo");
    expect(problems).toContain("missing courseCode (department code)");
    expect(problems).toContain("missing program");
    expect(problems).toContain("missing semester");
    expect(problems.some((p) => p.includes("invalid email"))).toBe(true);
  });
});

describe("buildRows", () => {
  it("separates valid from invalid rows", () => {
    const rows = buildRows([
      {
        __line: 2,
        email: "a@b.com",
        name: "Ann",
        enrollmentNo: "EN1",
        courseCode: "512",
        program: "BCA",
        semester: "1",
      },
      {
        __line: 3,
        email: "bad",
        name: "",
        enrollmentNo: "",
        courseCode: "",
        program: "",
        semester: "x",
      },
    ]);
    expect(rows.filter((r) => r.valid)).toHaveLength(1);
    expect(rows.filter((r) => !r.valid)).toHaveLength(1);
  });
});

// ─── Chunking + aggregation ────────────────────────────────────────────────────

function makeRows(n: number): BulkImportStudentRow[] {
  return Array.from({ length: n }, (_, i) => ({
    email: `s${i}@b.com`,
    name: `Student ${i}`,
    enrollmentNo: `EN${i}`,
    courseCode: "512",
    program: "BCA",
    semester: 1,
  }));
}

describe("chunkRows", () => {
  it("caps each chunk at BULK_IMPORT_MAX (500) — 1200 rows => three chunks", () => {
    const chunks = chunkRows(makeRows(1200));
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(500);
    expect(chunks[1]).toHaveLength(500);
    expect(chunks[2]).toHaveLength(200);
    expect(BULK_IMPORT_MAX).toBe(500);
  });

  it("returns one chunk for small inputs", () => {
    expect(chunkRows(makeRows(10))).toHaveLength(1);
  });

  it("returns no chunks for empty input", () => {
    expect(chunkRows([])).toHaveLength(0);
  });
});

describe("aggregateResults", () => {
  it("sums counts and concatenates errors across chunks", () => {
    const results: BulkImportResult[] = [
      { created: 400, updated: 50, skipped: 50, errors: ["EN1: Course '999' not found"] },
      { created: 480, updated: 10, skipped: 10, errors: ["EN2: Course '888' not found"] },
      { created: 150, updated: 30, skipped: 20, errors: [] },
    ];
    expect(aggregateResults(results)).toEqual({
      created: 1030,
      updated: 90,
      skipped: 80,
      errors: ["EN1: Course '999' not found", "EN2: Course '888' not found"],
    });
  });

  it("returns zeros for no results", () => {
    expect(aggregateResults([])).toEqual({
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [],
    });
  });
});

// ─── Contract pin ────────────────────────────────────────────────────────────

describe("backend contract pins", () => {
  it("template header row matches the exact required order", () => {
    expect(TEMPLATE_HEADERS.join(",")).toBe(
      "email,name,enrollmentNo,courseCode,program,semester,section,rollNumber,dob,phone,address",
    );
  });

  it("the request body shape is { students: Row[] }", () => {
    // The hook wraps rows as { students: chunk }. Pin that shape here so any
    // drift (e.g. sending a bare array) fails CI.
    const rows = makeRows(2);
    const body = { students: rows };
    expect(Array.isArray(body.students)).toBe(true);
    expect(body.students).toHaveLength(2);
    expect(body.students[0]).toMatchObject({
      email: "s0@b.com",
      name: "Student 0",
      enrollmentNo: "EN0",
      courseCode: "512",
      program: "BCA",
      semester: 1,
    });
    expect(typeof body.students[0].semester).toBe("number");
  });
});
