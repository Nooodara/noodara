// 27-02: one metrics collector tick (ADR 0012).
// - A1: per CONNECTED server, one SSH session runs the host sample and the container sample; the
//   whole tick is bounded by one deadline (an AbortSignal shared by every connect and probe), and
//   servers not reached before it are left for the next tick. Host and container samples of a
//   server are written together (one transaction in the store).
// - A2: an unreachable server records its outcome (summary, log, no samples, last_seen_at left as
//   is); a failure on one server never stops the others and the tick never throws per server.
// - A3: a container observation is stored only when its state changed; a crash loop or OOM that
//   the history before this point did not show writes one system activity event.
// - A4: samples older than the retention are pruned in bounded batches after sampling.
// - H1: a server with a non-terminal deployment (the deploy owns its connection) is skipped.
// - H2: one malformed container records a parse-error observation and keeps the host sample and
//   the other containers (container-salvage.ts).
// Logs carry ids, counts and error kinds only: no command output, driver or SSH message.
import { sampleContainers, sampleHost, type StepResult } from '@noodara/docker';
import {
  CRASH_LOOP_WINDOW_MS,
  containerStateFromSample,
  diskUsedPercent,
  observeContainer,
  type ContainerSample,
  type ContainerState,
  type ContainerStatePoint,
  type HostSample,
} from '@noodara/domain';
import type { Redactor } from '@noodara/domain/security';
import { containerNameFor } from '@noodara/domain/validators';
import type { SshDeploySession, StreamChunk } from '@noodara/ssh';
import type { ContainerIncidentDiagnosis } from '../activity/observability-events.js';
import type { DeployJobDeps, DeployJobLogger } from '../deploy/deploy-worker.js';
import { salvageContainerSample } from './container-salvage.js';

export interface HostSampleRow {
  readonly cpuPercent: number | null;
  readonly memoryTotalBytes: number;
  readonly memoryUsedBytes: number;
  readonly diskUsedPercent: number | null;
  readonly filesystems: HostSample['filesystems'];
  readonly uptimeSeconds: number;
}

export interface ContainerSampleRow {
  readonly serviceId: string;
  readonly containerId: string;
  readonly running: boolean;
  readonly cpuPercent: number | null;
  readonly memoryUsedBytes: number | null;
  readonly memoryLimitBytes: number | null;
  readonly restartCount: number;
}

export type ContainerObservationRow =
  | { readonly kind: 'state'; readonly serviceId: string; readonly containerId: string; readonly state: ContainerState }
  | { readonly kind: 'parse_error'; readonly serviceId: string; readonly containerId: string | null };

export interface ContainerIncident {
  readonly serviceId: string;
  readonly diagnosis: ContainerIncidentDiagnosis;
}

export interface ServerTickWrite {
  readonly serverId: string;
  readonly sampledAt: Date;
  readonly host: HostSampleRow | null;
  readonly containers: readonly ContainerSampleRow[];
  readonly observations: readonly ContainerObservationRow[];
  readonly incidents: readonly ContainerIncident[];
}

/** The last stored state point of a service's container. */
export interface LastContainerState extends ContainerStatePoint {
  readonly containerId: string;
}

export interface PruneResult {
  readonly deleted: number;
  /** The batch cap was reached; the rest is pruned on later ticks. */
  readonly capped: boolean;
}

export interface CollectorTickDeps {
  /** CONNECTED servers. */
  readonly listServers: () => Promise<readonly string[]>;
  /** A non-terminal deployment exists on one of the server's services (H1). */
  readonly serverBusy: (serverId: string) => Promise<boolean>;
  readonly listServices: (serverId: string) => Promise<readonly string[]>;
  readonly lastStates: (serviceIds: readonly string[]) => Promise<ReadonlyMap<string, LastContainerState>>;
  /** State points of one container observed at or after `since`. */
  readonly history: (serviceId: string, containerId: string, since: Date) => Promise<readonly ContainerStatePoint[]>;
  /** Samples, observations, incident events and last_seen_at in one transaction. */
  readonly writeServerTick: (write: ServerTickWrite) => Promise<void>;
  readonly prune: (cutoff: Date) => Promise<PruneResult>;
  readonly connect: DeployJobDeps['connect'];
  readonly createRedactor: () => Redactor;
  /** Bounds the whole tick (every connect and probe shares it). */
  readonly deadlineMs: number;
  /** NOODARA_METRICS_RETENTION_HOURS in ms. */
  readonly retentionMs: number;
  readonly logger: DeployJobLogger;
  readonly now?: () => Date;
  /** Servers sampled at once; default 4. */
  readonly serverConcurrency?: number;
  /** Seconds between the two /proc/stat reads; default 1. */
  readonly hostDeltaSeconds?: number;
}

