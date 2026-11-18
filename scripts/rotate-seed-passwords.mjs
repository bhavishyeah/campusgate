/**
 * CampusGate — rotate the public SEED demo passwords (ops script).
 *
 * The seed (packages/db/src/seed.ts) creates demo accounts with well-known
 * passwords. If the production database still holds them, anyone can log in.
 * This script replaces each seed account's passwordHash with a strong random
 * password.
 *
 * DRY RUN BY DEFAULT. Nothing is written unless BOTH `--apply` and
 * `--i-understand-this-changes-production` are passed.
 *
 * ─── USAGE ────────────────────────────────────────────────────────────────
 *   node scripts/rotate-seed-passwords.mjs                  # dry run (read-only, prints nothing secret)
 *   node scripts/rotate-seed-passwords.mjs --self-test      # offline safety-rail self-check
 *   node scripts/rotate-seed-passwords.mjs --apply --i-understand-this-changes-production
 *   node scripts/rotate-seed-passwords.mjs --apply --i-understand-this-changes-production --only admin@demo.edu,guard@demo.edu
 *   node scripts/rotate-seed-passwords.mjs --apply --i-understand-this-changes-production --exclude superadmin@campusgate.local
 *
 * ─── WHAT --apply DOES ────────────────────────────────────────────────────
 *  - Candidates = seed emails (list below) whose user exists, has a NON-NULL
 *    passwordHash, and sits in the expected tenant (DEMO, or PLATFORM for the
 *    super admin). Users with passwordHash NULL and users not in the seed list
 *    are never touched.
 *  - New password: 24 chars from crypto.randomBytes (unbiased), alphabet without
 *    ambiguous characters (no 0/O/1/l/I), always containing upper, lower, digit
 *    and symbol (symbols limited to "-_.+" so they survive copy-paste).
 *  - Hash: bcrypt, cost 12 — the same package and cost the API uses
 *    (apps/api/src/routes/auth.ts + platform.ts: bcrypt.hash(x, 12);
 *    login verifies with bcrypt.compare). Each hash is verified with
 *    bcrypt.compare before anything is written.
 *  - UPDATE touches ONLY "passwordHash", in ONE transaction (all or nothing).
 *  - Plaintext goes ONLY to scripts/.seed-credentials.local.json
 *    ({ "email": "password" }). It is written to a .pending file first and moved
 *    into place after the DB commit, so a failed run never overwrites older
 *    credentials and a committed run never loses new ones. The path must be
 *    git-ignored (verified with `git check-ignore`; a line is appended to
 *    .gitignore if missing; --apply refuses if it still is not ignored).
 *    The file is SECRET: keep it on your machine, never share or commit it.
 *    On Windows, protection = gitignore + your user-profile folder ACL.
 *  - Passwords are NEVER printed to stdout/stderr. The console shows only the
 *    DB host, the file path, and counts.
 *
 * ─── NOT COVERED ──────────────────────────────────────────────────────────
 *  - Already-issued JWTs stay valid until they expire. The API signs access
 *    tokens with expiresIn "24h" (apps/api/src/server.ts), so an attacker who
 *    logged in with a public password can keep using that token for up to 24h
 *    after rotation. Rotate JWT_SECRET on Railway to invalidate them at once.
 *  - Rotating superadmin@campusgate.local does NOT change its MFA enrollment
 *    (mfaEnabled/mfaSecret/recovery codes are untouched).
 *
 * Connection: PRIVILEGED_DATABASE_URL, else DIRECT_URL (packages/db/.env,
 * apps/api/.env). Connection strings are never logged.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcrypt";
import {
  repoRoot, resolveOwnerUrl, describeHost, makeClient, connectWithRetry,
  isGitIgnored, parseArgs, assertSelf,
} from "./_ops-common.mjs";

const BCRYPT_COST = 12; // identical to apps/api/src/routes/auth.ts / platform.ts
const CREDS_REL = "scripts/.seed-credentials.local.json";
const CREDS_PATH = path.join(repoRoot, CREDS_REL);
const PENDING_PATH = `${CREDS_PATH}.pending`;
const GITIGNORE_LINE = "scripts/.seed-credentials.local.json*";
const CONFIRM_FLAG = "i-understand-this-changes-production";

/**
 * Authoritative list: every user packages/db/src/seed.ts creates with a password.
 * `defaultPw` is the public seed password, used ONLY to report (dry run) whether
 * the demo password still works; it is never written anywhere.
 */
