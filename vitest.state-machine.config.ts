import { defineConfig } from 'vitest/config';
import { domainSourceAliases } from './vitest.shared.js';

// Gate coverage-state-machine (16-02, ROADMAP §8.7): the deployment state machine is held to 100%
// statements, branches, functions and lines by its own test file alone, so coverage borrowed
// from other suites can never hide an untested edge.
export default defineConfig({
  resolve: { alias: [...domainSourceAliases] },
  test: {
    include: ['packages/domain/src/deployment/deployment-state.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage/state-machine',
      include: ['packages/domain/src/deployment/deployment-state.ts'],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
