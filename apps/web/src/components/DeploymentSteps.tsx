'use client';

// 13-13: deploy narration. Renders a deployment's steps (clone or pull, configure, build, start,
// verify) from the server's `steps[]` (13-03, docs/deploy-engine.md "Step timeline") with the row
// treatment DiscoveryStep uses (StepRow, extracted there). A failed deploy shows only classified
// copy for its `errorCode` and, when given, a guarded tail of the build log. The server's
// `errorMessage` is never rendered. `useDeploymentSteps` keeps one deployment live: it refetches
// on that deployment's `deployment.updated` (the event carries no steps) and on stream resync.
// 23-04 A4: configure shows its counts once done and is hidden while skipped (no variables), so a
// service without an env keeps the v0.3 timeline.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isDeploymentErrorCode,
  type DeploymentStepName,
  type DeploymentStepState,
} from '@noodara/domain/deployment';
import { Banner } from '@noodara/ui';
import { getConfigureNames, getDeployment, type DeploymentView } from '../lib/deploy-api';
import {
  deploymentErrorCopy,
  guardLogTail,
  type ConfigureNames,
  type DeploymentErrorContext,
} from '../lib/deploy-error-copy';
import { shortSha } from '../lib/service-status-copy';
import type { CheckState } from '../lib/discovery-progress';
import { requireSession } from '../lib/require-session';
import type { SyncStream } from '../lib/use-server-events';
import { StepRow } from './DiscoveryStep';

/** One entry of a deployment view's `steps[]` (DeploymentStepViewSchema). */
export interface DeploymentStepView {
  readonly name: DeploymentStepName;
  readonly state: DeploymentStepState;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  /** Only on a configure step that completed. */
  readonly counts?: { readonly variables: number; readonly secrets: number };
}

/** What the GET deployment routes return: the view plus its step timeline. */
export type DeploymentWithSteps = DeploymentView & { readonly steps: readonly DeploymentStepView[] };

export function hasSteps(deployment: DeploymentView | null | undefined): deployment is DeploymentWithSteps {
  if (deployment === null || deployment === undefined) return false;
  const { steps } = deployment as { steps?: unknown };
  return Array.isArray(steps) && steps.length > 0;
}

export const DEPLOYMENT_STEP_LABELS = Object.freeze({
  clone: 'Clone',
  pull: 'Pull image',
  configure: 'Configure',
  build: 'Build',
  start: 'Start',
  verify: 'Health check',
} as const satisfies Record<DeploymentStepName, string>);

const STEP_WORDS = {
  pending: 'Pending',
  running: 'Running',
  success: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
} as const satisfies Record<DeploymentStepState, string>;

// Step state -> the shared row's icon/tone. Cancelled reads idle (minus), like a skipped check.
const STEP_VISUAL = {
  pending: 'pending',
  running: 'running',
  success: 'pass',
  failed: 'fail',
  cancelled: 'skipped',
  skipped: 'skipped',
} as const satisfies Record<DeploymentStepState, CheckState>;

const ROLLBACK_LABEL = 'Rollback';
const ROLLBACK_STATUSES: ReadonlySet<string> = new Set(['ROLLING_BACK', 'ROLLED_BACK']);

/** The rollback ran after the last step finished and ended with the deployment: the gap between them. */
function rollbackDuration(deployment: DeploymentWithSteps): number | null {
  if (deployment.completedAt === null) return null;
  const end = Date.parse(deployment.completedAt);
  let start = Number.NaN;
  for (const step of deployment.steps) {
    if (step.completedAt === null) continue;
    const at = Date.parse(step.completedAt);
    if (!Number.isNaN(at) && !(at <= start)) start = at;
  }
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return end - start;
}

/** The rollback row, only when a rollback happened (or was attempted and failed). */
function rollbackRow(
  deployment: DeploymentWithSteps,
  restoredCommit: string | null,
): { visual: CheckState; word: string; detail: string | null; durationMs: number | null } | null {
  const durationMs = rollbackDuration(deployment);
  if (deployment.status === 'ROLLING_BACK') return { visual: 'running', word: 'Running', detail: null, durationMs: null };
  if (deployment.status === 'ROLLED_BACK') {
    const detail = restoredCommit === null || restoredCommit === '' ? null : `Restored commit ${shortSha(restoredCommit)}`;
    return { visual: 'pass', word: 'Restored', detail, durationMs };
  }
  if (deployment.errorCode === 'ROLLBACK_FAILED') return { visual: 'fail', word: 'Failed', detail: null, durationMs };
  return null;
}

