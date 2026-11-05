import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { domainSourceAliases } from './vitest.shared.js';

// A live run (NOODARA_AI_EVAL_LIVE=1, 29-02) calls the provider for every scenario turn.
const live = process.env.NOODARA_AI_EVAL_LIVE === '1';

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
    hookTimeout: live ? 4 * 3600_000 : 120_000,
    testTimeout: live ? 4 * 3600_000 : 30_000,
  },
});
