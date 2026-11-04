// Diagnosis vocabulary and the pure evidence classifier (A4, DECISIONS 2026-11-03). The AI gets
// ranked hints, each citing the evidence refs that support it; the agent later drops any hint or
// ref a tool did not return. Thresholds are applied here (via thresholds.ts), so raw readings and
// observations are the only inputs. `unknown` is returned alone when no rule fires.

import type { DeploymentStatus } from '../deployment/deployment-state.js';
import type { ContainerRuntimeObservation } from './container-observation.js';
import type { FilesystemUsage } from './host-sample.js';
import { highDisk, highMemory, type MemoryReading } from './thresholds.js';

export const DIAGNOSES = Object.freeze([
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
] as const);

export type Diagnosis = (typeof DIAGNOSES)[number];

/**
 * Most specific cause first: an unreachable server makes every other reading stale; OOM and
 * crash loops explain a stopped container and a failed deploy; resource pressure comes last.
 */
export const DIAGNOSIS_RANK: readonly Exclude<Diagnosis, 'unknown'>[] = Object.freeze([
  'server_unreachable',
  'out_of_memory',
  'crash_loop',
  'healthcheck_timeout',
  'port_not_responding',
  'failed_deployment',
  'container_stopped',
  'high_memory',
  'high_disk',
]);

/** The deployment statuses that mean the attempt failed. */
const FAILED_DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = ['FAILED', 'ROLLED_BACK'];

/** Every item carries `ref`, the id the AI cites (a tool call or entity reference). */
export type Evidence =
  | { readonly kind: 'server'; readonly ref: string; readonly reachable: boolean }
  | {
      readonly kind: 'container';
      readonly ref: string;
      readonly container: string;
      readonly observation: ContainerRuntimeObservation;
    }
  | { readonly kind: 'deployment'; readonly ref: string; readonly status: DeploymentStatus }
  | { readonly kind: 'port'; readonly ref: string; readonly port: number; readonly responding: boolean }
  | { readonly kind: 'host_memory'; readonly ref: string; readonly readings: readonly MemoryReading[] }
  | {
      readonly kind: 'container_memory';
      readonly ref: string;
      readonly container: string;
      readonly readings: readonly MemoryReading[];
      /** Host MemTotal, used for a container without a memory limit. */
      readonly hostTotalBytes: number | null;
    }
  | { readonly kind: 'filesystem'; readonly ref: string; readonly filesystem: FilesystemUsage };

export interface DiagnosisCandidate {
  readonly diagnosis: Diagnosis;
  /** 1 is the most likely cause. */
  readonly rank: number;
  /** Supporting evidence refs, each once, in evidence order. */
  readonly evidence: readonly string[];
}

function container(observation: ContainerRuntimeObservation): Diagnosis[] {
  const fired: Diagnosis[] = [];
  if (observation.outOfMemory) fired.push('out_of_memory');
  if (observation.crashLoop) fired.push('crash_loop');
  if (observation.healthcheck === 'timeout') fired.push('healthcheck_timeout');
  if (observation.stopped) fired.push('container_stopped');
  return fired;
}

function rulesFor(item: Evidence): Diagnosis[] {
  switch (item.kind) {
    case 'server':
      return item.reachable ? [] : ['server_unreachable'];
    case 'container':
      return container(item.observation);
    case 'deployment':
      return FAILED_DEPLOYMENT_STATUSES.includes(item.status) ? ['failed_deployment'] : [];
    case 'port':
      return item.responding ? [] : ['port_not_responding'];
    case 'host_memory':
      return highMemory(item.readings) ? ['high_memory'] : [];
    case 'container_memory':
      return highMemory(item.readings, { hostTotalBytes: item.hostTotalBytes }) ? ['high_memory'] : [];
    case 'filesystem':
      return highDisk(item.filesystem) ? ['high_disk'] : [];
  }
}

export function classifyEvidence(evidence: readonly Evidence[]): readonly DiagnosisCandidate[] {
  const support = new Map<Diagnosis, string[]>();
  for (const item of evidence) {
    for (const diagnosis of rulesFor(item)) {
      const refs = support.get(diagnosis) ?? [];
      if (!refs.includes(item.ref)) refs.push(item.ref);
      support.set(diagnosis, refs);
    }
  }

  const ranked = DIAGNOSIS_RANK.flatMap((diagnosis) => {
    const refs = support.get(diagnosis);
    return refs === undefined ? [] : [{ diagnosis, refs }];
  });
  if (ranked.length === 0) return [{ diagnosis: 'unknown', rank: 1, evidence: [] }];
  return ranked.map(({ diagnosis, refs }, index) => ({ diagnosis, rank: index + 1, evidence: refs }));
}
