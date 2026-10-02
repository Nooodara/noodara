// Docker operations (11-15, D26, ADR 0008 G1/G4): each wrapper runs one allowlisted template
// through SshDeploySession.stream and classifies a failure with classifyDockerError. Names come
// from the service and deployment ids (D11/D12); no wrapper takes build args or env vars (D13).
// Registry credentials reach the server only on stdin, into the per-deployment --config dir.
import {
  parseContainerState,
  parseDockerPsOutput,
  type ContainerStateResult,
  type DockerPsResult,
} from '@noodara/domain/deployment';
import type { Redactor, SecretValue } from '@noodara/domain/security';
import {
  containerNameFor,
  deploymentImageRefFor,
  networkNameFor,
  resolveRepoBuildPaths,
  type ContainerName,
  type ContainerPort,
  type DeployWorkspace,
  type ImageRef,
  type NetworkName,
  type RegistryHost,
  type RegistryUsername,
  type ResourceId,
  type ServiceSource,
  type ValidationResult,
} from '@noodara/domain/validators';
import {
  classifyDockerError,
  dockerBuild,
  dockerCreate,
  dockerImageRemove,
  dockerInspectState,
  dockerLogin,
  dockerLogout,
  dockerNetworkCreate,
  dockerNetworkRemove,
  dockerPs,
  dockerPull,
  dockerRemove,
  dockerRestart,
  dockerStart,
  dockerStop,
  prepareWorkspace,
  removeDeployDir,
  supervise,
  type RemoteCommand,
  type SshDeploySession,
  type StreamChunk,
  type StreamResult,
} from '@noodara/ssh';
import { notCompleted, registerSecrets, runStep, type StepContext, type StepOutcome } from './run-step.js';
import type { StepLimits, StepResult } from './step-result.js';

export interface DockerStepContext {
  readonly session: SshDeploySession;
  /** The redactor the session was connected with; failure messages are redacted with it. */
  readonly redactor: Redactor;
  readonly limits: StepLimits;
  readonly signal?: AbortSignal;
  /** Redacted output of every step, for the deployment log. */
  readonly onChunk?: (chunk: StreamChunk) => void;
}

/** The decrypted registry credential; the password is a SecretValue, never a bare string. */
export interface RegistryCredential {
  readonly host: RegistryHost;
  readonly username: RegistryUsername;
  readonly password: SecretValue;
}

export interface PullImageInput {
  readonly workspace: DeployWorkspace;
  readonly image: ImageRef;
  /** `null` for a public image: no login and no --config. */
  readonly registry: RegistryCredential | null;
}

export interface BuildImageInput {
  /** Already cloned by @noodara/git's cloneRepository. */
  readonly workspace: DeployWorkspace;
  readonly source: Extract<ServiceSource, { kind: 'git' }>;
  readonly serviceId: ResourceId;
  readonly deploymentId: ResourceId;
}

export interface CreateContainerInput {
  readonly serviceId: ResourceId;
  readonly deploymentId: ResourceId;
  readonly image: ImageRef;
  readonly internalPort: ContainerPort;
  /** `null` publishes nothing. */
  readonly publishedPort: ContainerPort | null;
}

export interface ServiceRef {
  readonly serviceId: ResourceId;
}

export interface StopContainerInput extends ServiceRef {
  /** 0-300; the builder rejects anything else. */
  readonly timeoutSeconds: number;
}

type DockerOperation = Parameters<typeof classifyDockerError>[0]['operation'];
type Completed = Extract<StepOutcome, { kind: 'completed' }>;

// `docker network create` on an existing name (Docker 24-29 daemon wording).
const NETWORK_EXISTS_PATTERN = /network with name \S+ already exists/;

/** `withSignal: false` for cleanup that must run even after the caller aborted. */
function stepContext(context: DockerStepContext, withSignal = true): StepContext {
  return {
    session: context.session,
    limits: context.limits,
    ...(withSignal && context.signal !== undefined ? { signal: context.signal } : {}),
    ...(context.onChunk === undefined ? {} : { onChunk: context.onChunk }),
  };
}

