import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { domainSourceAliases } from './vitest.shared.js';
import { RUNNER_TIMEOUT_DEFAULTS, resolveRunnerTimeoutScale } from './tests/support/timeout-scale.js';

// A live run (NOODARA_AI_EVAL_LIVE=1, 29-02) calls the provider for every scenario turn.
const live = process.env.NOODARA_AI_EVAL_LIVE === '1';

// 36-01: runner-level timeouts are derived from tests/support/timeout-scale.ts (opt-in
// NOODARA_TEST_TIMEOUT_SCALE, exactly 1 when unset and never set in CI); an invalid value throws
// here, before any test, global setup, container or port is touched.
const timeouts = resolveRunnerTimeoutScale('vitest ai-evals');
const budget = live ? RUNNER_TIMEOUT_DEFAULTS.aiEvalsLive : RUNNER_TIMEOUT_DEFAULTS.aiEvals;

// 29-xx: the AI eval suite (tests/ai/evals). It runs the real tool registry from packages/ai
// source over in-memory fixtures; @noodara/ai is not a root dependency, so it resolves by alias.
export default defineConfig({
  resolve: {
    alias: [
      ...domainSourceAliases,
      { find: /^@noodara\/ai$/, replacement: fileURLToPath(new URL('./packages/ai/src/index.ts', import.meta.url)) },
    ],
  },
  test: {
    include: ['tests/ai/evals/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    hookTimeout: timeouts.scaled(budget.hookTimeout),
    testTimeout: timeouts.scaled(budget.testTimeout),
  },
});
