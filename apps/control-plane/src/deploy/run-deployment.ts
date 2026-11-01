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
// - 14-07: a non-bundled SSH Git host is pinned per service (TOFU): the stored key pins later
//   clones, the first scan is stored with a conditional write, a concurrent loser verifies against
//   the winner, and a changed key fails GIT_HOST_KEY_MISMATCH; nothing replaces a pin but the CLI.
// - 17-02 (ADR 0010): the previous container is stopped and kept as `noodara-<serviceId>-prev`
//   (not removed) and removed only after the new one passes its healthcheck. If the new container
//   cannot be created or started, `-prev` is restored right away (H2). The HEALTHCHECK step follows
//   the service's config through `decideHealthcheck`; no config keeps the v0.2 post-start polls.
//   A failed healthcheck keeps `-prev` stopped for the rollback (17-03).
// - 17-07: a DEPLOYING or HEALTHCHECK failure with a kept `-prev` and auto_rollback on enters
//   ROLLING_BACK: the new container is removed, `-prev` restored and checked with the previous
//   deployment's snapshot inside its own budget (reserved out of NOODARA_DEPLOY_MAX_MS). Pass ends
//   ROLLED_BACK with the original code; anything else ends FAILED/ROLLBACK_FAILED. One attempt,
//   never retried. Without a rollback the new container is stopped and `-prev` kept (A3).
// - 22-05: a service with domains has `routes`. Before the swap the proxy joins the service network
//   (idempotent; a proxy that is not running only gets a log line, never a failed deploy). The
//   dynamic file routes to the container name, so replace and every rollback need no rewrite; only
//   a passed attempt whose port differs from the live file's re-applies through apply-routes (H2).
import {
  cleanupSetFor,
  classifyCleanupOutcome,
  createResourceLedger,
  decideHealthcheck,
  decidePostStartPoll,
  DEFAULT_CONTAINER_HEALTHCHECK,
  healthcheckPolicy,
  preflightPublishedPort,
  recordResource,
  resolveHealthcheck,
  startPostStartPolls,
  transitionDeployment,
  V03_DEPLOYMENT_ERROR_MESSAGES,
  V04_DEPLOYMENT_ERROR_MESSAGES,
  type CleanupOutcome,
  type CleanupResource,
  type ContainerObservation,
  type DeploymentErrorCode,
  type DeploymentExit,
  type DeploymentLogPhase,
  type DeploymentStatus,
  type HealthcheckConfig,
  type HealthcheckObservation,
  type ObservedContainer,
  type PortPreflightResult,
  type PostStartObservation,
  type PostStartPollPolicy,
  type ResourceLedger,
  type RuntimeConfigSnapshot,
  type RuntimeEnvEntry,
} from '@noodara/domain/deployment';
import { revealSecret, secretValue, type Redactor, type SecretValue } from '@noodara/domain/security';
import {
  bundledGitHostKeysFor,
  deployWorkspaceFor,
  gitSshEndpoint,
  sameKnownHostsHost,
  validateContainerPort,
  validateImageRef,
  type CommitSha,
  type ContainerPort,
  type DeploySecretPath,
  type DeployWorkspace,
  type GitHostKey,
  type GitSshEndpoint,
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
  inspectImagePresent,
  listManagedContainers,
  probeContainerHealth,
  pullImage,
  removeContainer,
  removePrevious,
  renameToPrevious,
  restorePrevious,
  startContainer,
  stopContainer,
  stopPrevious,
  type DockerStepContext,
  type RegistryCredential,
  type StepLimits,
  type StepResult,
} from '@noodara/docker';
import { cloneRepository, type GitCredential } from '@noodara/git';
import { proxyDynamicPathFor, renderEnvFile, utf8ByteLength, type EnvFileEntry } from '@noodara/domain';
import {
  dockerImageRemove,
  dockerNetworkRemove,
  envFileFor,
  killSupervisedOperation,
  parseProxyDynamicPort,
  prepareWorkspace,
  previousContainerNameFor,
  proxyNetworkConnect,
  proxyReadDynamic,
  removeDeployDir,
  removeSecretFile,
  writeEnvFile,
  type RemoteCommand,
  type SshDeploySession,
  type StreamChunk,
} from '@noodara/ssh';
import { SecretStoreError } from '../secrets/secret-store.js';
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
  /** 17-07: the automatic rollback's budget, reserved inside deployMaxMs (capped at a quarter). */
  readonly rollbackMaxMs?: number;
}

export const DEFAULT_ROLLBACK_MAX_MS = 120_000;

/** 17-07 (A4): the rollback's own budget; always inside deployMaxMs, never more than a quarter. */
export function rollbackBudgetMs(limits: Pick<DeployRunLimits, 'deployMaxMs' | 'rollbackMaxMs'>): number {
  const wanted = limits.rollbackMaxMs ?? DEFAULT_ROLLBACK_MAX_MS;
  return Math.max(0, Math.min(wanted, Math.floor(limits.deployMaxMs / 4)));
}

/** 17-03: the service's latest SUCCESS deployment other than the one being run. `runtimeConfig`
 *  is null when its stored snapshot does not validate (it cannot be checked from it). */
export interface PreviousSuccessDeployment {
  readonly id: ResourceId;
  readonly runtimeConfig: RuntimeConfigSnapshot | null;
}

/** 17-02 (A3): written in the same UPDATE as the edge that carries it. */
export interface AdvanceRecord {
  readonly runtimeConfig?: RuntimeConfigSnapshot;
}

