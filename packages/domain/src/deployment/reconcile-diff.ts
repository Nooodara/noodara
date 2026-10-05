// Reconcile diff (ROADMAP D3, REC-01, REC-03). One `docker ps` snapshot per server tick becomes a
// container observation per service; only changed services are reported (so `service.updated` is
// emitted only on change), and a container stopped or removed while Noodara was not operating on
// the service is flagged for the activity log. Honest about blind spots: a failed snapshot makes
// every service `unknown`, and with unparseable lines an absent container is `unknown` too (it may
// be the line that failed). `unknown` never raises a discrepancy.

import { toContainerObservation, type DockerPsResult } from './docker-ps.js';
import type { ContainerObservation } from './service-status.js';

export interface ReconcileServiceRecord {
  readonly serviceId: string;
  /** Last persisted observation; null when the service was never observed. */
  readonly lastObserved: ContainerObservation | null;
  /** A deploy, stop, restart or remove job of Noodara is in flight for this service. */
  readonly operationInFlight: boolean;
}

export interface ReconcileChange {
  readonly serviceId: string;
  readonly previous: ContainerObservation | null;
  readonly current: ContainerObservation;
}

export type ReconcileDiscrepancyKind = 'stopped_outside_noodara' | 'removed_outside_noodara';

export interface ReconcileDiscrepancy extends ReconcileChange {
  readonly kind: ReconcileDiscrepancyKind;
  readonly previous: ContainerObservation;
}

export interface ReconcileDiff {
  readonly snapshot: DockerPsResult['kind'];
  readonly observations: readonly {
    readonly serviceId: string;
    readonly observation: ContainerObservation;
  }[];
  readonly changes: readonly ReconcileChange[];
  readonly discrepancies: readonly ReconcileDiscrepancy[];
}

function observe(snapshot: DockerPsResult, serviceId: string): ContainerObservation {
  if (snapshot.kind !== 'ok') {
    return { kind: 'unknown' };
  }
  const observation = toContainerObservation(snapshot.containers, `noodara-${serviceId}`);
  if (observation.kind === 'absent' && snapshot.unparseableLines.length > 0) {
    return { kind: 'unknown' };
  }
  return observation;
}

function exitCodeOf(o: ContainerObservation): number | null {
  return o.kind === 'stopped' ? o.exitCode : null;
}

function sameObservation(a: ContainerObservation | null, b: ContainerObservation): boolean {
  return a !== null && a.kind === b.kind && exitCodeOf(a) === exitCodeOf(b);
}

function discrepancyKind(
  previous: ContainerObservation,
  current: ContainerObservation,
): ReconcileDiscrepancyKind | null {
  if (current.kind === 'absent' && (previous.kind === 'running' || previous.kind === 'stopped')) {
    return 'removed_outside_noodara';
  }
  if (current.kind === 'stopped' && previous.kind === 'running') {
    return 'stopped_outside_noodara';
  }
  return null;
}

export function diffReconcileSnapshot(
  records: readonly ReconcileServiceRecord[],
  snapshot: DockerPsResult,
): ReconcileDiff {
  const observations: { serviceId: string; observation: ContainerObservation }[] = [];
  const changes: ReconcileChange[] = [];
  const discrepancies: ReconcileDiscrepancy[] = [];

  for (const { serviceId, lastObserved, operationInFlight } of records) {
    const current = observe(snapshot, serviceId);
    observations.push({ serviceId, observation: current });
    if (sameObservation(lastObserved, current)) {
      continue;
    }
    changes.push({ serviceId, previous: lastObserved, current });
    if (operationInFlight || lastObserved === null) {
      continue;
    }
    const kind = discrepancyKind(lastObserved, current);
    if (kind !== null) {
      discrepancies.push({ serviceId, kind, previous: lastObserved, current });
    }
  }
  return { snapshot: snapshot.kind, observations, changes, discrepancies };
}
