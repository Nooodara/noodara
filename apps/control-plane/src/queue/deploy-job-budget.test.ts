import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  DEPLOY_CLEANUP_ALLOWANCE_MS,
  DEPLOY_MAX_MS_DEFAULT,
  DEPLOY_MAX_MS_RANGE,
  computeDeployCancelKeyTtlMs,
  computeDeployJobBudget,
  computeDeployJobLockDurationMs,
} from './deploy-job-budget.js';

// Node's timers (and so BullMQ's lock-renewal timer) clamp anything above this to 1 ms.
const MAX_TIMER_MS = 2 ** 31 - 1;

describe('deploy job budget (D15)', () => {
  it('defaults NOODARA_DEPLOY_MAX_MS to 60 minutes inside its range', () => {
    expect(DEPLOY_MAX_MS_DEFAULT).toBe(3_600_000);
    expect(DEPLOY_MAX_MS_DEFAULT).toBeGreaterThanOrEqual(DEPLOY_MAX_MS_RANGE.min);
    expect(DEPLOY_MAX_MS_DEFAULT).toBeLessThanOrEqual(DEPLOY_MAX_MS_RANGE.max);
  });

  it.each([
    ['min', DEPLOY_MAX_MS_RANGE.min],
    ['default', DEPLOY_MAX_MS_DEFAULT],
    ['max', DEPLOY_MAX_MS_RANGE.max],
  ])('lock duration at the %s deploy max outlives the build plus its cleanup', (_label, deployMaxMs) => {
    const lockDurationMs = computeDeployJobLockDurationMs(deployMaxMs);

    expect(lockDurationMs).toBeGreaterThan(deployMaxMs + DEPLOY_CLEANUP_ALLOWANCE_MS);
    expect(Number.isInteger(lockDurationMs)).toBe(true);
    expect(lockDurationMs).toBeLessThanOrEqual(MAX_TIMER_MS);
  });

  it.each([
    ['min', DEPLOY_MAX_MS_RANGE.min],
    ['max', DEPLOY_MAX_MS_RANGE.max],
  ])('cancel-key TTL at the %s deploy max equals the lock duration', (_label, deployMaxMs) => {
    const ttlMs = computeDeployCancelKeyTtlMs(deployMaxMs);

    expect(ttlMs).toBe(computeDeployJobLockDurationMs(deployMaxMs));
    expect(ttlMs).toBeGreaterThan(deployMaxMs);
  });

  it('grows monotonically with the deploy max', () => {
    const atMin = computeDeployJobLockDurationMs(DEPLOY_MAX_MS_RANGE.min);
    const atMax = computeDeployJobLockDurationMs(DEPLOY_MAX_MS_RANGE.max);

    expect(atMax - atMin).toBe(DEPLOY_MAX_MS_RANGE.max - DEPLOY_MAX_MS_RANGE.min);
  });

  it('returns lock duration and cancel-key TTL together', () => {
    const budget = computeDeployJobBudget(DEPLOY_MAX_MS_DEFAULT);

    expect(budget).toEqual({
      lockDurationMs: computeDeployJobLockDurationMs(DEPLOY_MAX_MS_DEFAULT),
      cancelKeyTtlMs: computeDeployCancelKeyTtlMs(DEPLOY_MAX_MS_DEFAULT),
    });
  });

  it.each([
    ['below the minimum', DEPLOY_MAX_MS_RANGE.min - 1],
    ['above the maximum', DEPLOY_MAX_MS_RANGE.max + 1],
    ['not an integer', 60_000.5],
    ['NaN', Number.NaN],
  ])('rejects a deploy max %s', (_label, deployMaxMs) => {
    expect(() => computeDeployJobLockDurationMs(deployMaxMs)).toThrow(RangeError);
  });

  it('does not import or read a module-level env', async () => {
    const source = await readFile(new URL('./deploy-job-budget.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/from ['"]\.\.\/env\.js['"]/);
    expect(source).not.toMatch(/process\.env/);
  });
});
