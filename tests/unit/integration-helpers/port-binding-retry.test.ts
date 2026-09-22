// Unit coverage for tests/integration/helpers/port-binding-retry.ts: the bounded retry that
// absorbs Docker's asynchronous release of a just-stopped container's published host port. The
// real race was observed once in 930 E2E runs on the first real nightly (2026-09-22): stopping
// sshd A and immediately starting sshd B on the same fixed host port answered
// `driver failed programming external connectivity` and left a never-started container behind.
import { describe, expect, it, vi } from 'vitest';

const { isPortBindingRace, startWithPortBindingRetry } = await import(
  '../../integration/helpers/port-binding-retry.js'
);

const raceError = () =>
  new Error(
    '(HTTP code 500) server error - failed to set up container networking: driver failed programming external connectivity on endpoint cool_shtern (cddfb15b62cb): Bind for 0.0.0.0:42544 failed: port is already allocated',
  );

describe('isPortBindingRace', () => {
  it("recognises Docker's external-connectivity and port-allocated messages", () => {
    expect(isPortBindingRace(raceError())).toBe(true);
    expect(isPortBindingRace(new Error('listen tcp 0.0.0.0:42544: bind: address already in use'))).toBe(true);
  });

  it('does not treat any other failure as a race', () => {
    expect(isPortBindingRace(new Error('No such image: sshd-ubuntu-24.04'))).toBe(false);
    expect(isPortBindingRace(new Error('Wait strategy timed out'))).toBe(false);
    expect(isPortBindingRace('not even an Error')).toBe(false);
  });
});

describe('startWithPortBindingRetry', () => {
  it('returns the first successful result without sleeping when nothing fails', async () => {
    const sleep = vi.fn(async () => undefined);
    const start = vi.fn(async () => 'started');

    await expect(startWithPortBindingRetry(start, { sleep })).resolves.toBe('started');
    expect(start).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a port-binding race, cleaning up after each failed attempt, and succeeds', async () => {
    const sleep = vi.fn(async () => undefined);
    const onFailedAttempt = vi.fn(async () => undefined);
    const start = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(raceError())
      .mockRejectedValueOnce(raceError())
      .mockResolvedValueOnce('started');

    await expect(
      startWithPortBindingRetry(start, { attempts: 5, delayMs: 250, sleep, onFailedAttempt }),
    ).resolves.toBe('started');
    expect(start).toHaveBeenCalledTimes(3);
    expect(onFailedAttempt).toHaveBeenCalledTimes(2);
    expect(onFailedAttempt).toHaveBeenNthCalledWith(1, expect.any(Error), 1);
    expect(onFailedAttempt).toHaveBeenNthCalledWith(2, expect.any(Error), 2);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it('gives up after the configured number of attempts and rethrows the last race error', async () => {
    const sleep = vi.fn(async () => undefined);
    const error = raceError();
    const start = vi.fn(async () => {
      throw error;
    });

    await expect(startWithPortBindingRetry(start, { attempts: 3, sleep })).rejects.toBe(error);
    expect(start).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('never retries an error that is not a port-binding race', async () => {
    const sleep = vi.fn(async () => undefined);
    const onFailedAttempt = vi.fn(async () => undefined);
    const start = vi.fn(async () => {
      throw new Error('No such image: sshd-ubuntu-24.04');
    });

    await expect(startWithPortBindingRetry(start, { sleep, onFailedAttempt })).rejects.toThrow('No such image');
    expect(start).toHaveBeenCalledTimes(1);
    expect(onFailedAttempt).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rejects a non-positive attempt count instead of looping forever or never starting', async () => {
    await expect(startWithPortBindingRetry(async () => 'x', { attempts: 0 })).rejects.toThrow(RangeError);
  });
});
