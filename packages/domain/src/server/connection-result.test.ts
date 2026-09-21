import { describe, expect, it } from 'vitest';
import { InvalidTransitionError, type ServerStatus } from './server-state.js';
import {
  SERVER_ERROR_CODES,
  type ConnectionResult,
  type ServerConnectionState,
  applyConnectionResult,
  statusForErrorCode,
} from './connection-result.js';

// D-11: UNSUPPORTED_OS is a warning, not an error — the connection and discovery both succeeded,
// the platform is simply outside the supported matrix, so it lands on CONNECTED like a success
// while still being recorded in lastErrorCode for display.
const ERROR_STATUS_TABLE: Readonly<Record<(typeof SERVER_ERROR_CODES)[number], ServerStatus>> = {
  AUTH_FAILED: 'ERROR',
  COMMAND_TIMEOUT: 'ERROR',
  HOST_KEY_CHANGED: 'ERROR',
  UNSUPPORTED_OS: 'CONNECTED',
  HOST_UNRESOLVED: 'UNREACHABLE',
  CONNECT_TIMEOUT: 'UNREACHABLE',
  CONNECTION_LOST: 'UNREACHABLE',
};

function deepFreeze<T>(value: T): T {
  Object.getOwnPropertyNames(value).forEach((key) => {
    const prop = (value as Record<string, unknown>)[key];
    if (prop !== null && (typeof prop === 'object' || typeof prop === 'function')) {
      deepFreeze(prop);
    }
  });
  return Object.freeze(value);
}

function buildState(overrides: Partial<ServerConnectionState> = {}): ServerConnectionState {
  return {
    status: 'CONNECTING',
    lastErrorCode: null,
    hostFingerprint: null,
    pendingFingerprint: null,
    lastSeenAt: null,
    ...overrides,
  };
}

const NOW = new Date('2026-09-10T12:00:00.000Z');

describe('SERVER_ERROR_CODES', () => {
  it('contains exactly the 7 documented codes', () => {
    expect([...SERVER_ERROR_CODES].sort()).toEqual(
      [
        'AUTH_FAILED',
        'HOST_UNRESOLVED',
        'CONNECT_TIMEOUT',
        'COMMAND_TIMEOUT',
        'HOST_KEY_CHANGED',
        'CONNECTION_LOST',
        'UNSUPPORTED_OS',
      ].sort(),
    );
  });
});

describe('statusForErrorCode', () => {
  it.each(SERVER_ERROR_CODES.map((code) => [code, ERROR_STATUS_TABLE[code]] as const))(
    '%s maps to %s',
    (code, expected) => {
      expect(statusForErrorCode(code)).toBe(expected);
    },
  );
});

describe('applyConnectionResult (success)', () => {
  it('yields CONNECTED, clears lastErrorCode, and captures the fingerprint via TOFU when none was set', () => {
    const state = deepFreeze(buildState({ status: 'CONNECTING', lastErrorCode: 'AUTH_FAILED' }));
    const result: ConnectionResult = { ok: true, fingerprint: 'SHA256:abc' };

    const next = applyConnectionResult(state, result, NOW);

    expect(next.status).toBe('CONNECTED');
    expect(next.lastErrorCode).toBeNull();
    expect(next.hostFingerprint).toBe('SHA256:abc');
    expect(next.lastSeenAt).toEqual(NOW);
  });

  it('does not overwrite an already-trusted hostFingerprint', () => {
    const state = deepFreeze(
      buildState({ status: 'CONNECTING', hostFingerprint: 'SHA256:trusted' }),
    );
    const result: ConnectionResult = { ok: true, fingerprint: 'SHA256:new' };

    const next = applyConnectionResult(state, result, NOW);

    expect(next.hostFingerprint).toBe('SHA256:trusted');
  });

  // GR-01/gap 6: a fingerprint parked by an earlier HOST_KEY_CHANGED failure must not survive a
  // later successful connect and be promotable off a stale parked value.
  it('clears a previously parked pendingFingerprint on a successful reconnect', () => {
    const state = deepFreeze(
      buildState({
        status: 'CONNECTING',
        hostFingerprint: 'SHA256:trusted',
        pendingFingerprint: 'SHA256:parked',
      }),
    );
    const result: ConnectionResult = { ok: true, fingerprint: 'SHA256:trusted' };

    const next = applyConnectionResult(state, result, NOW);

    expect(next.pendingFingerprint).toBeNull();
    expect(next.status).toBe('CONNECTED');
    expect(next.lastErrorCode).toBeNull();
    expect(next.hostFingerprint).toBe('SHA256:trusted');
  });

  it('clears a parked pendingFingerprint on a successful first-capture (TOFU) connect too', () => {
    const state = deepFreeze(
      buildState({
        status: 'CONNECTING',
        hostFingerprint: null,
        pendingFingerprint: 'SHA256:parked',
      }),
    );
    const result: ConnectionResult = { ok: true, fingerprint: 'SHA256:observed' };

    const next = applyConnectionResult(state, result, NOW);

    expect(next.hostFingerprint).toBe('SHA256:observed');
    expect(next.pendingFingerprint).toBeNull();
  });
});

