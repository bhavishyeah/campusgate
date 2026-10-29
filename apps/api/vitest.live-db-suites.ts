// ─── Live-DB integration suites ──────────────────────────────────────────────
// These suites do NOT mock @campusgate/db — they open real connections to the
// live Supabase instance:
//   - tenant-escape        proves cross-tenant RLS isolation on every tenant table
//   - superadmin-security  break-glass + append-only audit_events + RLS
//   - module-system        the real module entitlement/activation engine
//   - *-behavioral         real withTenant transactions for academics/classes/attendance
//   - sis-regression       SIS invariants against the live student row
//
// On the free-tier session pooler (≤15 clients, auto-pause, ap-south-1 latency),
// running all of them together in one pass intermittently trips
// `max clients reached` / transient P1001 — NOT real defects (each passes in
// isolation). So they are SPLIT OUT of the default `npm test` run and executed by
// `npm run test:integration` (serial, generous timeouts).
//
// IMPORTANT: membership here is by "does it touch the real DB", NOT by the
// `.integration.test.ts` filename — most *.integration.test.ts files mock
// @campusgate/db and are fast. When you add a NEW suite that connects to the real
// DB (no vi.mock('@campusgate/db')), add its glob to this list so the default run
// stays fast/deterministic and the integration run covers it.
export const LIVE_DB_SUITES = [
  'src/**/tenant-escape.integration.test.ts',
  'src/**/superadmin-security.integration.test.ts',
  'src/**/module-system.integration.test.ts',
  'src/**/academics-behavioral.integration.test.ts',
  'src/**/classes-behavioral.integration.test.ts',
  'src/**/attendance-behavioral.integration.test.ts',
  'src/**/library-behavioral.integration.test.ts',
  'src/**/sis-regression.integration.test.ts',
];
