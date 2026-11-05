/**
 * CampusGate — bulk student loader (throwaway ops helper for testing).
 *
 * Reads a CSV of students and creates each one via POST /api/students against a
 * LIVE CampusGate API, logging in as an admin. It resolves a department NAME or
 * CODE to the real departmentId per tenant, validates required fields BEFORE
 * sending, throttles gently for the Supabase free tier, and prints a per-row
 * result (including the friendly 409s for duplicate email / enrollment number).
 *
 * It changes NOTHING in the app and creates nothing but students (each POST also
 * creates the login User with role STUDENT, ACTIVE, NO password — the student
 * sets a password later via the normal reset flow).
 *
 * ─── USAGE ────────────────────────────────────────────────────────────────
 *   node scripts/bulk-students.mjs --file students.csv
 *
 *   # dry run: validate + resolve departments, send nothing
 *   node scripts/bulk-students.mjs --file students.csv --dry-run
 *
 * Environment (NEVER hardcode secrets):
 *   API            API base URL      (default https://campusgate.up.railway.app)
 *   ADMIN_EMAIL    admin login email (default admin@demo.edu)
 *   ADMIN_PASSWORD admin password    (default admin123 — override for real use)
 *   THROTTLE_MS    delay between creates (default 250)
 *
 *   PowerShell example with explicit creds:
 *     $env:ADMIN_EMAIL="admin@demo.edu"; $env:ADMIN_PASSWORD="admin123"; `
 *       node scripts/bulk-students.mjs --file students.csv
 *
 * ─── CSV FORMAT ───────────────────────────────────────────────────────────
 * Header row required. Columns (order-independent, matched by header name):
 *   REQUIRED: email, name, enrollmentNo, department, program, semester
 *   OPTIONAL: section, rollNumber, dob, phone, address, admissionDate, programId
 *
 *   - `department`  : a department NAME or CODE for the tenant; resolved to
 *                     departmentId via GET /api/admin/departments. (You may also
 *                     supply a `departmentId` column directly to skip resolution.)
 *   - `program`     : a program CODE or NAME string (the server links it to a
 *                     real Program by code/name when it can; unlinked is legal).
 *   - `semester`    : integer 1..12.
 *   - `dob`/`admissionDate`: ISO date strings (YYYY-MM-DD) if present.
 *
 * A template is at scripts/students.template.csv.
 */

import { readFile } from "node:fs/promises";

const API = (process.env.API ?? "https://campusgate.up.railway.app").replace(/\/$/, "");
const ADMIN = {
  email: process.env.ADMIN_EMAIL ?? "admin@demo.edu",
  password: process.env.ADMIN_PASSWORD ?? "admin123",
};
const THROTTLE_MS = Number(process.env.THROTTLE_MS ?? 250);

const REQUIRED = ["email", "name", "enrollmentNo", "program", "semester"];
const OPTIONAL = ["section", "rollNumber", "dob", "phone", "address", "admissionDate", "programId"];

function parseArgs(argv) {
  const out = { file: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file" || a === "-f") out.file = argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
  }
  return out;
}

