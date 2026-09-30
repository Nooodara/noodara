import { describe, expect, it } from 'vitest';
import type { DeploymentStatus } from './deployment-state.js';
import {
  SERVICE_STATUSES,
  type ContainerObservation,
  type ServiceStatus,
  deriveServiceStatus,
} from './service-status.js';

type ContainerKind = ContainerObservation['kind'];

const CONTAINERS: Readonly<Record<ContainerKind, ContainerObservation>> = {
  running: { kind: 'running' },
  stopped: { kind: 'stopped', exitCode: 137 },
  absent: { kind: 'absent' },
  unknown: { kind: 'unknown' },
};

interface Row {
  readonly latest: DeploymentStatus | null;
  readonly container: ContainerKind;
  readonly expected: ServiceStatus;
}

// Full table (ROADMAP D5): (7 statuses + null) x 4 container kinds = 32 rows, each hand-written.
const TABLE: readonly Row[] = [
  { latest: null, container: 'running', expected: 'NEVER_DEPLOYED' },
  { latest: null, container: 'stopped', expected: 'NEVER_DEPLOYED' },
  { latest: null, container: 'absent', expected: 'NEVER_DEPLOYED' },
  { latest: null, container: 'unknown', expected: 'NEVER_DEPLOYED' },

  { latest: 'QUEUED', container: 'running', expected: 'DEPLOYING' },
  { latest: 'QUEUED', container: 'stopped', expected: 'DEPLOYING' },
  { latest: 'QUEUED', container: 'absent', expected: 'DEPLOYING' },
  { latest: 'QUEUED', container: 'unknown', expected: 'DEPLOYING' },

  { latest: 'PREPARING', container: 'running', expected: 'DEPLOYING' },
  { latest: 'PREPARING', container: 'stopped', expected: 'DEPLOYING' },
  { latest: 'PREPARING', container: 'absent', expected: 'DEPLOYING' },
  { latest: 'PREPARING', container: 'unknown', expected: 'DEPLOYING' },

  { latest: 'BUILDING', container: 'running', expected: 'DEPLOYING' },
  { latest: 'BUILDING', container: 'stopped', expected: 'DEPLOYING' },
  { latest: 'BUILDING', container: 'absent', expected: 'DEPLOYING' },
  { latest: 'BUILDING', container: 'unknown', expected: 'DEPLOYING' },

  { latest: 'DEPLOYING', container: 'running', expected: 'DEPLOYING' },
  { latest: 'DEPLOYING', container: 'stopped', expected: 'DEPLOYING' },
  { latest: 'DEPLOYING', container: 'absent', expected: 'DEPLOYING' },
  { latest: 'DEPLOYING', container: 'unknown', expected: 'DEPLOYING' },

  { latest: 'SUCCESS', container: 'running', expected: 'RUNNING' },
  { latest: 'SUCCESS', container: 'stopped', expected: 'STOPPED' },
  { latest: 'SUCCESS', container: 'absent', expected: 'STOPPED' },
  { latest: 'SUCCESS', container: 'unknown', expected: 'UNKNOWN' },

  { latest: 'FAILED', container: 'running', expected: 'RUNNING' },
  { latest: 'FAILED', container: 'stopped', expected: 'FAILED' },
  { latest: 'FAILED', container: 'absent', expected: 'FAILED' },
  { latest: 'FAILED', container: 'unknown', expected: 'UNKNOWN' },

  { latest: 'CANCELLED', container: 'running', expected: 'RUNNING' },
  { latest: 'CANCELLED', container: 'stopped', expected: 'STOPPED' },
  { latest: 'CANCELLED', container: 'absent', expected: 'STOPPED' },
  { latest: 'CANCELLED', container: 'unknown', expected: 'UNKNOWN' },
];

describe('SERVICE_STATUSES', () => {
  it('declares the six derived statuses', () => {
    expect([...SERVICE_STATUSES]).toEqual([
      'NEVER_DEPLOYED',
      'DEPLOYING',
      'RUNNING',
      'STOPPED',
      'FAILED',
      'UNKNOWN',
    ]);
  });
});

describe('deriveServiceStatus', () => {
  it('covers the full 32-row table', () => {
    expect(TABLE.length).toBe(32);
  });

  it.each(TABLE)('latest=$latest container=$container -> $expected', ({ latest, container, expected }) => {
    const result = deriveServiceStatus({
      latestDeployment: latest === null ? null : { status: latest },
      container: CONTAINERS[container],
    });

    expect(result).toBe(expected);
  });

  it('keeps a failed build RUNNING when the previous container is still up (DEP-03)', () => {
    expect(
      deriveServiceStatus({ latestDeployment: { status: 'FAILED' }, container: { kind: 'running' } }),
    ).toBe('RUNNING');
  });

  it('never reports an unobservable container as STOPPED (D5)', () => {
    expect(
      deriveServiceStatus({ latestDeployment: { status: 'SUCCESS' }, container: { kind: 'unknown' } }),
    ).toBe('UNKNOWN');
  });

  it('treats a stopped container without exit code the same as one with it', () => {
    expect(
      deriveServiceStatus({
        latestDeployment: { status: 'SUCCESS' },
        container: { kind: 'stopped', exitCode: null },
      }),
    ).toBe('STOPPED');
  });
});
