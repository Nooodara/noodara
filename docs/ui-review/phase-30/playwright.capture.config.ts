// 30-06 (A2): reproducible capture of the phase-30 screens (metrics and status, logs, graph, AI
// settings and chat) for the UX review. It runs the existing phase-30 e2e specs, which stub the
// API with page.route, once per theme at 375 and 1280 px, with a full-page screenshot at the end
// of every test. Run with
//   caffeinate -is pnpm exec playwright test -c docs/ui-review/phase-30/playwright.capture.config.ts
// then pick the end-of-test captures from test-results/phase-30-capture into this directory.
import { defineConfig, devices } from '@playwright/test';

const variants = [
  { theme: 'dark', width: 1280 },
  { theme: 'light', width: 1280 },
  { theme: 'dark', width: 375 },
  { theme: 'light', width: 375 },
] as const;

export default defineConfig({
  testDir: '../../../tests/e2e',
  testMatch: ['metrics.spec.ts', 'logs.spec.ts', 'graph.spec.ts', 'ai-settings.spec.ts', 'ai-chat.spec.ts'],
  globalSetup: '../../../tests/e2e/global-setup.ts',
  globalTeardown: '../../../tests/e2e/global-teardown.ts',
  outputDir: '../../../test-results/phase-30-capture',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
    video: 'off',
    screenshot: { mode: 'on', fullPage: true },
  },
  projects: variants.map(({ theme, width }) => ({
    name: `${theme}-${String(width)}`,
    use: { ...devices['Desktop Chrome'], colorScheme: theme, viewport: { width, height: 900 } },
  })),
});