export const SEED_ACCOUNTS = [
  { email: "superadmin@campusgate.local", tenant: "PLATFORM", defaultPw: "superadmin123" },
  { email: "admin@demo.edu", tenant: "DEMO", defaultPw: "admin123" },
  { email: "hod.bca@demo.edu", tenant: "DEMO", defaultPw: "hod123" },
  { email: "guard@demo.edu", tenant: "DEMO", defaultPw: "guard123" },
  { email: "bhavishya@demo.edu", tenant: "DEMO", defaultPw: "student123" },
  { email: "faculty.cs@demo.edu", tenant: "DEMO", defaultPw: "faculty123" },
  { email: "librarian@demo.edu", tenant: "DEMO", defaultPw: "library123" },
  { email: "admissions@demo.edu", tenant: "DEMO", defaultPw: "officer123" },
  { email: "applicant@demo.edu", tenant: "DEMO", defaultPw: "applicant123" },
  { email: "accountant@demo.edu", tenant: "DEMO", defaultPw: "accountant123" },
];
const SEED_EMAILS = new Set(SEED_ACCOUNTS.map((a) => a.email));
const SUPERADMIN = "superadmin@campusgate.local";

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const DIGIT = "23456789";
const SYMBOL = "-_.+";
const ALPHABET = UPPER + LOWER + DIGIT + SYMBOL;

function randomIndex(n) {
  // rejection sampling: no modulo bias
  const limit = 256 - (256 % n);
  for (;;) {
    const b = randomBytes(1)[0];
    if (b < limit) return b % n;
  }
}

export function generatePassword(len = 24) {
  for (;;) {
    let s = "";
    for (let i = 0; i < len; i++) s += ALPHABET[randomIndex(ALPHABET.length)];
    if ([UPPER, LOWER, DIGIT, SYMBOL].every((set) => [...s].some((c) => set.includes(c)))) return s;
  }
}

/** Pure decision for one seed account. */
export function decide(account, row) {
  if (!row) return { rotate: false, reason: "not found" };
  if (!row.passwordHash) return { rotate: false, reason: "passwordHash is NULL (never touched)" };
  if (row.institutionCode !== account.tenant) {
    return { rotate: false, reason: `unexpected institution ${row.institutionCode} (expected ${account.tenant})` };
  }
  return { rotate: true, reason: "seed account with password" };
}

export function selectEmails(all, only, exclude) {
  const known = new Set(all);
  for (const e of [...only, ...exclude]) {
    if (!known.has(e)) throw new Error(`"${e}" is not a seed account; refusing (never touch non-seed users).`);
  }
  return all.filter((e) => (only.length ? only.includes(e) : true) && !exclude.includes(e));
}

const csv = (v) => (v ? v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : []);

function selfTest() {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const p = generatePassword();
    assertSelf(p.length >= 20, "password shorter than 20");
    assertSelf(/^[A-HJ-NP-Za-km-z2-9+._-]+$/.test(p), "ambiguous or unexpected character");
    assertSelf(/[A-Z]/.test(p) && /[a-z]/.test(p) && /[2-9]/.test(p) && /[-_.+]/.test(p), "missing a character class");
    assertSelf(!seen.has(p), "duplicate password");
    seen.add(p);
  }
  const acct = SEED_ACCOUNTS[1];
  assertSelf(!decide(acct, null).rotate, "missing user must not rotate");
  assertSelf(!decide(acct, { passwordHash: null, institutionCode: "DEMO" }).rotate, "NULL hash must not rotate");
  assertSelf(!decide(acct, { passwordHash: "x", institutionCode: "OTHER" }).rotate, "wrong tenant must not rotate");
  assertSelf(decide(acct, { passwordHash: "x", institutionCode: "DEMO" }).rotate, "normal seed user should rotate");
  assertSelf(selectEmails([...SEED_EMAILS], ["admin@demo.edu"], []).length === 1, "--only filter");
  let threw = false;
  try { selectEmails([...SEED_EMAILS], ["someone@else.com"], []); } catch { threw = true; }
  assertSelf(threw, "non-seed email in --only must be refused");
  assertSelf(SEED_ACCOUNTS.length === 10, "seed list size changed");
  const h = bcrypt.hashSync("probe-Pass.1", BCRYPT_COST);
  assertSelf(bcrypt.compareSync("probe-Pass.1", h) && !bcrypt.compareSync("nope", h), "bcrypt round trip");
  console.log("self-test OK (password generator, decision rules, --only guard, bcrypt cost 12 round trip)");
}

