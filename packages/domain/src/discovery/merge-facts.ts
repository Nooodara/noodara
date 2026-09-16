// Pure discovery-result merging and snapshot classification (DISC-03, D-06, D-07). No I/O, no
// clock reads: the caller (a later plan's application service) supplies the current row and the
// freshly-collected facts, and this module never mutates either input.

import type { DiscoveryCheckStatus, DiscoveryFacts } from './types.js';

/** The three coarse outcomes a discovery run can report, derived purely from its checks. */
export type SnapshotOutcome = 'ok' | 'partial' | 'failed';

const FACTS_KEYS = [
  'hostname',
  'osDistribution',
  'osVersion',
  'arch',
  'cpuCores',
  'ramMb',
  'diskTotalMb',
  'diskUsedMb',
  'uptimeSeconds',
  'dockerInstalled',
  'dockerVersion',
  'dockerComposeVersion',
] as const satisfies readonly (keyof DiscoveryFacts)[];

/**
 * Merges a freshly-collected `incoming` snapshot's facts onto `current` (the server row's
 * denormalized facts). D-07: a `null` field on `incoming` means "this run did not observe this
 * fact" and must never overwrite a previously known value — `false` and `0` are real observed
 * values, not absences, and always win. Returns a new object; never mutates either input.
 */
export function mergeDiscoveryFacts(
  current: DiscoveryFacts,
  incoming: DiscoveryFacts,
): DiscoveryFacts {
  const merged = {} as Record<(typeof FACTS_KEYS)[number], DiscoveryFacts[(typeof FACTS_KEYS)[number]]>;

  for (const key of FACTS_KEYS) {
    merged[key] = incoming[key] ?? current[key];
  }

  return merged as DiscoveryFacts;
}

/** Checks that count toward classifying a run's outcome; skipped/not_applicable are excluded. */
function isRelevant(status: DiscoveryCheckStatus): boolean {
  return status === 'pass' || status === 'fail';
}

/**
 * Classifies a discovery run from its checks alone (D-06), as a pure function:
 * - no relevant checks (empty, or only skipped/not_applicable) -> 'failed'
 * - every relevant check passed -> 'ok'
 * - every relevant check failed -> 'failed'
 * - a mix -> 'partial'
 */
export function classifySnapshotOutcome(
  checks: readonly { status: DiscoveryCheckStatus }[],
): SnapshotOutcome {
  const relevant = checks.filter((check) => isRelevant(check.status));

  if (relevant.length === 0) {
    return 'failed';
  }

  const passCount = relevant.filter((check) => check.status === 'pass').length;

  if (passCount === relevant.length) {
    return 'ok';
  }
  if (passCount === 0) {
    return 'failed';
  }
  return 'partial';
}
