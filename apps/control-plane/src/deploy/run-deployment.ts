// 12-11: one deployment attempt, end to end, over an already connected SshDeploySession.
// clone (git) -> build or pull -> docker ps + port preflight -> network -> replace the container
// (stop + remove the previous `noodara-<serviceId>`, create + start the new one under the same
// name, OPEN_QUESTIONS #5: no automatic restore) -> post-start polls. Rules:
// - Status moves only through `transitionDeployment`; the store persists each edge (C1).
// - A failed build or pull never touches the running container: the replacement starts only
//   after the image exists (C2). The superseded own image is removed only once the new container
//   ran stably.
// - Every remote resource goes into the resource ledger and its cleanup set runs in `finally`
//   on every exit, thrown errors included (C2).
// - Output reaches only the injected sink, through the per-run redactor (A6, SEC). Every decrypted
//   credential is registered for the whole run and released at the end.
// - Remote failures become a closed-vocabulary code with a fixed, actionable message; nothing
//   here throws (ERR).
// - Every name comes from the validated ids; repo values reach argv only as single elements
//   through the allowlisted builders (H2).
import {
  cleanupSetFor,
  classifyCleanupOutcome,
  createResourceLedger,
  decidePostStartPoll,
  preflightPublishedPort,
  recordResource,
  startPostStartPolls,
  transitionDeployment,
  type CleanupOutcome,
  type CleanupResource,
  type ContainerObservation,
  type DeploymentErrorCode,
  type DeploymentExit,
  type DeploymentLogPhase,
  type DeploymentStatus,
  type PortPreflightResult,
  type PostStartObservation,
  type PostStartPollPolicy,
  type ResourceLedger,
} from '@noodara/domain/deployment';
import { revealSecret, type Redactor, type SecretValue } from '@noodara/domain/security';
import {
  deployWorkspaceFor,
  type CommitSha,
  type ContainerPort,
  type DeployWorkspace,
  type ImageRef,
  type ResourceId,
  type ServiceSource,
  type SupervisedOperation,
} from '@noodara/domain/validators';
import {
  buildImage,
  createContainer,
  ensureNetwork,
  inspectContainerState,
  listManagedContainers,
  pullImage,
  removeContainer,
  startContainer,
  stopContainer,
  type DockerStepContext,
  type RegistryCredential,
  type StepLimits,
  type StepResult,
} from '@noodara/docker';
import { cloneRepository, type GitCredential } from '@noodara/git';
import {
  dockerImageRemove,
  dockerNetworkRemove,
  killSupervisedOperation,
  removeDeployDir,
  type RemoteCommand,
  type SshDeploySession,
  type StreamChunk,
} from '@noodara/ssh';
import type { DeploymentLogSink } from './log-sink.js';

export interface DeployRunLimits {
  /** NOODARA_DEPLOY_MAX_MS: the whole attempt, cleanup excluded. */
  readonly deployMaxMs: number;
  /** NOODARA_DEPLOY_IDLE_MS: a step without output for this long is stalled. */
  readonly idleMs: number;
  readonly maxTotalBytes: number;
  readonly maxLineBytes: number;
  readonly stopTimeoutSeconds: number;
  readonly killConfirmMs: number;
  readonly killPollMs: number;
  /** Per cleanup command; cleanup runs after the deadline too. */
  readonly cleanupStepMs: number;
}

/** Persists each status edge as it happens (the store, in production). */
export interface DeploymentProgress {
  advance(from: DeploymentStatus, to: DeploymentStatus): Promise<void>;
  /** The start -> verify step boundary (13-03): the container started, post-start polls begin. */
  enterVerify(): Promise<void>;
  recordCommitSha(sha: CommitSha): Promise<void>;
}

export type DeployCredential = GitCredential | { readonly kind: 'registry'; readonly registry: RegistryCredential };

export interface DeployClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface RunDeploymentInput {
  readonly session: SshDeploySession;
  /** Per-run redactor, the one the session was connected with. */
  readonly redactor: Redactor;
  readonly serviceId: ResourceId;
  readonly deploymentId: ResourceId;
  readonly source: ServiceSource;
  readonly internalPort: ContainerPort;
  readonly publishedPort: ContainerPort | null;
  readonly credential: DeployCredential;
  readonly otherServices: readonly { readonly serviceId: string; readonly publishedPort: number | null }[];
  readonly panelPorts: readonly { readonly port: number; readonly label: string }[];
  readonly limits: DeployRunLimits;
  readonly pollPolicy: PostStartPollPolicy;
  readonly progress: DeploymentProgress;
  readonly sink: DeploymentLogSink;
  readonly clock: DeployClock;
  readonly signal?: AbortSignal;
}