/** The commit a ROLLED_BACK deployment restored: the previous deployment's commit, fetched once. */
function useRestoredCommit(deployment: DeploymentWithSteps): string | null {
  const previousId = deployment.status === 'ROLLED_BACK' ? deployment.previousDeploymentId : null;
  const [restored, setRestored] = useState<{ id: string; sha: string | null } | null>(null);
  useEffect(() => {
    if (previousId === null) return;
    let live = true;
    void getDeployment(previousId).then((result) => {
      if (live && result.ok) setRestored({ id: previousId, sha: result.data.commitSha });
    });
    return () => {
      live = false;
    };
  }, [previousId]);
  return previousId !== null && restored?.id === previousId ? restored.sha : null;
}

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

/** The configure row's detail: counts only, never a key or a reference name. */
export function configureDetail(step: DeploymentStepView): string | null {
  if (step.name !== 'configure' || step.counts === undefined) return null;
  return `${plural(step.counts.variables, 'variable')}, ${plural(step.counts.secrets, 'secret')}`;
}

const UNRESOLVED_STEP_STATES: ReadonlySet<DeploymentStepState> = new Set(['pending', 'running']);

// 24-03 A2: the env codes whose recovery names the keys and references configure logged.
const ENV_NAME_CODES: ReadonlySet<string> = new Set(['SECRET_UNRESOLVED', 'ENV_INJECTION_FAILED']);

/** Keys and reference names (never values) for a deployment that failed on its env, fetched once. */
function useConfigureNames(deployment: DeploymentWithSteps): ConfigureNames | null {
  const wanted = deployment.errorCode !== null && ENV_NAME_CODES.has(deployment.errorCode) ? deployment.id : null;
  const [names, setNames] = useState<{ id: string; names: ConfigureNames } | null>(null);
  useEffect(() => {
    if (wanted === null) return;
    let live = true;
    void getConfigureNames(wanted).then((result) => {
      if (live && result.ok) setNames({ id: wanted, names: result.data });
    });
    return () => {
      live = false;
    };
  }, [wanted]);
  return wanted !== null && names?.id === wanted ? names.names : null;
}

export interface DeploymentStepsProps {
  readonly deployment: DeploymentWithSteps;
  /** Build log text to show under the error; it goes through guardLogTail before rendering. */
  readonly logTail?: string | null;
  /** Names the caller already knows (e.g. the service's hostnames for PROXY_ROUTE_FAILED). */
  readonly errorContext?: DeploymentErrorContext;
}