/** Persists each status edge as it happens (the store, in production). */
export interface DeploymentProgress {
  /** 16-02: DEPLOYING -> HEALTHCHECK is the verify step boundary (the post-start polls begin).
   *  17-02: that edge also stamps healthcheck_started_at; BUILDING -> DEPLOYING carries the
   *  runtime config snapshot and image_ref. */
  advance(from: DeploymentStatus, to: DeploymentStatus, record?: AdvanceRecord): Promise<void>;
  recordCommitSha(sha: CommitSha): Promise<void>;
  /** 23-04 A4: the configure step (counts and bounds only; never a key, a name or a value). */
  recordConfigure?(step: ConfigureStepRecord): Promise<void>;
}

export interface ConfigureStepRecord {
  readonly variables: number;
  readonly secrets: number;
  readonly startedAt: Date;
  readonly completedAt: Date;
}

export type DeployCredential = GitCredential | { readonly kind: 'registry'; readonly registry: RegistryCredential };

/** 14-07: the keys pinned for a service's Git host (`host` is the known_hosts host). */
export interface PinnedGitHostKeys {
  readonly host: string;
  readonly keys: readonly GitHostKey[];
}

export type GitHostKeyPinResult =
  | { readonly kind: 'stored' }
  /** Another attempt pinned this host first; the caller verifies against it, never overwrites. */
  | { readonly kind: 'existing'; readonly pinned: PinnedGitHostKeys }
  /** The service row is gone (deleted mid-deploy). */
  | { readonly kind: 'missing' };

/** The per-service TOFU store of a non-bundled Git host's SSH host keys (the database, in production). */
export interface GitHostKeyStore {
  load(serviceId: string): Promise<PinnedGitHostKeys | null>;
  /** Stores `pinned` only if the service has no key for that host (one atomic, conditional write). */
  pin(serviceId: string, pinned: PinnedGitHostKeys): Promise<GitHostKeyPinResult>;
}

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
  /** 14-07: absent, a non-bundled SSH host is keyscanned on every deploy (nothing is pinned). */
  readonly gitHostKeys?: GitHostKeyStore;
  /** 17-02: the service's healthcheck; null or absent keeps the v0.2 post-start polls. */
  readonly healthcheck?: HealthcheckConfig | null;
  /** 17-07: services.autoRollback; absent = no automatic rollback. */
  readonly autoRollback?: boolean;
  /** 17-07: whose snapshot checks the restored `-prev`; null or absent = the container check. */
  readonly previousSuccess?: PreviousSuccessDeployment | null;
  /** 17-07 (A4): records the `deployment.rollback_started` event; a failure never stops the rollback. */
  readonly recordRollbackStarted?: (targetDeploymentId: ResourceId | null) => Promise<void>;
  /** 17-05: a manual rollback re-runs this retained deployment (no clone, no build) with its
   *  snapshot; a failure always rolls back to the version that ran before. */
  readonly rollbackTarget?: ManualRollbackTarget;
  /** 18-03: the exact commit to deploy (webhook push); null or absent = the branch head (v0.2). */
  readonly requestedSha?: CommitSha | null;
  /** 22-05: present only when the service has domains; absent = no proxy command at all. */
  readonly routes?: DeployRoutes;
  /** 23-04: the resolved env; absent keeps the v0.3 behaviour (no env file, v1 snapshot). */
  readonly env?: DeployEnv;
}

/** 22-05: what a deploy needs to keep a routed service reachable through the proxy. */
export interface DeployRoutes {
  /** The server's proxy is RUNNING; otherwise the deploy only logs and the domains stay pending. */
  readonly proxyRunning: boolean;
  /** H2: re-applies the service's routes on this session with this port, under the route lock. */
  readonly reapply: (session: SshDeploySession, internalPort: number) => Promise<{ readonly ok: boolean }>;
}

/** 23-04: one attempt's decrypted secrets by env key; `release` is idempotent. */
export interface DeployEnvLease {
  readonly secrets: ReadonlyMap<string, SecretValue>;
  release(): void;
}

/** 23-04: the resolved env of a deploy, loaded in PREPARING; values are decrypted only by `open`. */
export interface DeployEnv {
  /** Key-sorted plain values and pinned references: the v2 snapshot env, never a secret value. */
  readonly entries: readonly RuntimeEnvEntry[];
  /** Decrypts the referenced secrets and registers them in `redactor` (app_secret). */
  open(redactor: Redactor): Promise<DeployEnvLease>;
}

/** 17-05: the deployment a manual rollback restores, and the runtime config it ran with. */
export interface ManualRollbackTarget {
  readonly id: ResourceId;
  readonly runtimeConfig: RuntimeConfigSnapshot;
}

export interface CleanupReport {
  readonly resource: CleanupResource['kind'];
  readonly outcome: CleanupOutcome;
}

export interface DeploymentOutcome {
  /** ROLLED_BACK (17-07): the attempt failed and the previous version was restored and checked. */
  readonly status: 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'ROLLED_BACK';
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

/** 23-04 A4: the configure line; counts only. */
export function configureSummary(variables: number, secrets: number): string {
  const v = `${String(variables)} variable${variables === 1 ? '' : 's'}`;
  const r = `${String(secrets)} secret${secrets === 1 ? '' : 's'}`;
  return `Configuring environment: ${v}, ${r}.`;
}

export const ENV_FILE_NOT_REMOVED_LOG =
  'The environment file could not be removed after the container was created; it is removed with the workspace.';
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
  // 17-06 A2: the crash sweep of a HEALTHCHECK or ROLLING_BACK row says what it did on the server.
  WORKER_CRASHED_RESTORED:
    'The deploy worker stopped during the healthcheck or rollback. The previous version was restored; redeploy when ready.',
  WORKER_CRASHED_NO_PREVIOUS:
    'The deploy worker stopped during the healthcheck or rollback. There was no previous version to restore, so the service container was left as it is. Check it, then redeploy.',
  WORKER_CRASHED_NOT_RESTORED:
    'The deploy worker stopped during the healthcheck or rollback, and the previous version could not be restored. Check the containers on the server, then redeploy.',
});