export interface CleanupReport {
  readonly resource: CleanupResource['kind'];
  readonly outcome: CleanupOutcome;
}

export interface DeploymentOutcome {
  readonly status: 'SUCCESS' | 'FAILED' | 'CANCELLED';
  readonly errorCode: DeploymentErrorCode | null;
  /** Fixed, actionable text; never raw remote output. */
  readonly errorMessage: string | null;
  readonly commitSha: CommitSha | null;
  /** What this attempt knows about `noodara-<serviceId>`; null when it never touched it. */
  readonly container: ContainerObservation | null;
  readonly cleanup: readonly CleanupReport[];
  /** H2: set when a cancel could not confirm the remote process gone; the worker records it. */
  readonly warning?: DeploymentWarning;
}

/** Named warning of an unconfirmed cancel; carried by the `deployment.finished` activity event. */
export const CANCEL_UNCONFIRMED = 'CANCEL_UNCONFIRMED';
export type DeploymentWarning = typeof CANCEL_UNCONFIRMED;

/** The closed `deployment_error_code` (pg enum) has no cancel code, so an unconfirmed cancel is
 *  recorded as the code whose fix is the same (check the server), with its own message. */
export const CANCEL_UNCONFIRMED_ERROR_CODE: DeploymentErrorCode = 'SERVER_UNREACHABLE';

export const DEPLOY_MESSAGES = Object.freeze({
  BUILD_TIMEOUT:
    'The deployment ran longer than the configured limit (NOODARA_DEPLOY_MAX_MS) and was stopped. Speed up the build or raise the limit, then redeploy.',
  BUILD_STALLED:
    'The deployment produced no output for longer than the configured limit (NOODARA_DEPLOY_IDLE_MS) and was stopped. Check the last log lines, then redeploy.',
  WORKER_CRASHED:
    'The deploy job stopped on an unexpected internal error. Redeploy; if it happens again, check the worker logs.',
  DOCKER_PS_UNREADABLE:
    'Noodara could not read the container list from Docker on the server. Check that Docker is running and healthy, then redeploy.',
  CANCEL_UNCONFIRMED:
    'The deployment was cancelled, but Noodara could not confirm that its build stopped on the server. Check the server for a leftover build process, then redeploy.',
});

const CLEANUP_MAX_TOTAL_BYTES = 65_536;

type End =
  | {
      readonly status: 'FAILED';
      readonly code: DeploymentErrorCode;
      readonly message: string;
      readonly warning?: DeploymentWarning;
    }
  | { readonly status: 'CANCELLED' };

/** Internal control flow: ends the attempt with a known outcome. Never escapes runDeployment. */
class DeployStop extends Error {
  constructor(readonly end: End) {
    super('deploy stopped');
    this.name = 'DeployStop';
  }
}

function failed(code: DeploymentErrorCode, message: string): never {
  throw new DeployStop({ status: 'FAILED', code, message });
}

function credentialSecrets(credential: DeployCredential): SecretValue[] {
  switch (credential.kind) {
    case 'https_token':
      return [credential.token];
    case 'deploy_key':
      return [credential.privateKey];
    case 'registry':
      return [credential.registry.password];
    case 'none':
      return [];
  }
}

function gitCredentialOf(credential: DeployCredential): GitCredential {
  return credential.kind === 'registry' ? { kind: 'none' } : credential;
}

function portMessage(result: Extract<PortPreflightResult, { ok: false }>): string {
  const port = String(result.port);
  switch (result.owner.kind) {
    case 'panel':
      return `Host port ${port} is used by ${result.owner.label}. Choose a different published port, then redeploy.`;
    case 'service':
      return `Host port ${port} is already published by another service on this server. Choose a different published port, then redeploy.`;
    case 'container':
      return `Host port ${port} is already used by another container on the server. Choose a different published port or stop that container, then redeploy.`;
  }
}

