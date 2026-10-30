import { describe, expect, it } from 'vitest';
import {
  CERT_FAILURE_CAUSES,
  CERT_FAILURE_MESSAGES,
  CERT_POST_CHANGE_CHECK_DELAYS_MS,
  CERT_RENEWAL_WINDOW_MS,
  CERT_STATUSES,
  DEFAULT_CERT_CHECK_INTERVAL_MS,
  DEFAULT_CERT_ISSUE_TIMEOUT_MS,
  DEFAULT_CERT_TIMINGS,
  InvalidCertStatusTransitionError,
  type CertProbe,
  type CertState,
  type CertStatus,
  canTransitionCertStatus,
  certCheckDelayMs,
  decideCertStatus,
  retryCertStatus,
  transitionCertStatus,
} from './cert-status.js';

// Allowed edges, hand-written as the test's independent expectation (ADR 0011 A3 plus the
// 21-02 completions documented in docs/domain/cert-status-transitions.md). The cross-product
// is generated from CERT_STATUSES, so a new state or a widened table fails the suite.
const EDGES: readonly (readonly [CertStatus, CertStatus])[] = [
  ['NONE', 'PENDING'],
  ['PENDING', 'ISSUED'],
  ['PENDING', 'FAILED'],
  ['ISSUED', 'RENEWING'],
  ['ISSUED', 'EXPIRED'],
  ['ISSUED', 'PENDING'],
  ['RENEWING', 'ISSUED'],
  ['RENEWING', 'EXPIRED'],
  ['RENEWING', 'PENDING'],
  ['FAILED', 'PENDING'],
  ['FAILED', 'ISSUED'],
  ['EXPIRED', 'ISSUED'],
  ['EXPIRED', 'PENDING'],
];

const isEdge = (from: CertStatus, to: CertStatus): boolean =>
  EDGES.some(([f, t]) => f === from && t === to);

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = new Date('2026-10-30T12:00:00.000Z');
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

function state(overrides: Partial<CertState> & { status: CertStatus }): CertState {
  return {
    notAfter: null,
    errorCode: null,
    pendingSince: null,
    dnsStatus: null,
    ...overrides,
  };
}

const issued = (offsetMs: number): CertProbe => ({
  kind: 'issued',
  notAfter: at(offsetMs),
});
const DEFAULT: CertProbe = { kind: 'default' };
const DOWN: CertProbe = { kind: 'down' };

describe('CERT_STATUSES and the transition table (A2)', () => {
  it('lists the six states in ADR order', () => {
    expect(CERT_STATUSES).toEqual(['NONE', 'PENDING', 'ISSUED', 'RENEWING', 'FAILED', 'EXPIRED']);
    expect(Object.isFrozen(CERT_STATUSES)).toBe(true);
  });

  it('asserts all 36 ordered pairs', () => {
    let pairs = 0;
    for (const from of CERT_STATUSES) {
      for (const to of CERT_STATUSES) {
        pairs += 1;
        const allowed = isEdge(from, to);
        expect(canTransitionCertStatus(from, to), `${from} -> ${to}`).toBe(allowed);
        if (allowed) {
          expect(transitionCertStatus(from, to)).toBe(to);
        } else {
          expect(() => transitionCertStatus(from, to), `${from} -> ${to}`).toThrow(
            InvalidCertStatusTransitionError,
          );
        }
      }
    }
    expect(pairs).toBe(36);
  });

  it('names both ends on an invalid transition', () => {
    try {
      transitionCertStatus('NONE', 'ISSUED');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCertStatusTransitionError);
      const typed = error as InvalidCertStatusTransitionError;
      expect(typed.from).toBe('NONE');
      expect(typed.to).toBe('ISSUED');
      expect(typed.name).toBe('InvalidCertStatusTransitionError');
      expect(typed.message).toBe('Invalid certificate status transition: NONE -> ISSUED');
    }
  });

  it('retries only a FAILED certificate (dns-check RESOLVES or PATCH)', () => {
    for (const status of CERT_STATUSES) {
      expect(retryCertStatus(status)).toBe(status === 'FAILED' ? 'PENDING' : status);
    }
  });
});

describe('failure causes (A3)', () => {
  it('is a closed vocabulary with a fixed actionable message each', () => {
    expect(CERT_FAILURE_CAUSES).toEqual([
      'CERT_DNS_MISMATCH',
      'CERT_ISSUANCE_FAILED',
      'CERT_PROXY_UNAVAILABLE',
    ]);
    expect(Object.keys(CERT_FAILURE_MESSAGES).sort()).toEqual([...CERT_FAILURE_CAUSES].sort());
    for (const cause of CERT_FAILURE_CAUSES) {
      expect(CERT_FAILURE_MESSAGES[cause]).toMatch(/^[A-Z].+\.$/);
    }
    expect(CERT_FAILURE_MESSAGES.CERT_DNS_MISMATCH).toMatch(/A\/AAAA record/);
    expect(CERT_FAILURE_MESSAGES.CERT_ISSUANCE_FAILED).toMatch(/port 80/);
    expect(CERT_FAILURE_MESSAGES.CERT_PROXY_UNAVAILABLE).toMatch(/noodara-traefik/);
  });
});

