import { describe, expect, it } from 'vitest';
import type { ContainerRuntimeObservation } from './container-observation.js';
import { DIAGNOSES, DIAGNOSIS_RANK, classifyEvidence, type Diagnosis, type Evidence } from './diagnosis.js';

function observation(overrides: Partial<ContainerRuntimeObservation> = {}): ContainerRuntimeObservation {
  return {
    stopped: false,
    restarting: false,
    restartsInWindow: 0,
    crashLoop: false,
    outOfMemory: false,
    healthcheck: 'healthy',
    exitCode: null,
    ...overrides,
  };
}

const container = (ref: string, overrides: Partial<ContainerRuntimeObservation> = {}): Evidence => ({
  kind: 'container',
  ref,
  container: `noodara-${ref}`,
  observation: observation(overrides),
});

const reading = (percent: number) => ({ usedBytes: percent * 10, limitBytes: 1000 });

const diagnoses = (evidence: readonly Evidence[]): Diagnosis[] =>
  classifyEvidence(evidence).map((candidate) => candidate.diagnosis);

describe('DIAGNOSES vocabulary (A4)', () => {
  it('is the closed list from the roadmap, in order', () => {
    expect(DIAGNOSES).toEqual([
      'container_stopped',
      'crash_loop',
      'out_of_memory',
      'healthcheck_timeout',
      'port_not_responding',
      'failed_deployment',
      'high_memory',
      'high_disk',
      'server_unreachable',
      'unknown',
    ]);
    expect(Object.isFrozen(DIAGNOSES)).toBe(true);
  });

  it('ranks every diagnosis except unknown exactly once', () => {
    expect([...DIAGNOSIS_RANK].sort()).toEqual(DIAGNOSES.filter((d) => d !== 'unknown').sort());
  });
});

// Every diagnosis: one evidence set that fires it and one near miss that does not.
const CASES: readonly (readonly [Diagnosis, Evidence, Evidence])[] = [
  ['server_unreachable', { kind: 'server', ref: 'e1', reachable: false }, { kind: 'server', ref: 'e1', reachable: true }],
  ['out_of_memory', container('e1', { outOfMemory: true, stopped: true }), container('e1', { stopped: true, exitCode: 137 })],
  ['crash_loop', container('e1', { crashLoop: true, restartsInWindow: 3 }), container('e1', { restartsInWindow: 2 })],
  ['healthcheck_timeout', container('e1', { healthcheck: 'timeout' }), container('e1', { healthcheck: 'failing' })],
  ['port_not_responding', { kind: 'port', ref: 'e1', port: 3000, responding: false }, { kind: 'port', ref: 'e1', port: 3000, responding: true }],
  ['failed_deployment', { kind: 'deployment', ref: 'e1', status: 'FAILED' }, { kind: 'deployment', ref: 'e1', status: 'CANCELLED' }],
  ['container_stopped', container('e1', { stopped: true, exitCode: 0 }), container('e1', { restarting: true })],
  ['high_memory', { kind: 'host_memory', ref: 'e1', readings: [reading(90), reading(91), reading(95)] }, { kind: 'host_memory', ref: 'e1', readings: [reading(95), reading(89.9), reading(95)] }],
  ['high_disk', { kind: 'filesystem', ref: 'e1', filesystem: { target: '/', sizeBytes: 1000, usedBytes: 900, availBytes: 100 } }, { kind: 'filesystem', ref: 'e1', filesystem: { target: '/', sizeBytes: 1000, usedBytes: 899, availBytes: 101 } }],
];

