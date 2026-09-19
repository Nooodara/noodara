import { defineConfig } from 'vitest/config';
import { domainSourceAliases, sshSourceAliases, uiSourceAliases } from './vitest.shared.js';

// Vitest 5 uses `projects` (the config key that superseded the deprecated one removed since
// 3.2). Each monorepo package gets its own project scoped to `src/**/*.test.ts` so integration
// tests (tests/integration/**) never run as part of the unit pass, and a dedicated root project
// covers the repo-level harness smoke test in tests/unit/.
export default defineConfig({
  // packages/domain's `exports` resolve through its built `dist` (01-16-PLAN.md Task 2); this
  // alias keeps every in-process unit test resolving straight to packages/domain/src instead, so
  // QA-02's coverage gate keeps measuring source and no build step is required to run `pnpm test`.
  // See vitest.shared.ts for the ordering rule this alias array depends on.
  resolve: { alias: [...domainSourceAliases, ...sshSourceAliases, ...uiSourceAliases] },
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
          name: 'dom',
          // Separate project, not a widening of `packages`/`apps` above: those two include only
          // `*.test.ts` and run in the node environment. jsdom is meaningfully slower than node,
          // and apps/web (once it exists) must not inherit the `apps` project's control-plane
          // env stand-ins below -- a browser-side app has no business reading
          // NOODARA_MASTER_KEY/DATABASE_URL/etc.
          include: ['packages/ui/src/**/*.test.tsx', 'apps/web/src/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['./vitest.setup.dom.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'apps',
          include: ['apps/*/src/**/*.test.ts'],
          // apps/control-plane/src/env.ts fail-fasts at *import* time (INST-06: `export const env =
          // loadEnv(process.env)` is a required module-level side effect, not something env.test.ts
          // can opt out of). These are non-secret, obviously-fake stand-ins so that importing the
          // module during the unit-test run doesn't call `process.exit(1)` before any test runs —
          // they satisfy `parseEnv`'s shape/strength checks but are never used to reach a real
          // database, Redis instance or auth boundary.
          env: {
            NOODARA_MASTER_KEY: 'eWB5OqY8pzJkJZV29xSd3tXvJl4T6vytT1ChtZa7wRM=',
            BETTER_AUTH_SECRET: 'vitest-fixture-better-auth-secret-not-real-32chars',
            DATABASE_URL: 'postgres://test_user:test-fixture-pw@localhost:5432/noodara_test',
            REDIS_URL: 'redis://localhost:6379',
            NOODARA_PUBLIC_URL: 'http://localhost:3000',
          },
        },
      },
    ],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/integration/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      all: true,
      include: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.d.ts',
        '**/index.ts',
        'packages/ssh/src/testing/**',
        'packages/ui/src/testing/**',
      ],
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
