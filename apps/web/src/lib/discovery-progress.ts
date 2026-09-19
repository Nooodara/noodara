// The pure reducer behind DISC-02's discovery narrative (05-UI-SPEC.md SS4.2/SS4.3, D-05/D-06/
// D-08). Every rendering decision about progress lives here as a tested pure function -- no
// `fetch`, no `EventSource`, no clock read (`grep -cE "Date\.now\(\)|new Date\(\)|fetch\("` is 0).
// The caller (`DiscoverySection.tsx`) owns the clock (for "as of"/"Discovered {relative time}")
// and every network call; this module only ever transforms already-received data.
import type { DiscoveryCheck, DiscoveryCheckId } from '@noodara/domain/discovery';
import type { ServerErrorCode, ServerStatus } from '@noodara/domain/server';
import {
  CHECK_TO_STEP,
  CONNECTION_STEP_NAMES,
  DISCOVERY_CHECK_IDS,
  DISCOVERY_GROUP_STEPS,
  type DiscoveryStepName,
} from './discovery-steps';

/** The seven words SS4.2 requires state to render as text, never colour-only. Reused for both a
 *  single check's state and a step's aggregated state -- the same seven words apply to either
 *  granularity. */
export const CHECK_STATES = ['pass', 'warning', 'fail', 'not_applicable', 'skipped', 'pending', 'running'] as const;

export type CheckState = (typeof CHECK_STATES)[number];

// SS4.2's four ids whose `fail` still leaves the server usable -- a named constant list (not a
// chain of conditionals) so the "usable despite failure" set is reviewable in one place, per this
// plan's own action text. A `fail` on any other id ended the run and renders red.
const USABLE_DESPITE_FAILURE_IDS: ReadonlySet<DiscoveryCheckId> = new Set([
  'docker_version',
  'docker_compose_version',
  'sudo',
  'docker_group',
]);

/**
 * SS4.2's per-check severity classification, refining the domain's own four-value
 * `DiscoveryCheckStatus` into the seven-word state DiscoveryStep renders. `warnings` is the
 * settled run's own `warnings` array (or `[]` while a value is not yet known, e.g. mid-run) -- the
 * only status/id pair this function reads it for is `os_release` passing while `warnings` includes
 * `UNSUPPORTED_OS` (D-11's warning-not-failure treatment, SS4.2's row for it).
 */
export function severityFor(check: DiscoveryCheck, warnings: readonly ServerErrorCode[]): CheckState {
  if (check.status === 'skipped') return 'skipped';
  if (check.status === 'not_applicable') return 'not_applicable';
  if (check.status === 'pass') {
    if (check.id === 'os_release' && warnings.includes('UNSUPPORTED_OS')) return 'warning';
    return 'pass';
  }
  // check.status === 'fail'
  return USABLE_DESPITE_FAILURE_IDS.has(check.id) ? 'warning' : 'fail';
}

export interface DiscoveryCheckView {
  readonly id: DiscoveryCheckId;
  readonly state: CheckState;
  /** `null` for a check that has not run yet (`pending`/`running`) -- never an invented value. */
  readonly detail: string | null;
  readonly durationMs: number | null;
}

export interface DiscoveryStepView {
  readonly id: DiscoveryStepName;
  readonly state: CheckState;
  /** Empty for `ssh_reachable`/`authenticated` -- both are connection-derived, never backed by a
   *  `DiscoveryCheckId` (D-06). */
  readonly checks: readonly DiscoveryCheckView[];
}

export interface DiscoveryChecklist {
  readonly steps: readonly DiscoveryStepView[];
}

export interface DiscoverySettledSnapshot {
  readonly collectedAt: string | null;
  readonly checks: readonly DiscoveryCheck[];
  readonly warnings: readonly ServerErrorCode[];
}

