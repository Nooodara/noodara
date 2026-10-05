// 12-16: runtime container logs on demand (LOG-03, ROADMAP D8). Two shapes, one allowlisted template:
// - tail: `docker logs --tail N --timestamps` as a plain bounded command;
// - follow: the same with `--follow`, run under `setsid -w` with a pidfile in a throwaway run dir
//   (/opt/noodara-deploy/<uuid>/run/logs.pid). Closing the channel never stops it (ADR 0008), so
//   every end (max duration, client gone, output cap, shutdown, dropped connection) goes through
//   killSupervisedOperation, retried once on a fresh connection, and the run dir is removed only
//   once the group is confirmed absent.
// SEC: output is redacted by the session, then sanitized (ANSI, CR, binary); it is never stored
// or logged. Failures carry closed codes with fixed messages, never remote stderr.
import { sanitizeLogText } from '@noodara/domain/deployment';
import type { Redactor } from '@noodara/domain/security';
import { containerNameFor, deployWorkspaceFor, type ContainerName, type DeployWorkspace } from '@noodara/domain/validators';
import { listManagedContainers, type DockerStepContext } from '@noodara/docker';
import {
  dockerLogs,
  killSupervisedOperation,
  prepareWorkspace,
  removeDeployDir,
  supervise,
  type RemoteCommand,
  type SshDeploySession,
  type StreamChunk,
  type StreamResult,
} from '@noodara/ssh';
import { randomUUID } from 'node:crypto';
import type { DeployJobDeps } from '../deploy/deploy-worker.js';

export type ContainerLogsFailureCode =
  | 'RUNTIME_LOG_TAIL_INVALID'
  | 'RUNTIME_LOG_FOLLOW_LIMIT_REACHED'
  | 'SERVER_UNREACHABLE'
  | 'SERVER_DOCKER_UNAVAILABLE'
  | 'CONTAINER_NOT_FOUND'
  | 'RUNTIME_LOGS_FAILED'
  | 'RUNTIME_LOGS_TIMEOUT';

export const CONTAINER_LOGS_MESSAGES = Object.freeze({
  RUNTIME_LOG_TAIL_INVALID: 'tail must be a whole number from 1 to 10000.',
  RUNTIME_LOG_FOLLOW_LIMIT_REACHED:
    'Too many live log streams are open for this server or account. Close one and try again.',
  SERVER_UNREACHABLE: 'The server could not be reached over SSH. Check that it is online and try again.',
  SERVER_DOCKER_UNAVAILABLE: 'Docker is not available on the server. Check that the Docker daemon is running.',
  CONTAINER_NOT_FOUND: 'The service has no container on the server. Deploy the service to create it.',
  RUNTIME_LOGS_FAILED: 'Docker could not read the service logs. Try again or redeploy the service.',
  RUNTIME_LOGS_TIMEOUT: 'Reading the service logs timed out. Try again with a smaller tail.',
} satisfies Record<ContainerLogsFailureCode, string>);

export interface ContainerLogsFailure {
  readonly ok: false;
  readonly code: ContainerLogsFailureCode;
  readonly message: string;
}

export interface ContainerLogLine {
  readonly stream: 'stdout' | 'stderr';
  /** Docker's RFC 3339 timestamp, or null for a line that carries none (a cut line's rest). */
  readonly timestamp: string | null;
  readonly text: string;
}

export interface ContainerLogsLimits {
  /** NOODARA_RUNTIME_LOG_TAIL. */
  readonly defaultTail: number;
  /** Same bound as the dockerLogs template. */
  readonly maxTail: number;
  /** NOODARA_RUNTIME_LOG_FOLLOW_MAX_MS. */
  readonly followMaxMs: number;
  /** Bound of every other remote step (duration and idle). */
  readonly stepMs: number;
  readonly maxLineBytes: number;
  readonly tailMaxTotalBytes: number;
  readonly followMaxTotalBytes: number;
  readonly maxFollowsPerServer: number;
  readonly maxFollowsPerUser: number;
  readonly killConfirmTimeoutMs: number;
  readonly killPollIntervalMs: number;
}

export const MAX_RUNTIME_LOG_TAIL = 10_000;