describe('applyConnectionResult (failure)', () => {
  it('HOST_KEY_CHANGED lands in ERROR, parks the observed fingerprint (newest observation wins over an older parked value), and leaves hostFingerprint untouched (D-15)', () => {
    const state = deepFreeze(
      buildState({
        status: 'CONNECTING',
        hostFingerprint: 'SHA256:trusted',
        pendingFingerprint: 'SHA256:older',
      }),
    );
    const result: ConnectionResult = {
      ok: false,
      errorCode: 'HOST_KEY_CHANGED',
      observedFingerprint: 'SHA256:observed',
    };

    const next = applyConnectionResult(state, result, NOW);

    expect(next.status).toBe('ERROR');
    expect(next.lastErrorCode).toBe('HOST_KEY_CHANGED');
    expect(next.pendingFingerprint).toBe('SHA256:observed');
    expect(next.hostFingerprint).toBe('SHA256:trusted');
  });

  // GR-01/gap 6: this is the else-branch of the pendingFingerprint ternary — there is nothing
  // newer to replace the parked value with, so the older observation from an earlier
  // HOST_KEY_CHANGED failure is kept, not accidentally cleared.
  it('HOST_KEY_CHANGED with no observedFingerprint keeps the older parked value', () => {
    const state = deepFreeze(buildState({ status: 'CONNECTING', pendingFingerprint: 'SHA256:older' }));
    const result: ConnectionResult = { ok: false, errorCode: 'HOST_KEY_CHANGED' };

    const next = applyConnectionResult(state, result, NOW);

    expect(next.pendingFingerprint).toBe('SHA256:older');
  });

  // GR-01/gap 6: a fingerprint parked by an earlier HOST_KEY_CHANGED failure must not survive a
  // later, unrelated failure (e.g. AUTH_FAILED after a credential rotation) either.
  it.each(SERVER_ERROR_CODES.filter((code) => code !== 'HOST_KEY_CHANGED'))(
    '%s clears a parked pendingFingerprint (only a HOST_KEY_CHANGED outcome may keep one parked)',
    (code) => {
      const state = deepFreeze(
        buildState({ status: 'CONNECTING', pendingFingerprint: 'SHA256:parked' }),
      );
      const result: ConnectionResult = { ok: false, errorCode: code };

      const next = applyConnectionResult(state, result, NOW);

      expect(next.status).toBe(ERROR_STATUS_TABLE[code]);
      expect(next.lastErrorCode).toBe(code);
      expect(next.pendingFingerprint).toBeNull();
    },
  );
});

describe('applyConnectionResult (D-11: UNSUPPORTED_OS is a warning, not an error)', () => {
  it('lands on CONNECTED and records UNSUPPORTED_OS in lastErrorCode', () => {
    const state = deepFreeze(buildState({ status: 'CONNECTING' }));
    const result: ConnectionResult = { ok: false, errorCode: 'UNSUPPORTED_OS' };

    const next = applyConnectionResult(state, result, NOW);

    expect(next.status).toBe('CONNECTED');
    expect(next.lastErrorCode).toBe('UNSUPPORTED_OS');
  });

  it('does not set lastSeenAt or hostFingerprint (only the ok:true branch may)', () => {
    const state = deepFreeze(
      buildState({ status: 'CONNECTING', lastSeenAt: null, hostFingerprint: null }),
    );
    const result: ConnectionResult = { ok: false, errorCode: 'UNSUPPORTED_OS' };

    const next = applyConnectionResult(state, result, NOW);

    expect(next.lastSeenAt).toBeNull();
    expect(next.hostFingerprint).toBeNull();
  });

  it('still throws InvalidTransitionError when the source status is not CONNECTING (from PENDING)', () => {
    const state = deepFreeze(buildState({ status: 'PENDING' }));
    const result: ConnectionResult = { ok: false, errorCode: 'UNSUPPORTED_OS' };

    expect(() => applyConnectionResult(state, result, NOW)).toThrow(InvalidTransitionError);
  });
});

describe('applyConnectionResult (invariants)', () => {
  it.each(['PENDING', 'CONNECTED', 'DISCONNECTED', 'UNREACHABLE', 'ERROR'] as const)(
    'throws InvalidTransitionError when the server is not CONNECTING (from %s)',
    (status) => {
      const state = deepFreeze(buildState({ status }));
      const result: ConnectionResult = { ok: true, fingerprint: 'SHA256:abc' };

      expect(() => applyConnectionResult(state, result, NOW)).toThrow(InvalidTransitionError);
    },
  );

  it('is pure: does not mutate the input and returns deep-equal results for the same input', () => {
    const state = deepFreeze(buildState({ status: 'CONNECTING' }));
    const result: ConnectionResult = { ok: true, fingerprint: 'SHA256:abc' };

    const first = applyConnectionResult(state, result, NOW);
    const second = applyConnectionResult(state, result, NOW);

    expect(first).toEqual(second);
    expect(state.status).toBe('CONNECTING');
    expect(state.hostFingerprint).toBeNull();
  });
});
