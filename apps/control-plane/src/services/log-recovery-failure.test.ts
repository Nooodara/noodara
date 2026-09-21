// 05-REVIEW.md GR-03 / T-5G-41-01..04: unit coverage for the one helper that logs
// `connectAndDiscover`'s swallowed `failInFlightConnection` recovery failure. Deliberately no
// database, no real pino — a fake `ServiceLogger` is enough to pin the three load-bearing
// properties: it logs once, it never leaks error text into the message, and it never throws
// (a logging failure must never become a second failure on a recovery path, T-5G-41-03).
import { describe, expect, it, vi } from 'vitest';
import { logRecoveryFailure } from './log-recovery-failure.js';
import type { ServiceLogger } from './server-service-deps.js';

function buildFakeLogger(): { logger: ServiceLogger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const logger: ServiceLogger = { warn, error: vi.fn() };
  return { logger, warn };
}

describe('logRecoveryFailure (05-REVIEW.md GR-03)', () => {
  it('calls logger.warn exactly once with the error under `err` and the serverId', () => {
    const { logger, warn } = buildFakeLogger();
    const err = new Error('boom');

    logRecoveryFailure({ logger }, 'server-id-1', err);

    expect(warn).toHaveBeenCalledTimes(1);
    const [metadata, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(metadata.err).toBe(err);
    expect(metadata.serverId).toBe('server-id-1');
    expect(typeof message).toBe('string');
  });

  it('never puts any part of the error message in the log text', () => {
    const { logger, warn } = buildFakeLogger();
    const err = new Error('boom');

    logRecoveryFailure({ logger }, 'server-id-1', err);

    const [metadata, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).not.toContain('boom');
    const metadataWithoutErr: Record<string, unknown> = { ...metadata };
    delete metadataWithoutErr.err;
    expect(JSON.stringify(metadataWithoutErr)).not.toContain('boom');
  });

  it('a secret-shaped error message never reaches the log text', () => {
    const { logger, warn } = buildFakeLogger();
    const secret = 'postgres://user:sk-live-SECRET@host/db';
    const err = new Error(secret);

    logRecoveryFailure({ logger }, 'server-id-1', err);

    const [metadata, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).not.toContain('sk-live-SECRET');
    const metadataWithoutErr: Record<string, unknown> = { ...metadata };
    delete metadataWithoutErr.err;
    expect(JSON.stringify(metadataWithoutErr)).not.toContain('sk-live-SECRET');
  });

  it('never throws when logger is absent', () => {
    expect(() => {
      logRecoveryFailure({}, 'server-id-1', new Error('boom'));
    }).not.toThrow();
  });

  it('never throws when the logger itself throws', () => {
    const throwingLogger: ServiceLogger = {
      warn: () => {
        throw new Error('logger is down');
      },
      error: vi.fn(),
    };

    expect(() => {
      logRecoveryFailure({ logger: throwingLogger }, 'server-id-1', new Error('boom'));
    }).not.toThrow();
  });

  it('handles a non-Error rejection value (a string) without throwing', () => {
    const { logger, warn } = buildFakeLogger();

    expect(() => {
      logRecoveryFailure({ logger }, 'id', 'not-an-error');
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('handles a non-Error rejection value (undefined) without throwing', () => {
    const { logger, warn } = buildFakeLogger();

    expect(() => {
      logRecoveryFailure({ logger }, 'id', undefined);
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
