import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  MissingTransitionReasonError,
  SERVER_STATUSES,
  type ServerStatus,
  type TransitionReason,
  canTransition,
  canTrustFingerprint,
  transition,
} from './server-state.js';

// Allowed edges, hand-written once here as the test's independent expectation of the feature
// spec (D-13/D-14/D-15/D-16). The cross-product below is generated from SERVER_STATUSES so that
// adding a seventh state — or widening the table without updating this list — fails the suite.
const ALLOWED_EDGES: readonly (readonly [ServerStatus, ServerStatus])[] = [
  ['PENDING', 'CONNECTING'],
  ['CONNECTING', 'CONNECTED'],
  ['CONNECTING', 'UNREACHABLE'],
  ['CONNECTING', 'ERROR'],
  ['CONNECTED', 'CONNECTING'],
  ['CONNECTED', 'DISCONNECTED'],
  ['CONNECTED', 'UNREACHABLE'],
  ['CONNECTED', 'ERROR'],
  ['CONNECTED', 'PENDING'],
  ['DISCONNECTED', 'CONNECTING'],
  ['UNREACHABLE', 'CONNECTING'],
  ['ERROR', 'CONNECTING'],
  ['ERROR', 'PENDING'],
];

// The three edges D-13/D-14/D-15 gate behind an explicit reason.
const REASON_FOR_EDGE: Readonly<Partial<Record<string, TransitionReason>>> = {
  'CONNECTED->PENDING': 'identity_changed',
  'ERROR->PENDING': 'fingerprint_trusted',
  'CONNECTED->DISCONNECTED': 'clean_close',
};

const ALL_REASONS: readonly TransitionReason[] = [
  'identity_changed',
  'fingerprint_trusted',
  'clean_close',
];

const isAllowed = (from: ServerStatus, to: ServerStatus): boolean =>
  ALLOWED_EDGES.some(([f, t]) => f === from && t === to);

// The full 36-pair cross-product, derived mechanically from SERVER_STATUSES (RESEARCH Pattern 4).
const ALL_PAIRS: readonly (readonly [ServerStatus, ServerStatus])[] = SERVER_STATUSES.flatMap(
  (from) => SERVER_STATUSES.map((to) => [from, to] as const),
);

describe('SERVER_STATUSES', () => {
  it('has exactly 6 entries', () => {
    expect(SERVER_STATUSES.length).toBe(6);
  });

  it('produces a 36-pair cross-product', () => {
    expect(ALL_PAIRS.length).toBe(36);
  });
});

describe('canTransition', () => {
  it.each(ALL_PAIRS)('from %s to %s matches the allowed-edge table', (from, to) => {
    expect(canTransition(from, to)).toBe(isAllowed(from, to));
  });

  it('allows exactly 13 of the 36 ordered pairs', () => {
    expect(ALLOWED_EDGES.length).toBe(13);
    const allowedCount = ALL_PAIRS.filter(([from, to]) => canTransition(from, to)).length;
    expect(allowedCount).toBe(13);
  });

  it('rejects self-transitions for all six states', () => {
    for (const status of SERVER_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });
});

describe('transition (exhaustive cross-product)', () => {
  it.each(ALL_PAIRS)('from %s to %s', (from, to) => {
    const edgeKey = `${from}->${to}`;
    const requiredReason = REASON_FOR_EDGE[edgeKey];

    if (!isAllowed(from, to)) {
      expect(() => transition(from, to)).toThrow(InvalidTransitionError);
      expect(() => transition(from, to)).toThrow(`Invalid transition: ${from} -> ${to}`);
      return;
    }

    if (requiredReason !== undefined) {
      expect(() => transition(from, to)).toThrow(MissingTransitionReasonError);
      expect(transition(from, to, { reason: requiredReason })).toBe(to);

      const wrongReason = ALL_REASONS.find((reason) => reason !== requiredReason);
      if (wrongReason !== undefined) {
        expect(() => transition(from, to, { reason: wrongReason })).toThrow(
          MissingTransitionReasonError,
        );
      }
      return;
    }

    expect(transition(from, to)).toBe(to);
  });
});

describe('transition (reason-gated edges, D-13/D-14/D-15)', () => {
  it('CONNECTED -> PENDING requires identity_changed (D-14)', () => {
    expect(() => transition('CONNECTED', 'PENDING')).toThrow(MissingTransitionReasonError);
    expect(transition('CONNECTED', 'PENDING', { reason: 'identity_changed' })).toBe('PENDING');
    expect(() => transition('CONNECTED', 'PENDING', { reason: 'clean_close' })).toThrow(
      MissingTransitionReasonError,
    );
  });

  it('ERROR -> PENDING requires fingerprint_trusted (D-15)', () => {
    expect(() => transition('ERROR', 'PENDING')).toThrow(MissingTransitionReasonError);
    expect(transition('ERROR', 'PENDING', { reason: 'fingerprint_trusted' })).toBe('PENDING');
    expect(() => transition('ERROR', 'PENDING', { reason: 'identity_changed' })).toThrow(
      MissingTransitionReasonError,
    );
  });

  it('CONNECTED -> DISCONNECTED requires clean_close (D-13, no admin Disconnect action)', () => {
    expect(() => transition('CONNECTED', 'DISCONNECTED')).toThrow(MissingTransitionReasonError);
    expect(transition('CONNECTED', 'DISCONNECTED', { reason: 'clean_close' })).toBe(
      'DISCONNECTED',
    );
    expect(() => transition('CONNECTED', 'DISCONNECTED', { reason: 'fingerprint_trusted' })).toThrow(
      MissingTransitionReasonError,
    );
  });
});

describe('canTrustFingerprint (gap 6 / T-5G-27-04)', () => {
  it('is true for ERROR', () => {
    expect(canTrustFingerprint('ERROR')).toBe(true);
  });

  it.each<ServerStatus>(['PENDING', 'CONNECTING', 'CONNECTED', 'DISCONNECTED', 'UNREACHABLE'])(
    'is false for %s',
    (status) => {
      expect(canTrustFingerprint(status)).toBe(false);
    },
  );

  // Property test (plan 05-27 Task 1): canTrustFingerprint(s) === true iff
  // transition(s, 'PENDING', { reason: 'fingerprint_trusted' }) does not throw, for every status
  // — proving the predicate never drifts from transition()'s own table, without hardcoding a
  // second list here that could silently diverge from it.
  it.each(SERVER_STATUSES)('agrees with transition(%s, PENDING, fingerprint_trusted) not throwing', (status) => {
    let transitionThrows = false;
    try {
      transition(status, 'PENDING', { reason: 'fingerprint_trusted' });
    } catch {
      transitionThrows = true;
    }
    expect(canTrustFingerprint(status)).toBe(!transitionThrows);
  });
});

describe('InvalidTransitionError / MissingTransitionReasonError', () => {
  it('InvalidTransitionError carries from/to fields', () => {
    try {
      transition('PENDING', 'CONNECTED');
      expect.unreachable('expected transition to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      expect((error as InvalidTransitionError).from).toBe('PENDING');
      expect((error as InvalidTransitionError).to).toBe('CONNECTED');
    }
  });

  it('MissingTransitionReasonError carries from/to fields', () => {
    try {
      transition('CONNECTED', 'PENDING');
      expect.unreachable('expected transition to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(MissingTransitionReasonError);
      expect((error as MissingTransitionReasonError).from).toBe('CONNECTED');
      expect((error as MissingTransitionReasonError).to).toBe('PENDING');
    }
  });
});
