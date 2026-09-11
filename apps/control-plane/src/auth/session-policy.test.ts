import { describe, expect, it } from 'vitest';
import { env } from '../env.js';
import { clampExpiry, sessionPolicy } from './session-policy.js';

// D-05 (clarified 2026-09-10): 7-day sliding window (`expiresIn`), renewed at most once per day
// (`updateAge`), with a hard 30-day ceiling from creation enforced by clamping every refresh's
// proposed `expiresAt` against a separately stored `absolute_expires_at`. This file covers the
// pure parts only: config values, `clampExpiry`, and the two hook functions called directly with
// a fabricated session object (RESEARCH "Open Questions (RESOLVED)" #1) — database-backed
// behavior is `tests/integration/auth/session-lifetime.test.ts`.

describe('clampExpiry', () => {
  it('returns the proposed date when it is before the absolute ceiling', () => {
    const proposed = new Date('2026-01-05T00:00:00.000Z');
    const absolute = new Date('2026-01-10T00:00:00.000Z');
    expect(clampExpiry(proposed, absolute)).toEqual(proposed);
  });

  it('returns the absolute ceiling when the proposed date is after it', () => {
    const proposed = new Date('2026-01-15T00:00:00.000Z');
    const absolute = new Date('2026-01-10T00:00:00.000Z');
    expect(clampExpiry(proposed, absolute)).toEqual(absolute);
  });

  it('returns the same instant when the proposed date exactly equals the ceiling', () => {
    const same = new Date('2026-01-10T00:00:00.000Z');
    expect(clampExpiry(same, same)).toEqual(same);
  });
});

describe('sessionPolicy.config', () => {
  it('sets expiresIn from NOODARA_SESSION_SLIDING_SECONDS', () => {
    expect(sessionPolicy.config.expiresIn).toBe(env.NOODARA_SESSION_SLIDING_SECONDS);
  });

  it('sets updateAge from NOODARA_SESSION_UPDATE_AGE_SECONDS', () => {
    expect(sessionPolicy.config.updateAge).toBe(env.NOODARA_SESSION_UPDATE_AGE_SECONDS);
  });

  it('declares absoluteExpiresAt and lastSeenAt as additional fields', () => {
    const fields = sessionPolicy.config.additionalFields;
    expect(fields?.absoluteExpiresAt?.type).toBe('date');
    expect(fields?.lastSeenAt?.type).toBe('date');
  });
});

describe('sessionPolicy.hooks.session.create.before', () => {
  it('sets absoluteExpiresAt to createdAt + NOODARA_SESSION_ABSOLUTE_SECONDS and lastSeenAt to createdAt', async () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const before = sessionPolicy.hooks.session?.create?.before;
    if (!before) throw new Error('session.create.before is not defined');

    const result = await before({ createdAt } as never, null);

    expect(result).toMatchObject({
      data: {
        absoluteExpiresAt: new Date(createdAt.getTime() + env.NOODARA_SESSION_ABSOLUTE_SECONDS * 1000),
        lastSeenAt: createdAt,
      },
    });
  });
});

describe('sessionPolicy.hooks.session.update.before', () => {
  // `sessionPolicy.clock` is a plain mutable property (not a vitest mock), so each test saves
  // and restores it itself via try/finally rather than relying on a shared afterEach.
  const originalClock = sessionPolicy.clock;

  it('sets lastSeenAt to now and clamps a proposed expiresAt within the absolute ceiling', async () => {
    const now = new Date('2026-01-08T00:00:00.000Z');
    sessionPolicy.clock = () => now;
    try {
      const absoluteExpiresAt = new Date('2026-02-01T00:00:00.000Z');
      const proposedExpiresAt = new Date('2026-01-15T00:00:00.000Z');
      const before = sessionPolicy.hooks.session?.update?.before;
      if (!before) throw new Error('session.update.before is not defined');

      const context = { context: { session: { session: { absoluteExpiresAt }, user: {} } } };
      const result = await before({ expiresAt: proposedExpiresAt } as never, context as never);

      expect(result).toMatchObject({ data: { lastSeenAt: now, expiresAt: proposedExpiresAt } });
    } finally {
      sessionPolicy.clock = originalClock;
    }
  });

  it('clamps a proposed expiresAt that exceeds the absolute ceiling down to the ceiling', async () => {
    const now = new Date('2026-01-29T00:00:00.000Z');
    sessionPolicy.clock = () => now;
    try {
      const absoluteExpiresAt = new Date('2026-02-01T00:00:00.000Z');
      const proposedExpiresAt = new Date('2026-02-05T00:00:00.000Z');
      const before = sessionPolicy.hooks.session?.update?.before;
      if (!before) throw new Error('session.update.before is not defined');

      const context = { context: { session: { session: { absoluteExpiresAt }, user: {} } } };
      const result = await before({ expiresAt: proposedExpiresAt } as never, context as never);

      expect(result).toMatchObject({ data: { lastSeenAt: now, expiresAt: absoluteExpiresAt } });
    } finally {
      sessionPolicy.clock = originalClock;
    }
  });

  it('sets lastSeenAt without touching expiresAt when no endpoint context is available', async () => {
    const now = new Date('2026-01-08T00:00:00.000Z');
    sessionPolicy.clock = () => now;
    try {
      const before = sessionPolicy.hooks.session?.update?.before;
      if (!before) throw new Error('session.update.before is not defined');

      const result = await before({ expiresAt: new Date('2026-01-15T00:00:00.000Z') } as never, null);

      expect(result).toMatchObject({ data: { lastSeenAt: now } });
      expect((result as { data: Record<string, unknown> }).data.expiresAt).toBeUndefined();
    } finally {
      sessionPolicy.clock = originalClock;
    }
  });
});