function startFailedMessage(reason: string, exitCode: number | null, oomKilled: boolean): string {
  const fix = 'Check the runtime logs, fix the application or its configuration, then redeploy.';
  switch (reason) {
    case 'missing':
      return `The container disappeared right after starting. ${fix}`;
    case 'not_stable':
      return `The container did not stay running after starting. ${fix}`;
    default: {
      const exit = exitCode === null ? '' : ` (exit code ${String(exitCode)})`;
      const oom = oomKilled ? ' It ran out of memory.' : '';
      return `The container stopped right after starting${exit}.${oom} ${fix}`;
    }
  }
}

function exitFor(end: End | null): DeploymentExit {
  if (end === null) return 'SUCCESS';
  if (end.status === 'CANCELLED' || end.warning !== undefined) return 'CANCELLED';
  return end.code === 'BUILD_TIMEOUT' || end.code === 'BUILD_STALLED' ? 'TIMEOUT' : 'FAILED';
}

/** Branded ids always produce a ledger and a workspace; a failure is a caller bug. */
function derive<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new TypeError('Invalid resource id for a deployment');
  return result.value;
}

export async function runDeployment(input: RunDeploymentInput): Promise<DeploymentOutcome> {
  const { session, redactor, serviceId, deploymentId, limits, clock, progress } = input;
  const startedAt = clock.now();
  const deadline = startedAt + limits.deployMaxMs;
  const workspace: DeployWorkspace = derive(deployWorkspaceFor(deploymentId));
  let ledger: ResourceLedger = derive(createResourceLedger(serviceId, deploymentId));
  let status: DeploymentStatus = 'PREPARING';
  let commitSha: CommitSha | null = null;
  let container: ContainerObservation | null = null;
  let containerTouched = false;
  let containerCreated = false;
  let seq = 0;

  const secrets = credentialSecrets(input.credential).map((secret) => revealSecret(secret));
  const kinds = credentialSecrets(input.credential).map((secret) => secret.kind);
  secrets.forEach((raw, index) => {
    redactor.register(raw, kinds[index] ?? 'api_key');
  });

  const log = (phase: DeploymentLogPhase, stream: 'stdout' | 'stderr' | 'system', text: string): void => {
    try {
      input.sink.write({ phase, stream, text: redactor.redact(text), seq: seq++ });
    } catch {
      // A sink failure never fails the deployment.
    }
  };

  const stepLimits = (): StepLimits => {
    const remaining = deadline - clock.now();
    if (remaining <= 0) failed('BUILD_TIMEOUT', DEPLOY_MESSAGES.BUILD_TIMEOUT);
    return {
      maxDurationMs: remaining,
      idleTimeoutMs: Math.min(limits.idleMs, remaining),
      maxTotalBytes: limits.maxTotalBytes,
      maxLineBytes: limits.maxLineBytes,
    };
  };

  // A2: a cancel seen between steps ends the attempt before the next remote command. Once the
  // container swap starts the attempt runs to its end (H1): a half-done swap is worse than a
  // late cancel, and the row still ends in exactly one terminal state.
  let cancellable = true;
  const context = (phase: DeploymentLogPhase | null): DockerStepContext => {
    const signal = cancellable ? input.signal : undefined;
    if (signal?.aborted === true) throw new DeployStop({ status: 'CANCELLED' });
    return {
      session,
      redactor,
      limits: stepLimits(),
      ...(signal === undefined ? {} : { signal }),
      ...(phase === null ? {} : {
            onChunk: (chunk: StreamChunk) => {
              log(phase, chunk.stream, chunk.text);
            },
          }),
    };
  };

  /** Unwraps a step; an interrupted supervised step is killed before the attempt ends. */
  const check = async <T>(result: StepResult<T>, supervised: SupervisedOperation | null): Promise<T> => {
    if (result.ok) return result.value;
    if (result.kind === 'failed') failed(result.code, result.message);
    let confirmed = true;
    if (supervised !== null) {
      const killed = await killSupervisedOperation({
        session,
        pidFile: workspace.pidFile(supervised),
        buildContainer: null,
        confirmTimeoutMs: limits.killConfirmMs,
        pollIntervalMs: limits.killPollMs,
        redactor,
      });
      confirmed = killed.confirmed;
      if (!confirmed) log('deploy', 'system', `The interrupted ${supervised} could not be confirmed stopped on the server.`);
    }
    switch (result.outcome) {
      case 'aborted':
        // H2: a cancel ends CANCELLED only once the remote group is confirmed gone.
        if (!confirmed) {
          throw new DeployStop({
            status: 'FAILED',
            code: CANCEL_UNCONFIRMED_ERROR_CODE,
            message: DEPLOY_MESSAGES.CANCEL_UNCONFIRMED,
            warning: CANCEL_UNCONFIRMED,
          });
        }
        throw new DeployStop({ status: 'CANCELLED' });
      case 'timed_out':
        return failed('BUILD_TIMEOUT', DEPLOY_MESSAGES.BUILD_TIMEOUT);
      case 'idle_timeout':
        return failed('BUILD_STALLED', DEPLOY_MESSAGES.BUILD_STALLED);
    }
  };

  const advance = async (to: DeploymentStatus): Promise<void> => {
    const next = transitionDeployment(status, to);
    await progress.advance(status, next);
    status = next;
  };

  const observe = async (): Promise<PostStartObservation> => {
    const result = await inspectContainerState(context(null), { serviceId });
    if (result.ok || result.kind === 'interrupted') return check(result, null);
    if (result.code === 'DOCKER_UNAVAILABLE' || result.code === 'SERVER_UNREACHABLE') {
      failed(result.code, result.message);
    }
    return { kind: 'missing' };
  };

  const pipeline = async (): Promise<void> => {
    // prepare
    let image: ImageRef;
    const { source } = input;
    if (source.kind === 'git') {
      ledger = recordResource(ledger, { kind: 'workspace_created' });
      const cloned = await check(
        await cloneRepository({
          ...context('prepare'),
          workspace,
          source,
          credential: gitCredentialOf(input.credential),
        }),
        'clone',
      );
      commitSha = cloned.commitSha;
      await progress.recordCommitSha(cloned.commitSha);

      // build
      await advance('BUILDING');
      image = await check(await buildImage(context('build'), { workspace, source, serviceId, deploymentId }), 'build');
      ledger = recordResource(ledger, { kind: 'image_created' });
    } else {
      // An image source has nothing to prepare beyond the workspace the pull creates.
      await advance('BUILDING');
      ledger = recordResource(ledger, { kind: 'workspace_created' });
      const registry = input.credential.kind === 'registry' ? input.credential.registry : null;
      image = await check(await pullImage(context('build'), { workspace, image: source.imageRef, registry }), 'pull');
    }

    // deploy
    await advance('DEPLOYING');
    const ps = await check(await listManagedContainers(context(null)), null);
    if (ps.kind !== 'ok') failed('DOCKER_UNAVAILABLE', DEPLOY_MESSAGES.DOCKER_PS_UNREADABLE);
    const preflight = preflightPublishedPort({
      serviceId,
      publishedPort: input.publishedPort,
      otherServices: input.otherServices,
      panelPorts: input.panelPorts,
      containers: ps.containers,
    });
    if (!preflight.ok) failed('PORT_IN_USE', portMessage(preflight));
    const previous = ps.containers.find((observed) => observed.name === ledger.names.container) ?? null;

    const network = await ensureNetwork(context(null), { serviceId });
    await check(network, null);
    if (network.ok && network.result.exitCode === 0) ledger = recordResource(ledger, { kind: 'network_created' });

    cancellable = false;
    if (previous !== null) {
      containerTouched = true;
      await check(await stopContainer(context('deploy'), { serviceId, timeoutSeconds: limits.stopTimeoutSeconds }), null);
      await check(await removeContainer(context('deploy'), { serviceId }), null);
    }
    containerTouched = true;
    await check(
      await createContainer(context('deploy'), {
        serviceId,
        deploymentId,
        image,
        internalPort: input.internalPort,
        publishedPort: input.publishedPort,
      }),
      null,
    );
    containerCreated = true;
    ledger = recordResource(ledger, { kind: 'container_created' });
    await check(await startContainer(context('deploy'), { serviceId }), null);

    // verify
    await progress.enterVerify();
    let { delayMs, state } = startPostStartPolls(input.pollPolicy);
    for (;;) {
      await clock.sleep(delayMs);
      const step = decidePostStartPoll(input.pollPolicy, state, await observe());
      state = step.state;
      const { decision } = step;
      if (decision.kind === 'success') break;
      if (decision.kind === 'start_failed') {
        container =
          decision.reason === 'missing' ? { kind: 'absent' } : { kind: 'stopped', exitCode: decision.exitCode };
        failed('START_FAILED', startFailedMessage(decision.reason, decision.exitCode, decision.oomKilled));
      }
      delayMs = decision.delayMs;
    }
    container = { kind: 'running' };
    // Only now is the superseded image no longer the service's last good one.
    if (previous !== null) {
      ledger = recordResource(ledger, { kind: 'previous_container_removed', imageRef: previous.image });
    }
  };

  let end: End | null = null;
  try {
    await pipeline();
  } catch (error) {
    end =
      error instanceof DeployStop
        ? error.end
        : { status: 'FAILED', code: 'WORKER_CRASHED', message: DEPLOY_MESSAGES.WORKER_CRASHED };
    // The pipeline closure assigns these; TS narrows them to their initial values here.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (container === null && containerTouched) {
      const unreachable = end.status === 'FAILED' && (end.code === 'SERVER_UNREACHABLE' || end.code === 'DOCKER_UNAVAILABLE');
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      container = unreachable ? { kind: 'unknown' } : containerCreated ? { kind: 'stopped', exitCode: null } : { kind: 'absent' };
    }
  }

  // Cleanup runs on every exit; it never throws (the outcome is already decided).
  let cleanup: CleanupReport[] = [];
  try {
    cleanup = await runLedgerCleanup(session, limits, workspace, ledger, exitFor(end));
  } finally {
    secrets.forEach((raw) => {
      redactor.release(raw);
    });
  }

  if (end === null) {
    return { status: 'SUCCESS', errorCode: null, errorMessage: null, commitSha, container, cleanup };
  }
  if (end.status === 'CANCELLED') {
    return { status: 'CANCELLED', errorCode: null, errorMessage: null, commitSha, container, cleanup };
  }
  return {
    status: 'FAILED',
    errorCode: end.code,
    errorMessage: redactor.redact(end.message),
    commitSha,
    container,
    cleanup,
    ...(end.warning === undefined ? {} : { warning: end.warning }),
  };
}

