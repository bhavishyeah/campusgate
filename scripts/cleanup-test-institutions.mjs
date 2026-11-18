/**
 * CampusGate — find and remove leftover TEST institutions (ops script).
 *
 * The live integration suites (apps/api/src/**\/__tests__/*.integration.test.ts)
 * run against the production database and create institutions whose name/code
 * start with a suite prefix (ADM_TEST_, LIB_TEST_, ...). Their teardown can leave
 * rows behind. This script finds them and either suspends or hard-deletes them.
 *
 * DRY RUN BY DEFAULT. Writes need `--suspend` or `--delete` AND
 * `--i-understand-this-changes-production`.
 *
 * ─── USAGE ────────────────────────────────────────────────────────────────
 *   node scripts/cleanup-test-institutions.mjs                       # dry run: candidates, counts, PROTECTED list, Demo residue
 *   node scripts/cleanup-test-institutions.mjs --verbose             # + every non-empty table per candidate
 *   node scripts/cleanup-test-institutions.mjs --self-test           # offline safety-rail self-check
 *   node scripts/cleanup-test-institutions.mjs --suspend --i-understand-this-changes-production
 *   node scripts/cleanup-test-institutions.mjs --delete  --i-understand-this-changes-production
 *   node scripts/cleanup-test-institutions.mjs --delete  --i-understand-this-changes-production --skip-export
 *   node scripts/cleanup-test-institutions.mjs --export-json scripts/.cleanup-export.local.json   # export only, no DB change
 *
 * Options: --only <id|code,...>  limit to these candidates (must already match a test prefix)
 *          --max N               allow more than 25 candidates (default 25)
 *          --allow-large         allow a candidate with more than 50 users
 *          --export-json <path>  write institutions + users + memberships to a git-ignored file
 *          --skip-export         let --delete run without a same-run export
 *
 * ─── SAFETY RAILS (enforced in code; see --self-test) ─────────────────────
 *  - Candidates are chosen ONLY by an explicit allow-list of name/code prefixes
 *    (TEST_PREFIXES) — never by "everything except Demo".
 *  - Institutions with code DEMO or PLATFORM, the names "Demo University" /
 *    "CAMPUSGATE Platform", and the ids of those rows are never candidates, even
 *    if a prefix would match them. They are re-checked again at write time.
 *  - More than 25 candidates (--max), or a candidate with more than 50 users
 *    (--allow-large), aborts the run.
 *  - --delete needs an export written in the SAME run (default
 *    scripts/.cleanup-export.local.json, must be git-ignored) unless --skip-export.
 *    The export omits passwordHash / MFA secrets. Supabase free tier has NO
 *    automatic backup: the export is your only way back.
 *  - --suspend changes only institutions.status -> SUSPENDED (what the Platform
 *    console 'Suspend' does; reversible with 'Activate'). Suspended institutions
 *    cannot log in ("Institution is suspended" in /api/auth/login).
 *
 * ─── HOW --delete WORKS (FK-safe order) ───────────────────────────────────
 *  Learned from cleanup() in apps/api/src/routes/__tests__/helpers/tenant-escape-setup.ts,
 *  which deletes child tables before parents (documents -> service requests ->
 *  inventory -> transport -> HR -> hostel -> faculty -> exams -> fees -> admissions
 *  -> attendance -> library -> classes -> RBAC -> gate/student -> academics ->
 *  users -> departments -> institution) and disables the append-only/guard
 *  triggers (ALTER TABLE ... DISABLE TRIGGER) around deletes of guarded tables.
 *  Rather than hard-coding ~125 tables (which would drift), the script reads the
 *  live catalog: every public table with an "institutionId" column, the FK graph
 *  between them (pg_constraint), and their user triggers. It topologically sorts
 *  children before parents, aborts on a cycle, and per institution runs ONE
 *  transaction that: disables the guard triggers on tables that have rows,
 *  deletes sessions + role_permissions that hang off the tenant's users/roles,
 *  deletes the tenant tables in order, re-enables the triggers, and deletes the
 *  institutions row. Postgres DDL is transactional, so any failure rolls back
 *  the deletes AND the trigger changes for that institution; the script reports
 *  it and continues with the next one.
 *  The owner role (rolbypassrls) is required and checked; it bypasses RLS, so no
 *  tenant GUC is needed (the suites' adminClient works the same way).
 *
 * Audit: the app's recordAuditEvent needs registered action keys and app
 * internals, so this script does NOT write audit events. It prints a console
 * report instead; copy it into your change log.
 *
 * Connection: PRIVILEGED_DATABASE_URL, else DIRECT_URL (packages/db/.env,
 * apps/api/.env). Connection strings are never logged.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  repoRoot, resolveOwnerUrl, describeHost, makeClient, connectWithRetry,
  isGitIgnored, parseArgs, assertSelf,
} from "./_ops-common.mjs";

/** Prefixes found as PFX / PREFIX constants in the integration suites. */
export const TEST_PREFIXES = [
  "ACAD_TEST_", "ADM_TEST_", "ATT_TEST_", "CLASS_TEST_", "DOC9_TEST_", "ESCAPE_TEST_",
  "EXAM_TEST_", "FAC9_TEST_", "FEE_TEST_", "HOST9_TEST_", "HR9_TEST_", "INV9_TEST_",
  "LIB_TEST_", "MODSYS_TEST_", "SASEC_TEST_", "SISREG_TEST_", "SR9_TEST_", "TRANS9_TEST_",
];
/** Extra residue markers searched (read-only) inside the Demo tenant. */
const RESIDUE_MARKERS = ["IMPCHK-", "IMPBAD-", "imp.check."];
const RESIDUE_COLUMNS = ["name", "title", "code", "label", "email", "enrollmentNo", "rollNumber"];