export type ServerOutcome = 'sampled' | 'unreachable' | 'busy' | 'deadline' | 'failed';

export interface CollectorTickSummary {
  readonly servers: number;
  readonly sampled: number;
  readonly unreachable: number;
  readonly busy: number;
  readonly deadline: number;
  readonly failed: number;
  readonly containers: number;
  readonly observations: number;
  readonly parseErrors: number;
  readonly incidents: number;
  readonly pruned: number;
  readonly outcomes: Readonly<Record<string, ServerOutcome>>;
}

const DEFAULT_SERVER_CONCURRENCY = 4;
const FULL_CONTAINER_ID = /^[0-9a-f]{64}$/;
/** Unused by the observability probes (each template has its own budget); required by the type. */
const PROBE_LIMITS = Object.freeze({ maxDurationMs: 60_000, idleTimeoutMs: 60_000, maxTotalBytes: 1_048_576, maxLineBytes: 1_048_576 });

/** Only the error's class name: a driver or SSH message can carry a URL or a secret. */
function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function stepKind(step: StepResult<unknown>): string {
  if (step.ok) return 'ok';
  return step.kind === 'failed' ? step.code : step.outcome;
}

/** A session view that also hands the stdout it streamed to `sink` (H2 salvage). */
function capturing(session: SshDeploySession, sink: string[]): SshDeploySession {
  const view = Object.create(session) as SshDeploySession;
  Object.defineProperty(view, 'stream', {
    value: (command: Parameters<SshDeploySession['stream']>[0], options: Parameters<SshDeploySession['stream']>[1]) =>
      session.stream(command, {
        ...options,
        onChunk: (chunk: StreamChunk) => {
          if (chunk.stream === 'stdout') sink.push(chunk.text);
          options.onChunk(chunk);
        },
      }),
  });
  return view;
}

function hostRow(sample: HostSample): HostSampleRow {
  const percents = sample.filesystems.map(diskUsedPercent).filter((value): value is number => value !== null);
  return {
    cpuPercent: sample.cpuPercent,
    memoryTotalBytes: sample.memory.totalBytes,
    memoryUsedBytes: sample.memory.usedBytes,
    diskUsedPercent: percents.length === 0 ? null : Math.min(100, Math.max(...percents)),
    filesystems: sample.filesystems,
    uptimeSeconds: Math.floor(sample.uptimeSeconds),
  };
}

function sameState(a: ContainerState, b: ContainerState): boolean {
  return (
    a.status === b.status &&
    a.running === b.running &&
    a.restarting === b.restarting &&
    a.restartCount === b.restartCount &&
    a.oomKilled === b.oomKilled &&
    a.exitCode === b.exitCode &&
    a.health === b.health &&
    a.memoryLimitBytes === b.memoryLimitBytes &&
    a.healthExitCodes.join(',') === b.healthExitCodes.join(',')
  );
}

interface Counters {
  servers: number;
  sampled: number;
  unreachable: number;
  busy: number;
  deadline: number;
  failed: number;
  containers: number;
  observations: number;
  parseErrors: number;
  incidents: number;
  outcomes: Record<string, ServerOutcome>;
}

interface SessionSamples {
  /** The host probe completed (parsed or not). */
  readonly hostCompleted: boolean;
  readonly hostSample: HostSample | null;
  /** null when the container probe did not complete. */
  readonly containers: readonly ContainerSample[] | null;
  readonly failures: ReturnType<typeof salvageContainerSample>['failures'];
}