export function DeploymentSteps({ deployment, logTail = null, errorContext }: DeploymentStepsProps) {
  const restoredCommit = useRestoredCommit(deployment);
  const configureNames = useConfigureNames(deployment);
  const rollback = rollbackRow(deployment, restoredCommit);
  const failed = deployment.status === 'FAILED' || deployment.errorCode !== null || ROLLBACK_STATUSES.has(deployment.status);
  const copy = deploymentErrorCopy(deployment.errorCode, { ...errorContext, ...configureNames });
  const knownCode = deployment.errorCode !== null && isDeploymentErrorCode(deployment.errorCode) ? deployment.errorCode : undefined;
  const tailLines = failed ? guardLogTail(logTail) : [];

  return (
    <section aria-label="Deployment steps" className="flex flex-col gap-4">
      <div data-testid="deployment-steps" className="flex flex-col">
        {deployment.steps
          .filter((step) => !(step.name === 'configure' && step.state === 'skipped'))
          .map((step) => {
            const detail = configureDetail(step);
            return (
              <StepRow
                key={step.name}
                testId={`deployment-step-${step.name}`}
                visual={Object.hasOwn(STEP_VISUAL, step.state) ? STEP_VISUAL[step.state] : 'skipped'}
                label={Object.hasOwn(DEPLOYMENT_STEP_LABELS, step.name) ? DEPLOYMENT_STEP_LABELS[step.name] : 'Step'}
                word={Object.hasOwn(STEP_WORDS, step.state) ? STEP_WORDS[step.state] : 'Unknown'}
                durationMs={step.state === 'skipped' ? null : step.durationMs}
                threadFilled={!UNRESOLVED_STEP_STATES.has(step.state)}
              >
                {detail === null ? null : (
                  <p data-testid="deployment-configure-counts" className="pl-6 text-caption text-ink-secondary">
                    {detail}
                  </p>
                )}
              </StepRow>
            );
          })}
        {rollback === null ? null : (
          <StepRow
            testId="deployment-step-rollback"
            visual={rollback.visual}
            label={ROLLBACK_LABEL}
            word={rollback.word}
            durationMs={rollback.durationMs}
            threadFilled={rollback.visual !== 'running'}
          >
            {rollback.detail === null ? null : (
              <p data-testid="deployment-rollback-commit" className="pl-6 font-mono text-mono text-ink-secondary">
                {rollback.detail}
              </p>
            )}
          </StepRow>
        )}
      </div>
      {failed ? (
        <Banner message={copy.title} {...(knownCode === undefined ? {} : { errorCode: knownCode })} data-testid="deployment-error">
          <p className="max-w-[70ch] text-callout text-ink-secondary">{copy.recovery}</p>
          {tailLines.length > 0 ? (
            <pre
              data-testid="deployment-error-log"
              data-mono="true"
              className="overflow-x-auto whitespace-pre-wrap break-words rounded-sm bg-canvas px-3 py-2 font-mono text-mono text-ink"
            >
              {tailLines.join('\n')}
            </pre>
          ) : null}
        </Banner>
      ) : null}
    </section>
  );
}

function stamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * The deployment `deploymentId` names, with its steps, kept live. `seed` (a history row) is shown
 * until the first fetch settles when it already carries steps. A response for a deployment no
 * longer shown, or older than what is shown, is dropped; a failed refetch keeps what is shown.
 */
export function useDeploymentSteps(
  deploymentId: string | null,
  stream: SyncStream,
  seed: DeploymentView | null = null,
): DeploymentWithSteps | null {
  const { subscribeDeploy, registerResync } = stream;
  const seedFor = (id: string | null): DeploymentWithSteps | null =>
    id !== null && seed !== null && seed.id === id && hasSteps(seed) ? seed : null;
  const [shown, setShown] = useState<DeploymentWithSteps | null>(() => seedFor(deploymentId));
  const shownRef = useRef<DeploymentWithSteps | null>(shown);
  const currentId = useRef<string | null>(deploymentId);
  const request = useRef(0);

  const commit = useCallback((next: DeploymentWithSteps | null): void => {
    shownRef.current = next;
    setShown(next);
  }, []);

  const refetch = useCallback((): void => {
    const id = currentId.current;
    if (id === null) return;
    request.current += 1;
    const token = request.current;
    void getDeployment(id).then((result) => {
      if (token !== request.current || currentId.current !== id) return;
      if (!result.ok) {
        if (result.unauthorized) void requireSession();
        return;
      }
      if (!hasSteps(result.data) || result.data.id !== id) return;
      const held = shownRef.current;
      if (held !== null && held.id === id && stamp(result.data.updatedAt) < stamp(held.updatedAt)) return;
      commit(result.data);
    });
  }, [commit]);

  useEffect(() => {
    currentId.current = deploymentId;
    const held = shownRef.current;
    if (held?.id !== deploymentId) commit(seedFor(deploymentId));
    refetch();
    // `seed` is read once per id: a later seed for the same id never replaces a fetched view.
  }, [deploymentId, refetch, commit]);

  useEffect(() => registerResync(refetch), [registerResync, refetch]);
  useEffect(
    () =>
      subscribeDeploy((event) => {
        if (event.type !== 'deployment.updated' || event.deployment.id !== currentId.current) return;
        refetch();
      }),
    [subscribeDeploy, refetch],
  );

  return shown !== null && shown.id === deploymentId ? shown : null;
}