export interface BuildChecklistInput {
  readonly serverStatus: ServerStatus;
  /** Checks received live over `server.discovery_progress` for the run currently in flight --
   *  accumulated by the caller, cleared the instant a new run starts (a transition into
   *  `CONNECTING`). Ignored entirely unless `serverStatus === 'CONNECTING'`. */
  readonly receivedChecks: readonly DiscoveryCheck[];
  /** The last completed run's checklist, fetched from the read endpoint. D-05/05-RESEARCH.md
   *  Pitfall 3: while `serverStatus === 'CONNECTING'`, this argument is ignored entirely -- a page
   *  opened mid-run must never render a previous run's results as if they belonged to the run
   *  currently happening. Do not "optimise" this branch away. */
  readonly settled: DiscoverySettledSnapshot;
}

function checkView(check: DiscoveryCheck, warnings: readonly ServerErrorCode[]): DiscoveryCheckView {
  return { id: check.id, state: severityFor(check, warnings), detail: check.detail, durationMs: check.durationMs };
}

function pendingCheckView(id: DiscoveryCheckId, state: 'pending' | 'running'): DiscoveryCheckView {
  return { id, state, detail: null, durationMs: null };
}

function groupChecksByStep(checks: readonly DiscoveryCheckView[]): Record<DiscoveryStepName, DiscoveryCheckView[]> {
  const groups: Record<DiscoveryStepName, DiscoveryCheckView[]> = {
    ssh_reachable: [],
    authenticated: [],
    os: [],
    resources: [],
    docker: [],
    access: [],
  };
  for (const check of checks) {
    groups[CHECK_TO_STEP[check.id]].push(check);
  }
  return groups;
}

/** A step (once every one of its checks has actually run) passes only if every check passed
 *  (D-06); fails if any check is a true fail; else warns if any check is a warning; else -- every
 *  check skipped or not_applicable -- reports whichever of those two applies (D-06's "idle" case
 *  is never a single silent bucket: the step still names which of the two it is, matching SS4.2's
 *  own seven-word vocabulary). */
function aggregateSettledStepState(checks: readonly DiscoveryCheckView[]): CheckState {
  if (checks.some((c) => c.state === 'fail')) return 'fail';
  if (checks.some((c) => c.state === 'warning')) return 'warning';
  if (checks.some((c) => c.state === 'pass')) return 'pass';
  if (checks.length > 0 && checks.every((c) => c.state === 'not_applicable')) return 'not_applicable';
  return 'skipped';
}

/** Live aggregation for a step that may be partially resolved. `DISCOVERY_SEQUENCE`'s fixed order
 *  groups each step's checks contiguously, so at any moment a step is either entirely in the
 *  future (`pending`), currently executing (`running`, unless an earlier check in it already
 *  failed/warned), or entirely resolved (falls through to the settled aggregation above). */
function aggregateLiveStepState(checks: readonly DiscoveryCheckView[]): CheckState {
  if (checks.some((c) => c.state === 'fail')) return 'fail';
  if (checks.some((c) => c.state === 'warning')) return 'warning';
  if (checks.some((c) => c.state === 'running')) return 'running';
  if (checks.every((c) => c.state === 'pending')) return 'pending';
  return aggregateSettledStepState(checks);
}

function discoveryGroupChecksFor(
  stepId: DiscoveryStepName,
  byStep: Record<DiscoveryStepName, DiscoveryCheckView[]>,
): readonly DiscoveryCheckView[] {
  return DISCOVERY_CHECK_IDS.filter((id) => CHECK_TO_STEP[id] === stepId).map(
    (id) => byStep[stepId].find((c) => c.id === id) ?? pendingCheckView(id, 'pending'),
  );
}

/**
 * Builds the full six-step checklist from what has actually been received -- never from anything
 * else. See `BuildChecklistInput.settled`'s own doc comment for the D-05 mid-run discard rule.
 */
