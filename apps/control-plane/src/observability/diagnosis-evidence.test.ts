// 27-06: stored observability rows -> classifier evidence (pure half). The DB loader is proved on
// real faults by tests/integration/observability/evidence-faults.test.ts.
import { describe, expect, it } from 'vitest';
import { classifyEvidence, type ContainerState, type ContainerStatePoint } from '@noodara/domain';
import {
  EVIDENCE_SURFACES,
  SERVER_STALE_INTERVALS,
  assembleServiceEvidence,
  healthcheckPortResponding,
  type ServiceEvidenceSnapshot,
} from './diagnosis-evidence.js';

const SERVER = '00000000-0000-4000-8000-00000000000a';
const SERVICE = '11111111-1111-4111-8111-111111111111';
const DEPLOYMENT = '22222222-2222-4222-8222-222222222222';
const CONTAINER = 'c'.repeat(64);
const NOW = 1_800_000_000_000;
const INTERVAL = 60_000;
const OPTIONS = { nowMs: NOW, intervalMs: INTERVAL };

const running: ContainerState = {
  status: 'running',
  running: true,
  restarting: false,
  restartCount: 0,
  oomKilled: false,
  exitCode: 0,
  health: null,
  healthExitCodes: [],
  memoryLimitBytes: null,
  memoryUsedBytes: 10,
};
const point = (offsetMs: number, state: Partial<ContainerState> = {}): ContainerStatePoint => ({
  observedAtMs: NOW + offsetMs,
  state: { ...running, ...state },
});

function snapshot(overrides: Partial<ServiceEvidenceSnapshot> = {}): ServiceEvidenceSnapshot {
  return {
    serviceId: SERVICE,
    server: { id: SERVER, status: 'CONNECTED', lastSeenAt: new Date(NOW - 1_000) },
    container: { containerId: CONTAINER, history: [point(-1_000)] },
    hostTotalBytes: 1_000,
    containerMemory: [],
    hostMemory: [],
    filesystems: [],
    deployment: null,
    ...overrides,
  };
}

const top = (s: ServiceEvidenceSnapshot) => classifyEvidence(assembleServiceEvidence(s, OPTIONS))[0]?.diagnosis;

describe('assembleServiceEvidence', () => {
  it('a healthy service yields evidence that classifies as unknown', () => {
    const evidence = assembleServiceEvidence(snapshot(), OPTIONS);
    expect(evidence.map((item) => item.kind)).toEqual(['server', 'container']);
    expect(top(snapshot())).toBe('unknown');
  });

  it('server reachability: UNREACHABLE status, or a CONNECTED server not seen for 1.5 intervals', () => {
    expect(top(snapshot({ server: { id: SERVER, status: 'UNREACHABLE', lastSeenAt: new Date(NOW) } }))).toBe('server_unreachable');
    const stale = NOW - INTERVAL * SERVER_STALE_INTERVALS - 1;
    expect(top(snapshot({ server: { id: SERVER, status: 'CONNECTED', lastSeenAt: new Date(stale) } }))).toBe('server_unreachable');
    const edge = NOW - INTERVAL * SERVER_STALE_INTERVALS;
    expect(top(snapshot({ server: { id: SERVER, status: 'CONNECTED', lastSeenAt: new Date(edge) } }))).toBe('unknown');
    // Never sampled, or not connected by the user: no claim either way.
    for (const server of [
      { id: SERVER, status: 'CONNECTED' as const, lastSeenAt: null },
      { id: SERVER, status: 'DISCONNECTED' as const, lastSeenAt: null },
    ]) {
      expect(assembleServiceEvidence(snapshot({ server }), OPTIONS).some((item) => item.kind === 'server')).toBe(false);
    }
  });

  it('container history: OOM, crash loop, healthcheck timeout and stopped', () => {
    const container = (history: ContainerStatePoint[]) => snapshot({ container: { containerId: CONTAINER, history } });
    expect(top(container([point(0, { status: 'exited', running: false, oomKilled: true, exitCode: 137 })]))).toBe('out_of_memory');
    expect(
      top(container([point(-60_000, { restartCount: 1 }), point(0, { status: 'restarting', restarting: true, restartCount: 4, exitCode: 3 })])),
    ).toBe('crash_loop');
    expect(top(container([point(0, { health: 'unhealthy', healthExitCodes: [0, -1] })]))).toBe('healthcheck_timeout');
    expect(top(container([point(0, { status: 'exited', running: false, exitCode: 0 })]))).toBe('container_stopped');
    expect(assembleServiceEvidence(snapshot({ container: null }), OPTIONS).some((item) => item.kind === 'container')).toBe(false);
    expect(assembleServiceEvidence(container([]), OPTIONS).some((item) => item.kind === 'container')).toBe(false);
  });

  it('deployment and port: a refused healthcheck outranks the failed deployment', () => {
    const deployment = (status: 'FAILED' | 'SUCCESS', portResponding: boolean | null) =>
      snapshot({ deployment: { id: DEPLOYMENT, status, port: 3000, portResponding } });
    expect(top(deployment('FAILED', null))).toBe('failed_deployment');
    const refused = assembleServiceEvidence(deployment('FAILED', false), OPTIONS);
    expect(refused.find((item) => item.kind === 'port')).toEqual({
      kind: 'port',
      ref: `port:${SERVICE}:3000`,
      port: 3000,
      responding: false,
    });
    expect(classifyEvidence(refused).map((c) => c.diagnosis)).toEqual(['port_not_responding', 'failed_deployment']);
    expect(top(deployment('SUCCESS', true))).toBe('unknown');
  });

  it('memory and disk: sustained container memory and a near-full filesystem', () => {
    const high = { usedBytes: 95, limitBytes: 100 };
    expect(top(snapshot({ containerMemory: [high, high, high] }))).toBe('high_memory');
    expect(top(snapshot({ containerMemory: [high, high] }))).toBe('unknown');
    expect(top(snapshot({ hostMemory: [high, high, high] }))).toBe('high_memory');
    const full = { target: '/var/lib/docker', sizeBytes: 100, usedBytes: 95, availBytes: 5 };
    const evidence = assembleServiceEvidence(snapshot({ filesystems: [full] }), OPTIONS);
    expect(evidence.find((item) => item.kind === 'filesystem')?.ref).toBe(`filesystem:${SERVER}:/var/lib/docker`);
    expect(classifyEvidence(evidence)[0]?.diagnosis).toBe('high_disk');
  });

  it('every evidence kind names the API that surfaces it', () => {
    for (const surfaces of Object.values(EVIDENCE_SURFACES)) expect(surfaces.length).toBeGreaterThan(0);
  });
});

describe('healthcheckPortResponding', () => {
  it('reads only the engine fixed healthcheck lines, the last attempt wins', () => {
    expect(healthcheckPortResponding(['Healthcheck attempt 1: connection refused'])).toBe(false);
    expect(healthcheckPortResponding(['Healthcheck attempt 1: connection refused', 'Healthcheck attempt 2: port open'])).toBe(true);
    expect(healthcheckPortResponding(['Healthcheck attempt 3: HTTP 500', 'Healthcheck passed.'])).toBe(true);
    expect(healthcheckPortResponding(['Healthcheck attempt 1: container running'])).toBeNull();
    expect(healthcheckPortResponding(['npm: connection refused', 'Healthcheck attempt x: connection refused'])).toBeNull();
    expect(healthcheckPortResponding([])).toBeNull();
  });
});
