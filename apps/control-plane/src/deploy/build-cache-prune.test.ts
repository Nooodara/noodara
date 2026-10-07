import { describe, expect, it, vi } from 'vitest';
import type { StepResult } from '@noodara/docker';
import { createRedactor } from '@noodara/domain/security';
import type { SshDeploySession } from '@noodara/ssh';
import {
  BUILD_CACHE_PRUNE_LIMITS,
  BUILD_CACHE_PRUNE_TTL_SECONDS,
  buildCachePruneKey,
  createBuildCachePrune,
  type BuildCachePruneDeps,
} from './build-cache-prune.js';

const SERVER = '11111111-1111-4111-8111-111111111111';
const DEPLOYMENT = '22222222-2222-4222-8222-222222222222';
const session = {} as SshDeploySession;

const OK: StepResult<null> = {
  ok: true,
  value: null,
  result: { exitCode: 0, stdoutTail: 'Total: 1.2GB\ndeadbeefcache', stderrTail: '', truncated: false } as never,
};

function setup(overrides: Partial<BuildCachePruneDeps> = {}) {
  const keys = new Map<string, number>();
  const redis = {
    setNxEx: vi.fn((key: string, ttl: number) => {
      if (keys.has(key)) return Promise.resolve(false);
      keys.set(key, ttl);
      return Promise.resolve(true);
    }),
    del: vi.fn((key: string) => {
      keys.delete(key);
      return Promise.resolve();
    }),
  };
  const prune = vi.fn((): Promise<StepResult<null>> => Promise.resolve(OK));
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: BuildCachePruneDeps = {
    mode: 'on',
    redis,
    hasOtherBuilding: vi.fn(() => Promise.resolve(false)),
    prune,
    logger,
    ...overrides,
  };
  const run = () =>
    createBuildCachePrune(deps)({ serverId: SERVER, deploymentId: DEPLOYMENT, session, redactor: createRedactor() });
  return { run, redis, prune, logger, keys, deps };
}

describe('after-success build cache prune (14-10, D12)', () => {
  it('prunes once, with an explicit hard timeout, and sets the key with the 24 h TTL first', async () => {
    const { run, prune, redis } = setup();

    const outcome = await run();

    expect(outcome).toBe('pruned');
    expect(redis.setNxEx).toHaveBeenCalledWith(buildCachePruneKey(SERVER), BUILD_CACHE_PRUNE_TTL_SECONDS);
    expect(BUILD_CACHE_PRUNE_TTL_SECONDS).toBe(86_400);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(BUILD_CACHE_PRUNE_LIMITS.maxDurationMs).toBeGreaterThan(0);
    expect(BUILD_CACHE_PRUNE_LIMITS.maxDurationMs).toBeLessThanOrEqual(300_000);
    expect(redis.setNxEx.mock.invocationCallOrder[0]).toBeLessThan(prune.mock.invocationCallOrder[0] ?? 0);
  });

  it('runs one prune for two consecutive deployments on the same server', async () => {
    const { run, prune } = setup();

    expect(await run()).toBe('pruned');
    expect(await run()).toBe('skipped_recent');
    expect(prune).toHaveBeenCalledTimes(1);
  });

  it('runs one prune for two concurrent deployments (SET NX is the arbiter)', async () => {
    const { run, prune } = setup();

    const outcomes = await Promise.all([run(), run()]);

    expect(outcomes.sort()).toEqual(['pruned', 'skipped_recent']);
    expect(prune).toHaveBeenCalledTimes(1);
  });

  it('issues no prune and touches no Redis key when the knob is off', async () => {
    const { run, prune, redis } = setup({ mode: 'off' });

    expect(await run()).toBe('disabled');
    expect(prune).not.toHaveBeenCalled();
    expect(redis.setNxEx).not.toHaveBeenCalled();
  });

  it('skips while another deployment on the server is BUILDING, without taking the key', async () => {
    const { run, prune, redis, deps } = setup({ hasOtherBuilding: vi.fn(() => Promise.resolve(true)) });

    expect(await run()).toBe('skipped_building');
    expect(prune).not.toHaveBeenCalled();
    expect(redis.setNxEx).not.toHaveBeenCalled();
    expect(deps.hasOtherBuilding).toHaveBeenCalledWith(SERVER, DEPLOYMENT);
  });

  it('skips (never runs unbounded) when Redis fails, logging the error class only', async () => {
    const boom = new Error('connect redis://:hunter2@host failed');
    boom.name = 'ReplyError';
    const failing = setup({
      redis: { setNxEx: () => Promise.reject(boom), del: () => Promise.resolve() },
    });

    expect(await failing.run()).toBe('skipped_redis');
    expect(failing.prune).not.toHaveBeenCalled();
    expect(JSON.stringify(failing.logger.warn.mock.calls)).not.toContain('hunter2');
    expect(JSON.stringify(failing.logger.warn.mock.calls)).toContain('ReplyError');
  });

  it('skips when the building check fails, without pruning', async () => {
    const { run, prune } = setup({ hasOtherBuilding: () => Promise.reject(new Error('db down')) });

    expect(await run()).toBe('skipped_check_failed');
    expect(prune).not.toHaveBeenCalled();
  });

  it.each([
    ['a classified failure', { ok: false, kind: 'failed', code: 'DOCKER_DAEMON_UNREACHABLE', message: 'cache id deadbeef' }],
    ['a timeout', { ok: false, kind: 'interrupted', outcome: 'timed_out' }],
    ['an idle timeout', { ok: false, kind: 'interrupted', outcome: 'idle_timeout' }],
  ] as const)('releases the key after %s so the next deploy retries, logging the class only', async (_name, result) => {
    const { run, keys, logger, prune } = setup();
    prune.mockResolvedValueOnce(result as unknown as StepResult<null>);

    expect(await run()).toBe('failed');

    expect(keys.size).toBe(0);
    const logged = JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls, logger.info.mock.calls]);
    expect(logged).not.toContain('deadbeef');
    expect(await run()).toBe('pruned');
  });

  it('never throws when the prune port throws, and releases the key', async () => {
    const { run, keys, prune, logger } = setup();
    prune.mockRejectedValueOnce(Object.assign(new Error('secret-token-xyz'), { name: 'SshError' }));

    expect(await run()).toBe('failed');

    expect(keys.size).toBe(0);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret-token-xyz');
    expect(JSON.stringify(logger.warn.mock.calls)).toContain('SshError');
  });

  it('does not log or return the prune output (cache ids)', async () => {
    const { run, logger } = setup();

    await run();

    const logged = JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls, logger.info.mock.calls]);
    expect(logged).not.toContain('deadbeefcache');
  });
});