async function loadRows(db, emails) {
  return db.$queryRawUnsafe(
    `SELECT u.id, u.email, u.role::text AS role, u."accountStatus"::text AS status,
            u."passwordHash" AS "passwordHash", u."mfaEnabled" AS mfa,
            i.name AS "institutionName", i.code AS "institutionCode"
       FROM users u JOIN institutions i ON i.id = u."institutionId"
      WHERE u.email = ANY($1::text[])`,
    emails,
  );
}

function pad(s, n) { return String(s).padEnd(n); }

function ensureIgnored() {
  if (isGitIgnored(CREDS_REL)) return;
  console.log(`Credentials path is NOT git-ignored. Adding to .gitignore: ${GITIGNORE_LINE}`);
  const gi = path.join(repoRoot, ".gitignore");
  const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  appendFileSync(gi, `${cur.endsWith("\n") || cur === "" ? "" : "\n"}${GITIGNORE_LINE}\n`);
  if (!isGitIgnored(CREDS_REL)) throw new Error(`${CREDS_REL} is still not git-ignored; refusing --apply.`);
  console.log("  .gitignore updated and path re-verified as ignored (commit .gitignore).");
}

async function main() {
  const { flags, values } = parseArgs(process.argv.slice(2), ["only", "exclude"]);
  if (flags.has("self-test")) return selfTest();

  const apply = flags.has("apply");
  if (apply && !flags.has(CONFIRM_FLAG)) {
    throw new Error(`--apply requires --${CONFIRM_FLAG}. Nothing was changed.`);
  }
  const emails = selectEmails(SEED_ACCOUNTS.map((a) => a.email), csv(values.only), csv(values.exclude));

  const url = resolveOwnerUrl();
  console.log(`Target database host: ${describeHost(url)}`);
  console.log(`Mode: ${apply ? "APPLY (writes to production)" : "DRY RUN (read-only)"}\n`);

  const db = makeClient(url);
  try {
    await connectWithRetry(db);
    const rows = await loadRows(db, SEED_ACCOUNTS.map((a) => a.email));
    const byEmail = new Map(rows.map((r) => [r.email, r]));

    const plan = [];
    console.log(`${pad("email", 30)} ${pad("found", 5)} ${pad("role", 12)} ${pad("institution", 20)} ${pad("hasPw", 5)} ${pad("mfa", 4)} ${pad("demoPwStillWorks", 16)} WOULD ROTATE`);
    for (const acct of SEED_ACCOUNTS) {
      const row = byEmail.get(acct.email);
      const d = decide(acct, row);
      const selected = emails.includes(acct.email);
      const stillDefault = row?.passwordHash
        ? (await bcrypt.compare(acct.defaultPw, row.passwordHash) ? "YES (public!)" : "no")
        : "-";
      const verdict = !selected ? "no (excluded by --only/--exclude)" : d.rotate ? "yes" : `no: ${d.reason}`;
      console.log(`${pad(acct.email, 30)} ${pad(row ? "yes" : "no", 5)} ${pad(row?.role ?? "-", 12)} ${pad(row?.institutionName ?? "-", 20)} ${pad(row ? (row.passwordHash ? "yes" : "no") : "-", 5)} ${pad(row ? (row.mfa ? "on" : "off") : "-", 4)} ${pad(stillDefault, 16)} ${verdict}`);
      if (selected && d.rotate) plan.push({ ...acct, id: row.id });
    }

    // Demo-looking accounts that are NOT in the seed list (list only, never touched).
    const others = await db.$queryRawUnsafe(
      `SELECT u.email, u.role::text AS role, i.name AS inst, (u."passwordHash" IS NOT NULL) AS "hasPw"
         FROM users u JOIN institutions i ON i.id = u."institutionId"
        WHERE (u.email ILIKE '%@demo.edu' OR u.email ILIKE '%@campusgate.local' OR u.email ILIKE '%@example.test')
          AND NOT (u.email = ANY($1::text[]))
        ORDER BY u.email`,
      [...SEED_EMAILS],
    );
    console.log(`\nDemo-looking users NOT in the seed list (listed only, never touched): ${others.length}`);
    for (const o of others) console.log(`  ${pad(o.email, 42)} ${pad(o.role, 12)} ${pad(o.inst, 34)} hasPw=${o.hasPw ? "yes" : "no"}`);

    const missing = SEED_ACCOUNTS.filter((a) => !byEmail.has(a.email)).map((a) => a.email);
    console.log(`\nSeed emails not found: ${missing.length ? missing.join(", ") : "none"}`);
    console.log(`Would rotate: ${plan.length} of ${SEED_ACCOUNTS.length}`);
    if (plan.some((p) => p.email === SUPERADMIN)) {
      console.log(`\n!!! WARNING: rotating ${SUPERADMIN} does NOT change its MFA enrollment (MFA secret/recovery codes stay as they are).`);
    }
    console.log("Reminder: already-issued JWTs stay valid for up to 24h (expiresIn \"24h\"); rotate JWT_SECRET to cut them off at once.");

    if (!apply) {
      console.log(`\nDry run only. To apply: node scripts/rotate-seed-passwords.mjs --apply --${CONFIRM_FLAG}`);
      return;
    }
    if (plan.length === 0) { console.log("\nNothing to rotate."); return; }

    // ─── APPLY ───────────────────────────────────────────────────────────────
    ensureIgnored();
    const creds = {};
    const hashes = [];
    for (const p of plan) {
      const pw = generatePassword();
      const hash = await bcrypt.hash(pw, BCRYPT_COST);
      if (!(await bcrypt.compare(pw, hash))) throw new Error("hash verification failed; aborting before any write");
      creds[p.email] = pw;
      hashes.push({ id: p.id, hash });
    }

    let merged = {};
    if (existsSync(CREDS_PATH)) {
      try { merged = JSON.parse(readFileSync(CREDS_PATH, "utf8")); } catch { merged = {}; }
    }
    writeFileSync(PENDING_PATH, JSON.stringify({ ...merged, ...creds }, null, 2) + "\n", { mode: 0o600 });

    try {
      await db.$transaction(
        async (tx) => {
          for (const h of hashes) {
            const n = await tx.$executeRawUnsafe(
              `UPDATE users SET "passwordHash" = $1 WHERE id = $2 AND "passwordHash" IS NOT NULL`,
              h.hash, h.id,
            );
            if (n !== 1) throw new Error(`expected to update exactly 1 row, got ${n}; rolling back`);
          }
        },
        { maxWait: 15000, timeout: 60000 },
      );
    } catch (e) {
      try { unlinkSync(PENDING_PATH); } catch { /* ignore */ }
      throw e;
    }
    try {
      renameSync(PENDING_PATH, CREDS_PATH);
    } catch (e) {
      throw new Error(`DB COMMITTED but moving the credentials file failed (${e.message}). The new passwords are in ${PENDING_PATH}; do not delete it.`);
    }
    console.log(`\nRotated ${hashes.length} account(s) in one transaction.`);
    console.log(`Credentials written to: ${CREDS_PATH}  (secret, git-ignored; passwords are not printed)`);
  } finally {
    await db.$disconnect();
  }
}

// Run only when executed directly (keeps the exports importable for tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`\nERROR: ${String(e?.message ?? e).split("\n").slice(-3).join(" ").slice(0, 400)}`);
    process.exitCode = 1;
  });
}