describe('timings', () => {
  it('uses the ADR defaults', () => {
    expect(DEFAULT_CERT_ISSUE_TIMEOUT_MS).toBe(10 * MINUTE);
    expect(DEFAULT_CERT_CHECK_INTERVAL_MS).toBe(10 * MINUTE);
    expect(CERT_RENEWAL_WINDOW_MS).toBe(30 * DAY);
    expect(DEFAULT_CERT_TIMINGS).toEqual({
      issueTimeoutMs: 10 * MINUTE,
      renewalWindowMs: 30 * DAY,
    });
    expect(CERT_POST_CHANGE_CHECK_DELAYS_MS).toEqual([15_000, 30_000, 60_000]);
  });

  it('checks at 15 s, 30 s and 60 s after a change, then on the regular interval', () => {
    expect(certCheckDelayMs(0, 600_000)).toBe(15_000);
    expect(certCheckDelayMs(1, 600_000)).toBe(30_000);
    expect(certCheckDelayMs(2, 600_000)).toBe(60_000);
    expect(certCheckDelayMs(3, 600_000)).toBe(600_000);
    expect(certCheckDelayMs(50, 120_000)).toBe(120_000);
    expect(certCheckDelayMs(-1, 600_000)).toBe(15_000);
  });
});

describe('decideCertStatus (A2)', () => {
  describe('PENDING', () => {
    it('becomes ISSUED with notAfter on an issued certificate', () => {
      const decision = decideCertStatus(
        state({
          status: 'PENDING',
          pendingSince: at(-MINUTE),
          errorCode: 'CERT_PROXY_UNAVAILABLE',
        }),
        issued(90 * DAY),
        NOW,
        DEFAULT_CERT_TIMINGS,
      );
      expect(decision).toEqual({
        status: 'ISSUED',
        notAfter: at(90 * DAY),
        errorCode: null,
        statusChanged: true,
      });
    });

    it('becomes ISSUED even when the new certificate is already inside the renewal window', () => {
      const decision = decideCertStatus(
        state({ status: 'PENDING', pendingSince: at(-MINUTE) }),
        issued(5 * MINUTE),
        NOW,
      );
      expect(decision.status).toBe('ISSUED');
    });

    it('stays PENDING on the default certificate within the timeout and clears a stale cause', () => {
      const decision = decideCertStatus(
        state({
          status: 'PENDING',
          pendingSince: at(-10 * MINUTE),
          errorCode: 'CERT_PROXY_UNAVAILABLE',
        }),
        DEFAULT,
        NOW,
      );
      expect(decision).toEqual({
        status: 'PENDING',
        notAfter: null,
        errorCode: null,
        statusChanged: false,
      });
    });

    it('stays PENDING when pendingSince is unknown', () => {
      expect(decideCertStatus(state({ status: 'PENDING' }), DEFAULT, NOW).status).toBe('PENDING');
    });

    it.each([
      ['MISMATCH', 'CERT_DNS_MISMATCH'],
      ['UNRESOLVED', 'CERT_DNS_MISMATCH'],
      ['UNAVAILABLE', 'CERT_DNS_MISMATCH'],
      [null, 'CERT_DNS_MISMATCH'],
      ['RESOLVES', 'CERT_ISSUANCE_FAILED'],
    ] as const)('fails beyond the timeout with dns %s -> %s', (dnsStatus, cause) => {
      const decision = decideCertStatus(
        state({
          status: 'PENDING',
          pendingSince: at(-10 * MINUTE - 1),
          dnsStatus,
        }),
        DEFAULT,
        NOW,
      );
      expect(decision).toEqual({
        status: 'FAILED',
        notAfter: null,
        errorCode: cause,
        statusChanged: true,
      });
    });

    it('treats an expired certificate as not issued yet', () => {
      const within = decideCertStatus(
        state({ status: 'PENDING', pendingSince: at(-MINUTE) }),
        issued(-DAY),
        NOW,
      );
      expect(within.status).toBe('PENDING');
      const beyond = decideCertStatus(
        state({
          status: 'PENDING',
          pendingSince: at(-11 * MINUTE),
          dnsStatus: 'RESOLVES',
        }),
        issued(-DAY),
        NOW,
      );
      expect(beyond).toMatchObject({
        status: 'FAILED',
        errorCode: 'CERT_ISSUANCE_FAILED',
      });
    });

    it('honours a custom issue timeout', () => {
      const timings = {
        issueTimeoutMs: 1_000,
        renewalWindowMs: CERT_RENEWAL_WINDOW_MS,
      };
      const decision = decideCertStatus(
        state({
          status: 'PENDING',
          pendingSince: at(-2_000),
          dnsStatus: 'MISMATCH',
        }),
        DEFAULT,
        NOW,
        timings,
      );
      expect(decision.status).toBe('FAILED');
    });
  });

  describe('proxy down', () => {
    it.each(['NONE', 'ISSUED', 'RENEWING', 'FAILED', 'EXPIRED'] as const)(
      'keeps %s and records CERT_PROXY_UNAVAILABLE',
      (status) => {
        const current = state({
          status,
          notAfter: at(40 * DAY),
          errorCode: 'CERT_DNS_MISMATCH',
          pendingSince: at(-DAY),
        });
        expect(decideCertStatus(current, DOWN, NOW)).toEqual({
          status,
          notAfter: at(40 * DAY),
          errorCode: 'CERT_PROXY_UNAVAILABLE',
          statusChanged: false,
        });
      },
    );

    it('keeps PENDING within the timeout', () => {
      expect(
        decideCertStatus(state({ status: 'PENDING', pendingSince: at(-MINUTE) }), DOWN, NOW),
      ).toEqual({
        status: 'PENDING',
        notAfter: null,
        errorCode: 'CERT_PROXY_UNAVAILABLE',
        statusChanged: false,
      });
    });

    it('fails a PENDING certificate that timed out with CERT_PROXY_UNAVAILABLE', () => {
      expect(
        decideCertStatus(
          state({
            status: 'PENDING',
            pendingSince: at(-11 * MINUTE),
            dnsStatus: 'RESOLVES',
          }),
          DOWN,
          NOW,
        ),
      ).toEqual({
        status: 'FAILED',
        notAfter: null,
        errorCode: 'CERT_PROXY_UNAVAILABLE',
        statusChanged: true,
      });
    });
  });

  describe('ISSUED', () => {
    it('stays ISSUED outside the renewal window and follows a silent renewal', () => {
      const decision = decideCertStatus(
        state({
          status: 'ISSUED',
          notAfter: at(40 * DAY),
          errorCode: 'CERT_PROXY_UNAVAILABLE',
        }),
        issued(89 * DAY),
        NOW,
      );
      expect(decision).toEqual({
        status: 'ISSUED',
        notAfter: at(89 * DAY),
        errorCode: null,
        statusChanged: false,
      });
    });

    it('becomes RENEWING when notAfter is within 30 days (inclusive)', () => {
      const decision = decideCertStatus(
        state({ status: 'ISSUED', notAfter: at(30 * DAY) }),
        issued(30 * DAY),
        NOW,
      );
      expect(decision).toEqual({
        status: 'RENEWING',
        notAfter: at(30 * DAY),
        errorCode: null,
        statusChanged: true,
      });
      const outside = decideCertStatus(state({ status: 'ISSUED' }), issued(30 * DAY + 1), NOW);
      expect(outside.status).toBe('ISSUED');
    });

    it('becomes EXPIRED once notAfter is past, and stays valid at exactly notAfter', () => {
      expect(
        decideCertStatus(state({ status: 'ISSUED', notAfter: at(-1) }), issued(-1), NOW),
      ).toEqual({
        status: 'EXPIRED',
        notAfter: at(-1),
        errorCode: null,
        statusChanged: true,
      });
      expect(decideCertStatus(state({ status: 'ISSUED' }), issued(0), NOW).status).toBe('RENEWING');
    });

    it('returns to PENDING when the proxy serves its default certificate again', () => {
      expect(
        decideCertStatus(state({ status: 'ISSUED', notAfter: at(60 * DAY) }), DEFAULT, NOW),
      ).toEqual({
        status: 'PENDING',
        notAfter: null,
        errorCode: null,
        statusChanged: true,
      });
    });
  });

  describe('RENEWING', () => {
    it('becomes ISSUED on a later notAfter', () => {
      expect(
        decideCertStatus(
          state({ status: 'RENEWING', notAfter: at(10 * DAY) }),
          issued(90 * DAY),
          NOW,
        ),
      ).toEqual({
        status: 'ISSUED',
        notAfter: at(90 * DAY),
        errorCode: null,
        statusChanged: true,
      });
    });

    it('becomes ISSUED when no previous notAfter is known', () => {
      expect(decideCertStatus(state({ status: 'RENEWING' }), issued(DAY), NOW).status).toBe(
        'ISSUED',
      );
    });

    it('stays RENEWING on the same notAfter', () => {
      expect(
        decideCertStatus(
          state({ status: 'RENEWING', notAfter: at(10 * DAY) }),
          issued(10 * DAY),
          NOW,
        ),
      ).toEqual({
        status: 'RENEWING',
        notAfter: at(10 * DAY),
        errorCode: null,
        statusChanged: false,
      });
    });

    it('becomes EXPIRED once notAfter is past', () => {
      expect(
        decideCertStatus(state({ status: 'RENEWING', notAfter: at(-DAY) }), issued(-DAY), NOW)
          .status,
      ).toBe('EXPIRED');
    });

    it('returns to PENDING on the default certificate', () => {
      expect(decideCertStatus(state({ status: 'RENEWING' }), DEFAULT, NOW).status).toBe('PENDING');
    });
  });

  describe('EXPIRED', () => {
    it('stays EXPIRED on an expired certificate', () => {
      expect(
        decideCertStatus(state({ status: 'EXPIRED', notAfter: at(-DAY) }), issued(-DAY), NOW),
      ).toEqual({
        status: 'EXPIRED',
        notAfter: at(-DAY),
        errorCode: null,
        statusChanged: false,
      });
    });

    it('becomes ISSUED on a valid certificate', () => {
      expect(
        decideCertStatus(state({ status: 'EXPIRED', notAfter: at(-DAY) }), issued(60 * DAY), NOW),
      ).toEqual({
        status: 'ISSUED',
        notAfter: at(60 * DAY),
        errorCode: null,
        statusChanged: true,
      });
    });

    it('returns to PENDING on the default certificate', () => {
      expect(decideCertStatus(state({ status: 'EXPIRED' }), DEFAULT, NOW).status).toBe('PENDING');
    });
  });

  describe('FAILED', () => {
    it('stays FAILED with its cause on the default or an expired certificate', () => {
      const current = state({
        status: 'FAILED',
        errorCode: 'CERT_DNS_MISMATCH',
      });
      for (const probe of [DEFAULT, issued(-DAY)]) {
        expect(decideCertStatus(current, probe, NOW)).toEqual({
          status: 'FAILED',
          notAfter: null,
          errorCode: 'CERT_DNS_MISMATCH',
          statusChanged: false,
        });
      }
    });

    it('becomes ISSUED when a valid certificate is observed', () => {
      expect(
        decideCertStatus(
          state({ status: 'FAILED', errorCode: 'CERT_ISSUANCE_FAILED' }),
          issued(60 * DAY),
          NOW,
        ),
      ).toEqual({
        status: 'ISSUED',
        notAfter: at(60 * DAY),
        errorCode: null,
        statusChanged: true,
      });
    });
  });

  describe('NONE', () => {
    it('never leaves NONE on a probe (only "domain added" does)', () => {
      for (const probe of [DEFAULT, issued(60 * DAY), issued(-DAY)]) {
        expect(decideCertStatus(state({ status: 'NONE' }), probe, NOW)).toEqual({
          status: 'NONE',
          notAfter: null,
          errorCode: null,
          statusChanged: false,
        });
      }
    });
  });

  it('leaves the state untouched on an unparseable notAfter', () => {
    const current = state({ status: 'ISSUED', notAfter: at(60 * DAY) });
    expect(
      decideCertStatus(current, { kind: 'issued', notAfter: new Date(Number.NaN) }, NOW),
    ).toEqual({
      status: 'ISSUED',
      notAfter: at(60 * DAY),
      errorCode: null,
      statusChanged: false,
    });
  });

  it('only ever moves along an allowed edge, for every state, probe and timing', () => {
    const probes: CertProbe[] = [DEFAULT, DOWN, issued(-DAY), issued(DAY), issued(90 * DAY)];
    const dnsValues = [null, 'RESOLVES', 'MISMATCH', 'UNRESOLVED', 'UNAVAILABLE'] as const;
    for (const status of CERT_STATUSES) {
      for (const probe of probes) {
        for (const pendingSince of [null, at(-MINUTE), at(-DAY)]) {
          for (const dnsStatus of dnsValues) {
            const current = state({
              status,
              pendingSince,
              dnsStatus,
              notAfter: at(10 * DAY),
            });
            const decision = decideCertStatus(current, probe, NOW);
            expect(decision.statusChanged).toBe(decision.status !== status);
            if (decision.statusChanged) expect(isEdge(status, decision.status)).toBe(true);
            if (decision.errorCode !== null) {
              expect(CERT_FAILURE_CAUSES).toContain(decision.errorCode);
            }
          }
        }
      }
    }
  });

  it('is pure: the input state is not mutated', () => {
    const current = Object.freeze(state({ status: 'ISSUED', notAfter: at(10 * DAY) }));
    const snapshot = JSON.stringify(current);
    decideCertStatus(current, issued(90 * DAY), NOW);
    expect(JSON.stringify(current)).toBe(snapshot);
  });
});
