import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDockerPsOutput, type DockerPsResult, type ObservedContainer } from './docker-ps.js';
import { diffReconcileSnapshot, type ReconcileServiceRecord } from './reconcile-diff.js';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';

function container(
  serviceId: string,
  overrides: Partial<ObservedContainer> = {},
): ObservedContainer {
  return {
    id: '4fb0b52c06b9',
    name: `noodara-${serviceId}`,
    image: `noodara/${serviceId}:x`,
    state: 'running',
    exitCode: null,
    labels: { 'noodara.managed': 'true', 'noodara.service_id': serviceId },
    ports: '',
    ...overrides,
  };
}

function snapshot(
  containers: ObservedContainer[],
  unparseableLines: { line: number; reason: string }[] = [],
): DockerPsResult {
  return { kind: 'ok', containers, unparseableLines };
}

function record(
  serviceId: string,
  overrides: Partial<ReconcileServiceRecord> = {},
): ReconcileServiceRecord {
  return { serviceId, lastObserved: { kind: 'running' }, operationInFlight: false, ...overrides };
}

describe('diffReconcileSnapshot: per-service states', () => {
  it('maps one snapshot to the container state of every service', () => {
    const diff = diffReconcileSnapshot(
      [record(A), record(B), record(C)],
      snapshot([container(A), container(B, { state: 'exited', exitCode: 3 })]),
    );

    expect(diff.observations).toEqual([
      { serviceId: A, observation: { kind: 'running' } },
      { serviceId: B, observation: { kind: 'stopped', exitCode: 3 } },
      { serviceId: C, observation: { kind: 'absent' } },
    ]);
  });

  it('maps the real Ubuntu capture by container name', () => {
    const stdout = readFileSync(
      new URL('./fixtures/ubuntu-24.04/docker_ps.ndjson', import.meta.url),
      'utf8',
    );
    const parsed = parseDockerPsOutput({ stdout, stderr: '', exitCode: 0 });
    if (parsed.kind !== 'ok') throw new Error(parsed.kind);
    const records = parsed.containers.map((c) =>
      record(c.name.replace(/^noodara-/, ''), { lastObserved: null }),
    );

    const diff = diffReconcileSnapshot(records, parsed);

    expect(diff.observations.map((o) => o.observation.kind).sort()).toEqual([
      'running',
      'stopped',
      'stopped',
    ]);
  });

  it.each<[string, DockerPsResult]>([
    ['daemon_unreachable', { kind: 'daemon_unreachable' }],
    ['unparseable', { kind: 'unparseable', reason: 'docker command not found' }],
  ])('marks every service unknown when the snapshot is %s', (kind, ps) => {
    const diff = diffReconcileSnapshot([record(A), record(B)], ps);

    expect(diff.snapshot).toBe(kind);
    expect(diff.observations.map((o) => o.observation)).toEqual([
      { kind: 'unknown' },
      { kind: 'unknown' },
    ]);
    expect(diff.discrepancies).toEqual([]);
  });

  it('marks an absent container unknown when some snapshot lines were unparseable', () => {
    const diff = diffReconcileSnapshot(
      [record(A), record(B)],
      snapshot([container(A)], [{ line: 2, reason: 'Line was not valid JSON' }]),
    );

    expect(diff.snapshot).toBe('ok');
    expect(diff.observations).toEqual([
      { serviceId: A, observation: { kind: 'running' } },
      { serviceId: B, observation: { kind: 'unknown' } },
    ]);
    expect(diff.discrepancies).toEqual([]);
  });
});

describe('diffReconcileSnapshot: changes', () => {
  it('reports only the services whose observation changed', () => {
    const diff = diffReconcileSnapshot(
      [
        record(A),
        record(B, { lastObserved: { kind: 'stopped', exitCode: 1 } }),
        record(C, { lastObserved: { kind: 'absent' } }),
      ],
      snapshot([container(A), container(B, { state: 'exited', exitCode: 2 })]),
    );

    expect(diff.changes).toEqual([
      {
        serviceId: B,
        previous: { kind: 'stopped', exitCode: 1 },
        current: { kind: 'stopped', exitCode: 2 },
      },
    ]);
  });

  it('reports a first observation as a change', () => {
    const diff = diffReconcileSnapshot(
      [record(A, { lastObserved: null })],
      snapshot([container(A)]),
    );

    expect(diff.changes).toEqual([{ serviceId: A, previous: null, current: { kind: 'running' } }]);
  });

  it('reports nothing when nothing changed', () => {
    const diff = diffReconcileSnapshot(
      [record(A), record(B, { lastObserved: { kind: 'unknown' } })],
      snapshot([container(A), container(B, { state: 'paused' })]),
    );

    expect(diff.changes).toEqual([]);
    expect(diff.discrepancies).toEqual([]);
  });

  it('reports a transition between different kinds', () => {
    const diff = diffReconcileSnapshot(
      [record(A, { lastObserved: { kind: 'unknown' } })],
      snapshot([container(A)]),
    );

    expect(diff.changes).toEqual([
      { serviceId: A, previous: { kind: 'unknown' }, current: { kind: 'running' } },
    ]);
  });
});

describe('diffReconcileSnapshot: discrepancies', () => {
  it('flags a running container stopped outside Noodara', () => {
    const diff = diffReconcileSnapshot(
      [record(A)],
      snapshot([container(A, { state: 'exited', exitCode: 137 })]),
    );

    expect(diff.discrepancies).toEqual([
      {
        serviceId: A,
        kind: 'stopped_outside_noodara',
        previous: { kind: 'running' },
        current: { kind: 'stopped', exitCode: 137 },
      },
    ]);
  });

  it.each([
    ['running', { kind: 'running' } as const],
    ['stopped', { kind: 'stopped', exitCode: 0 } as const],
  ])('flags a %s container removed outside Noodara', (_label, lastObserved) => {
    const diff = diffReconcileSnapshot([record(A, { lastObserved })], snapshot([]));

    expect(diff.discrepancies).toEqual([
      {
        serviceId: A,
        kind: 'removed_outside_noodara',
        previous: lastObserved,
        current: { kind: 'absent' },
      },
    ]);
  });

  it('does not flag a stop or removal while Noodara itself is operating on the service', () => {
    const diff = diffReconcileSnapshot(
      [record(A, { operationInFlight: true }), record(B, { operationInFlight: true })],
      snapshot([container(A, { state: 'exited', exitCode: 0 })]),
    );

    expect(diff.changes).toHaveLength(2);
    expect(diff.discrepancies).toEqual([]);
  });

  it.each([
    ['never observed', null],
    ['unknown', { kind: 'unknown' } as const],
    ['absent', { kind: 'absent' } as const],
  ])('does not flag a disappearance when the previous state was %s', (_label, lastObserved) => {
    const diff = diffReconcileSnapshot(
      [record(A, { lastObserved }), record(B, { lastObserved })],
      snapshot([container(B, { state: 'exited', exitCode: 1 })]),
    );

    expect(diff.discrepancies).toEqual([]);
  });

  it('does not flag a container that went from stopped to running', () => {
    const diff = diffReconcileSnapshot(
      [record(A, { lastObserved: { kind: 'stopped', exitCode: 0 } })],
      snapshot([container(A)]),
    );

    expect(diff.changes).toHaveLength(1);
    expect(diff.discrepancies).toEqual([]);
  });
});