export const DEFAULT_CONTAINER_LOGS_LIMITS: ContainerLogsLimits = Object.freeze({
  defaultTail: 1_000,
  maxTail: MAX_RUNTIME_LOG_TAIL,
  followMaxMs: 600_000,
  stepMs: 60_000,
  maxLineBytes: 16_384,
  tailMaxTotalBytes: 8 * 1024 * 1024,
  followMaxTotalBytes: 32 * 1024 * 1024,
  maxFollowsPerServer: 5,
  maxFollowsPerUser: 3,
  killConfirmTimeoutMs: 15_000,
  killPollIntervalMs: 250,
});

export type FollowEndReason =
  | 'max_duration'
  | 'client_closed'
  | 'container_exited'
  | 'output_limit'
  | 'connection_lost'
  | 'shutdown';

export interface FollowEnd {
  readonly reason: FollowEndReason;
  /** The remote `docker logs` group was confirmed absent in ps. */
  readonly remoteStopped: boolean;
}

export interface FollowStream {
  /** Runs the stream to its end and always cleans up; never rejects. Call it exactly once. */
  pump(onLine: (line: ContainerLogLine) => void): Promise<FollowEnd>;
}

export type TailResult = { readonly ok: true; readonly lines: ContainerLogLine[]; readonly truncated: boolean } | ContainerLogsFailure;
export type OpenFollowResult = { readonly ok: true; readonly stream: FollowStream } | ContainerLogsFailure;

export interface TailRequest {
  readonly serverId: string;
  readonly serviceId: string;
  readonly tail: number;
}

export interface FollowRequest extends TailRequest {
  /** Key of the per-user cap. */
  readonly userId: string;
  /** The client connection: aborting it ends the stream. */
  readonly signal: AbortSignal;
}

export interface ContainerLogs {
  /** The `tail` query value against this instance's limits. */
  resolveTail(raw: string | undefined): ReturnType<typeof resolveTail>;
  tail(request: TailRequest): Promise<TailResult>;
  openFollow(request: FollowRequest): Promise<OpenFollowResult>;
  activeFollows(): number;
  /** Ends every open follow (remote kill included); for the app's preClose. */
  closeAll(): Promise<void>;
}

export interface ContainerLogsDeps {
  readonly connect: DeployJobDeps['connect'];
  readonly createRedactor: () => Redactor;
  readonly limits: ContainerLogsLimits;
  readonly newStreamId?: () => string;
  /** Ids and outcomes only, never log content. */
  readonly logger?: { warn(fields: Record<string, unknown>, message: string): void };
}

const TAIL_PATTERN = /^[1-9][0-9]{0,5}$/;
const TIMESTAMP_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})) (.*)$/s;
const PS_MAX_TOTAL_BYTES = 1_048_576;
const COMMAND_NOT_FOUND_EXIT_CODE = 127;

function failure(code: ContainerLogsFailureCode): ContainerLogsFailure {
  return { ok: false, code, message: CONTAINER_LOGS_MESSAGES[code] };
}

/** `tail` query value: absent means the default; otherwise digits only, 1..maxTail. */
export function resolveTail(
  raw: string | undefined,
  limits: Pick<ContainerLogsLimits, 'defaultTail' | 'maxTail'>,
): { readonly ok: true; readonly value: number } | ContainerLogsFailure {
  if (raw === undefined) return { ok: true, value: limits.defaultTail };
  if (!TAIL_PATTERN.test(raw)) return failure('RUNTIME_LOG_TAIL_INVALID');
  const value = Number(raw);
  if (value > limits.maxTail) return failure('RUNTIME_LOG_TAIL_INVALID');
  return { ok: true, value };
}

function validTail(tail: number, limits: ContainerLogsLimits): boolean {
  return Number.isInteger(tail) && tail >= 1 && tail <= Math.min(limits.maxTail, MAX_RUNTIME_LOG_TAIL);
}