const PROTECTED_CODES = new Set(["DEMO", "PLATFORM"]);
const PROTECTED_NAMES = new Set(["demo university", "campusgate platform"]);
const KNOWN_DEMO_ID = "cmvdnz1ob0001uihgz50icv5t"; // also in packages/db/activate-modules.mjs
const DEFAULT_MAX = 25;
const MAX_USERS = 50;
const EXPORT_REL = "scripts/.cleanup-export.local.json";
const CONFIRM_FLAG = "i-understand-this-changes-production";
const IDENT = /^[a-z][a-z0-9_]*$/i;
const SECRET_USER_KEYS = ["passwordHash", "mfaSecret", "mfaRecoveryCodes"];

// ─── pure rules (unit-tested by --self-test) ────────────────────────────────

export function isProtected(inst, protectedIds = new Set()) {
  return (
    PROTECTED_CODES.has(String(inst.code ?? "").toUpperCase()) ||
    PROTECTED_NAMES.has(String(inst.name ?? "").trim().toLowerCase()) ||
    protectedIds.has(inst.id) ||
    inst.id === KNOWN_DEMO_ID
  );
}

export function matchesTestPrefix(inst) {
  const name = String(inst.name ?? "");
  const code = String(inst.code ?? "");
  return TEST_PREFIXES.some((p) => name.startsWith(p) || code.startsWith(p));
}

export function isCandidate(inst, protectedIds) {
  return !isProtected(inst, protectedIds) && matchesTestPrefix(inst);
}

export function checkLimits(candidates, userCounts, { max = DEFAULT_MAX, allowLarge = false } = {}) {
  if (candidates.length > max) {
    throw new Error(`${candidates.length} candidates exceeds the limit of ${max}. Review the list, then re-run with --max N.`);
  }
  if (!allowLarge) {
    for (const c of candidates) {
      const n = userCounts.get(c.id) ?? 0;
      if (n > MAX_USERS) throw new Error(`"${c.name}" has ${n} users (> ${MAX_USERS}). Re-run with --allow-large if this is really a test tenant.`);
    }
  }
}

