import { defineConfig } from 'vitest/config';
import { domainSourceAliases } from './vitest.shared.js';

// Gate coverage-state-machine (16-02, ROADMAP §8.7; 21-02; 26-02; 26-03): the deployment and certificate state
// machines, the observability thresholds, the diagnosis classifier, the Infrastructure Graph and the log
// filter are held to 100% statements, branches, functions and lines by their own test files
// alone, so coverage borrowed from other suites can never hide an untested edge.
export default defineConfig({
  resolve: { alias: [...domainSourceAliases] },
  test: {
    include: [
      'packages/domain/src/deployment/deployment-state.test.ts',
      'packages/domain/src/domain/cert-status.test.ts',
      'packages/domain/src/observability/thresholds.test.ts',
      'packages/domain/src/observability/diagnosis.test.ts',
      'packages/domain/src/graph/graph.test.ts',
      'packages/domain/src/logs/log-filter.test.ts',
      'packages/domain/src/logs/merge-log-entries.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage/state-machine',
      include: [
        'packages/domain/src/deployment/deployment-state.ts',
        'packages/domain/src/domain/cert-status.ts',
        'packages/domain/src/observability/thresholds.ts',
        'packages/domain/src/observability/diagnosis.ts',
        'packages/domain/src/graph/build-graph.ts',
        'packages/domain/src/graph/scope-graph.ts',
        'packages/domain/src/logs/log-filter.ts',
        'packages/domain/src/logs/log-timestamp.ts',
        'packages/domain/src/logs/merge-log-entries.ts',
      ],
      thresholds: {
        perFile: true,
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