/** H3: names the fix, never a key blob (an operator compares fingerprints out of band). */
export function gitHostKeyMismatchMessage(serviceId: string): string {
  return `The Git host's SSH host key does not match the key pinned for this service, so the deployment was stopped. Verify the host's key fingerprint with its operator; if the change is expected, run "noodara services reset-host-key ${serviceId}" and redeploy.`;
}

const PINNED_ON_FIRST_USE_LOG =
  "Trusted the Git host's SSH host key on first use and pinned it for this service.";

// H3: an OpenSSH public key blob (keyscan output, ssh diagnostics) never reaches the deployment log.
const HOST_KEY_BLOB_PATTERN = /\b(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa)(\s+)AAAA[A-Za-z0-9+/]+={0,2}/g;

function scrubHostKeyBlobs(text: string): string {
  return text.replace(HOST_KEY_BLOB_PATTERN, '$1$2[host key]');
}

/** The SSH endpoint a clone pins per service: an ssh URL whose host has no bundled published key. */
function tofuEndpoint(source: ServiceSource): GitSshEndpoint | null {
  if (source.kind !== 'git') return null;
  const endpoint = gitSshEndpoint(source.repositoryUrl);
  if (endpoint === null || bundledGitHostKeysFor(endpoint).length > 0) return null;
  return endpoint;
}

/** H1: the loser accepts only keys the winner pinned (a superset scan could smuggle one in). */
function agreesWith(pinned: PinnedGitHostKeys, endpoint: GitSshEndpoint, scanned: readonly GitHostKey[]): boolean {
  if (!sameKnownHostsHost(pinned.host, endpoint.knownHostsHost) || scanned.length === 0) return false;
  return scanned.every((key) => pinned.keys.some((stored) => stored.type === key.type && stored.key === key.key));
}

const CLEANUP_MAX_TOTAL_BYTES = 65_536;

interface FailedEnd {
  readonly status: 'FAILED';
  readonly code: DeploymentErrorCode;
  readonly message: string;
  readonly warning?: DeploymentWarning;
}

type End =
  | FailedEnd
  | { readonly status: 'ROLLED_BACK'; readonly code: DeploymentErrorCode; readonly message: string }
  | { readonly status: 'CANCELLED' };

/** H2: only a failure after the swap began may roll back; never a cancel or a BUILDING timeout. */
const ROLLBACK_SOURCE_STATUSES: readonly DeploymentStatus[] = ['DEPLOYING', 'HEALTHCHECK'];

function rolledBackMessage(original: string, target: PreviousSuccessDeployment | null): string {
  const version = target === null ? 'The previous version' : `The previous version (deployment ${target.id})`;
  return `${original} ${version} was restored automatically.`;
}

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

/** A fixed line per observation: never probe output, IPs or container names (A2). */
function healthcheckLine(attempt: number, observation: HealthcheckObservation): string {
  const prefix = `Healthcheck attempt ${String(attempt)}:`;
  switch (observation.kind) {
    case 'http':
      return `${prefix} HTTP ${String(observation.status)}`;
    case 'open':
      return `${prefix} port open`;
    case 'running':
      return `${prefix} container running`;
    case 'refused':
      return `${prefix} connection refused`;
    case 'timeout':
      return `${prefix} no answer before the probe timeout`;
    case 'exited':
      return `${prefix} the container is not running`;
    case 'empty':
    case 'malformed':
    case 'error':
      return `${prefix} no valid answer`;
  }
}

const HEALTHCHECK_PASSED_LOG = 'Healthcheck passed.';
const PREVIOUS_RESTORED_LOG = 'The new container could not start, so the previous version was restored.';
const PREVIOUS_NOT_RESTORED_LOG = 'The new container could not start and the previous version could not be restored.';
const CURRENT_RESTARTED_LOG = 'The running version could not be replaced, so it was started again.';
const PREVIOUS_NOT_REMOVED_LOG = 'The previous container could not be removed after the healthcheck passed; it stays stopped.';
const ROLLBACK_STARTED_LOG = 'Rolling back: restoring the previous version.';
const ROLLBACK_PASSED_LOG = 'The previous version was restored and passed its healthcheck.';
const ROLLBACK_FAILED_LOG = 'The previous version could not be restored.';
const NEW_STOPPED_LOG = 'The new container was stopped; the previous version is kept for a manual rollback.';
const CANCEL_RESTORED_LOG = 'The deployment was cancelled during the healthcheck, so the previous version was restored.';
const CANCEL_NOT_RESTORED_LOG = 'The deployment was cancelled during the healthcheck and the previous version could not be restored.';
const CANCEL_STOPPED_LOG = 'The deployment was cancelled during the healthcheck, so the new container was stopped.';
/** 22-05: the proxy lines of a routed service's deploy (never remote output). */
export const ROUTE_LOGS = Object.freeze({
  PROXY_NOT_RUNNING: 'The proxy is not running on this server; the domains stay pending until it is.',
  PROXY_NOT_JOINED: 'The proxy could not join the service network; the domains may not answer until the next domain apply.',
  REAPPLIED: 'The service port changed, so the domain routes were re-applied.',
  NOT_REAPPLIED: 'The service port changed but the domain routes could not be re-applied; the next domain apply retries.',
});
const PROXY_ALREADY_JOINED = /already exists|already attached|endpoint with name .* already/i;