/** Children-before-parents order. edges: [{child, parent}]. Throws on a cycle. */
export function deletionOrder(tables, edges) {
  const set = new Set(tables);
  const childrenOf = new Map(tables.map((t) => [t, new Set()]));
  for (const { child, parent } of edges) {
    if (child === parent || !set.has(child) || !set.has(parent)) continue;
    childrenOf.get(parent).add(child);
  }
  const done = new Set();
  const order = [];
  let progressed = true;
  while (order.length < tables.length && progressed) {
    progressed = false;
    for (const t of tables) {
      if (done.has(t)) continue;
      if ([...childrenOf.get(t)].every((c) => done.has(c))) {
        done.add(t); order.push(t); progressed = true;
      }
    }
  }
  if (order.length < tables.length) {
    throw new Error(`FK cycle among: ${tables.filter((t) => !done.has(t)).join(", ")}`);
  }
  return order;
}

function ident(s) {
  if (!IDENT.test(s)) throw new Error(`unsafe identifier from catalog: ${s}`);
  return `"${s}"`;
}

function selfTest() {
  const demo = { id: "d1", name: "Demo University", code: "DEMO" };
  const plat = { id: "p1", name: "CAMPUSGATE Platform", code: "PLATFORM" };
  const pids = new Set(["d1", "p1"]);
  assertSelf(!isCandidate(demo, pids), "DEMO must be refused");
  assertSelf(!isCandidate(plat, pids), "PLATFORM must be refused");
  assertSelf(!isCandidate({ id: "x", name: "ADM_TEST_x", code: "demo" }, pids), "code DEMO (any case) must be refused even with test prefix name");
  assertSelf(!isCandidate({ id: "x", name: "CAMPUSGATE Platform", code: "ADM_TEST_Z" }, pids), "platform name must be refused even with test prefix code");
  assertSelf(!isCandidate({ id: "d1", name: "ADM_TEST_x", code: "ADM_TEST_x" }, pids), "demo id must be refused");
  assertSelf(!isCandidate({ id: KNOWN_DEMO_ID, name: "ADM_TEST_x", code: "ADM_TEST_x" }, new Set()), "hard-coded demo id must be refused");
  assertSelf(!isCandidate({ id: "r1", name: "Real College", code: "RC" }, pids), "non-test institution must not be a candidate");
  assertSelf(!isCandidate({ id: "r2", name: "My ADM_TEST_ college", code: "MC" }, pids), "prefix must be at the start");
  assertSelf(!isCandidate({ id: "r3", name: "adm_test_lower", code: "X" }, pids), "prefix match is case-sensitive");
  assertSelf(isCandidate({ id: "t1", name: "ADM_TEST_ADM_TEST_instA", code: "X1" }, pids), "name prefix should match");
  assertSelf(isCandidate({ id: "t2", name: "Something", code: "LIB_TEST_CODE" }, pids), "code prefix should match");
  for (const p of TEST_PREFIXES) assertSelf(isCandidate({ id: "z", name: `${p}Inst`, code: "C" }, pids), `prefix ${p}`);
  const many = Array.from({ length: 26 }, (_, i) => ({ id: `i${i}`, name: `ADM_TEST_${i}`, code: `c${i}` }));
  let threw = false;
  try { checkLimits(many, new Map()); } catch { threw = true; }
  assertSelf(threw, ">25 candidates must be refused");
  checkLimits(many, new Map(), { max: 26 });
  threw = false;
  try { checkLimits([many[0]], new Map([["i0", 51]])); } catch { threw = true; }
  assertSelf(threw, ">50 users must be refused");
  checkLimits([many[0]], new Map([["i0", 51]]), { allowLarge: true });
  const order = deletionOrder(["inst_child", "parent", "leaf"], [
    { child: "inst_child", parent: "parent" }, { child: "leaf", parent: "inst_child" },
  ]);
  assertSelf(order.join(",") === "leaf,inst_child,parent", `topological order wrong: ${order}`);
  threw = false;
  try { deletionOrder(["a", "b"], [{ child: "a", parent: "b" }, { child: "b", parent: "a" }]); } catch { threw = true; }
  assertSelf(threw, "cycle must be detected");
  threw = false;
  try { ident('users"; drop table x;--'); } catch { threw = true; }
  assertSelf(threw, "unsafe identifier must be refused");
  console.log(`self-test OK (${TEST_PREFIXES.length} prefixes; DEMO/PLATFORM/demo-id refusal; >${DEFAULT_MAX} candidates; >${MAX_USERS} users; FK order; cycle; identifier guard)`);
}

