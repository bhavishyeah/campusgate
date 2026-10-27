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
  },
});
