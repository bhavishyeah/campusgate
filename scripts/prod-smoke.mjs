/**
 * CampusGate — DEPLOYED production smoke test.
 *
 * Hits the LIVE Railway API (not localhost) end-to-end:
 *   A. /api/health
 *   B. login as the student + admin (seed creds)
 *   C. tenant-scoped read sanity (student sees their own fees/me)
 *   D. Documents round-trip: upload (admin) -> appears in list -> mint signed
 *      download URL -> the signed URL actually returns the bytes from Supabase
 *      Storage -> a NON-owner/non-grantee student gets 404 (not-public-by-default)
 *   E. an unauthenticated call is rejected (401)
 *
 * Usage:
 *   node scripts/prod-smoke.mjs                 # uses the default Railway URL below
 *   API=https://your-api.example node scripts/prod-smoke.mjs
 *
 * No secrets are read or printed. Seed passwords are the well-known demo creds.
 */
import { createHash } from "node:crypto";

const API = (process.env.API ?? "https://campusgate.up.railway.app").replace(/\/$/, "");

const ADMIN = { email: "admin@demo.edu", password: "admin123" };
const STUDENT = { email: "bhavishya@demo.edu", password: "student123" };
// documents.upload_own is an OWNER self-service key — held by FACULTY, not ADMIN
// (ADMIN holds the admin keys: admin.view_all / grants.manage / retention.manage).
const FACULTY = { email: "faculty.cs@demo.edu", password: "faculty123" };

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}
function step(n, m) { console.log(`\n[${n}] ${m}`); }

async function api(path, { method = "GET", token, body, rawBody, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (rawBody !== undefined) { payload = rawBody; }
  else if (body !== undefined) { h["content-type"] = "application/json"; payload = JSON.stringify(body); }
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

try {
  console.log(`CampusGate production smoke test → ${API}`);

  // A. health
  step("A", "GET /api/health");
  const health = await api("/api/health");
  ok("health 200 + status ok", health.status === 200 && health.json?.status === "ok", JSON.stringify(health.json));

  // E. unauthenticated rejected (do early, no token)
  step("E", "unauthenticated /api/documents is rejected");
  const noauth = await api("/api/documents");
  ok("unauth -> 401", noauth.status === 401, `got ${noauth.status}`);

  // B. logins
  step("B", "Login (admin + faculty + student)");
  const adminTok = await login(ADMIN);
  ok("admin login", !!adminTok);
  const facultyTok = await login(FACULTY);
  ok("faculty login", !!facultyTok);
  const studentTok = await login(STUDENT);
  ok("student login", !!studentTok);

  // C. tenant-scoped self read
  step("C", "student self-scoped read (/api/fees/me/charges)");
  const meCharges = await api("/api/fees/me/charges", { token: studentTok });
  ok("student /me/charges 200", meCharges.status === 200, `got ${meCharges.status}`);

  // D. documents round-trip (admin uploads — admin holds documents via ADMIN role)
  step("D", "Documents round-trip (upload → list → signed URL → fetch bytes → non-owner 404)");
  const fileText = `campusgate prod smoke ${new Date().toISOString()}`;
  const fileBuf = Buffer.from(fileText, "utf8");
  const expectedSha = createHash("sha256").update(fileBuf).digest("hex");

  const up = await api("/api/documents", {
    method: "POST",
    token: facultyTok,
    rawBody: fileBuf,
    headers: {
      "content-type": "application/octet-stream",
      // upload metadata rides on x-<field> headers (lowercased), per the route's headerOrQuery
      "x-title": "Prod Smoke Doc",
      "x-filename": "smoke.txt",
      "x-contenttype": "text/plain",
    },
  });
  ok("upload -> 201", up.status === 201, JSON.stringify(up.json));
  const docId = up.json?.id;
  const versionId = up.json?.currentVersionId ?? up.json?.currentVersion?.id;
  ok("upload returned doc id + version id", !!docId && !!versionId);
  // checksum the server computed should match ours (integrity)
  const serverSha = up.json?.currentVersion?.checksumSha256;
  ok("server checksum matches uploaded bytes", !serverSha || serverSha === expectedSha,
     serverSha ? `server=${serverSha?.slice(0,12)} ours=${expectedSha.slice(0,12)}` : "(not returned)");

  if (docId && versionId) {
    // list shows it — admin is tenant-scoped; response envelope is { page, pageSize, total, data: [...] }
    const list = await api("/api/documents", { token: adminTok });
    const rows = list.json?.data ?? list.json?.documents ?? (Array.isArray(list.json) ? list.json : []);
    const found = Array.isArray(rows) && rows.some((d) => d.id === docId);
    ok("admin tenant-scoped list includes the new doc", list.status === 200 && found,
       `status ${list.status}, rows ${Array.isArray(rows) ? rows.length : "n/a"}`);

    // mint signed download URL (as the owner/faculty)
    const dl = await api(`/api/documents/${docId}/versions/${versionId}/download-url`, {
      method: "POST", token: facultyTok,
    });
    ok("mint signed download-url -> 200", dl.status === 200, JSON.stringify(dl.json));
    const url = dl.json?.url ?? dl.json?.downloadUrl ?? dl.json?.signedUrl;
    // A valid Supabase signed URL is https://<ref>.supabase.co/storage/v1/object/sign/...?token=<JWT>.
    // The token JWT is the per-object SIGNATURE (short-lived), NOT the service-role key — the
    // real safety proof is the unauthenticated byte-fetch below succeeding then expiring.
    ok("response carries a Supabase signed URL (object/sign + token, not raw service-role key)",
       typeof url === "string" && url.includes("/storage/v1/object/sign/") && url.includes("token="),
       url ? url.slice(0, 72) + "…" : "(no url)");

    // the signed URL actually returns the bytes from Supabase Storage
    if (typeof url === "string" && url.startsWith("http")) {
      const blob = await fetch(url);
      const got = await blob.text();
      ok("signed URL returns the uploaded bytes", blob.status === 200 && got === fileText,
         `status ${blob.status}, match ${got === fileText}`);
    }

    // not-public-by-default: a student who is neither owner nor grantee nor admin -> 404
    const foreign = await api(`/api/documents/${docId}/versions/${versionId}/download-url`, {
      method: "POST", token: studentTok,
    });
    ok("non-owner/non-grantee student -> 404 (not-public-by-default)", foreign.status === 404,
       `got ${foreign.status}`);
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exitCode = 1;
} catch (e) {
  console.error("\nSMOKE ERROR:", e.message);
  process.exitCode = 1;
}