// ─── catalog + queries ──────────────────────────────────────────────────────

const pad = (s, n) => String(s).padEnd(n);

async function loadCatalog(db) {
  const tenantTables = (await db.$queryRawUnsafe(
    `SELECT DISTINCT c.table_name AS t FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'institutionId' AND t.table_type = 'BASE TABLE'
        AND c.table_name <> 'institutions' ORDER BY 1`,
  )).map((r) => r.t);
  const fks = await db.$queryRawUnsafe(
    `SELECT cl.relname AS child, pl.relname AS parent
       FROM pg_constraint c
       JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_class pl ON pl.oid = c.confrelid
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'`,
  );
  const triggers = await db.$queryRawUnsafe(
    `SELECT c.relname AS t, g.tgname AS n FROM pg_trigger g
       JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT g.tgisinternal AND n.nspname = 'public'`,
  );
  const tenantSet = new Set(tenantTables);
  // FKs from tables WITHOUT institutionId into tenant tables must be known/handled.
  const outsiders = new Set(fks.filter((f) => !tenantSet.has(f.child) && tenantSet.has(f.parent)).map((f) => f.child));
  const HANDLED_OUTSIDERS = new Set(["sessions", "role_permissions", "institutions"]);
  const unhandled = [...outsiders].filter((t) => !HANDLED_OUTSIDERS.has(t));
  if (unhandled.length) throw new Error(`Schema drift: tables reference tenant tables but are not handled: ${unhandled.join(", ")}`);
  const order = deletionOrder(tenantTables, fks);
  return { tenantTables, order, triggers: triggers.filter((g) => tenantSet.has(g.t)) };
}

async function tableCounts(db, tables, instIds) {
  const sql = tables
    .map((t) => `SELECT '${t}' AS t, "institutionId" AS i, count(*)::int AS c FROM ${ident(t)} WHERE "institutionId" = ANY($1::text[]) GROUP BY "institutionId"`)
    .join(" UNION ALL ");
  const rows = await db.$queryRawUnsafe(sql, instIds);
  const byInst = new Map(instIds.map((i) => [i, new Map()]));
  for (const r of rows) byInst.get(r.i).set(r.t, r.c);
  return byInst;
}

async function demoResidue(db, tables, demoId) {
  const cols = await db.$queryRawUnsafe(
    `SELECT table_name AS t, column_name AS c FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = ANY($1::text[]) AND table_name = ANY($2::text[])`,
    RESIDUE_COLUMNS, tables,
  );
  if (!cols.length) return [];
  const pats = [...TEST_PREFIXES, ...RESIDUE_MARKERS].map((p) => p.toLowerCase());
  const sql = cols
    .map(({ t, c }) =>
      `SELECT '${t}.${c}' AS k, count(*)::int AS n FROM ${ident(t)} x WHERE x."institutionId" = $1 AND EXISTS (SELECT 1 FROM unnest($2::text[]) p WHERE starts_with(lower(x.${ident(c)}::text), p))`)
    .join(" UNION ALL ");
  return (await db.$queryRawUnsafe(sql, demoId, pats)).filter((r) => r.n > 0);
}

