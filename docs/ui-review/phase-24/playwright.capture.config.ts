// 24-05 (A3): reproducible capture of the phase-24 screens for the UX review. Run with
// NOODARA_UI_REVIEW_CAPTURE=1 pnpm exec playwright test -c docs/ui-review/phase-24/playwright.capture.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'capture.spec.ts',
  globalSetup: '../../../tests/e2e/global-setup.ts',
  globalTeardown: '../../../tests/e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 25 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3000', video: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