async function sampleOver(
  deps: CollectorTickDeps,
  session: SshDeploySession,
  redactor: Redactor,
  signal: AbortSignal,
  serverId: string,
): Promise<SessionSamples> {
  const host = await sampleHost(
    { session, redactor, limits: PROBE_LIMITS, signal },
    { deltaSeconds: deps.hostDeltaSeconds ?? 1 },
  );
  let hostSample: HostSample | null = null;
  if (!host.ok) {
    deps.logger.warn({ serverId, errorKind: stepKind(host) }, 'metrics: host sample failed');
  } else if (host.value.kind === 'ok') {
    hostSample = host.value.value;
  } else {
    deps.logger.warn({ serverId, errorKind: 'HOST_SAMPLE_UNPARSEABLE' }, 'metrics: host sample unparseable');
  }

  const stdout: string[] = [];
  const containers = await sampleContainers({ session: capturing(session, stdout), redactor, limits: PROBE_LIMITS, signal });
  if (!containers.ok) {
    deps.logger.warn({ serverId, errorKind: stepKind(containers) }, 'metrics: container sample failed');
    return { hostCompleted: host.ok, hostSample, containers: null, failures: [] };
  }
  if (containers.value.kind === 'ok') {
    return { hostCompleted: host.ok, hostSample, containers: containers.value.value, failures: [] };
  }
  // H2: re-parse container by container; redacted again before any parser sees it.
  const salvaged = salvageContainerSample(redactor.redact(stdout.join('')));
  return { hostCompleted: host.ok, hostSample, containers: salvaged.samples, failures: salvaged.failures };
}

async function incidentsFor(
  deps: CollectorTickDeps,
  serviceId: string,
  containerId: string,
  current: ContainerStatePoint,
  last: LastContainerState | undefined,
  hostTotalBytes: number | null,
): Promise<ContainerIncidentDiagnosis[]> {
  const since = new Date(current.observedAtMs - CRASH_LOOP_WINDOW_MS);
  const before = [...(await deps.history(serviceId, containerId, since))];
  // The last stored point counts even outside the window: an OOM that is still showing is not new.
  if (last?.containerId === containerId && !before.some((p) => p.observedAtMs === last.observedAtMs)) {
    before.push({ observedAtMs: last.observedAtMs, state: last.state });
  }
  const options = { hostTotalBytes };
  const previous = observeContainer(before, options);
  const now = observeContainer([...before, current], options);
  const found: ContainerIncidentDiagnosis[] = [];
  if (now?.crashLoop === true && previous?.crashLoop !== true) found.push('crash_loop');
  if (now?.outOfMemory === true && previous?.outOfMemory !== true) found.push('out_of_memory');
  return found;
}

async function collectServer(
  deps: CollectorTickDeps,
  serverId: string,
  signal: AbortSignal,
  now: () => Date,
  counters: Counters,
): Promise<ServerOutcome> {
  if (await deps.serverBusy(serverId)) return 'busy';
  const serviceIds = await deps.listServices(serverId);
  const serviceByName = new Map<string, string>();
  for (const serviceId of serviceIds) {
    const name = containerNameFor(serviceId);
    if (name.ok) serviceByName.set(name.value, serviceId);
  }

  const redactor = deps.createRedactor();
  let connected;
  try {
    connected = await deps.connect(serverId, redactor, signal);
  } catch (error) {
    if (signal.aborted) return 'deadline';
    deps.logger.warn({ serverId, errorKind: errorKind(error) }, 'metrics: server unreachable');
    return 'unreachable';
  }
  if (!connected.ok) {
    // A connect cut short by the tick deadline is the deadline, not an unreachable server.
    if (signal.aborted) return 'deadline';
    deps.logger.warn({ serverId, errorKind: connected.code }, 'metrics: server unreachable');
    return 'unreachable';
  }

  let samples: SessionSamples;
  try {
    samples = await sampleOver(deps, connected.session, redactor, signal, serverId);
  } finally {
    try {
      await connected.close();
    } catch {
      // A failed close never changes the samples.
    }
  }
  if (!samples.hostCompleted && samples.containers === null) {
    return signal.aborted ? 'deadline' : 'unreachable';
  }

  const sampledAt = now();
  const host = samples.hostSample === null ? null : hostRow(samples.hostSample);
  const hostTotalBytes = samples.hostSample?.memory.totalBytes ?? null;
  const containers: ContainerSampleRow[] = [];
  const observations: ContainerObservationRow[] = [];
  const incidents: ContainerIncident[] = [];

  const seen = new Set<string>();
  const kept = (samples.containers ?? []).filter((sample) => {
    const serviceId = serviceByName.get(sample.name);
    if (serviceId === undefined || seen.has(serviceId)) return false;
    seen.add(serviceId);
    return true;
  });
  const last = await deps.lastStates(kept.map((sample) => serviceByName.get(sample.name) ?? ''));

  for (const sample of kept) {
    const serviceId = serviceByName.get(sample.name) ?? '';
    if (!FULL_CONTAINER_ID.test(sample.id)) {
      observations.push({ kind: 'parse_error', serviceId, containerId: null });
      continue;
    }
    const state = containerStateFromSample(sample);
    containers.push({
      serviceId,
      containerId: sample.id,
      running: sample.running,
      cpuPercent: sample.stats?.cpuPercent ?? null,
      memoryUsedBytes: sample.stats?.memoryBytes ?? null,
      memoryLimitBytes: sample.memoryLimitBytes,
      restartCount: sample.restartCount,
    });
    const previous = last.get(serviceId);
    if (previous?.containerId === sample.id && sameState(previous.state, state)) continue;
    observations.push({ kind: 'state', serviceId, containerId: sample.id, state });
    const point = { observedAtMs: sampledAt.getTime(), state };
    for (const diagnosis of await incidentsFor(deps, serviceId, sample.id, point, previous, hostTotalBytes)) {
      incidents.push({ serviceId, diagnosis });
    }
  }
  for (const failure of samples.failures) {
    const serviceId = failure.name === null ? undefined : serviceByName.get(failure.name);
    if (serviceId === undefined) {
      counters.parseErrors += 1;
      continue;
    }
    const containerId = failure.containerId !== null && FULL_CONTAINER_ID.test(failure.containerId) ? failure.containerId : null;
    observations.push({ kind: 'parse_error', serviceId, containerId });
  }

  await deps.writeServerTick({ serverId, sampledAt, host, containers, observations, incidents });
  const parseErrors = observations.filter((o) => o.kind === 'parse_error').length;
  counters.containers += containers.length;
  counters.observations += observations.length - parseErrors;
  counters.parseErrors += parseErrors;
  counters.incidents += incidents.length;
  if (samples.failures.length > 0) {
    deps.logger.warn({ serverId, parseErrors: samples.failures.length }, 'metrics: container sample partly unparseable');
  }
  for (const incident of incidents) {
    deps.logger.info({ serverId, serviceId: incident.serviceId, diagnosis: incident.diagnosis }, 'metrics: container incident');
  }
  return 'sampled';
}