describe('classifyEvidence: positive and near-miss per diagnosis (A4)', () => {
  it.each(CASES)('%s fires on its evidence and cites it', (diagnosis, positive) => {
    expect(classifyEvidence([positive])).toContainEqual({ diagnosis, rank: 1, evidence: ['e1'] });
  });

  it.each(CASES)('%s does not fire on the near miss', (diagnosis, _positive, nearMiss) => {
    expect(diagnoses([nearMiss])).not.toContain(diagnosis);
  });

  it('returns unknown with no evidence when no rule fires', () => {
    expect(classifyEvidence([])).toEqual([{ diagnosis: 'unknown', rank: 1, evidence: [] }]);
    // The OOM near miss (exit 137, no OOM signal) is still a stopped container, so it is left out.
    const quiet = CASES.filter(([d]) => d !== 'out_of_memory').map(([, , nearMiss]) => nearMiss);
    expect(classifyEvidence(quiet)).toEqual([
      { diagnosis: 'unknown', rank: 1, evidence: [] },
    ]);
  });

  it('every diagnosis has a case (unknown is the empty one)', () => {
    expect(CASES.map(([d]) => d).sort()).toEqual(DIAGNOSES.filter((d) => d !== 'unknown').sort());
  });
});

describe('classifyEvidence: memory and failed deployment variants', () => {
  it('fires high_memory for a container over its own limit and for an unlimited one over the host total', () => {
    const own: Evidence = { kind: 'container_memory', ref: 'm1', container: 'c', readings: [reading(95), reading(95), reading(95)], hostTotalBytes: null };
    const unlimited: Evidence = {
      kind: 'container_memory',
      ref: 'm2',
      container: 'c',
      readings: [0, 1, 2].map(() => ({ usedBytes: 950, limitBytes: null })),
      hostTotalBytes: 1000,
    };
    const unknownHost: Evidence = { ...unlimited, ref: 'm3', hostTotalBytes: null };
    expect(classifyEvidence([own, unlimited, unknownHost])).toEqual([
      { diagnosis: 'high_memory', rank: 1, evidence: ['m1', 'm2'] },
    ]);
  });

  it('treats ROLLED_BACK as a failed deployment attempt and SUCCESS as none', () => {
    expect(diagnoses([{ kind: 'deployment', ref: 'd1', status: 'ROLLED_BACK' }])).toEqual(['failed_deployment']);
    expect(diagnoses([{ kind: 'deployment', ref: 'd1', status: 'SUCCESS' }])).toEqual(['unknown']);
  });
});

describe('classifyEvidence: ranking and references', () => {
  it('ranks the most specific cause first and numbers ranks from 1', () => {
    const evidence: Evidence[] = [
      { kind: 'filesystem', ref: 'disk', filesystem: { target: '/', sizeBytes: 100, usedBytes: 95, availBytes: 5 } },
      { kind: 'deployment', ref: 'deploy', status: 'FAILED' },
      container('svc', { stopped: true, outOfMemory: true, exitCode: 137 }),
      { kind: 'server', ref: 'srv', reachable: false },
    ];
    expect(classifyEvidence(evidence)).toEqual([
      { diagnosis: 'server_unreachable', rank: 1, evidence: ['srv'] },
      { diagnosis: 'out_of_memory', rank: 2, evidence: ['svc'] },
      { diagnosis: 'failed_deployment', rank: 3, evidence: ['deploy'] },
      { diagnosis: 'container_stopped', rank: 4, evidence: ['svc'] },
      { diagnosis: 'high_disk', rank: 5, evidence: ['disk'] },
    ]);
  });

  it('collects every supporting reference once, in evidence order', () => {
    const evidence: Evidence[] = [
      container('b', { crashLoop: true }),
      container('a', { crashLoop: true }),
      container('b', { crashLoop: true }),
    ];
    expect(classifyEvidence(evidence)).toEqual([{ diagnosis: 'crash_loop', rank: 1, evidence: ['b', 'a'] }]);
  });

  it('is pure: same input, same output, input untouched', () => {
    const evidence: Evidence[] = [container('x', { stopped: true }), { kind: 'port', ref: 'p', port: 80, responding: false }];
    const snapshot = JSON.stringify(evidence);
    expect(classifyEvidence(evidence)).toEqual(classifyEvidence(evidence));
    expect(JSON.stringify(evidence)).toBe(snapshot);
  });
});
