import { defineConfig } from 'vitest/config';
import { LIVE_DB_SUITES } from './vitest.live-db-suites.js';

// Integration run (`npm run test:integration`): ONLY the live-Supabase suites,
// serially, with generous timeouts for pooler latency. Kept separate from the
// default `npm test` run so pooler flakiness never reddens the fast unit run.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: LIVE_DB_SUITES,
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false, // never overlap real-DB suites on the 15-client pooler
  },
});
