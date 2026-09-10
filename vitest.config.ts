import { defineConfig } from 'vitest/config';

// Vitest 5 uses `projects` (the config key that superseded the deprecated one removed since
// 3.2). Each monorepo package gets its own project scoped to `src/**/*.test.ts` so integration
// tests (tests/integration/**) never run as part of the unit pass, and a dedicated root project
// covers the repo-level harness smoke test in tests/unit/.
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'root',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'packages',
          include: ['packages/*/src/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'apps',
          include: ['apps/*/src/**/*.test.ts'],
        },
      },
    ],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/integration/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      all: true,
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/index.ts'],
      // QA-02: packages/domain must stay at >=95% statements/branches. No global threshold is
      // set for other packages/apps in v0.1 — coverage is reported for them, not gated.
      thresholds: {
        'packages/domain/**': {
          statements: 95,
          branches: 95,
        },
      },
    },
  },
});
