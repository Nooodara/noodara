// Per-target connection mutex tests (T-2-35). No test waits real wall-clock time — ordering is
// proven via deferred promises the test itself resolves, never a `setTimeout`.
import { describe, expect, it } from 'vitest';
import { createConnectionMutex } from './connection-mutex.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('createConnectionMutex', () => {
  it('serialises two acquisitions for the same key', async () => {
    const mutex = createConnectionMutex();
    const order: string[] = [];
    const first = deferred<undefined>();

    const firstRun = mutex.runExclusive('host-a', async () => {
      order.push('first-start');
      await first.promise;
      order.push('first-end');
    });
    const secondRun = mutex.runExclusive('host-a', () => {
      order.push('second-start');
      return Promise.resolve();
    });

    first.resolve(undefined);
    await Promise.all([firstRun, secondRun]);

    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('runs two different keys concurrently', async () => {
    const mutex = createConnectionMutex();
    const order: string[] = [];
    const gate = deferred<undefined>();

    const runA = mutex.runExclusive('host-a', async () => {
      order.push('a-start');
      await gate.promise;
      order.push('a-end');
    });
    const runB = mutex.runExclusive('host-b', () => {
      order.push('b-start');
      return Promise.resolve();
    });

    // host-b's run must not wait on host-a's still-outstanding lock.
    await runB;
    expect(order).toEqual(['a-start', 'b-start']);

    gate.resolve(undefined);
    await runA;
    expect(order).toEqual(['a-start', 'b-start', 'a-end']);
  });

  it('releases the mutex even when the guarded function rejects, so the same key succeeds afterwards', async () => {
    const mutex = createConnectionMutex();

    await expect(
      mutex.runExclusive('host-a', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    await expect(mutex.runExclusive('host-a', () => Promise.resolve('recovered'))).resolves.toBe('recovered');
  });

  it('acquires, releases and re-acquires the same key in sequence', async () => {
    const mutex = createConnectionMutex();

    await expect(mutex.runExclusive('host-a', () => Promise.resolve(1))).resolves.toBe(1);
    await expect(mutex.runExclusive('host-a', () => Promise.resolve(2))).resolves.toBe(2);
    await expect(mutex.runExclusive('host-a', () => Promise.resolve(3))).resolves.toBe(3);
  });
});
