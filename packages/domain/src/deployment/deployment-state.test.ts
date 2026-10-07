import { describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_LOG_PHASES,
  DEPLOYMENT_STATUSES,
  DEPLOYMENT_TRIGGERS,
  InvalidDeploymentTransitionError,
  NON_TERMINAL_DEPLOYMENT_STATUSES,
  TERMINAL_DEPLOYMENT_STATUSES,
  type DeploymentStatus,
  canTransitionDeployment,
  isTerminalDeploymentStatus,
  transitionDeployment,
} from './deployment-state.js';

// Allowed edges, hand-written as the test's independent expectation (DEP-01, ROADMAP D4). The
// cross-product below is generated from DEPLOYMENT_STATUSES, so adding a state or widening the
// table without updating this list fails the suite.
const ALLOWED_EDGES: readonly (readonly [DeploymentStatus, DeploymentStatus])[] = [
  ['QUEUED', 'PREPARING'],
  ['QUEUED', 'CANCELLED'],
  // 14-08: a QUEUED row whose job never reached the queue ends FAILED/ENQUEUE_FAILED.
  ['QUEUED', 'FAILED'],
  ['PREPARING', 'BUILDING'],
  ['PREPARING', 'FAILED'],
  ['PREPARING', 'CANCELLED'],
  ['BUILDING', 'DEPLOYING'],
  ['BUILDING', 'FAILED'],
  ['BUILDING', 'CANCELLED'],
  ['DEPLOYING', 'SUCCESS'],
  ['DEPLOYING', 'FAILED'],
  ['DEPLOYING', 'CANCELLED'],
];

const isAllowed = (from: DeploymentStatus, to: DeploymentStatus): boolean =>
  ALLOWED_EDGES.some(([f, t]) => f === from && t === to);

const ALL_PAIRS: readonly (readonly [DeploymentStatus, DeploymentStatus])[] =
  DEPLOYMENT_STATUSES.flatMap((from) => DEPLOYMENT_STATUSES.map((to) => [from, to] as const));

describe('DEPLOYMENT_STATUSES', () => {
  it('has exactly the seven v0.2 states', () => {
    expect([...DEPLOYMENT_STATUSES]).toEqual([
      'QUEUED',
      'PREPARING',
      'BUILDING',
      'DEPLOYING',
      'SUCCESS',
      'FAILED',
      'CANCELLED',
    ]);
  });

  it('produces a 49-pair cross-product', () => {
    expect(ALL_PAIRS.length).toBe(49);
  });

  it('does not declare the v0.3 states yet (D4)', () => {
    const statuses: readonly string[] = DEPLOYMENT_STATUSES;
    for (const future of ['HEALTHCHECK', 'ROLLING_BACK', 'ROLLED_BACK']) {
      expect(statuses).not.toContain(future);
    }
  });

  it('splits into disjoint non-terminal and terminal sets covering every state', () => {
    const nonTerminal: readonly string[] = NON_TERMINAL_DEPLOYMENT_STATUSES;
    const terminal: readonly string[] = TERMINAL_DEPLOYMENT_STATUSES;

    expect([...nonTerminal]).toEqual(['QUEUED', 'PREPARING', 'BUILDING', 'DEPLOYING']);
    expect([...terminal]).toEqual(['SUCCESS', 'FAILED', 'CANCELLED']);
    expect(nonTerminal.filter((s) => terminal.includes(s))).toEqual([]);
    expect([...nonTerminal, ...terminal].sort()).toEqual([...DEPLOYMENT_STATUSES].sort());
  });
});

describe('DEPLOYMENT_TRIGGERS / DEPLOYMENT_LOG_PHASES', () => {
  it('declares only manual and redeploy triggers in v0.2', () => {
    expect([...DEPLOYMENT_TRIGGERS]).toEqual(['manual', 'redeploy']);
  });

  it('declares the three log phases', () => {
    expect([...DEPLOYMENT_LOG_PHASES]).toEqual(['prepare', 'build', 'deploy']);
  });
});

describe('canTransitionDeployment', () => {
  it.each(ALL_PAIRS)('from %s to %s matches the allowed-edge table', (from, to) => {
    expect(canTransitionDeployment(from, to)).toBe(isAllowed(from, to));
  });

  it('allows exactly 12 of the 49 ordered pairs', () => {
    expect(ALLOWED_EDGES.length).toBe(12);
    expect(ALL_PAIRS.filter(([from, to]) => canTransitionDeployment(from, to)).length).toBe(12);
  });

  it('rejects self-transitions for all seven states', () => {
    for (const status of DEPLOYMENT_STATUSES) {
      expect(canTransitionDeployment(status, status)).toBe(false);
    }
  });

  it.each(['SUCCESS', 'FAILED', 'CANCELLED'] as const)('%s has no outgoing edges', (terminal) => {
    for (const to of DEPLOYMENT_STATUSES) {
      expect(canTransitionDeployment(terminal, to)).toBe(false);
    }
  });
});

describe('transitionDeployment (exhaustive cross-product)', () => {
  it.each(ALL_PAIRS)('from %s to %s', (from, to) => {
    if (isAllowed(from, to)) {
      expect(transitionDeployment(from, to)).toBe(to);
      return;
    }

    let caught: unknown;
    try {
      transitionDeployment(from, to);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvalidDeploymentTransitionError);
    const error = caught as InvalidDeploymentTransitionError;
    expect(error.from).toBe(from);
    expect(error.to).toBe(to);
    expect(error.name).toBe('InvalidDeploymentTransitionError');
    expect(error.message).toBe(`Invalid deployment transition: ${from} -> ${to}`);
  });
});

describe('isTerminalDeploymentStatus', () => {
  it.each(DEPLOYMENT_STATUSES)('%s', (status) => {
    expect(isTerminalDeploymentStatus(status)).toBe(
      status === 'SUCCESS' || status === 'FAILED' || status === 'CANCELLED',
    );
  });
});
