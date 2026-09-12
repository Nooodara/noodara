import { defineConfig } from 'vitest/config';

// Separate config for Testcontainers-backed integration tests: heavier timeouts, no coverage,
// and file-parallelism disabled since containers are heavy and must not race each other.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    fileParallelism: false,
    // No integration tests exist yet in this plan; only this config may set passWithNoTests.
    passWithNoTests: true,
    // Builds the workspace once before the whole integration run (see global-setup.ts) so the
    // boot smoke test always exercises current sources, never a stale dist/.
    globalSetup: ['tests/integration/global-setup.ts'],
  },
});
