// 12-14: operations on a deployed service's container over an already connected SshDeploySession.
// - runServiceOperation: `docker ps` first (an absent container is CONTAINER_NOT_FOUND, nothing is
//   touched), then stop / restart / remove (a running container is stopped before its removal),
//   then a best-effort re-observation for the status cache.
// - cleanupServiceRemote: what deleting a service leaves behind: the container, its network, and
//   per claimed deployment (newest first, capped) its own image and workspace. Every removal is
//   idempotent (absent counts as settled) and the first unsettled one ends the run, so a retry
//   resumes safely. Images are never forced.
// Nothing here throws, and no remote output reaches a result: failures carry a closed code and a
// fixed message (SEC: never raw stderr).
import {
  classifyCleanupOutcome,
  toContainerObservation,
  type CleanupResource,
  type ContainerObservation,
  type DockerContainerState,
  type DockerPsResult,
} from '@noodara/domain/deployment';
import type { Redactor } from '@noodara/domain/security';
import {
  containerNameFor,
  deploymentImageRefFor,
  deployWorkspaceFor,
  networkNameFor,
  validateResourceId,
  type ResourceId,
} from '@noodara/domain/validators';
import {
  listManagedContainers,
  removeContainer,
  restartContainer,
  stopContainer,
  type DockerStepContext,
  type StepResult,
} from '@noodara/docker';
import {
  dockerImageRemove,
  dockerNetworkRemove,
  removeDeployDir,
  type RemoteCommand,
  type SshDeploySession,
} from '@noodara/ssh';
import type { DeployJobDeps } from './deploy-worker.js';

export const SERVICE_OPERATIONS = Object.freeze(['stop', 'restart', 'remove'] as const);
export type ServiceOperation = (typeof SERVICE_OPERATIONS)[number];

export type ServiceOperationFailureCode =
  | 'SERVER_UNREACHABLE'
  | 'SERVER_DOCKER_UNAVAILABLE'
  | 'CONTAINER_NOT_FOUND'
  | 'SERVICE_OPERATION_FAILED'
  | 'SERVICE_OPERATION_TIMEOUT';

export type ServiceCleanupFailureCode = 'SERVER_UNREACHABLE' | 'SERVER_DOCKER_UNAVAILABLE' | 'SERVICE_CLEANUP_FAILED';

export type ServiceOpsCode = ServiceOperationFailureCode | ServiceCleanupFailureCode;

/** Fixed, actionable messages: the only text a failure ever carries. */
export const SERVICE_OPS_MESSAGES = Object.freeze({
  SERVER_UNREACHABLE: 'The server could not be reached over SSH. Check that it is online and try again.',
  SERVER_DOCKER_UNAVAILABLE: 'Docker is not available on the server. Check that the Docker daemon is running.',
  CONTAINER_NOT_FOUND: 'The service container does not exist on the server. Redeploy the service to recreate it.',
  SERVICE_OPERATION_FAILED: 'Docker refused the operation on the service container. Try again or redeploy the service.',
  SERVICE_OPERATION_TIMEOUT: 'The operation on the service container timed out. Try again.',
  SERVICE_CLEANUP_FAILED: 'Removing the service resources on the server failed. Nothing was deleted; try again.',
} satisfies Record<ServiceOpsCode, string>);

export interface ServiceOpsLimits {
  /** Bound of each remote step (duration and idle). */
  readonly stepMs: number;
  readonly maxLineBytes: number;
  /** `docker stop --timeout`. */
  readonly stopTimeoutSeconds: number;
}

export const DEFAULT_SERVICE_OPS_LIMITS: ServiceOpsLimits = Object.freeze({
  stepMs: 60_000,
  maxLineBytes: 16_384,
  stopTimeoutSeconds: 10,
});

/** Per-deployment removals of one delete; older leftovers are beyond what one request may do. */
export const MAX_CLEANUP_DEPLOYMENTS = 50;

const PS_MAX_TOTAL_BYTES = 1_048_576;
const REMOVAL_MAX_TOTAL_BYTES = 65_536;
const COMMAND_NOT_FOUND_EXIT_CODE = 127;

export type ServiceOperationResult =
  | {
      readonly ok: true;
      readonly operation: ServiceOperation;
      readonly previousState: DockerContainerState;
      /** Re-observed after the operation; `unknown` when that observation failed. */
      readonly container: ContainerObservation;
      readonly durationMs: number;
    }
  | {
      readonly ok: false;
      readonly code: ServiceOperationFailureCode;
      readonly message: string;
      readonly durationMs: number;
    };

export type ServiceCleanupResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ServiceCleanupFailureCode; readonly message: string };

