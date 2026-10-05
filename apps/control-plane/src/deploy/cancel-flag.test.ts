import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeployCancelFlags,
  deployCancelKey,
  watchDeployCancel,
  type CancelFlagRedis,
} from './cancel-flag.js';

const DEPLOYMENT_ID = '0192f1a4-7b3c-7d2e-8f00-00000000cccc';

function fakeRedis(overrides: Partial<CancelFlagRedis> = {}) {
  const keys = new Map<string, { value: string; ttlMs: number }>();
  const redis: CancelFlagRedis = {
    setNxPx: (key, value, ttlMs) => {
      if (keys.has(key)) return Promise.resolve(false);
      keys.set(key, { value, ttlMs });
      return Promise.resolve(true);
    },
    exists: (key) => Promise.resolve(keys.has(key)),
    del: (key) => {
      keys.delete(key);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { redis, keys };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('deploy cancel flag (A2, H1)', () => {
  it('uses the noodara:deploy-cancel:<deploymentId> key', () => {
    expect(deployCancelKey(DEPLOYMENT_ID)).toBe(`noodara:deploy-cancel:${DEPLOYMENT_ID}`);
  });

  it('sets the flag once with the given TTL; a second request is a no-op', async () => {
    const { redis, keys } = fakeRedis();
    const flags = createDeployCancelFlags({ redis, ttlMs: 3_930_000 });

    expect(await flags.request(DEPLOYMENT_ID)).toBe('requested');
    expect(await flags.request(DEPLOYMENT_ID)).toBe('already_requested');
    expect(keys.get(deployCancelKey(DEPLOYMENT_ID))).toEqual({ value: '1', ttlMs: 3_930_000 });
    expect(await flags.isRequested(DEPLOYMENT_ID)).toBe(true);

    await flags.clear(DEPLOYMENT_ID);
    expect(await flags.isRequested(DEPLOYMENT_ID)).toBe(false);
  });

  it('never throws: a failing or hanging Redis is unavailable / not requested', async () => {
    const failing = createDeployCancelFlags({
      redis: fakeRedis({
        setNxPx: () => Promise.reject(new Error('redis://:pw@cache down')),
        exists: () => Promise.reject(new Error('down')),
        del: () => Promise.reject(new Error('down')),
      }).redis,
      ttlMs: 1000,
    });
    expect(await failing.request(DEPLOYMENT_ID)).toBe('unavailable');
    expect(await failing.isRequested(DEPLOYMENT_ID)).toBe(false);
    await expect(failing.clear(DEPLOYMENT_ID)).resolves.toBeUndefined();

    const never = new Promise<never>(() => undefined);
    const hanging = createDeployCancelFlags({
      redis: fakeRedis({ setNxPx: () => never, exists: () => never }).redis,
      ttlMs: 1000,
      commandTimeoutMs: 20,
    });
    expect(await hanging.request(DEPLOYMENT_ID)).toBe('unavailable');
    expect(await hanging.isRequested(DEPLOYMENT_ID)).toBe(false);
  });
});

describe('watchDeployCancel', () => {
  it('aborts its signal once the flag appears and stops polling', async () => {
    vi.useFakeTimers();
    let requested = false;
    const isRequested = vi.fn(() => Promise.resolve(requested));
    const watch = watchDeployCancel({ flags: { isRequested }, deploymentId: DEPLOYMENT_ID, pollMs: 100 });

    await vi.advanceTimersByTimeAsync(250);
    expect(watch.signal.aborted).toBe(false);
    const callsBefore = isRequested.mock.calls.length;
    expect(callsBefore).toBeGreaterThanOrEqual(3);

    requested = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(watch.signal.aborted).toBe(true);
    const callsAtAbort = isRequested.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(isRequested.mock.calls.length).toBe(callsAtAbort);
    watch.stop();
  });

  it('stop() ends polling without aborting', async () => {
    vi.useFakeTimers();
    const isRequested = vi.fn(() => Promise.resolve(false));
    const watch = watchDeployCancel({ flags: { isRequested }, deploymentId: DEPLOYMENT_ID, pollMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    watch.stop();
    const calls = isRequested.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(isRequested.mock.calls.length).toBe(calls);
    expect(watch.signal.aborted).toBe(false);
  });
});
