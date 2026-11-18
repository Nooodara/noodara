import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['docs/testing/ssh-fixture-timeouts/runner.test.ts'], fileParallelism: false, testTimeout: 180000, hookTimeout: 30000, disableConsoleIntercept: true } });
