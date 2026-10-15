// Runtime operations of the v0.3 engine (17-01, ADR 0010): healthcheck probes, the -prev container
// and the service's own images. Each wrapper runs allowlisted templates through
// SshDeploySession.stream; nothing here removes a version the caller did not name.
import {
  parseContainerState,
  parseProbeOutput,
  V03_DEPLOYMENT_ERROR_MESSAGES,
  type HealthcheckConfig,
  type HealthcheckObservation,
} from '@noodara/domain/deployment';
import {
  containerNameFor,
  deploymentImageRefFor,
  isResourceId,
  networkNameFor,
  type ContainerName,
  type ImageRef,
  type ResourceId,
  type ValidationResult,
} from '@noodara/domain/validators';
import {
  dockerInspectNetworks,
  dockerInspectState,
  dockerListServiceImages,
  dockerNetworkConnect,
  dockerRemovePrevious,
  dockerRemoveServiceImage,
  dockerRenameFromPrevious,
  dockerRenameToPrevious,
  dockerStart,
  dockerStartPrevious,
  dockerStopPrevious,
  PROBE_OUTPUT_MAX_BYTES,
  previousContainerNameFor,
  probeHttp,
  probeTcp,
  validateContainerIp,
  type ContainerIp,
  type HttpHealthcheckConfig,
  type RemoteCommand,
  type StreamResult,
  type TcpHealthcheckConfig,
} from '@noodara/ssh';
import {
  classify,
  done,
  stepContext,
  type DockerOperation,
  type DockerStepContext,
  type ServiceRef,
  type StopContainerInput,
} from './docker-operations.js';
import { notCompleted, runStep, type StepOutcome } from './run-step.js';
import type { StepResult } from './step-result.js';

export interface ProbeHealthInput extends ServiceRef {
  readonly config: HealthcheckConfig;
}

/** H1: `rename` never overwrites; an existing `-prev` is reported, never removed here. */
export interface PreviousExists {
  readonly ok: false;
  readonly kind: 'previous_exists';
  readonly name: ContainerName;
  readonly message: string;
}

export interface PreviousMissing {
  readonly ok: false;
  readonly kind: 'previous_missing';
  readonly name: ContainerName;
  readonly message: string;
}

/** Docker refused to remove an image a container (running or `-prev`) still uses. */
export interface ImageInUse {
  readonly ok: false;
  readonly kind: 'in_use';
  readonly image: ImageRef;
  readonly message: string;
}

export interface ServiceImage {
  readonly deploymentId: ResourceId;
  readonly imageId: string;
  readonly createdAt: string;
}

export type ServiceImagesResult =
  | { readonly kind: 'ok'; readonly images: readonly ServiceImage[] }
  | { readonly kind: 'unparseable'; readonly reason: string };

type Completed = Extract<StepOutcome, { kind: 'completed' }>;

/** Exit codes of `timeout` (124) and of its `-k` KILL (137): the hard step cap was hit. */
const TIMEOUT_EXIT_CODES: readonly (number | null)[] = [124, 137];
/** H1: the SSH exec budget is the probe timeout plus this margin (ADR 0010). */
const PROBE_EXEC_MARGIN_MS = 5_000;
const NO_SUCH_CONTAINER = /No such container/i;
const NO_SUCH_IMAGE = /No such image/i;
const NAME_IN_USE = /Conflict\. The container name .* is already in use/;
const IMAGE_IN_USE_PATTERN = /(unable to remove repository reference|image is being used|is using its referenced image)/i;
const TIMED_OUT: StepResult<never> = { ok: false, kind: 'interrupted', outcome: 'timed_out' };

function derived<T>(result: ValidationResult<T>): T {
  if (!result.ok) throw new TypeError('Invalid resource id for a Docker name');
  return result.value;
}

/** Probe and inspect steps never write to the deployment log (H2): they run without onChunk. */
function quiet(context: DockerStepContext): DockerStepContext {
  const { onChunk: _discarded, ...rest } = context;
  return rest;
}

/** A bounded (`timeout -k 1 <s>`) template: 124/137 is the step cap, not a Docker failure. */
async function bounded<T>(
  context: DockerStepContext,
  operation: DockerOperation,
  command: RemoteCommand,
  read: (outcome: Completed) => StepResult<T> | null,
): Promise<StepResult<T>> {
  const outcome = await runStep(stepContext(context), command);
  if (outcome.kind !== 'completed') return notCompleted(outcome);
  const { result } = outcome;
  if (TIMEOUT_EXIT_CODES.includes(result.exitCode)) return TIMED_OUT;
  return read(outcome) ?? classify(context, operation, result);
}