export interface RunServiceOperationInput {
  readonly session: SshDeploySession;
  readonly redactor: Redactor;
  readonly serviceId: string;
  readonly operation: ServiceOperation;
  readonly limits: ServiceOpsLimits;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export interface CleanupServiceRemoteInput {
  readonly session: SshDeploySession;
  readonly redactor: Redactor;
  readonly serviceId: string;
  /** Claimed deployments (startedAt set), newest first. */
  readonly deploymentIds: readonly string[];
  readonly limits: ServiceOpsLimits;
  readonly signal?: AbortSignal;
}

/** A step that did not settle: its classification, before it is mapped to an op or cleanup code. */
type StepFailure = 'unreachable' | 'docker_unavailable' | 'timeout' | 'failed';

class StepError extends Error {
  constructor(readonly failure: StepFailure) {
    super(failure);
    this.name = 'StepError';
  }
}

function stepContext(input: {
  session: SshDeploySession;
  redactor: Redactor;
  limits: ServiceOpsLimits;
  signal?: AbortSignal;
}): DockerStepContext {
  return {
    session: input.session,
    redactor: input.redactor,
    limits: {
      maxDurationMs: input.limits.stepMs,
      idleTimeoutMs: input.limits.stepMs,
      maxTotalBytes: PS_MAX_TOTAL_BYTES,
      maxLineBytes: input.limits.maxLineBytes,
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

/** Runs one @noodara/docker step; a rejected stream (SSH dropped) is `unreachable`. */
async function step<T>(work: () => Promise<StepResult<T>>): Promise<{ value: T; exitCode: number | null }> {
  let result: StepResult<T>;
  try {
    result = await work();
  } catch {
    throw new StepError('unreachable');
  }
  if (result.ok) return { value: result.value, exitCode: result.result.exitCode };
  if (result.kind === 'interrupted') throw new StepError(result.outcome === 'aborted' ? 'failed' : 'timeout');
  if (result.code === 'SERVER_UNREACHABLE') throw new StepError('unreachable');
  if (result.code === 'DOCKER_UNAVAILABLE') throw new StepError('docker_unavailable');
  throw new StepError('failed');
}

/** `docker ps`; a daemon that is down or missing is `docker_unavailable`. */
async function observe(context: DockerStepContext): Promise<DockerPsResult & { kind: 'ok' }> {
  const ps = await step(() => listManagedContainers(context));
  if (ps.value.kind === 'ok') return ps.value;
  if (ps.value.kind === 'daemon_unreachable' || ps.exitCode === COMMAND_NOT_FOUND_EXIT_CODE) {
    throw new StepError('docker_unavailable');
  }
  throw new StepError('failed');
}

function needsStop(state: DockerContainerState): boolean {
  return state === 'running' || state === 'restarting' || state === 'paused';
}

const OPERATION_CODE: Record<StepFailure, ServiceOperationFailureCode> = {
  unreachable: 'SERVER_UNREACHABLE',
  docker_unavailable: 'SERVER_DOCKER_UNAVAILABLE',
  timeout: 'SERVICE_OPERATION_TIMEOUT',
  failed: 'SERVICE_OPERATION_FAILED',
};

const CLEANUP_CODE: Record<StepFailure, ServiceCleanupFailureCode> = {
  unreachable: 'SERVER_UNREACHABLE',
  docker_unavailable: 'SERVER_DOCKER_UNAVAILABLE',
  timeout: 'SERVICE_CLEANUP_FAILED',
  failed: 'SERVICE_CLEANUP_FAILED',
};

export async function runServiceOperation(input: RunServiceOperationInput): Promise<ServiceOperationResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const fail = (code: ServiceOperationFailureCode): ServiceOperationResult => ({
    ok: false,
    code,
    message: SERVICE_OPS_MESSAGES[code],
    durationMs: Math.max(0, now() - startedAt),
  });

  const serviceId = validateResourceId(input.serviceId);
  const container = containerNameFor(input.serviceId);
  if (!serviceId.ok || !container.ok) return fail('SERVICE_OPERATION_FAILED');
  const ref = { serviceId: serviceId.value };
  const context = stepContext(input);
  const timeoutSeconds = input.limits.stopTimeoutSeconds;

  try {
    const before = await observe(context);
    const found = before.containers.find((candidate) => candidate.name === container.value);
    if (found === undefined) return fail('CONTAINER_NOT_FOUND');

    switch (input.operation) {
      case 'stop':
        await step(() => stopContainer(context, { ...ref, timeoutSeconds }));
        break;
      case 'restart':
        await step(() => restartContainer(context, { ...ref, timeoutSeconds }));
        break;
      case 'remove':
        if (needsStop(found.state)) await step(() => stopContainer(context, { ...ref, timeoutSeconds }));
        await step(() => removeContainer(context, ref));
        break;
    }

    let after: ContainerObservation;
    try {
      after = toContainerObservation((await observe(context)).containers, container.value);
    } catch {
      after = { kind: 'unknown' };
    }
    return {
      ok: true,
      operation: input.operation,
      previousState: found.state,
      container: after,
      durationMs: Math.max(0, now() - startedAt),
    };
  } catch (error) {
    return fail(error instanceof StepError ? OPERATION_CODE[error.failure] : 'SERVICE_OPERATION_FAILED');
  }
}

/** One idempotent removal: settled unless the classifier says `failed`. */
async function removeResource(
  input: CleanupServiceRemoteInput,
  command: RemoteCommand,
  resource: CleanupResource,
): Promise<void> {
  let settled: boolean;
  try {
    const result = await input.session.stream(command, {
      maxDurationMs: input.limits.stepMs,
      idleTimeoutMs: input.limits.stepMs,
      maxTotalBytes: REMOVAL_MAX_TOTAL_BYTES,
      maxLineBytes: input.limits.maxLineBytes,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      onChunk: () => {
        // Cleanup output is classified from the tails, never logged.
      },
    });
    settled =
      result.outcome === 'completed' &&
      result.exitCode !== null &&
      classifyCleanupOutcome(resource, {
        exitCode: result.exitCode,
        stdout: result.stdoutTail,
        stderr: result.stderrTail,
      }) !== 'failed';
  } catch {
    throw new StepError('unreachable');
  }
  if (!settled) throw new StepError('failed');
}

function deploymentTargets(serviceId: ResourceId, deploymentIds: readonly string[]) {
  const targets = [];
  for (const raw of deploymentIds) {
    if (targets.length >= MAX_CLEANUP_DEPLOYMENTS) break;
    const deploymentId = validateResourceId(raw);
    if (!deploymentId.ok) continue;
    const image = deploymentImageRefFor(serviceId, deploymentId.value);
    const workspace = deployWorkspaceFor(deploymentId.value);
    if (!image.ok || !workspace.ok) continue;
    targets.push({ image: image.value, workspace: workspace.value });
  }
  return targets;
}

export async function cleanupServiceRemote(input: CleanupServiceRemoteInput): Promise<ServiceCleanupResult> {
  const serviceId = validateResourceId(input.serviceId);
  const container = containerNameFor(input.serviceId);
  const network = networkNameFor(input.serviceId);
  if (!serviceId.ok || !container.ok || !network.ok) {
    return { ok: false, code: 'SERVICE_CLEANUP_FAILED', message: SERVICE_OPS_MESSAGES.SERVICE_CLEANUP_FAILED };
  }
  const ref = { serviceId: serviceId.value };
  const context = stepContext(input);

  try {
    const found = (await observe(context)).containers.find((candidate) => candidate.name === container.value);
    if (found !== undefined) {
      if (needsStop(found.state)) {
        await step(() => stopContainer(context, { ...ref, timeoutSeconds: input.limits.stopTimeoutSeconds }));
      }
      await step(() => removeContainer(context, ref));
    }
    await removeResource(input, dockerNetworkRemove(network.value), { kind: 'network', name: network.value });
    for (const target of deploymentTargets(serviceId.value, input.deploymentIds)) {
      await removeResource(input, dockerImageRemove(target.image), { kind: 'image', ref: target.image });
      await removeResource(input, removeDeployDir(target.workspace), { kind: 'workspace', path: target.workspace.root });
    }
    return { ok: true };
  } catch (error) {
    const code = error instanceof StepError ? CLEANUP_CODE[error.failure] : 'SERVICE_CLEANUP_FAILED';
    return { ok: false, code, message: SERVICE_OPS_MESSAGES[code] };
  }
}

export interface ServiceRemoteCleanupRequest {
  readonly serverId: string;
  readonly serviceId: string;
  /** Claimed deployments (startedAt set), newest first. */
  readonly deploymentIds: readonly string[];
}

/** The port the delete paths depend on (fakeable in route tests). Never rejects. */
export type ServiceRemoteCleanup = (request: ServiceRemoteCleanupRequest) => Promise<ServiceCleanupResult>;

export interface ServiceRemoteCleanupDeps {
  readonly connect: DeployJobDeps['connect'];
  readonly createRedactor: () => Redactor;
  readonly limits: ServiceOpsLimits;
}

export function createServiceRemoteCleanup(deps: ServiceRemoteCleanupDeps): ServiceRemoteCleanup {
  return async (request) => {
    const redactor = deps.createRedactor();
    let close: (() => Promise<void>) | null = null;
    try {
      const connected = await deps.connect(request.serverId, redactor, undefined);
      if (!connected.ok) {
        const code = connected.code === 'DOCKER_UNAVAILABLE' ? 'SERVER_DOCKER_UNAVAILABLE' : 'SERVER_UNREACHABLE';
        return { ok: false, code, message: SERVICE_OPS_MESSAGES[code] };
      }
      close = connected.close;
      return await cleanupServiceRemote({
        session: connected.session,
        redactor,
        serviceId: request.serviceId,
        deploymentIds: request.deploymentIds,
        limits: deps.limits,
      });
    } catch {
      return { ok: false, code: 'SERVER_UNREACHABLE', message: SERVICE_OPS_MESSAGES.SERVER_UNREACHABLE };
    } finally {
      if (close !== null) {
        try {
          await close();
        } catch {
          // A failed close never changes the outcome.
        }
      }
    }
  };
}
