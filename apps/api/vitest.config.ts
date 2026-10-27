import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.property.test.ts'],
    // A few *.integration.test.ts suites (tenant-escape, superadmin-security,
    // module-system) run against the live Supabase pooler. Remote round-trips
    // over the ap-south-1 pooler can take several seconds and occasionally spike,
    // so the default 5s test / 10s hook timeouts cause flaky failures that are
    // purely latency, not real defects. Widen them so these suites are reliable.
    testTimeout: 30000,
    hookTimeout: 60000,
    // Several *.integration.test.ts suites (tenant-escape, superadmin-security,
    // module-system, and the two Phase-1 academics suites) run against the live
    // Supabase instance. Each opens connections on the session pooler, which caps
    // at 15 clients in session mode; the academics ROUTE suite additionally drives
    // `authenticate`'s privilegedPrisma reads on that same pooler. On a 16-logical-
    // CPU host Vitest fans out enough forks to run many real-DB files at once and
    // trips `EMAXCONNSESSION: max clients reached` / transient P1001s mid-suite.
    // Run test FILES serially (one at a time) so no two real-DB suites overlap on
    // the pooler. Tests WITHIN a file still run in order; this is a reliability
    // bound only — no behaviour changes. The mocked suites are fast enough that
    // serial file execution keeps the whole run well within a few minutes.
    fileParallelism: false,
  },
});
