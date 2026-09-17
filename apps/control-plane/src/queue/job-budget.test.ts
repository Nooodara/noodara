import { describe, expect, it } from 'vitest';
import { computeJobLockDurationMs } from './job-budget.js';

describe('computeJobLockDurationMs (D-14)', () => {
  it('returns 112000 for the default SSH timeouts', () => {
    const result = computeJobLockDurationMs({ connectMs: 10000, commandMs: 30000, discoveryMs: 60000 });

    expect(result).toBe(112000);
  });

  it('is a pure function: two calls with the same input return the same number', () => {
    const timeouts = { connectMs: 5000, commandMs: 45000, discoveryMs: 90000 };

    const first = computeJobLockDurationMs(timeouts);
    const second = computeJobLockDurationMs(timeouts);

    expect(first).toBe(second);
  });

  it('does not import or read a module-level env', async () => {
    const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('./job-budget.ts', import.meta.url), 'utf8'));

    expect(source).not.toMatch(/from ['"]\.\.\/env\.js['"]/);
  });
});