export function buildChecklist(input: BuildChecklistInput): DiscoveryChecklist {
  const { serverStatus, receivedChecks, settled } = input;

  if (serverStatus === 'CONNECTING') {
    // D-05 / 05-RESEARCH.md Pitfall 3: `settled` is never read below this point in this branch.
    const resolved = receivedChecks.map((check) => checkView(check, []));
    const resolvedIds = new Set(receivedChecks.map((check) => check.id));
    // Discovery checks only start executing once the connection itself has succeeded (SS4.3) --
    // evidenced by at least one received check. Before that, no check is "next in line" yet, so
    // none renders `running`; every discovery-group check stays `pending`.
    const firstUnresolvedIndex =
      receivedChecks.length > 0 ? DISCOVERY_CHECK_IDS.findIndex((id) => !resolvedIds.has(id)) : -1;
    const byStep = groupChecksByStep(resolved);

    const discoverySteps: DiscoveryStepView[] = DISCOVERY_GROUP_STEPS.map((stepId) => {
      const checks: DiscoveryCheckView[] = DISCOVERY_CHECK_IDS.filter((id) => CHECK_TO_STEP[id] === stepId).map((id) => {
        const already = byStep[stepId].find((c) => c.id === id);
        if (already) return already;
        const idx = DISCOVERY_CHECK_IDS.indexOf(id);
        return pendingCheckView(id, idx === firstUnresolvedIndex ? 'running' : 'pending');
      });
      return { id: stepId, state: aggregateLiveStepState(checks), checks };
    });

    // Discovery only starts after a successful, authenticated connection (SS4.3) -- the first
    // received check implicitly resolves both connection steps to `pass`.
    const connectionState: CheckState = receivedChecks.length > 0 ? 'pass' : 'running';
    const connectionSteps: DiscoveryStepView[] = CONNECTION_STEP_NAMES.map((id) => ({
      id,
      state: connectionState,
      checks: [],
    }));

    return { steps: [...connectionSteps, ...discoverySteps] };
  }

  const settledChecks = settled.checks.map((check) => checkView(check, settled.warnings));
  const byStep = groupChecksByStep(settledChecks);

  const discoverySteps: DiscoveryStepView[] = DISCOVERY_GROUP_STEPS.map((stepId) => ({
    id: stepId,
    state: aggregateSettledStepState(discoveryGroupChecksFor(stepId, byStep)),
    checks: discoveryGroupChecksFor(stepId, byStep),
  }));

  const connectionState: CheckState = settledChecks.length > 0 ? 'pass' : 'pending';
  const connectionSteps: DiscoveryStepView[] = CONNECTION_STEP_NAMES.map((id) => ({
    id,
    state: connectionState,
    checks: [],
  }));

  return { steps: [...connectionSteps, ...discoverySteps] };
}

// A step counts toward the settled summary's denominator only when it actually ran something
// (SS4.3's "applicableSteps excludes steps that are entirely idle/not-applicable").
const APPLICABLE_STATES: ReadonlySet<CheckState> = new Set(['pass', 'warning', 'fail']);

/**
 * The settled one-line summary's own counting portion -- SS4.3: "{passed} of {applicable}
 * passed{, {warnings} warning(s)}{, {failed} failed}". Deliberately excludes the "Discovered
 * {relative time}" prefix: this function never reads a clock, so the caller prepends that part
 * itself from `collectedAt` and its own `now`.
 */
export function summarize(checklist: DiscoveryChecklist): string {
  const applicable = checklist.steps.filter((step) => APPLICABLE_STATES.has(step.state));
  const passed = applicable.filter((step) => step.state === 'pass').length;
  const warnings = applicable.filter((step) => step.state === 'warning').length;
  const failed = applicable.filter((step) => step.state === 'fail').length;

  const parts = [`${String(passed)} of ${String(applicable.length)} passed`];
  if (warnings > 0) {
    parts.push(`${String(warnings)} warning${warnings === 1 ? '' : 's'}`);
  }
  if (failed > 0) {
    parts.push(`${String(failed)} failed`);
  }
  return parts.join(', ');
}