function classify(
  context: DockerStepContext,
  operation: DockerOperation,
  result: StreamResult,
): StepResult<never> {
  const classification = classifyDockerError(
    {
      operation,
      failure: { exitCode: result.exitCode, stderr: result.stderrTail, stdoutTail: result.stdoutTail },
    },
    { redactor: context.redactor },
  );
  return { ok: false, kind: 'failed', ...classification };
}

/** Branded ids always validate; a failure here is a caller bug, not a remote failure. */
function derived<T>(result: ValidationResult<T>): T {
  if (!result.ok) throw new TypeError('Invalid resource id for a Docker name');
  return result.value;
}

/** One command: run it, classify a non-zero exit, otherwise return `value`. */
async function single<T>(
  context: DockerStepContext,
  operation: DockerOperation,
  command: RemoteCommand,
  value: T,
): Promise<StepResult<T>> {
  const outcome = await runStep(stepContext(context), command);
  if (outcome.kind !== 'completed') return notCompleted(outcome);
  if (outcome.result.exitCode !== 0) return classify(context, operation, outcome.result);
  return done(value, outcome.result);
}

/** One command whose completed output `read` turns into the result (parsed or classified). */
async function observe<T>(
  context: DockerStepContext,
  command: RemoteCommand,
  read: (outcome: Completed) => StepResult<T>,
): Promise<StepResult<T>> {
  const outcome = await runStep(stepContext(context), command);
  if (outcome.kind !== 'completed') return notCompleted(outcome);
  return read(outcome);
}

function done<T>(value: T, result: StreamResult): StepResult<T> {
  return { ok: true, value, result };
}

/**
 * Prepares the workspace (the supervised pull writes its pidfile there), then pulls under
 * process.supervise. With a credential: login over stdin into workspace.dockerConfigDir, pull with
 * that --config, and log out once the login succeeded, even after a failed or interrupted pull.
 */
export async function pullImage(
  context: DockerStepContext,
  input: PullImageInput,
): Promise<StepResult<ImageRef>> {
  const { workspace, image, registry } = input;
  const release = registerSecrets(context.redactor, registry === null ? [] : [registry.password]);
  try {
    const prepared = await runStep(stepContext(context), prepareWorkspace(workspace));
    if (prepared.kind !== 'completed') return notCompleted(prepared);
    if (prepared.result.exitCode !== 0) return classify(context, 'pull', prepared.result);

    if (registry === null) {
      const pull = supervise(workspace.pidFile('pull'), dockerPull({ config: null, image }));
      return await single(context, 'pull', pull, image);
    }

    const config = workspace.dockerConfigDir;
    const login = await runStep(
      stepContext(context),
      dockerLogin({ config, host: registry.host, username: registry.username }),
      registry.password,
    );
    if (login.kind === 'transport') return notCompleted(login);
    if (login.kind === 'completed' && login.result.exitCode !== 0) {
      return classify(context, 'login', login.result);
    }

    let pulled: StepResult<ImageRef>;
    if (login.kind === 'interrupted') {
      pulled = notCompleted(login);
    } else {
      const pull = supervise(workspace.pidFile('pull'), dockerPull({ config, image }));
      pulled = await single(context, 'pull', pull, image);
    }
    // Cleanup, so the caller's signal is not passed: an aborted pull must still log out. A
    // failed logout leaves the credential in the workspace, which removeWorkspace deletes.
    await runStep(stepContext(context, false), dockerLogout({ config, host: registry.host }));
    return pulled;
  } finally {
    release();
  }
}

/** Builds `noodara/<serviceId>:<deploymentId>` from the cloned repo under process.supervise. */
export async function buildImage(
  context: DockerStepContext,
  input: BuildImageInput,
): Promise<StepResult<ImageRef>> {
  const { workspace, source, serviceId, deploymentId } = input;
  const image = derived(deploymentImageRefFor(serviceId, deploymentId));
  const { contextPath, dockerfilePath } = resolveRepoBuildPaths(
    workspace.repo,
    source.buildContext,
    source.dockerfilePath,
  );
  const build = dockerBuild({
    contextPath,
    dockerfilePath,
    image,
    target: source.target,
    serviceId,
    deploymentId,
  });
  return single(context, 'build', supervise(workspace.pidFile('build'), build), image);
}