function cleanupCommand(resource: CleanupResource, workspace: DeployWorkspace, ledger: ResourceLedger): RemoteCommand | null {
  switch (resource.kind) {
    case 'workspace':
      return removeDeployDir(workspace);
    case 'image':
      if (resource.ref === ledger.names.image) return dockerImageRemove(ledger.names.image);
      if (ledger.replacedImage !== null && resource.ref === ledger.replacedImage) {
        return dockerImageRemove(ledger.replacedImage);
      }
      return null;
    case 'network':
      return dockerNetworkRemove(ledger.names.network);
    case 'secrets_file':
      // Secrets live under the workspace; its removal takes them.
      return null;
  }
}

/** Runs the ledger's cleanup set for `exit`; every removal is bounded and never forced. Never
 *  throws. Also used by the worker-crash sweep (12-13 A4). */
export async function runLedgerCleanup(
  session: SshDeploySession,
  limits: Pick<DeployRunLimits, 'cleanupStepMs' | 'maxLineBytes'>,
  workspace: DeployWorkspace,
  ledger: ResourceLedger,
  exit: DeploymentExit,
): Promise<CleanupReport[]> {
  const reports: CleanupReport[] = [];
  for (const resource of cleanupSetFor(ledger, exit)) {
    const command = cleanupCommand(resource, workspace, ledger);
    if (command === null) continue;
    let outcome: CleanupOutcome;
    try {
      const result = await session.stream(command, {
        maxDurationMs: limits.cleanupStepMs,
        idleTimeoutMs: limits.cleanupStepMs,
        maxTotalBytes: CLEANUP_MAX_TOTAL_BYTES,
        maxLineBytes: limits.maxLineBytes,
        onChunk: () => {
          // Cleanup output is classified from the tails, never logged.
        },
      });
      outcome =
        result.outcome !== 'completed' || result.exitCode === null
          ? 'failed'
          : classifyCleanupOutcome(resource, {
              exitCode: result.exitCode,
              stdout: result.stdoutTail,
              stderr: result.stderrTail,
            });
    } catch {
      outcome = 'failed';
    }
    reports.push({ resource: resource.kind, outcome });
  }
  return reports;
}
