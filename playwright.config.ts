// QA-04: replaces the `test:e2e` placeholder with a real Playwright suite driving the whole
// stack (tests/e2e/fixtures/stack.ts). `workers: 1` + `fullyParallel: false` mirror
// vitest.integration.config.ts's own `fileParallelism: false` reasoning — one shared
// Postgres/Redis/API/worker/web stack, never raced against itself. This config deliberately
// has no built-in single-command-server option configured: the stack fixture (not Playwright)
// owns the lifecycle of all five processes/containers, since they must start and stop together
// and none of them is "just a dev server".
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  // A flaky E2E must be visible, not retried away — this project holds zero known flaky tests
  // (CLAUDE.md SS2.2) — so this is 0 both locally and in CI, never a CI-only override.
  retries: 0,
  // A stray `test.only` must fail CI outright.
  forbidOnly: !!process.env.CI,
  // Sized for a real SSH-and-worker flow (connect + discovery over a real sshd container), not a
  // typical UI-only assertion budget.
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  reporter: [['html'], ['list']],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