function exitFor(end: End | null): DeploymentExit {
  if (end === null) return 'SUCCESS';
  if (end.status === 'ROLLED_BACK') return 'FAILED';
  if (end.status === 'CANCELLED' || end.warning !== undefined) return 'CANCELLED';
  return end.code === 'BUILD_TIMEOUT' || end.code === 'BUILD_STALLED' ? 'TIMEOUT' : 'FAILED';
}

/** Branded ids always produce a ledger and a workspace; a failure is a caller bug. */
/** 17-05: the snapshot's values as validated names; null when any of them does not validate. */
function manualRuntimeOf(
  snapshot: RuntimeConfigSnapshot,
): { readonly image: ImageRef; readonly internalPort: ContainerPort; readonly publishedPort: ContainerPort | null } | null {
  const image = validateImageRef(snapshot.imageRef);
  const internalPort = validateContainerPort(snapshot.internalPort);
  const publishedPort = snapshot.publishedPort === null ? null : validateContainerPort(snapshot.publishedPort);
  if (!image.ok || !internalPort.ok || (publishedPort !== null && !publishedPort.ok)) return null;
  return { image: image.value, internalPort: internalPort.value, publishedPort: publishedPort === null ? null : publishedPort.value };
}

function derive<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new TypeError('Invalid resource id for a deployment');
  return result.value;
}

