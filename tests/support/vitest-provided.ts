// 36-02 (QA-26): the timeout factor as Vitest `provide`s it to every unit-test worker.
//
// vitest.config.ts resolves the factor once (tests/support/timeout-scale.ts) and provides it under
// TIMEOUT_SCALE_PROVIDE_KEY. Tests inside workspace packages cannot import this directory (pnpm
// boundaries), so they declare the same ProvidedContext key locally and call `inject` themselves;
// tests/unit/scripts/timeout-scale-runners.test.ts pins that every such declaration matches.
// Kept separate from timeout-scale.ts, which must stay import-free for Playwright and plain node.
import { inject } from 'vitest';
import { TIMEOUT_SCALE_PROVIDE_KEY, createTimeoutScale, type TimeoutScale } from './timeout-scale.js';

declare module 'vitest' {
  interface ProvidedContext {
    noodaraTestTimeoutScale: number;
  }
}

/**
 * Returns the provided factor as a TimeoutScale. Never defaults: a missing or out-of-range value
 * means the test is not running under the root vitest.config.ts, which is a wiring error.
 */
export function injectedTimeoutScale(read: () => unknown = () => inject(TIMEOUT_SCALE_PROVIDE_KEY)): TimeoutScale {
  const factor = read();
  if (typeof factor !== 'number') {
    throw new Error(`${TIMEOUT_SCALE_PROVIDE_KEY} was not provided: run this test through the root vitest.config.ts`);
  }
  return createTimeoutScale(factor);
}
