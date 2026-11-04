// Observability reads (27-01, ADR 0012): host sample, container states and stats, bounded log
// window. Each wrapper runs one allowlisted template through SshDeploySession.stream with its own
// limits (template timeout + margin, template cap + margin), never writes to a deployment log, and
// passes every byte of output through the context's redactor before it is parsed or returned.
import {
  parseContainerSample,
  parseHostSample,
  type ContainerSample,
  type HostSample,
  type ValidationResult,
} from '@noodara/domain';
import type { ResourceId } from '@noodara/domain/validators';
import {
  OBSERVABILITY_LIMITS,
  dockerInspectStateSample,
  dockerLogsWindow,
  dockerStatsSample,
  metricsHostSample,
  parseLogsWindow,
  type LogsWindow,
  type LogsWindowInput,
  type RemoteCommand,
} from '@noodara/ssh';
import { classify, type DockerStepContext } from './docker-operations.js';
import { notCompleted, runStep } from './run-step.js';
import type { StepResult } from './step-result.js';

/** A completed read whose output did not match the template (never carries raw output). */
export type ParsedSample<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'unparseable'; readonly reason: string };

interface TemplateLimits {
  readonly timeoutSeconds: number;
  readonly capBytes: number;
}

/** The SSH exec budget is the remote `timeout` plus this margin, so `timeout` fires first. */
const EXEC_MARGIN_MS = 5_000;
/** The remote `head -c` cap plus this margin, so the session never cuts what head let through. */
const BYTES_MARGIN = 4_096;
/** Exit codes of `timeout` (124) and of its `-k` KILL (137). */
const TIMEOUT_EXIT_CODES: readonly (number | null)[] = [124, 137];
/** `head -c` closed the pipe on a long log window: the parser flags it as capped. */
const SIGPIPE_EXIT = 141;
const TIMED_OUT: StepResult<never> = { ok: false, kind: 'interrupted', outcome: 'timed_out' };

async function probe<T>(
  context: DockerStepContext,
  command: RemoteCommand,
  limits: TemplateLimits,
  acceptedExits: readonly number[],
  read: (stdout: string, exitCode: number | null) => T,
): Promise<StepResult<T>> {
  const budgetMs = limits.timeoutSeconds * 1000 + EXEC_MARGIN_MS;
  const bytes = limits.capBytes + BYTES_MARGIN;
  // No onChunk: observability output never reaches a deployment log.
  const outcome = await runStep(
    {
      session: context.session,
      limits: { maxDurationMs: budgetMs, idleTimeoutMs: budgetMs, maxTotalBytes: bytes, maxLineBytes: bytes },
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    },
    command,
  );
  if (outcome.kind !== 'completed') return notCompleted(outcome);
  const { result } = outcome;
  if (TIMEOUT_EXIT_CODES.includes(result.exitCode)) return TIMED_OUT;
  if (result.exitCode === null || !acceptedExits.includes(result.exitCode)) {
    return classify(context, 'inspect', result);
  }
  return { ok: true, value: read(context.redactor.redact(outcome.stdout), result.exitCode), result };
}

function parsed<T>(validation: ValidationResult<T>): ParsedSample<T> {
  return validation.ok
    ? { kind: 'ok', value: validation.value }
    : { kind: 'unparseable', reason: validation.message };
}

/** metrics.host_sample: CPU over `deltaSeconds`, memory, filesystems, uptime. */
export function sampleHost(
  context: DockerStepContext,
  input: { readonly deltaSeconds?: number } = {},
): Promise<StepResult<ParsedSample<HostSample>>> {
  return probe(context, metricsHostSample(input), OBSERVABILITY_LIMITS.hostSample, [0], (stdout) =>
    parsed(parseHostSample(stdout, { capBytes: OBSERVABILITY_LIMITS.hostSample.capBytes })),
  );
}

/** docker.stats: state of every managed container (or one service's) plus stats of running ones. */
export function sampleContainers(
  context: DockerStepContext,
  input: { readonly serviceId?: ResourceId } = {},
): Promise<StepResult<ParsedSample<readonly ContainerSample[]>>> {
  return probe(context, dockerStatsSample(input), OBSERVABILITY_LIMITS.containerSample, [0], (stdout) =>
    parsed(parseContainerSample(stdout, { capBytes: OBSERVABILITY_LIMITS.containerSample.capBytes })),
  );
}

/** docker.inspect_state: state only (no stats), for the reconcile-style status read. */
export function inspectContainerStates(
  context: DockerStepContext,
  input: { readonly serviceId?: ResourceId } = {},
): Promise<StepResult<ParsedSample<readonly ContainerSample[]>>> {
  return probe(context, dockerInspectStateSample(input), OBSERVABILITY_LIMITS.inspectState, [0], (stdout) =>
    parsed(parseContainerSample(stdout, { capBytes: OBSERVABILITY_LIMITS.inspectState.capBytes })),
  );
}

/** docker.logs_window: at most `tail` lines from `since`, filtered to `until`; never fails on the cap. */
export function fetchLogsWindow(
  context: DockerStepContext,
  input: LogsWindowInput,
): Promise<StepResult<LogsWindow>> {
  const command = dockerLogsWindow(input);
  return probe(context, command, OBSERVABILITY_LIMITS.logsWindow, [0, SIGPIPE_EXIT], (stdout, exitCode) =>
    parseLogsWindow(stdout, { exitCode, ...(input.until === undefined ? {} : { until: input.until }) }),
  );
}