export async function runDeployment(input: RunDeploymentInput): Promise<DeploymentOutcome> {
  const { session, redactor, serviceId, deploymentId, limits, clock, progress } = input;
  const startedAt = clock.now();
  const manual = input.rollbackTarget ?? null;
  // 17-05 A3: a manual rollback always restores the version it replaces when it fails.
  const autoRollback = input.autoRollback === true || manual !== null;
  const manualRuntime = manual === null ? null : manualRuntimeOf(manual.runtimeConfig);
  const internalPort = manualRuntime === null ? input.internalPort : manualRuntime.internalPort;
  const publishedPort = manualRuntime === null ? input.publishedPort : manualRuntime.publishedPort;
  const rollbackBudget = autoRollback ? rollbackBudgetMs(limits) : 0;
  // A4: with auto_rollback the main steps leave the rollback budget free inside deployMaxMs.
  let deadline = startedAt + limits.deployMaxMs - rollbackBudget;
  const workspace: DeployWorkspace = derive(deployWorkspaceFor(deploymentId));
  let ledger: ResourceLedger = derive(createResourceLedger(serviceId, deploymentId));
  let status: DeploymentStatus = 'PREPARING';
  let commitSha: CommitSha | null = null;
  let container: ContainerObservation | null = null;
  let containerTouched = false;
  let containerCreated = false;
  // The container kept as `-prev`: the restore target until the new one passes its healthcheck.
  let kept: ObservedContainer | null = null;
  // A failed swap already put `-prev` back under the service's name (17-02 H2).
  let swapRecovered = false;
  // The new container is gone from the server, so the ledger may clean its image (A5).
  let newRemoved = false;
  let seq = 0;
  // 23-04: the attempt's decrypted env secrets (held in an object so TS does not narrow it).
  const envHold: { lease: DeployEnvLease | null } = { lease: null };

  const secrets = credentialSecrets(input.credential).map((secret) => revealSecret(secret));
  const kinds = credentialSecrets(input.credential).map((secret) => secret.kind);
  secrets.forEach((raw, index) => {
    redactor.register(raw, kinds[index] ?? 'api_key');
  });

  const log = (phase: DeploymentLogPhase, stream: 'stdout' | 'stderr' | 'system', text: string): void => {
    // 20-09 F1: the sink concatenates entries as-is, so a system line carries its own newline.
    const line = stream === 'system' && !text.endsWith('\n') ? `${text}\n` : text;
    try {
      input.sink.write({ phase, stream, text: scrubHostKeyBlobs(redactor.redact(line)), seq: seq++ });
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

  // A2: a cancel seen between steps ends the attempt before the next remote command. The container
  // swap is never cancelled (a half-done swap is worse than a late cancel); HEALTHCHECK is again
  // (17-06 A1), and from the passed check or ROLLING_BACK on the attempt runs to its end (H1).
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

  const advance = async (to: DeploymentStatus, record?: AdvanceRecord): Promise<void> => {
    // 17-05: PREPARING -> DEPLOYING is an edge only a `rollback` deployment may take.
    const next = transitionDeployment(status, to, manual === null ? undefined : 'rollback');
    await (record === undefined ? progress.advance(status, next) : progress.advance(status, next, record));
    status = next;
  };

  /** H2: recovery steps run after the deadline too, bounded per command, never cancelled. */
  const recoveryContext = (): DockerStepContext => ({
    session,
    redactor,
    limits: {
      maxDurationMs: limits.cleanupStepMs,
      idleTimeoutMs: limits.cleanupStepMs,
      maxTotalBytes: CLEANUP_MAX_TOTAL_BYTES,
      maxLineBytes: limits.maxLineBytes,
    },
    onChunk: (chunk: StreamChunk) => {
      log('deploy', chunk.stream, chunk.text);
    },
  });

  /** A recovery step's outcome; it never throws (the attempt already has its end). */
  const recover = async (step: () => Promise<{ readonly ok: boolean }>): Promise<boolean> => {
    try {
      return (await step()).ok;
    } catch {
      return false;
    }
  };

  /** Runs `body`; a stop that escapes it first gets `onStop` (which never throws). */
  const guarded = async (body: () => Promise<void>, onStop: () => Promise<void>): Promise<void> => {
    try {
      await body();
    } catch (error) {
      await onStop();
      throw error;
    }
  };

  /** 22-05: a proxy command bounded like a recovery step; its output is classified, never logged. */
  const proxyStep = async (
    command: RemoteCommand,
    stdin?: SecretValue,
  ): Promise<{ readonly ok: boolean; readonly stdout: string; readonly stderr: string }> => {
    try {
      const result = await session.stream(command, {
        ...(stdin === undefined ? {} : { stdin }),
        maxDurationMs: limits.cleanupStepMs,
        idleTimeoutMs: limits.cleanupStepMs,
        maxTotalBytes: CLEANUP_MAX_TOTAL_BYTES,
        maxLineBytes: limits.maxLineBytes,
        onChunk: () => undefined,
      });
      return { ok: result.outcome === 'completed' && result.exitCode === 0, stdout: result.stdoutTail, stderr: result.stderrTail };
    } catch {
      return { ok: false, stdout: '', stderr: '' };
    }
  };

  /** A1: before the swap the proxy is on the service network (idempotent); never fails the deploy. */
  const joinProxy = async (): Promise<void> => {
    const routes = input.routes;
    if (routes === undefined) return;
    if (!routes.proxyRunning) {
      log('deploy', 'system', ROUTE_LOGS.PROXY_NOT_RUNNING);
      return;
    }
    const joined = await proxyStep(proxyNetworkConnect(serviceId));
    if (joined.ok || PROXY_ALREADY_JOINED.test(joined.stderr)) {
      ledger = recordResource(ledger, { kind: 'proxy_attached' });
    } else {
      log('deploy', 'system', ROUTE_LOGS.PROXY_NOT_JOINED);
    }
  };

  /** H2: a passed attempt re-applies the routes only when the live file routes to another port. */
  const reapplyRoutesOnPortChange = async (): Promise<void> => {
    const routes = input.routes;
    if (routes?.proxyRunning !== true) return;
    const path = proxyDynamicPathFor(serviceId);
    if (!path.ok) return;
    const read = await proxyStep(proxyReadDynamic(path.value));
    if (!read.ok) return;
    const live = parseProxyDynamicPort(read.stdout);
    if (live.kind !== 'port' || live.port === internalPort) return;
    let reapplied = false;
    try {
      reapplied = (await routes.reapply(session, internalPort)).ok;
    } catch {
      reapplied = false;
    }
    log('deploy', 'system', reapplied ? ROUTE_LOGS.REAPPLIED : ROUTE_LOGS.NOT_REAPPLIED);
  };

  const probe = async (config: HealthcheckConfig): Promise<HealthcheckObservation> => {
    const result = await probeContainerHealth(context(null), { serviceId, config });
    if (result.ok || result.kind === 'interrupted') return check(result, null);
    if (result.code === 'DOCKER_UNAVAILABLE' || result.code === 'SERVER_UNREACHABLE') {
      failed(result.code, result.message);
    }
    return { kind: 'error' };
  };

  const observe = async (): Promise<PostStartObservation> => {
    const result = await inspectContainerState(context(null), { serviceId });
    if (result.ok || result.kind === 'interrupted') return check(result, null);
    if (result.code === 'DOCKER_UNAVAILABLE' || result.code === 'SERVER_UNREACHABLE') {
      failed(result.code, result.message);
    }
    return { kind: 'missing' };
  };

  /** 23-04 A1, A4: decrypts the referenced secrets (registered in the redactor) and logs the
   *  configure step with keys and reference names only. Runs first: nothing is cloned or built
   *  for an env that cannot be resolved. */
  const configureEnv = async (): Promise<void> => {
    const env = input.env;
    if (env === undefined) return;
    const configureStartedAt = new Date(clock.now());
    try {
      envHold.lease = await env.open(redactor);
    } catch (error) {
      if (!(error instanceof SecretStoreError)) throw error;
      if (error.code === 'SECRET_NOT_IN_SCOPE' || error.code === 'SECRET_NOT_FOUND') {
        failed('SECRET_UNRESOLVED', V04_DEPLOYMENT_ERROR_MESSAGES.SECRET_UNRESOLVED);
      }
      failed('ENV_INJECTION_FAILED', V04_DEPLOYMENT_ERROR_MESSAGES.ENV_INJECTION_FAILED);
    }
    const references = env.entries.filter((entry) => 'secretRef' in entry).length;
    const plain = env.entries.length - references;
    log('prepare', 'system', configureSummary(plain, references));
    for (const entry of env.entries) {
      log('prepare', 'system', 'secretRef' in entry ? `  ${entry.key} = <secret:${entry.secretRef}>` : `  ${entry.key}`);
    }
    await progress.recordConfigure?.({
      variables: plain,
      secrets: references,
      startedAt: configureStartedAt,
      completedAt: new Date(clock.now()),
    });
  };

  /** 23-04 A2, H3: renders and writes `<workspace>/secrets/env` (0600 from the first byte, byte
   *  count checked remotely). Null when the deploy has no env. Any failure is ENV_INJECTION_FAILED. */
  const writeEnv = async (): Promise<DeploySecretPath | null> => {
    const env = input.env;
    const lease = envHold.lease;
    if (env === undefined || lease === null || env.entries.length === 0) return null;
    const fileEntries: EnvFileEntry[] = [];
    for (const entry of env.entries) {
      if (!('secretRef' in entry)) {
        fileEntries.push({ key: entry.key, value: entry.value });
        continue;
      }
      const value = lease.secrets.get(entry.key);
      if (value === undefined) failed('SECRET_UNRESOLVED', V04_DEPLOYMENT_ERROR_MESSAGES.SECRET_UNRESOLVED);
      fileEntries.push({ key: entry.key, value: revealSecret(value) });
    }
    const rendered = renderEnvFile(fileEntries);
    if (!rendered.ok) failed('ENV_INJECTION_FAILED', V04_DEPLOYMENT_ERROR_MESSAGES.ENV_INJECTION_FAILED);
    if (!ledger.workspaceCreated) {
      // A manual rollback has no workspace yet: the env file still lives under one (cleaned up).
      ledger = recordResource(ledger, { kind: 'workspace_created' });
      if (!(await proxyStep(prepareWorkspace(workspace))).ok) {
        failed('ENV_INJECTION_FAILED', V04_DEPLOYMENT_ERROR_MESSAGES.ENV_INJECTION_FAILED);
      }
    }
    const path = envFileFor(workspace);
    ledger = recordResource(ledger, { kind: 'secrets_file_written', name: 'env' });
    const written = await proxyStep(
      writeEnvFile(path, utf8ByteLength(rendered.value)),
      secretValue(rendered.value, 'app_secret'),
    );
    if (!written.ok) failed('ENV_INJECTION_FAILED', V04_DEPLOYMENT_ERROR_MESSAGES.ENV_INJECTION_FAILED);
    return path;
  };

  /** 23-04 H2: the env file goes as soon as docker create returns; the workspace cleanup is the
   *  fallback when this removal fails. Never throws. */
  const removeEnv = async (path: DeploySecretPath): Promise<void> => {
    if (!(await proxyStep(removeSecretFile(path))).ok) log('deploy', 'system', ENV_FILE_NOT_REMOVED_LOG);
  };

  const pipeline = async (): Promise<void> => {
    await configureEnv();
    // prepare
    let image: ImageRef;
    const { source } = input;
    if (manual !== null) {
      // 17-05 H1: re-checked here, not only at the API; nothing is touched when it is gone.
      if (manualRuntime === null) {
        failed('ROLLBACK_TARGET_UNAVAILABLE', V03_DEPLOYMENT_ERROR_MESSAGES.ROLLBACK_TARGET_UNAVAILABLE);
      }
      image = manualRuntime.image;
      const present = await check(await inspectImagePresent(context(null), { image }), null);
      if (!present) failed('ROLLBACK_TARGET_UNAVAILABLE', V03_DEPLOYMENT_ERROR_MESSAGES.ROLLBACK_TARGET_UNAVAILABLE);
    } else if (source.kind === 'git') {
      ledger = recordResource(ledger, { kind: 'workspace_created' });
      const store = input.gitHostKeys;
      const endpoint = store === undefined ? null : tofuEndpoint(source);
      // A store that cannot be read fails the attempt (WORKER_CRASHED): never an unpinned rescan.
      const pinned = endpoint === null || store === undefined ? null : await store.load(serviceId);
      const pinnedHostKeys =
        endpoint !== null && pinned !== null && sameKnownHostsHost(pinned.host, endpoint.knownHostsHost) ? pinned.keys : [];
      const clone = await cloneRepository({
        ...context('prepare'),
        workspace,
        source,
        credential: gitCredentialOf(input.credential),
        pinnedHostKeys,
        ...(input.requestedSha === undefined || input.requestedSha === null ? {} : { requestedSha: input.requestedSha }),
      });
      if (endpoint !== null && !clone.ok && clone.kind === 'failed' && clone.code === 'GIT_HOST_KEY_MISMATCH') {
        failed('GIT_HOST_KEY_MISMATCH', gitHostKeyMismatchMessage(serviceId));
      }
      const cloned = await check(clone, 'clone');
      if (endpoint !== null && store !== undefined && cloned.hostKeySource === 'scanned') {
        const stored = await store.pin(serviceId, { host: endpoint.knownHostsHost, keys: cloned.hostKeys });
        if (stored.kind === 'existing' && !agreesWith(stored.pinned, endpoint, cloned.hostKeys)) {
          failed('GIT_HOST_KEY_MISMATCH', gitHostKeyMismatchMessage(serviceId));
        }
        if (stored.kind === 'stored') log('prepare', 'system', PINNED_ON_FIRST_USE_LOG);
      }
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
    const resolved = resolveHealthcheck(manual === null ? (input.healthcheck ?? null) : manual.runtimeConfig.healthcheck);
    const runtime = { imageRef: image, internalPort, publishedPort, healthcheck: resolved.config };
    await advance('DEPLOYING', {
      // 23-04 A3: v2 carries plain values and pinned references, never a secret value.
      runtimeConfig:
        input.env === undefined ? { version: 1, ...runtime } : { version: 2, ...runtime, env: input.env.entries },
    });
    const ps = await check(await listManagedContainers(context(null)), null);
    if (ps.kind !== 'ok') failed('DOCKER_UNAVAILABLE', DEPLOY_MESSAGES.DOCKER_PS_UNREADABLE);
    const preflight = preflightPublishedPort({
      serviceId,
      publishedPort,
      otherServices: input.otherServices,
      panelPorts: input.panelPorts,
      containers: ps.containers,
    });
    if (!preflight.ok) failed('PORT_IN_USE', portMessage(preflight));
    const current = ps.containers.find((observed) => observed.name === ledger.names.container) ?? null;
    const previousName = previousContainerNameFor(serviceId);
    const stale = ps.containers.find((observed) => observed.name === previousName) ?? null;

    const network = await ensureNetwork(context(null), { serviceId });
    await check(network, null);
    if (network.ok && network.result.exitCode === 0) ledger = recordResource(ledger, { kind: 'network_created' });
    await joinProxy();

    cancellable = false;
    const stop = { serviceId, timeoutSeconds: limits.stopTimeoutSeconds };
    const currentRuns = current?.state === 'running';
    if (stale !== null) {
      // A `-prev` left by an earlier attempt: the running current one supersedes it; otherwise it
      // is still the last version known to run, so it stays the restore target.
      containerTouched = true;
      if (currentRuns) {
        await check(await stopPrevious(context('deploy'), stop), null);
        await check(await removePrevious(context('deploy'), { serviceId }), null);
      } else {
        if (current !== null) await check(await removeContainer(context('deploy'), { serviceId }), null);
        await check(await stopPrevious(context('deploy'), stop), null);
        kept = stale;
        ledger = recordResource(ledger, { kind: 'previous_container_kept', imageRef: stale.image });
      }
    }
    if (current !== null && (stale === null || currentRuns)) {
      containerTouched = true;
      await guarded(
        async () => {
          await check(await stopContainer(context('deploy'), stop), null);
          const renamed = await renameToPrevious(context('deploy'), { serviceId });
          if (!renamed.ok && renamed.kind === 'previous_exists') failed('START_FAILED', renamed.message);
          await check(renamed, null);
        },
        async () => {
          // H2: the running version was not replaced; it is started again before the attempt ends.
          const restarted = await recover(() => startContainer(recoveryContext(), { serviceId }));
          container = restarted ? { kind: 'running' } : { kind: 'unknown' };
          if (restarted) log('deploy', 'system', CURRENT_RESTARTED_LOG);
        },
      );
      kept = current;
      ledger = recordResource(ledger, { kind: 'previous_container_kept', imageRef: current.image });
    }

    containerTouched = true;
    await guarded(
      async () => {
        const envFile = await writeEnv();
        try {
          await check(
            await createContainer(context('deploy'), {
              serviceId,
              deploymentId,
              image,
              internalPort,
              publishedPort,
              ...(envFile === null ? {} : { envFile }),
            }),
            null,
          );
        } finally {
          if (envFile !== null) await removeEnv(envFile);
        }
        containerCreated = true;
        ledger = recordResource(ledger, { kind: 'container_created' });
        await check(await startContainer(context('deploy'), { serviceId }), null);
      },
      async () => {
        // H2: never leave the service down without a restore attempt. With auto_rollback the
        // ROLLING_BACK step restores `-prev` (and checks it) once the attempt has its end.
        if (kept === null || autoRollback) return;
        swapRecovered = true;
        if ((await recover(() => removeContainer(recoveryContext(), { serviceId }))) || !containerCreated) newRemoved = true;
        const restored = await recover(() => restorePrevious(recoveryContext(), { serviceId }));
        container = restored ? { kind: 'running' } : { kind: 'unknown' };
        log('deploy', 'system', restored ? PREVIOUS_RESTORED_LOG : PREVIOUS_NOT_RESTORED_LOG);
      },
    );

    // verify: the HEALTHCHECK step; the worker's finish ends SUCCESS.
    await advance('HEALTHCHECK');
    cancellable = true;
    if (resolved.postStart !== null) {
      // v0.2: no healthcheck config, the post-start polls decide.
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
    } else {
      const policy = healthcheckPolicy(resolved.config);
      let state = { elapsedMs: 0, failures: 0 };
      for (let attempt = 1; ; attempt += 1) {
        const observation = await probe(resolved.config);
        log('healthcheck', 'system', healthcheckLine(attempt, observation));
        const step = decideHealthcheck(policy, state, observation);
        state = step.state;
        const { decision } = step;
        if (decision.kind === 'pass') break;
        if (decision.kind === 'failed' || decision.kind === 'timeout') {
          container = observation.kind === 'exited' ? { kind: 'stopped', exitCode: null } : { kind: 'running' };
          failed(decision.code, V03_DEPLOYMENT_ERROR_MESSAGES[decision.code]);
        }
        await clock.sleep(decision.delayMs);
      }
      log('healthcheck', 'system', HEALTHCHECK_PASSED_LOG);
    }
    // 17-06 H1: a cancel racing the passed check loses; the attempt ends SUCCESS.
    cancellable = false;
    container = { kind: 'running' };
    // Only now is the superseded version no longer the service's last good one.
    const superseded: ObservedContainer | null = kept;
    if (superseded !== null) {
      if (await recover(() => removePrevious(recoveryContext(), { serviceId }))) {
        ledger = recordResource(ledger, { kind: 'previous_container_removed', imageRef: superseded.image });
      } else {
        log('deploy', 'system', PREVIOUS_NOT_REMOVED_LOG);
      }
    }
    await reapplyRoutesOnPortChange();
  };

  /** The rollback's probe loop on the restored container; throws a DeployStop when it fails. */
  let restoredObservation: HealthcheckObservation | null = null;
  const checkRestored = async (config: HealthcheckConfig): Promise<void> => {
    const policy = healthcheckPolicy(config);
    let state = { elapsedMs: 0, failures: 0 };
    for (let attempt = 1; ; attempt += 1) {
      const observation = await probe(config);
      restoredObservation = observation;
      log('rollback', 'system', healthcheckLine(attempt, observation));
      const step = decideHealthcheck(policy, state, observation);
      state = step.state;
      const { decision } = step;
      if (decision.kind === 'pass') return;
      if (decision.kind === 'failed' || decision.kind === 'timeout') {
        failed('ROLLBACK_FAILED', '');
      }
      const remaining = deadline - clock.now();
      if (remaining <= 0) failed('ROLLBACK_FAILED', '');
      await clock.sleep(Math.min(decision.delayMs, remaining));
    }
  };

  /** 17-07: one rollback attempt; it never throws and never leaves the status at ROLLING_BACK. */
  const rollback = async (original: FailedEnd): Promise<End> => {
    const target = input.previousSuccess ?? null;
    // 17-06 A1: ROLLING_BACK is never cancelled; the restore always runs to its end.
    cancellable = false;
    try {
      await advance('ROLLING_BACK');
    } catch {
      // The edge was not recorded: no rollback, but the service is not left down (17-02 H2).
      swapRecovered = true;
      if ((await recover(() => removeContainer(recoveryContext(), { serviceId }))) || !containerCreated) newRemoved = true;
      const restored = await recover(() => restorePrevious(recoveryContext(), { serviceId }));
      container = restored ? { kind: 'running' } : { kind: 'unknown' };
      log('deploy', 'system', restored ? PREVIOUS_RESTORED_LOG : PREVIOUS_NOT_RESTORED_LOG);
      return original;
    }
    log('rollback', 'system', ROLLBACK_STARTED_LOG);
    try {
      await input.recordRollbackStarted?.(target === null ? null : target.id);
    } catch {
      // A4: the activity row is best effort; the restore matters more.
    }
    // A4: its own budget, never past the attempt's NOODARA_DEPLOY_MAX_MS.
    deadline = Math.min(clock.now() + rollbackBudget, startedAt + limits.deployMaxMs);
    let restored = false;
    try {
      const removed = await removeContainer(context('rollback'), { serviceId });
      if (removed.ok || !containerCreated) newRemoved = true;
      const back = await restorePrevious(context('rollback'), { serviceId });
      if (!back.ok) failed('ROLLBACK_FAILED', '');
      restored = true;
      const config = target?.runtimeConfig?.healthcheck ?? DEFAULT_CONTAINER_HEALTHCHECK;
      await checkRestored(config);
      container = { kind: 'running' };
      log('rollback', 'system', ROLLBACK_PASSED_LOG);
      return { status: 'ROLLED_BACK', code: original.code, message: rolledBackMessage(original.message, target) };
    } catch {
      const exited = restoredObservation?.kind === 'exited';
      container = restored ? (exited ? { kind: 'stopped', exitCode: null } : { kind: 'running' }) : { kind: 'unknown' };
      log('rollback', 'system', ROLLBACK_FAILED_LOG);
      return { status: 'FAILED', code: 'ROLLBACK_FAILED', message: V03_DEPLOYMENT_ERROR_MESSAGES.ROLLBACK_FAILED };
    }
  };

  /** A3: without a rollback the new container does not keep serving a failed version. */
  const stopNew = async (message: string = NEW_STOPPED_LOG): Promise<void> => {
    const stopped = await recover(() =>
      stopContainer(recoveryContext(), { serviceId, timeoutSeconds: limits.stopTimeoutSeconds }),
    );
    if (!stopped) return;
    if (container?.kind !== 'stopped') container = { kind: 'stopped', exitCode: null };
    log('deploy', 'system', message);
  };

  /** 17-06 A1: a cancel during HEALTHCHECK puts `-prev` back; the only version is only stopped. */
  const undoCancelledSwap = async (): Promise<void> => {
    if (kept === null) {
      await stopNew(CANCEL_STOPPED_LOG);
      return;
    }
    swapRecovered = true;
    if ((await recover(() => removeContainer(recoveryContext(), { serviceId }))) || !containerCreated) newRemoved = true;
    const restored = await recover(() => restorePrevious(recoveryContext(), { serviceId }));
    container = restored ? { kind: 'running' } : { kind: 'unknown' };
    log('healthcheck', 'system', restored ? CANCEL_RESTORED_LOG : CANCEL_NOT_RESTORED_LOG);
  };
  // A closure, so TS does not narrow `status` to its initial value inside the catch block.
  const inHealthcheck = (): boolean => status === 'HEALTHCHECK';

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
    if (end.status === 'FAILED' && end.warning === undefined) {
      // H2: `status` is where the failure happened; a cancel or a BUILDING timeout never gets here.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (autoRollback && kept !== null && ROLLBACK_SOURCE_STATUSES.includes(status)) {
        end = await rollback(end);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      } else if (containerCreated && !swapRecovered) {
        await stopNew();
      }
    } else if (end.status === 'CANCELLED' && inHealthcheck()) {
      await undoCancelledSwap();
    }
  }

  // Cleanup runs on every exit; it never throws (the outcome is already decided). A removed new
  // container no longer pins its image or network (A5).
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const cleanupLedger: ResourceLedger = newRemoved ? { ...ledger, containerCreated: false } : ledger;
  let cleanup: CleanupReport[] = [];
  try {
    cleanup = await runLedgerCleanup(session, limits, workspace, cleanupLedger, exitFor(end));
  } finally {
    secrets.forEach((raw) => {
      redactor.release(raw);
    });
    envHold.lease?.release();
  }

  if (end === null) {
    return { status: 'SUCCESS', errorCode: null, errorMessage: null, commitSha, container, cleanup };
  }
  if (end.status === 'CANCELLED') {
    return { status: 'CANCELLED', errorCode: null, errorMessage: null, commitSha, container, cleanup };
  }
  return {
    status: end.status,
    errorCode: end.code,
    errorMessage: redactor.redact(end.message),
    commitSha,
    container,
    cleanup,
    ...(end.status === 'FAILED' && end.warning !== undefined ? { warning: end.warning } : {}),
  };
}

function cleanupCommand(resource: CleanupResource, workspace: DeployWorkspace, ledger: ResourceLedger): RemoteCommand | null {
  switch (resource.kind) {
    case 'workspace':
      return removeDeployDir(workspace);
    case 'image':
      // Only the attempt's own image; superseded images belong to image retention (17-04).
      return resource.ref === ledger.names.image ? dockerImageRemove(ledger.names.image) : null;
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
