import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
    // Test files share live Neon/Upstash test instances (never mocked, per
    // the design spec) — running files in parallel causes cross-file
    // resetDb() races against the same tables/queue.
    fileParallelism: false,
  },
});