export function createCollectorTick(deps: CollectorTickDeps): () => Promise<CollectorTickSummary> {
  const concurrency = Math.max(1, deps.serverConcurrency ?? DEFAULT_SERVER_CONCURRENCY);
  const now = deps.now ?? (() => new Date());
  return async () => {
    const counters: Counters = {
      servers: 0,
      sampled: 0,
      unreachable: 0,
      busy: 0,
      deadline: 0,
      failed: 0,
      containers: 0,
      observations: 0,
      parseErrors: 0,
      incidents: 0,
      outcomes: {},
    };
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort();
    }, deps.deadlineMs);
    timer.unref();
    try {
      const pending = [...(await deps.listServers())];
      counters.servers = pending.length;
      const lane = async (): Promise<void> => {
        for (let serverId = pending.shift(); serverId !== undefined; serverId = pending.shift()) {
          let outcome: ServerOutcome;
          if (deadline.signal.aborted) {
            outcome = 'deadline';
          } else {
            try {
              outcome = await collectServer(deps, serverId, deadline.signal, now, counters);
            } catch (error) {
              outcome = 'failed';
              deps.logger.error({ serverId, errorKind: errorKind(error) }, 'metrics: server tick failed');
            }
          }
          counters.outcomes[serverId] = outcome;
          counters[outcome] += 1;
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, lane));
    } finally {
      clearTimeout(timer);
    }

    let pruned = 0;
    try {
      const result = await deps.prune(new Date(now().getTime() - deps.retentionMs));
      pruned = result.deleted;
    } catch (error) {
      deps.logger.error({ errorKind: errorKind(error) }, 'metrics: retention prune failed');
    }
    const summary: CollectorTickSummary = { ...counters, outcomes: { ...counters.outcomes }, pruned };
    deps.logger.info(
      {
        servers: summary.servers,
        sampled: summary.sampled,
        unreachable: summary.unreachable,
        busy: summary.busy,
        deadline: summary.deadline,
        failed: summary.failed,
        containers: summary.containers,
        parseErrors: summary.parseErrors,
        incidents: summary.incidents,
        pruned,
      },
      'metrics tick complete',
    );
    return summary;
  };
}