async function main() {
  const { flags, values } = parseArgs(process.argv.slice(2), ["only", "max", "export-json"]);
  if (flags.has("self-test")) return selfTest();

  const suspend = flags.has("suspend");
  const del = flags.has("delete");
  const verbose = flags.has("verbose");
  if (suspend && del) throw new Error("Choose one of --suspend or --delete, not both.");
  const writing = suspend || del;
  if (writing && !flags.has(CONFIRM_FLAG)) throw new Error(`--${suspend ? "suspend" : "delete"} requires --${CONFIRM_FLAG}. Nothing was changed.`);
  const max = values.max === undefined ? DEFAULT_MAX : Number(values.max);
  if (!Number.isInteger(max) || max < 1) throw new Error("--max must be a positive integer");

  // Decide the export path up front and refuse early if it is not git-ignored.
  let exportRel = values["export-json"] ?? null;
  if (del && !flags.has("skip-export") && !exportRel) exportRel = EXPORT_REL;
  if (exportRel) {
    exportRel = exportRel.replace(/\\/g, "/");
    const abs = path.resolve(repoRoot, exportRel);
    if (!abs.startsWith(repoRoot + path.sep)) throw new Error("--export-json must be inside the repo (and git-ignored).");
    if (!isGitIgnored(path.relative(repoRoot, abs).replace(/\\/g, "/"))) throw new Error(`Export path ${exportRel} is not git-ignored; refusing.`);
  }

  const url = resolveOwnerUrl();
  console.log(`Target database host: ${describeHost(url)}`);
  console.log(`Mode: ${suspend ? "SUSPEND (writes to production)" : del ? "DELETE (writes to production)" : "DRY RUN (read-only)"}\n`);

  const db = makeClient(url);
  let failures = 0;
  try {
    await connectWithRetry(db);
    const role = (await db.$queryRawUnsafe(`SELECT rolbypassrls AS b, current_user AS u FROM pg_roles WHERE rolname = current_user`))[0];
    if (!role?.b) throw new Error("Connected role does not bypass RLS (not the owner role); refusing. Use PRIVILEGED_DATABASE_URL/DIRECT_URL for the postgres role.");

    const insts = await db.$queryRawUnsafe(
      `SELECT id, name, code, status::text AS status, "createdAt" AS "createdAt" FROM institutions ORDER BY "createdAt"`,
    );
    const protectedIds = new Set(insts.filter((i) => PROTECTED_CODES.has(String(i.code).toUpperCase())).map((i) => i.id));
    let candidates = insts.filter((i) => isCandidate(i, protectedIds));
    const protectedList = insts.filter((i) => !candidates.includes(i));

    if (values.only) {
      const wanted = values.only.split(",").map((s) => s.trim()).filter(Boolean);
      const bad = wanted.filter((w) => !candidates.some((c) => c.id === w || c.code === w));
      if (bad.length) throw new Error(`--only: not a test-prefix candidate (refused): ${bad.join(", ")}`);
      candidates = candidates.filter((c) => wanted.includes(c.id) || wanted.includes(c.code));
    }

    const cat = await loadCatalog(db);
    const counts = candidates.length ? await tableCounts(db, cat.tenantTables, candidates.map((c) => c.id)) : new Map();
    const userCounts = new Map(candidates.map((c) => [c.id, counts.get(c.id)?.get("users") ?? 0]));

    console.log(`Test institutions matching an allow-listed prefix: ${candidates.length}`);
    console.log(`${pad("id", 28)} ${pad("name", 30)} ${pad("code", 26)} ${pad("status", 10)} ${pad("createdAt", 24)} ${pad("users", 5)} ${pad("memb", 5)} ${pad("depts", 5)} ${pad("stud", 5)} rows(total/tables)`);
    for (const c of candidates) {
      const m = counts.get(c.id);
      const total = [...m.values()].reduce((a, b) => a + b, 0);
      console.log(`${pad(c.id, 28)} ${pad(c.name, 30)} ${pad(c.code, 26)} ${pad(c.status, 10)} ${pad(new Date(c.createdAt).toISOString(), 24)} ${pad(m.get("users") ?? 0, 5)} ${pad(m.get("institution_memberships") ?? 0, 5)} ${pad(m.get("departments") ?? 0, 5)} ${pad(m.get("student_profiles") ?? 0, 5)} ${total}/${m.size}`);
      if (verbose) console.log(`    ${[...m.entries()].map(([t, n]) => `${t}=${n}`).join(", ")}`);
    }

    console.log(`\n=== PROTECTED: will NEVER be touched (${protectedList.length}) ===`);
    const protCounts = protectedList.length ? await db.$queryRawUnsafe(`SELECT "institutionId" AS i, count(*)::int AS n FROM users GROUP BY "institutionId"`) : [];
    const uByInst = new Map(protCounts.map((r) => [r.i, r.n]));
    for (const p of protectedList) {
      const why = isProtected(p, protectedIds) ? "SYSTEM (DEMO/PLATFORM)" : "no test prefix";
      console.log(`  ${pad(p.name, 30)} code=${pad(p.code, 12)} status=${pad(p.status, 10)} users=${pad(uByInst.get(p.id) ?? 0, 4)} id=${p.id}  [${why}]`);
    }

    const demo = insts.find((i) => String(i.code).toUpperCase() === "DEMO");
    console.log("\n=== residue inside Demo tenant (not removed by this script) ===");
    if (!demo) console.log("  (no DEMO institution found)");
    else {
      const res = await demoResidue(db, cat.tenantTables, demo.id);
      if (!res.length) console.log("  none found");
      for (const r of res) console.log(`  ${pad(r.k, 34)} ${r.n} row(s)`);
      console.log("  (heuristic: prefix match on name/title/code/label/email/enrollmentNo/rollNumber, case-insensitive)");
    }

    console.log(`\nSummary: ${candidates.length} candidate(s), ${protectedList.length} protected. Delete plan: ${cat.order.length} tenant tables, FK order verified (no cycles), ${cat.triggers.length} guard triggers known.`);
    console.log("Audit: no audit events are written by this script (app audit keys are not usable from a script); keep this console report.");

    try {
      checkLimits(candidates, userCounts, { max, allowLarge: flags.has("allow-large") });
      console.log("Limits check: OK (<= max candidates, <= 50 users each).");
    } catch (e) {
      console.log(`Limits check: WOULD REFUSE to write: ${e.message}`);
    }

    if (!writing && !exportRel) {
      console.log(`\nDry run only. Next: --suspend (reversible) or --delete, each with --${CONFIRM_FLAG}.`);
      return;
    }
    if (!candidates.length) { console.log("\nNothing to do."); return; }

    // Limits apply to anything beyond a dry run (export or write).
    checkLimits(candidates, userCounts, { max, allowLarge: flags.has("allow-large") });

    let exported = false;
    if (exportRel) {
      const ids = candidates.map((c) => c.id);
      const dump = {
        exportedAt: new Date().toISOString(),
        note: "Excludes passwordHash, mfaSecret, mfaRecoveryCodes. Other tenant tables are not exported.",
        institutions: await db.$queryRawUnsafe(`SELECT to_jsonb(i) AS r FROM institutions i WHERE id = ANY($1::text[])`, ids).then((x) => x.map((y) => y.r)),
        users: await db.$queryRawUnsafe(`SELECT to_jsonb(u) AS r FROM users u WHERE "institutionId" = ANY($1::text[])`, ids)
          .then((x) => x.map((y) => Object.fromEntries(Object.entries(y.r).filter(([k]) => !SECRET_USER_KEYS.includes(k))))),
        institution_memberships: await db.$queryRawUnsafe(`SELECT to_jsonb(m) AS r FROM institution_memberships m WHERE "institutionId" = ANY($1::text[])`, ids).then((x) => x.map((y) => y.r)),
        rowCounts: Object.fromEntries(candidates.map((c) => [c.id, Object.fromEntries(counts.get(c.id))])),
      };
      const abs = path.resolve(repoRoot, exportRel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, JSON.stringify(dump, null, 2) + "\n", { mode: 0o600 });
      exported = true;
      console.log(`\nExport written: ${abs} (${dump.institutions.length} institutions, ${dump.users.length} users, ${dump.institution_memberships.length} memberships). Local only, git-ignored.`);
    }
    if (!writing) return;

    if (del) {
      console.log("\n!!! Supabase free tier has NO automatic backup. A hard delete cannot be undone except from the export above.");
      if (!exported && !flags.has("skip-export")) throw new Error("--delete requires an export in the same run (or --skip-export).");
      if (flags.has("skip-export")) console.log("!!! --skip-export given: deleting WITHOUT an export.");
    }

    console.log(`\nApplying ${suspend ? "SUSPEND" : "DELETE"} to ${candidates.length} institution(s):`);
    for (const c of candidates) {
      try {
        // Re-verify against the live row at write time (rails apply again).
        const fresh = (await db.$queryRawUnsafe(`SELECT id, name, code, status::text AS status FROM institutions WHERE id = $1`, c.id))[0];
        if (!fresh) { console.log(`  SKIP   ${c.name}: already gone`); continue; }
        if (!isCandidate(fresh, protectedIds)) throw new Error("no longer matches the allow-list / is protected; refusing");

        if (suspend) {
          if (fresh.status === "SUSPENDED") { console.log(`  SKIP   ${c.name}: already SUSPENDED`); continue; }
          const n = await db.$executeRawUnsafe(
            `UPDATE institutions SET status = 'SUSPENDED' WHERE id = $1 AND upper(code) NOT IN ('DEMO','PLATFORM')`, c.id);
          if (n !== 1) throw new Error(`expected 1 row, updated ${n}`);
          console.log(`  OK     ${c.name} (${c.id}) -> SUSPENDED`);
          continue;
        }

        const deleted = await db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '10s'`);
          const rowCounts = (await tableCounts(tx, cat.tenantTables, [c.id])).get(c.id);
          const populated = new Set(rowCounts.keys());
          const trig = cat.triggers.filter((g) => populated.has(g.t));
          for (const g of trig) await tx.$executeRawUnsafe(`ALTER TABLE ${ident(g.t)} DISABLE TRIGGER ${ident(g.n)}`);
          let total = 0;
          // sessions hang off users (FK cascade), role_permissions off the tenant's own roles.
          if (populated.has("users")) {
            await tx.$executeRawUnsafe(`DELETE FROM sessions WHERE "userId" IN (SELECT id FROM users WHERE "institutionId" = $1)`, c.id);
          }
          if (populated.has("roles")) {
            await tx.$executeRawUnsafe(`DELETE FROM role_permissions WHERE "roleId" IN (SELECT id FROM roles WHERE "institutionId" = $1)`, c.id);
          }
          for (const t of cat.order) {
            if (!populated.has(t)) continue;
            total += await tx.$executeRawUnsafe(`DELETE FROM ${ident(t)} WHERE "institutionId" = $1`, c.id);
          }
          for (const g of trig) await tx.$executeRawUnsafe(`ALTER TABLE ${ident(g.t)} ENABLE TRIGGER ${ident(g.n)}`);
          const n = await tx.$executeRawUnsafe(
            `DELETE FROM institutions WHERE id = $1 AND upper(code) NOT IN ('DEMO','PLATFORM')`, c.id);
          if (n !== 1) throw new Error(`institution row not deleted (${n}); rolling back`);
          return total;
        }, { maxWait: 15000, timeout: 120000 });
        console.log(`  OK     ${c.name} (${c.id}) deleted, ${deleted} tenant rows removed`);
      } catch (e) {
        failures++;
        console.log(`  FAILED ${c.name} (${c.id}): ${String(e?.message ?? e).split("\n").slice(-2).join(" ").slice(0, 300)} (rolled back; continuing)`);
      }
    }
    console.log(`\nDone. ${candidates.length - failures} ok, ${failures} failed.`);
    if (failures) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`\nERROR: ${String(e?.message ?? e).split("\n").slice(-3).join(" ").slice(0, 400)}`);
    process.exitCode = 1;
  });
}
