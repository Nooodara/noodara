import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { domainSourceAliases } from './vitest.shared.js';

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
  },
});
