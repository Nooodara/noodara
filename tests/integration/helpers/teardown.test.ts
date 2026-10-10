import { describe, expect, it } from 'vitest';
import { runTeardown, settleWithin } from './teardown.js';

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

describe('runTeardown (14-27)', () => {
  it('runs every step in order and resolves when all succeed', async () => {
    const ran: string[] = [];
    await runTeardown('suite', [
      { name: 'a', run: () => void ran.push('a') },
      { name: 'b', run: async () => void ran.push('b') },
    ]);
    expect(ran).toEqual(['a', 'b']);
  });

  it('still runs the later steps (stack.stop) when an earlier step hangs past its timeout, then fails naming it', async () => {
    const ran: string[] = [];
    const outcome = runTeardown('logs suite', [
      { name: 'logs.closeAll', run: () => never(), timeoutMs: 20 },
      { name: 'stack.stop', run: () => void ran.push('stack.stop') },
    ]);
    await expect(outcome).rejects.toThrow(
      /logs suite teardown failed: logs\.closeAll: timed out after 20 ms/,
    );
    expect(ran).toEqual(['stack.stop']);
  });

  it('still runs the later steps when an earlier step throws, and reports every failure', async () => {
    const ran: string[] = [];
    const outcome = runTeardown('suite', [
      { name: 'redis.stop', run: () => Promise.reject(new Error('boom')) },
      { name: 'postgres.stop', run: () => void ran.push('postgres.stop') },
      {
        name: 'stack.stop',
        run: () => {
          throw new Error('bang');
        },
      },
    ]);
    await expect(outcome).rejects.toThrow(
      'suite teardown failed: redis.stop: boom; stack.stop: bang',
    );
    expect(ran).toEqual(['postgres.stop']);
  });

  it('applies the default step timeout when a step sets none', async () => {
    const outcome = runTeardown(
      'suite',
      [{ name: 'hang', run: () => never() }],
      { stepTimeoutMs: 15 },
    );
    await expect(outcome).rejects.toThrow(/hang: timed out after 15 ms/);
  });
});

describe('settleWithin (14-27)', () => {
  it('returns the value of a start that resolves in time', async () => {
    await expect(settleWithin(Promise.resolve('stack'), 50)).resolves.toBe(
      'stack',
    );
  });

  it('returns undefined for a missing, rejected or still-pending start, never throwing', async () => {
    await expect(settleWithin(undefined, 50)).resolves.toBeUndefined();
    await expect(
      settleWithin(Promise.reject(new Error('no')), 50),
    ).resolves.toBeUndefined();
    await expect(settleWithin(never(), 15)).resolves.toBeUndefined();
  });

  it('picks up a start that was still pending when the hook gave up but resolves within the wait', async () => {
    const late = new Promise<string>((resolve) =>
      setTimeout(() => resolve('late stack'), 10),
    );
    await expect(settleWithin(late, 500)).resolves.toBe('late stack');
  });
});