/** Redacted text in, sanitized lines out. A trailing newline does not make an empty line. */
function toLines(chunk: StreamChunk): ContainerLogLine[] {
  const parts = sanitizeLogText(chunk.text).split('\n');
  if (parts.at(-1) === '') parts.pop();
  return parts.map((part) => {
    const match = TIMESTAMP_PREFIX.exec(part);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return { stream: chunk.stream, timestamp: match[1], text: match[2] };
    }
    return { stream: chunk.stream, timestamp: null, text: part };
  });
}

interface Connected {
  readonly session: SshDeploySession;
  readonly close: () => Promise<void>;
}

async function safeClose(connected: Connected | null): Promise<void> {
  if (connected === null) return;
  try {
    await connected.close();
  } catch {
    // A failed close never changes the outcome.
  }
}

/** Every remote step's failure, before it becomes a code. */
class StepFailure extends Error {
  constructor(readonly code: ContainerLogsFailureCode) {
    super(code);
    this.name = 'StepFailure';
  }
}

export function createContainerLogs(deps: ContainerLogsDeps): ContainerLogs {
  const { limits } = deps;
  const newStreamId = deps.newStreamId ?? randomUUID;
  const perServer = new Map<string, number>();
  const perUser = new Map<string, number>();
  const active = new Set<{ readonly stop: () => void; readonly done: Promise<unknown> }>();
  let slots = 0;

  const bump = (map: Map<string, number>, key: string, delta: number): void => {
    const next = (map.get(key) ?? 0) + delta;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  };

  /** Synchronous check-and-take, so two concurrent opens can never both pass the cap. */
  function acquire(serverId: string, userId: string): (() => void) | null {
    if ((perServer.get(serverId) ?? 0) >= limits.maxFollowsPerServer) return null;
    if ((perUser.get(userId) ?? 0) >= limits.maxFollowsPerUser) return null;
    bump(perServer, serverId, 1);
    bump(perUser, userId, 1);
    slots += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      bump(perServer, serverId, -1);
      bump(perUser, userId, -1);
      slots -= 1;
    };
  }

  async function connect(serverId: string, redactor: Redactor): Promise<Connected> {
    let result: Awaited<ReturnType<ContainerLogsDeps['connect']>>;
    try {
      result = await deps.connect(serverId, redactor, undefined);
    } catch {
      throw new StepFailure('SERVER_UNREACHABLE');
    }
    if (!result.ok) {
      throw new StepFailure(result.code === 'DOCKER_UNAVAILABLE' ? 'SERVER_DOCKER_UNAVAILABLE' : 'SERVER_UNREACHABLE');
    }
    return { session: result.session, close: result.close };
  }

  /** One bounded step whose output is not needed; a dropped stream is SERVER_UNREACHABLE. */
  async function runStep(session: SshDeploySession, command: RemoteCommand): Promise<StreamResult> {
    try {
      return await session.stream(command, {
        maxDurationMs: limits.stepMs,
        idleTimeoutMs: limits.stepMs,
        maxTotalBytes: limits.maxLineBytes,
        maxLineBytes: limits.maxLineBytes,
        onChunk: () => {
          // Discarded: only the exit code matters.
        },
      });
    } catch {
      throw new StepFailure('SERVER_UNREACHABLE');
    }
  }

  /** G4: the container must exist (and be ours) before docker logs runs. */
  async function requireContainer(session: SshDeploySession, redactor: Redactor, container: ContainerName): Promise<void> {
    const context: DockerStepContext = {
      session,
      redactor,
      limits: {
        maxDurationMs: limits.stepMs,
        idleTimeoutMs: limits.stepMs,
        maxTotalBytes: PS_MAX_TOTAL_BYTES,
        maxLineBytes: limits.maxLineBytes,
      },
    };
    let ps: Awaited<ReturnType<typeof listManagedContainers>>;
    try {
      ps = await listManagedContainers(context);
    } catch {
      throw new StepFailure('SERVER_UNREACHABLE');
    }
    if (!ps.ok) {
      if (ps.kind === 'interrupted') throw new StepFailure('RUNTIME_LOGS_TIMEOUT');
      if (ps.code === 'SERVER_UNREACHABLE') throw new StepFailure('SERVER_UNREACHABLE');
      if (ps.code === 'DOCKER_UNAVAILABLE') throw new StepFailure('SERVER_DOCKER_UNAVAILABLE');
      throw new StepFailure('RUNTIME_LOGS_FAILED');
    }
    const observed = ps.value;
    if (observed.kind === 'daemon_unreachable' || ps.result.exitCode === COMMAND_NOT_FOUND_EXIT_CODE) {
      throw new StepFailure('SERVER_DOCKER_UNAVAILABLE');
    }
    if (observed.kind !== 'ok') throw new StepFailure('RUNTIME_LOGS_FAILED');
    if (!observed.containers.some((candidate) => candidate.name === container)) {
      throw new StepFailure('CONTAINER_NOT_FOUND');
    }
  }

  function codeOf(error: unknown): ContainerLogsFailure {
    return failure(error instanceof StepFailure ? error.code : 'SERVER_UNREACHABLE');
  }

  async function tail(request: TailRequest): Promise<TailResult> {
    if (!validTail(request.tail, limits)) return failure('RUNTIME_LOG_TAIL_INVALID');
    const container = containerNameFor(request.serviceId);
    if (!container.ok) return failure('RUNTIME_LOGS_FAILED');
    const redactor = deps.createRedactor();
    let connected: Connected | null = null;
    try {
      connected = await connect(request.serverId, redactor);
      await requireContainer(connected.session, redactor, container.value);
      const lines: ContainerLogLine[] = [];
      let result: StreamResult;
      try {
        result = await connected.session.stream(dockerLogs({ container: container.value, tail: request.tail, follow: false }), {
          maxDurationMs: limits.stepMs,
          idleTimeoutMs: limits.stepMs,
          maxTotalBytes: limits.tailMaxTotalBytes,
          maxLineBytes: limits.maxLineBytes,
          onChunk: (chunk) => {
            lines.push(...toLines(chunk));
          },
        });
      } catch {
        return failure('SERVER_UNREACHABLE');
      }
      if (result.outcome !== 'completed') return failure('RUNTIME_LOGS_TIMEOUT');
      if (result.exitCode === COMMAND_NOT_FOUND_EXIT_CODE) return failure('SERVER_DOCKER_UNAVAILABLE');
      if (result.exitCode !== 0) return failure('RUNTIME_LOGS_FAILED');
      return { ok: true, lines, truncated: result.truncated };
    } catch (error) {
      return codeOf(error);
    } finally {
      await safeClose(connected);
    }
  }

  async function openFollow(request: FollowRequest): Promise<OpenFollowResult> {
    if (!validTail(request.tail, limits)) return failure('RUNTIME_LOG_TAIL_INVALID');
    const container = containerNameFor(request.serviceId);
    const workspace = deployWorkspaceFor(newStreamId());
    if (!container.ok || !workspace.ok) return failure('RUNTIME_LOGS_FAILED');
    const release = acquire(request.serverId, request.userId);
    if (release === null) return failure('RUNTIME_LOG_FOLLOW_LIMIT_REACHED');

    const redactor = deps.createRedactor();
    let connected: Connected | null = null;
    try {
      connected = await connect(request.serverId, redactor);
      await requireContainer(connected.session, redactor, container.value);
      const prepared = await runStep(connected.session, prepareWorkspace(workspace.value));
      if (prepared.outcome !== 'completed') throw new StepFailure('RUNTIME_LOGS_TIMEOUT');
      if (prepared.exitCode !== 0) throw new StepFailure('RUNTIME_LOGS_FAILED');
    } catch (error) {
      await safeClose(connected);
      release();
      return codeOf(error);
    }

    const stream = createFollowStream({
      request,
      container: container.value,
      workspace: workspace.value,
      redactor,
      connected,
      release,
    });
    return { ok: true, stream };
  }

  function createFollowStream(input: {
    readonly request: FollowRequest;
    readonly container: ContainerName;
    readonly workspace: DeployWorkspace;
    readonly redactor: Redactor;
    readonly connected: Connected;
    readonly release: () => void;
  }): FollowStream {
    const { request, workspace, redactor, release } = input;
    const pidFile = workspace.pidFile('logs');
    const stop = new AbortController();
    let stopReason: FollowEndReason | null = null;
    const stopWith = (reason: FollowEndReason): void => {
      stopReason ??= reason;
      stop.abort();
    };
    const onClientAbort = (): void => {
      stopWith('client_closed');
    };
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let pumped: Promise<FollowEnd> | null = null;
    // An un-pumped stream still holds a slot and a run dir: shutdown pumps it to its teardown.
    const entry = {
      stop: () => {
        stopWith('shutdown');
        pumped ??= pump(() => undefined);
      },
      done,
    };
    active.add(entry);

    async function kill(session: SshDeploySession): Promise<boolean> {
      const result = await killSupervisedOperation({
        session,
        pidFile,
        buildContainer: null,
        confirmTimeoutMs: limits.killConfirmTimeoutMs,
        pollIntervalMs: limits.killPollIntervalMs,
        redactor,
      });
      return result.confirmed;
    }

    /** Kill, then remove the run dir; a second connection when the first cannot confirm. */
    async function teardown(launched: boolean): Promise<boolean> {
      let current: Connected | null = input.connected;
      let stopped = !launched || (await kill(current.session));
      if (!stopped) {
        await safeClose(current);
        current = null;
        try {
          current = await connect(request.serverId, redactor);
          stopped = await kill(current.session);
        } catch {
          stopped = false;
        }
      }
      if (stopped && current !== null) {
        try {
          await runStep(current.session, removeDeployDir(workspace));
        } catch {
          // The dir holds no secret; a leftover is swept with the deploy workspaces.
        }
      }
      await safeClose(current);
      return stopped;
    }

    async function pump(onLine: (line: ContainerLogLine) => void): Promise<FollowEnd> {
      let launched = false;
      let reason: FollowEndReason;
      request.signal.addEventListener('abort', onClientAbort);
      try {
        if (request.signal.aborted) stopWith('client_closed');
        if (stop.signal.aborted) {
          reason = stopReason ?? 'client_closed';
        } else {
          launched = true;
          let delivered = 0;
          let result: StreamResult | null = null;
          try {
            result = await input.connected.session.stream(
              supervise(pidFile, dockerLogs({ container: input.container, tail: request.tail, follow: true })),
              {
                maxDurationMs: limits.followMaxMs,
                // A quiet container is normal: only the max duration bounds a follow.
                idleTimeoutMs: limits.followMaxMs,
                maxTotalBytes: limits.followMaxTotalBytes * 2,
                maxLineBytes: limits.maxLineBytes,
                signal: stop.signal,
                onChunk: (chunk) => {
                  if (stop.signal.aborted) return;
                  delivered += Buffer.byteLength(chunk.text, 'utf8');
                  if (delivered > limits.followMaxTotalBytes) {
                    stopWith('output_limit');
                    return;
                  }
                  try {
                    for (const line of toLines(chunk)) onLine(line);
                  } catch {
                    // The client side is gone or broken: end the stream like a disconnect.
                    stopWith('client_closed');
                  }
                },
              },
            );
          } catch {
            stopWith('connection_lost');
          }
          if (stopReason !== null) reason = stopReason;
          else if (result?.outcome === 'timed_out' || result?.outcome === 'idle_timeout') reason = 'max_duration';
          else reason = 'container_exited';
        }
      } finally {
        request.signal.removeEventListener('abort', onClientAbort);
      }

      let remoteStopped = false;
      try {
        remoteStopped = await teardown(launched);
      } catch {
        remoteStopped = false;
      }
      if (!remoteStopped) {
        deps.logger?.warn(
          { serverId: request.serverId, serviceId: request.serviceId, reason },
          'runtime log follow: remote docker logs not confirmed stopped',
        );
      }
      release();
      active.delete(entry);
      resolveDone?.();
      return { reason, remoteStopped };
    }

    return {
      pump: (onLine) => (pumped ??= pump(onLine)),
    };
  }

  return {
    resolveTail: (raw) => resolveTail(raw, limits),
    tail,
    openFollow,
    activeFollows: () => slots,
    closeAll: async () => {
      const pending = [...active];
      for (const entry of pending) entry.stop();
      await Promise.all(pending.map((entry) => entry.done));
    },
  };
}