/**
 * Minimal RFC-4180-ish CSV parser: handles quoted fields, embedded commas,
 * escaped double-quotes (""), and CRLF/LF line endings. No external dependency.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((v) => v !== "")) rows.push(row); }
  return rows;
}

function rowsToObjects(rows) {
  if (rows.length === 0) return { header: [], records: [] };
  const header = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r, idx) => {
    const o = { __line: idx + 2 }; // human line number (1-based + header)
    header.forEach((h, i) => { o[h] = (r[i] ?? "").trim(); });
    return o;
  });
  return { header, records };
}

async function api(path, { method = "GET", token, body } = {}) {
  const h = {};
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`${API}${path}`, { method, headers: h, body: payload });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

async function login(creds) {
  const r = await api("/api/auth/login", { method: "POST", body: creds });
  if (r.status !== 200) throw new Error(`login ${creds.email} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.token ?? r.json.accessToken ?? r.json.access_token;
}

function buildStudentBody(rec, departmentId) {
  const body = {
    email: rec.email,
    name: rec.name,
    enrollmentNo: rec.enrollmentNo,
    departmentId,
    program: rec.program,
    semester: Number(rec.semester),
  };
  for (const k of OPTIONAL) {
    if (k === "programId") continue;
    if (rec[k]) body[k] = rec[k];
  }
  if (rec.programId) body.programId = rec.programId;
  return body;
}

function validateRow(rec) {
  const problems = [];
  for (const k of REQUIRED) if (!rec[k]) problems.push(`missing ${k}`);
  // department resolved separately (name/code OR explicit departmentId)
  if (!rec.department && !rec.departmentId) problems.push("missing department (name/code) or departmentId");
  if (rec.semester) {
    const n = Number(rec.semester);
    if (!Number.isInteger(n) || n < 1 || n > 12) problems.push(`semester must be an integer 1..12 (got "${rec.semester}")`);
  }
  if (rec.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rec.email)) problems.push(`invalid email "${rec.email}"`);
  return problems;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { file, dryRun } = parseArgs(process.argv.slice(2));
  if (!file) {
    console.error("Usage: node scripts/bulk-students.mjs --file <students.csv> [--dry-run]");
    process.exit(2);
  }

  console.log(`CampusGate bulk student loader → ${API}${dryRun ? "  (DRY RUN — no writes)" : ""}`);

  const raw = await readFile(file, "utf8");
  const { header, records } = rowsToObjects(parseCsv(raw));
  if (records.length === 0) { console.error("No data rows found in CSV."); process.exit(2); }
  console.log(`Parsed ${records.length} row(s). Columns: ${header.join(", ")}`);

  const token = await login(ADMIN);
  console.log(`Logged in as ${ADMIN.email}.`);

  // Resolve departments once: build name->id and code->id maps (case-insensitive).
  const deptRes = await api("/api/admin/departments", { token });
  if (deptRes.status !== 200 || !Array.isArray(deptRes.json)) {
    throw new Error(`GET /api/admin/departments -> ${deptRes.status} ${JSON.stringify(deptRes.json)}`);
  }
  const byName = new Map();
  const byCode = new Map();
  const byId = new Set();
  for (const d of deptRes.json) {
    if (d.name) byName.set(String(d.name).toLowerCase(), d.id);
    if (d.code) byCode.set(String(d.code).toLowerCase(), d.id);
    byId.add(d.id);
  }
  console.log(`Loaded ${deptRes.json.length} department(s) for the tenant.`);

  function resolveDept(rec) {
    if (rec.departmentId) {
      if (byId.has(rec.departmentId)) return { id: rec.departmentId };
      return { error: `departmentId "${rec.departmentId}" not found in this tenant` };
    }
    const key = String(rec.department).toLowerCase();
    const id = byName.get(key) ?? byCode.get(key);
    if (!id) return { error: `department "${rec.department}" not found (by name or code)` };
    return { id };
  }

  let created = 0, skipped = 0, failed = 0;
  for (const rec of records) {
    const label = `line ${rec.__line} ${rec.email || "(no email)"}`;
    const problems = validateRow(rec);
    const dept = problems.length ? null : resolveDept(rec);
    if (dept?.error) problems.push(dept.error);

    if (problems.length) {
      failed++;
      console.log(`  SKIP  ${label} — ${problems.join("; ")}`);
      continue;
    }

    if (dryRun) {
      console.log(`  OK    ${label} — would create (dept ${dept.id}, program "${rec.program}", sem ${rec.semester})`);
      continue;
    }

    const r = await api("/api/students", { method: "POST", token, body: buildStudentBody(rec, dept.id) });
    if (r.status === 201) {
      created++;
      console.log(`  CREATED ${label} — id ${r.json?.id ?? "?"}`);
    } else if (r.status === 409) {
      skipped++;
      console.log(`  EXISTS  ${label} — ${r.json?.error ?? "conflict"}`);
    } else {
      failed++;
      const detail = typeof r.json === "object" ? JSON.stringify(r.json) : String(r.json);
      console.log(`  FAIL    ${label} — ${r.status} ${detail}`);
    }
    await sleep(THROTTLE_MS);
  }

  console.log(
    dryRun
      ? `\n=== DRY RUN complete: ${records.length - failed} valid, ${failed} invalid ===`
      : `\n=== DONE: ${created} created, ${skipped} already existed, ${failed} failed (of ${records.length}) ===`,
  );
  if (!dryRun && failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error("FATAL:", err.message); process.exit(1); });
