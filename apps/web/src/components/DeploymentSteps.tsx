'use client';

// 13-13: deploy narration. Renders a deployment's four steps (clone or pull, build, start, verify)
// from the server's `steps[]` (13-03, docs/deploy-engine.md "Step timeline") with the row
// treatment DiscoveryStep uses (StepRow, extracted there). A failed deploy shows only classified
// copy for its `errorCode` and, when given, a guarded tail of the build log. The server's
// `errorMessage` is never rendered. `useDeploymentSteps` keeps one deployment live: it refetches
// on that deployment's `deployment.updated` (the event carries no steps) and on stream resync.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isDeploymentErrorCode,
  type DeploymentStepName,
  type DeploymentStepState,
} from '@noodara/domain/deployment';
import { Banner } from '@noodara/ui';
import { getDeployment, type DeploymentView } from '../lib/deploy-api';
import { deploymentErrorCopy, guardLogTail } from '../lib/deploy-error-copy';
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
}

/** What the GET deployment routes return: the view plus its four-step timeline. */
export type DeploymentWithSteps = DeploymentView & { readonly steps: readonly DeploymentStepView[] };

export function hasSteps(deployment: DeploymentView | null | undefined): deployment is DeploymentWithSteps {
  if (deployment === null || deployment === undefined) return false;
  const { steps } = deployment as { steps?: unknown };
  return Array.isArray(steps) && steps.length > 0;
}

export const DEPLOYMENT_STEP_LABELS = Object.freeze({
  clone: 'Clone',
  pull: 'Pull image',
  build: 'Build',
  start: 'Start',
  verify: 'Verify',
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

const UNRESOLVED_STEP_STATES: ReadonlySet<DeploymentStepState> = new Set(['pending', 'running']);

export interface DeploymentStepsProps {
  readonly deployment: DeploymentWithSteps;
  /** Build log text to show under the error; it goes through guardLogTail before rendering. */
  readonly logTail?: string | null;
}

export function DeploymentSteps({ deployment, logTail = null }: DeploymentStepsProps) {
  const failed = deployment.status === 'FAILED' || deployment.errorCode !== null;
  const copy = deploymentErrorCopy(deployment.errorCode);
  const knownCode = deployment.errorCode !== null && isDeploymentErrorCode(deployment.errorCode) ? deployment.errorCode : undefined;
  const tailLines = failed ? guardLogTail(logTail) : [];

  return (
    <section aria-label="Deployment steps" className="flex flex-col gap-4">
      <div data-testid="deployment-steps" className="flex flex-col">
        {deployment.steps.map((step) => (
          <StepRow
            key={step.name}
            testId={`deployment-step-${step.name}`}
            visual={STEP_VISUAL[step.state]}
            label={DEPLOYMENT_STEP_LABELS[step.name]}
            word={STEP_WORDS[step.state]}
            durationMs={step.state === 'skipped' ? null : step.durationMs}
            threadFilled={!UNRESOLVED_STEP_STATES.has(step.state)}
          />
        ))}
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