/** Creates the service network; an existing one is success (redeploys reuse it). */
export async function ensureNetwork(
  context: DockerStepContext,
  input: ServiceRef,
): Promise<StepResult<NetworkName>> {
  const network = derived(networkNameFor(input.serviceId));
  return observe(context, dockerNetworkCreate({ network, serviceId: input.serviceId }), ({ result }) => {
    if (result.exitCode === 0 || NETWORK_EXISTS_PATTERN.test(result.stderrTail)) {
      return done(network, result);
    }
    return classify(context, 'network', result);
  });
}

export function removeNetwork(
  context: DockerStepContext,
  input: ServiceRef,
): Promise<StepResult<NetworkName>> {
  const network = derived(networkNameFor(input.serviceId));
  return single(context, 'network', dockerNetworkRemove(network), network);
}

export function createContainer(
  context: DockerStepContext,
  input: CreateContainerInput,
): Promise<StepResult<ContainerName>> {
  const container = derived(containerNameFor(input.serviceId));
  const command = dockerCreate({
    container,
    network: derived(networkNameFor(input.serviceId)),
    image: input.image,
    internalPort: input.internalPort,
    publishedPort: input.publishedPort,
    serviceId: input.serviceId,
    deploymentId: input.deploymentId,
  });
  return single(context, 'create', command, container);
}

export function startContainer(
  context: DockerStepContext,
  input: ServiceRef,
): Promise<StepResult<ContainerName>> {
  const container = derived(containerNameFor(input.serviceId));
  return single(context, 'start', dockerStart(container), container);
}

export function stopContainer(
  context: DockerStepContext,
  input: StopContainerInput,
): Promise<StepResult<ContainerName>> {
  const container = derived(containerNameFor(input.serviceId));
  const command = dockerStop({ container, timeoutSeconds: input.timeoutSeconds });
  return single(context, 'stop', command, container);
}

/** A restart failure is a start failure (classifier operation `start`). */
export function restartContainer(
  context: DockerStepContext,
  input: StopContainerInput,
): Promise<StepResult<ContainerName>> {
  const container = derived(containerNameFor(input.serviceId));
  const command = dockerRestart({ container, timeoutSeconds: input.timeoutSeconds });
  return single(context, 'start', command, container);
}

export function removeContainer(
  context: DockerStepContext,
  input: ServiceRef,
): Promise<StepResult<ContainerName>> {
  const container = derived(containerNameFor(input.serviceId));
  return single(context, 'remove', dockerRemove(container), container);
}

export function removeImage(
  context: DockerStepContext,
  input: { readonly image: ImageRef },
): Promise<StepResult<ImageRef>> {
  return single(context, 'remove', dockerImageRemove(input.image), input.image);
}

/** G4: state detail from inspect. Truncated output is reported unparseable, never guessed. */
export function inspectContainerState(
  context: DockerStepContext,
  input: ServiceRef,
): Promise<StepResult<ContainerStateResult>> {
  const container = derived(containerNameFor(input.serviceId));
  return observe(context, dockerInspectState(container), ({ result, stdout }) => {
    if (result.exitCode !== 0) return classify(context, 'inspect', result);
    const state: ContainerStateResult = result.truncated
      ? { kind: 'unparseable', reason: 'Inspect output was truncated' }
      : parseContainerState(stdout);
    return done(state, result);
  });
}

/** The parser owns exit-code handling (daemon_unreachable); a missing exit code is unparseable. */
export function listManagedContainers(context: DockerStepContext): Promise<StepResult<DockerPsResult>> {
  return observe(context, dockerPs(), ({ result, stdout }) => {
    let containers: DockerPsResult;
    if (result.exitCode === null) {
      containers = { kind: 'unparseable', reason: 'docker ps ended without an exit code' };
    } else if (result.truncated) {
      containers = { kind: 'unparseable', reason: 'docker ps output was truncated' };
    } else {
      containers = parseDockerPsOutput({ stdout, stderr: result.stderrTail, exitCode: result.exitCode });
    }
    return done(containers, result);
  });
}

/** Deletes the deployment directory, including secrets and the registry --config dir. */
export function removeWorkspace(
  context: DockerStepContext,
  input: { readonly workspace: DeployWorkspace },
): Promise<StepResult<DeployWorkspace>> {
  return single(context, 'remove', removeDeployDir(input.workspace), input.workspace);
}
