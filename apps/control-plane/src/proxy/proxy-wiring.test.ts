// 22-02 (H1): the stale-install pick, the proxy worker options and the never-throwing boot sweep.
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/client.js';
import { noopServerEventPublisher } from '../events/server-event-publisher.js';
import { PROXY_QUEUE_NAME } from '../queue/proxy-queue.js';
import { pickStaleInstalls } from './proxy-store.js';
import {
  PROXY_INSTALL_BUDGET_MS,
  proxyRemoveTimeoutMs,
  proxyRuntimeLimits,
  proxyWorkerLockDurationMs,
  startProxyWorker,
  sweepStaleProxyInstalls,
  type CreateProxyBullWorker,
} from './proxy-wiring.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('pickStaleInstalls (H1)', () => {
  const cutoff = new Date('2026-10-31T10:00:00Z');
  const before = new Date('2026-10-31T09:59:59Z');
  const after = new Date('2026-10-31T10:00:01Z');

  it('fails a row older than the budget even while its job is pending', async () => {
    const isPending = vi.fn(() => Promise.resolve(true));
    expect(await pickStaleInstalls([{ id: 'a', installStartedAt: before }], cutoff, isPending)).toEqual(['a']);
    expect(isPending).not.toHaveBeenCalled();
  });

  it('keeps a recent row whose job is pending and fails a recent row whose job is gone', async () => {
    const pending = new Set(['live']);
    const stale = await pickStaleInstalls(
      [
        { id: 'live', installStartedAt: after },
        { id: 'lost', installStartedAt: after },
        { id: 'edge', installStartedAt: cutoff },
      ],
      cutoff,
      (id) => Promise.resolve(pending.has(id)),
    );
    expect(stale).toEqual(['lost', 'edge']);
  });

  it('fails a row with no install start time without asking the queue', async () => {
    const isPending = vi.fn(() => Promise.resolve(true));
    expect(await pickStaleInstalls([{ id: 'legacy', installStartedAt: null }], cutoff, isPending)).toEqual(['legacy']);
    expect(isPending).not.toHaveBeenCalled();
  });

  it('returns nothing for no rows', async () => {
    expect(await pickStaleInstalls([], cutoff, () => Promise.resolve(false))).toEqual([]);
  });
});

describe('proxy runtime limits', () => {
  it('bounds each step by the SSH command timeout and keeps the lock above the budget', () => {
    const limits = proxyRuntimeLimits({ commandMs: 30_000, maxLineBytes: 16_384 });
    expect(limits.stepMs).toBe(30_000);
    expect(limits.maxLineBytes).toBe(16_384);
    expect(limits.pullMs + limits.verifyMs + limits.stepMs * 6).toBeLessThan(PROXY_INSTALL_BUDGET_MS);
    expect(proxyWorkerLockDurationMs(PROXY_INSTALL_BUDGET_MS)).toBeGreaterThan(PROXY_INSTALL_BUDGET_MS);
    expect(proxyRemoveTimeoutMs({ connectMs: 10_000, commandMs: 30_000 })).toBe(110_000);
  });
});

describe('startProxyWorker', () => {
  it('runs the handler on the proxy queue with a lock above the budget and no stalled retries', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const close = vi.fn(() => Promise.resolve());
    let captured: { name: string; opts: Record<string, unknown>; processor: Parameters<CreateProxyBullWorker>[1] } | undefined;
    const createWorker: CreateProxyBullWorker = (name, processor, opts) => {
      captured = { name, opts: opts as unknown as Record<string, unknown>, processor };
      const on = (event: string, listener: (...args: unknown[]) => void): unknown => listeners.set(event, listener);
      return { on: on as ReturnType<CreateProxyBullWorker>['on'], close };
    };
    const handler = vi.fn(() => Promise.resolve('installed' as const));
    const handle = startProxyWorker({
      handler,
      connection: {} as never,
      budgetMs: 1_000,
      logger,
      createWorker,
    });

    expect(captured?.name).toBe(PROXY_QUEUE_NAME);
    expect(captured?.opts.lockDuration).toBe(proxyWorkerLockDurationMs(1_000));
    expect(captured?.opts.maxStalledCount).toBe(0);
    expect(await captured?.processor({ data: { serverId: 'x' } })).toEqual({ outcome: 'installed' });
    expect(handler).toHaveBeenCalledWith({ serverId: 'x' });

    // A worker error logs only the class name.
    listeners.get('error')?.(new Error('redis://user:hunter2@host'));
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('hunter2');
    expect(listeners.has('failed')).toBe(true);

    await handle.close();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('sweepStaleProxyInstalls', () => {
  it('never throws when the database is unavailable', async () => {
    const db = {
      select: () => {
        throw new Error('postgres://noodara:secret@db/noodara');
      },
    } as unknown as Database;
    const result = await sweepStaleProxyInstalls({
      db,
      now: () => new Date(),
      events: noopServerEventPublisher,
      isPending: () => Promise.resolve(false),
      budgetMs: PROXY_INSTALL_BUDGET_MS,
      logger,
    });
    expect(result).toEqual([]);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
  });
});