type NetworkAddress =
  | { readonly kind: 'ip'; readonly ip: ContainerIp }
  | { readonly kind: 'none' }
  | { readonly kind: 'detached' }
  | { readonly kind: 'invalid' };

/** `{{json .NetworkSettings.Networks}}`: the address on the service network, never another one. */
function networkAddress(stdout: string, network: string): NetworkAddress {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim()) as unknown;
  } catch {
    return { kind: 'invalid' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { kind: 'invalid' };
  if (!Object.hasOwn(parsed, network)) return { kind: 'detached' };
  const entry = (parsed as Record<string, unknown>)[network];
  if (typeof entry !== 'object' || entry === null) return { kind: 'invalid' };
  const ip = (entry as Record<string, unknown>).IPAddress;
  if (ip === '') return { kind: 'none' };
  if (typeof ip !== 'string') return { kind: 'invalid' };
  const checked = validateContainerIp(ip);
  return checked.ok ? { kind: 'ip', ip: checked.value } : { kind: 'invalid' };
}

/** The probe's stream result without its output tails: only the observation leaves (A4/H2). */
function withoutOutput(result: StreamResult): StreamResult {
  return { ...result, stdoutTail: '', stderrTail: '' };
}

function observed(
  value: HealthcheckObservation,
  result: StreamResult,
): StepResult<HealthcheckObservation> {
  return done(value, withoutOutput(result));
}

/**
 * One healthcheck observation (ADR 0010 A1): container state, then the IP on
 * `noodara-net-<serviceId>` read fresh, then the probe against that IP. A stopped or missing
 * container, or an empty IP, is `exited` and is never probed. The probe runs under its own limits
 * (probeTimeoutS + 5 s, 1 KiB) and its output never reaches `onChunk` (H1/H2).
 */
export async function probeContainerHealth(
  context: DockerStepContext,
  input: ProbeHealthInput,
): Promise<StepResult<HealthcheckObservation>> {
  const silent = quiet(context);
  const container = derived(containerNameFor(input.serviceId));
  const network = derived(networkNameFor(input.serviceId));

  const state = await runStep(stepContext(silent), dockerInspectState(container));
  if (state.kind !== 'completed') return notCompleted(state);
  if (state.result.exitCode !== 0) {
    if (NO_SUCH_CONTAINER.test(state.result.stderrTail)) return observed({ kind: 'exited' }, state.result);
    return classify(silent, 'inspect', state.result);
  }
  const parsedState = state.result.truncated
    ? ({ kind: 'unparseable' } as const)
    : parseContainerState(state.stdout);
  if (parsedState.kind !== 'ok') return observed({ kind: 'error' }, state.result);
  if (!parsedState.running) return observed({ kind: 'exited' }, state.result);
  if (input.config.type === 'container') return observed({ kind: 'running' }, state.result);

  const inspected = await runStep(
    stepContext(silent),
    dockerInspectNetworks({ serviceId: input.serviceId, container: 'current' }),
  );
  if (inspected.kind !== 'completed') return notCompleted(inspected);
  if (inspected.result.exitCode !== 0) {
    if (NO_SUCH_CONTAINER.test(inspected.result.stderrTail)) {
      return observed({ kind: 'exited' }, inspected.result);
    }
    if (TIMEOUT_EXIT_CODES.includes(inspected.result.exitCode)) return TIMED_OUT;
    return classify(silent, 'inspect', inspected.result);
  }
  const address = inspected.result.truncated
    ? ({ kind: 'invalid' } as const)
    : networkAddress(inspected.stdout, network);
  if (address.kind === 'none') return observed({ kind: 'exited' }, inspected.result);
  if (address.kind !== 'ip') return observed({ kind: 'error' }, inspected.result);

  const command =
    input.config.type === 'http'
      ? probeHttp({ ip: address.ip, config: input.config as HttpHealthcheckConfig })
      : probeTcp({ ip: address.ip, config: input.config as TcpHealthcheckConfig });
  const budgetMs = input.config.probeTimeoutS * 1000 + PROBE_EXEC_MARGIN_MS;
  const probe = await runStep(
    {
      session: silent.session,
      limits: {
        maxDurationMs: budgetMs,
        idleTimeoutMs: budgetMs,
        maxTotalBytes: PROBE_OUTPUT_MAX_BYTES,
        maxLineBytes: PROBE_OUTPUT_MAX_BYTES,
      },
      ...(silent.signal === undefined ? {} : { signal: silent.signal }),
    },
    command,
  );
  if (probe.kind === 'transport') return notCompleted(probe);
  if (probe.kind === 'interrupted') {
    if (probe.outcome === 'aborted') return notCompleted(probe);
    return {
      ok: true,
      value: { kind: 'timeout' },
      result: withoutOutput({
        commandName: command.name,
        outcome: probe.outcome,
        exitCode: null,
        exitSignal: null,
        durationMs: budgetMs,
        totalBytes: 0,
        truncated: false,
        stdoutTail: '',
        stderrTail: '',
      }),
    };
  }
  const { result } = probe;
  if (TIMEOUT_EXIT_CODES.includes(result.exitCode)) return observed({ kind: 'timeout' }, result);
  if (result.exitCode !== 0 || result.truncated) return observed({ kind: 'error' }, result);
  return observed(parseProbeOutput(context.redactor.redact(probe.stdout)), result);
}

/** ADR 0010 A2: `noodara-<serviceId>` → `noodara-<serviceId>-prev`, after the caller stopped it. */
export async function renameToPrevious(
  context: DockerStepContext,
  input: ServiceRef,
): Promise<StepResult<ContainerName> | PreviousExists> {
  const name = previousContainerNameFor(input.serviceId);
  const outcome = await runStep(stepContext(context), dockerRenameToPrevious(input.serviceId));
  if (outcome.kind !== 'completed') return notCompleted(outcome);
  const { result } = outcome;
  if (result.exitCode === 0) return done(name, result);
  if (TIMEOUT_EXIT_CODES.includes(result.exitCode)) return TIMED_OUT;
  if (NAME_IN_USE.test(result.stderrTail)) {
    return {
      ok: false,
      kind: 'previous_exists',
      name,
      message: 'A previous version of this service is still kept on the server. It must be restored or removed first.',
    };
  }
  return classify(context, 'start', result);
}

function rollbackFailed(): StepResult<never> {
  return {
    ok: false,
    kind: 'failed',
    code: 'ROLLBACK_FAILED',
    message: V03_DEPLOYMENT_ERROR_MESSAGES.ROLLBACK_FAILED,
  };
}

/**
 * ADR 0010 A2 restore, after the caller removed the new container: rename `-prev` back,
 * re-attach it to `noodara-net-<serviceId>` while stopped if it was detached, then start it.
 * Removes nothing.
 */
export async function restorePrevious(
  context: DockerStepContext,
  input: ServiceRef,
): Promise<StepResult<ContainerName> | PreviousMissing> {
  const container = derived(containerNameFor(input.serviceId));
  const network = derived(networkNameFor(input.serviceId));
  const previous = previousContainerNameFor(input.serviceId);

  const renamed = await runStep(stepContext(context), dockerRenameFromPrevious(input.serviceId));
  if (renamed.kind !== 'completed') return notCompleted(renamed);
  if (renamed.result.exitCode !== 0) {
    if (TIMEOUT_EXIT_CODES.includes(renamed.result.exitCode)) return TIMED_OUT;
    if (NO_SUCH_CONTAINER.test(renamed.result.stderrTail)) {
      return {
        ok: false,
        kind: 'previous_missing',
        name: previous,
        message: V03_DEPLOYMENT_ERROR_MESSAGES.ROLLBACK_TARGET_UNAVAILABLE,
      };
    }
    return classify(context, 'start', renamed.result);
  }

  const attached = await bounded(
    quiet(context),
    'inspect',
    dockerInspectNetworks({ serviceId: input.serviceId, container: 'current' }),
    ({ result, stdout }) => {
      if (result.exitCode !== 0) return null;
      const address = result.truncated ? ({ kind: 'invalid' } as const) : networkAddress(stdout, network);
      if (address.kind === 'invalid') return rollbackFailed();
      return done(address.kind !== 'detached', result);
    },
  );
  if (!attached.ok) return attached;
  if (!attached.value) {
    const connected = await bounded(context, 'network', dockerNetworkConnect(input.serviceId), ({ result }) =>
      result.exitCode === 0 ? done(true, result) : null,
    );
    if (!connected.ok) return connected;
  }

  const started = await runStep(stepContext(context), dockerStart(container));
  if (started.kind !== 'completed') return notCompleted(started);
  if (started.result.exitCode !== 0) return classify(context, 'start', started.result);
  return done(container, started.result);
}

export function startPrevious(
  context: DockerStepContext,
  input: ServiceRef,
): Promise<StepResult<ContainerName>> {
  const name = previousContainerNameFor(input.serviceId);
  return bounded(context, 'start', dockerStartPrevious(input.serviceId), ({ result }) =>
    result.exitCode === 0 ? done(name, result) : null,
  );
}

export function stopPrevious(
  context: DockerStepContext,
  input: StopContainerInput,
): Promise<StepResult<ContainerName>> {
  const name = previousContainerNameFor(input.serviceId);
  const command = dockerStopPrevious({ serviceId: input.serviceId, timeoutSeconds: input.timeoutSeconds });
  return bounded(context, 'stop', command, ({ result }) => (result.exitCode === 0 ? done(name, result) : null));
}

/** Only `-prev`, never forced; an already absent `-prev` is success (idempotent cleanup). */
export function removePrevious(
  context: DockerStepContext,
  input: ServiceRef,
): Promise<StepResult<ContainerName>> {
  const name = previousContainerNameFor(input.serviceId);
  return bounded(context, 'remove', dockerRemovePrevious(input.serviceId), ({ result }) =>
    result.exitCode === 0 || NO_SUCH_CONTAINER.test(result.stderrTail) ? done(name, result) : null,
  );
}

function parseServiceImages(stdout: string, serviceId: ResourceId): ServiceImagesResult {
  const repository = `noodara/${serviceId}`;
  const images: ServiceImage[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    let row: unknown;
    try {
      row = JSON.parse(line) as unknown;
    } catch {
      return { kind: 'unparseable', reason: 'An image list line was not JSON' };
    }
    if (typeof row !== 'object' || row === null) {
      return { kind: 'unparseable', reason: 'An image list line was not an object' };
    }
    const { Repository, Tag, ID, CreatedAt } = row as Record<string, unknown>;
    if (Repository !== repository || typeof Tag !== 'string' || !isResourceId(Tag)) continue;
    if (typeof ID !== 'string' || typeof CreatedAt !== 'string') {
      return { kind: 'unparseable', reason: 'An image list line had no ID or CreatedAt' };
    }
    images.push({ deploymentId: Tag as ResourceId, imageId: ID, createdAt: CreatedAt });
  }
  return { kind: 'ok', images };
}

/** Retention input: this service's `noodara/<serviceId>:<deploymentId>` images only. */
export function listServiceImages(
  context: DockerStepContext,
  input: ServiceRef,
): Promise<StepResult<ServiceImagesResult>> {
  return bounded(quiet(context), 'inspect', dockerListServiceImages(input.serviceId), ({ result, stdout }) => {
    if (result.exitCode !== 0) return null;
    const images: ServiceImagesResult = result.truncated
      ? { kind: 'unparseable', reason: 'The image list was truncated' }
      : parseServiceImages(stdout, input.serviceId);
    return done(images, result);
  });
}

/** Never forced: an image in use is `in_use`; an already removed image is success. */
export async function removeServiceImage(
  context: DockerStepContext,
  input: { readonly serviceId: ResourceId; readonly deploymentId: ResourceId },
): Promise<StepResult<ImageRef> | ImageInUse> {
  const image = derived(deploymentImageRefFor(input.serviceId, input.deploymentId));
  const outcome = await runStep(
    stepContext(context),
    dockerRemoveServiceImage({ serviceId: input.serviceId, deploymentId: input.deploymentId }),
  );
  if (outcome.kind !== 'completed') return notCompleted(outcome);
  const { result } = outcome;
  if (result.exitCode === 0 || NO_SUCH_IMAGE.test(result.stderrTail)) return done(image, result);
  if (IMAGE_IN_USE_PATTERN.test(result.stderrTail)) {
    return {
      ok: false,
      kind: 'in_use',
      image,
      message: 'The image is still used by a container on the server and was kept.',
    };
  }
  return classify(context, 'remove', result);
}
