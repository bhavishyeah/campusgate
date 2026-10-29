import { defineConfig } from 'vitest/config';
import { LIVE_DB_SUITES } from './vitest.live-db-suites.js';

// Default test run: everything EXCEPT the live-DB suites (fast, deterministic,
// no Supabase pooler dependency), so "all tests green" is a trustworthy signal.
// The live-DB suites run via `npm run test:integration` (vitest.integration.config.ts).
//
// See vitest.live-db-suites.ts for why the split exists and how to keep the list
// current when a new real-DB suite is added.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.property.test.ts'],
    exclude: [...LIVE_DB_SUITES, '**/node_modules/**', '**/dist/**'],
    testTimeout: 30000,
    hookTimeout: 60000,
    // The live-DB session pooler caps at 15 clients; run FILES serially so no two
    // real-DB suites overlap on the pooler. Harmless for the fast default run.
    fileParallelism: false,
  },
});
