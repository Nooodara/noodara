// 27-02 (A1-A4, H1, H2): one collector tick over fake ports; the Docker probes are stubbed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerSample, ContainerStatePoint, HostSample } from '@noodara/domain';
import type { Redactor } from '@noodara/domain/security';
import type { SshDeploySession, StreamOptions } from '@noodara/ssh';
import type { ConnectResult } from '../deploy/deploy-worker.js';
import {
  createCollectorTick,
  type CollectorTickDeps,
  type LastContainerState,
  type ServerTickWrite,
} from './collector-tick.js';

const docker = vi.hoisted(() => ({ sampleHost: vi.fn(), sampleContainers: vi.fn() }));
vi.mock('@noodara/docker', () => docker);

const SERVER_A = '00000000-0000-4000-8000-00000000000a';
const SERVER_B = '00000000-0000-4000-8000-00000000000b';
const SERVICE_1 = '11111111-1111-4111-8111-111111111111';
const SERVICE_2 = '22222222-2222-4222-8222-222222222222';
const ID_1 = '1'.repeat(64);
const ID_2 = '2'.repeat(64);
const NOW = new Date('2026-11-04T12:00:00.000Z');
const SECRET_MARKER = 'stdout-must-not-leak';

const HOST: HostSample = {
  cpuPercent: 12.5,
  cpu: { total: 1000, idle: 800 },
  memory: { totalBytes: 2_000_000_000, availableBytes: 1_500_000_000, usedBytes: 500_000_000 },
  filesystems: [{ target: '/', sizeBytes: 100, usedBytes: 40, availBytes: 60 }],
  uptimeSeconds: 3600.7,
};

function container(serviceId: string, id: string, overrides: Partial<ContainerSample> = {}): ContainerSample {
  return {
    id,
    name: `noodara-${serviceId}`,
    status: 'running',
    running: true,
    restarting: false,
    restartCount: 0,
    oomKilled: false,
    exitCode: 0,
    startedAt: '2026-11-04T00:00:00Z',
    finishedAt: null,
    health: null,
    healthExitCodes: [],
    memoryLimitBytes: null,
    stats: { cpuPercent: 1.5, memoryBytes: 10_000_000 } as ContainerSample['stats'],
    ...overrides,
  };
}

const ok = <T>(value: T) => ({ ok: true, value: { kind: 'ok', value }, result: {} });

function silentLogger() {
  const logs: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const push = (level: string) => (fields: Record<string, unknown>, message: string) => logs.push({ level, fields, message });
  return { logs, logger: { info: push('info'), warn: push('warn'), error: push('error') } };
}

const redactor: Redactor = { redact: (text: string) => text } as unknown as Redactor;

interface Harness {
  readonly deps: CollectorTickDeps;
  readonly writes: ServerTickWrite[];
  readonly connects: string[];
  readonly closes: string[];
  readonly prunes: Date[];
  readonly logs: ReturnType<typeof silentLogger>['logs'];
}

function fakeSession(stdout = ''): SshDeploySession {
  return {
    stream: (_command: unknown, options: StreamOptions) => {
      if (stdout !== '') options.onChunk({ stream: 'stdout', text: stdout, seq: 1, truncatedLine: false });
      return Promise.resolve({} as never);
    },
  } as unknown as SshDeploySession;
}

function harness(overrides: Partial<CollectorTickDeps> = {}, servicesByServer: Record<string, string[]> = {}): Harness {
  const writes: ServerTickWrite[] = [];
  const connects: string[] = [];
  const closes: string[] = [];
  const prunes: Date[] = [];
  const { logs, logger } = silentLogger();
  const deps: CollectorTickDeps = {
    listServers: () => Promise.resolve([SERVER_A]),
    serverBusy: () => Promise.resolve(false),
    listServices: (serverId) => Promise.resolve(servicesByServer[serverId] ?? [SERVICE_1, SERVICE_2]),
    lastStates: () => Promise.resolve(new Map()),
    history: () => Promise.resolve([]),
    writeServerTick: (write) => {
      writes.push(write);
      return Promise.resolve();
    },
    prune: (cutoff) => {
      prunes.push(cutoff);
      return Promise.resolve({ deleted: 3, capped: false });
    },
    connect: (serverId): Promise<ConnectResult> => {
      connects.push(serverId);
      return Promise.resolve({
        ok: true,
        session: fakeSession(),
        close: () => {
          closes.push(serverId);
          return Promise.resolve();
        },
      });
    },
    createRedactor: () => redactor,
    deadlineMs: 5_000,
    retentionMs: 168 * 3_600_000,
    logger,
    now: () => NOW,
    ...overrides,
  };
  return { deps, writes, connects, closes, prunes, logs };
}

function expectSafeLogs(logs: Harness['logs']): void {
  const allowed = new Set([
    'serverId',
    'serviceId',
    'errorKind',
    'diagnosis',
    'parseErrors',
    'servers',
    'sampled',
    'unreachable',
    'busy',
    'deadline',
    'failed',
    'containers',
    'incidents',
    'pruned',
  ]);
  for (const entry of logs) {
    for (const key of Object.keys(entry.fields)) expect(allowed.has(key)).toBe(true);
    expect(JSON.stringify(entry)).not.toContain(SECRET_MARKER);
  }
}

beforeEach(() => {
  docker.sampleHost.mockReset();
  docker.sampleContainers.mockReset();
  docker.sampleHost.mockResolvedValue(ok(HOST));
  docker.sampleContainers.mockResolvedValue(ok([container(SERVICE_1, ID_1), container(SERVICE_2, ID_2)]));
});

describe('createCollectorTick (27-02)', () => {
  it('A1: samples each CONNECTED server over one session and writes host and containers together', async () => {
    const h = harness({ listServers: () => Promise.resolve([SERVER_A, SERVER_B]) });
    const summary = await createCollectorTick(h.deps)();

    expect(h.connects.sort()).toEqual([SERVER_A, SERVER_B]);
    expect(h.closes.sort()).toEqual([SERVER_A, SERVER_B]);
    expect(docker.sampleHost).toHaveBeenCalledTimes(2);
    expect(docker.sampleContainers).toHaveBeenCalledTimes(2);
    expect(h.writes).toHaveLength(2);
    const write = h.writes.find((w) => w.serverId === SERVER_A);
    expect(write?.sampledAt).toEqual(NOW);
    expect(write?.host).toMatchObject({ cpuPercent: 12.5, memoryUsedBytes: 500_000_000, diskUsedPercent: 40, uptimeSeconds: 3600 });
    expect(write?.containers.map((c) => c.serviceId).sort()).toEqual([SERVICE_1, SERVICE_2]);
    expect(summary).toMatchObject({ servers: 2, sampled: 2, containers: 4, pruned: 3 });
    expectSafeLogs(h.logs);
  });

  it('A1: containers that are not managed services are ignored', async () => {
    docker.sampleContainers.mockResolvedValue(ok([container(SERVICE_1, ID_1), { ...container(SERVICE_2, ID_2), name: 'postgres' }]));
    const h = harness();
    await createCollectorTick(h.deps)();
    expect(h.writes[0]?.containers.map((c) => c.serviceId)).toEqual([SERVICE_1]);
  });

  it('A2: an unreachable server records its outcome, writes nothing and never stops the others', async () => {
    const h = harness({
      listServers: () => Promise.resolve([SERVER_A, SERVER_B]),
      connect: (serverId) =>
        serverId === SERVER_A
          ? Promise.resolve({ ok: false, code: 'SERVER_UNREACHABLE' })
          : Promise.resolve({ ok: true, session: fakeSession(), close: () => Promise.resolve() }),
    });
    const summary = await createCollectorTick(h.deps)();
    expect(summary.outcomes).toEqual({ [SERVER_A]: 'unreachable', [SERVER_B]: 'sampled' });
    expect(h.writes.map((w) => w.serverId)).toEqual([SERVER_B]);
    expectSafeLogs(h.logs);
  });

  it('A2: a connect that throws or a store failure on one server is contained', async () => {
    const h = harness({
      listServers: () => Promise.resolve([SERVER_A, SERVER_B]),
      connect: () => Promise.reject(new Error(`ssh: ${SECRET_MARKER}`)),
    });
    const summary = await createCollectorTick(h.deps)();
    expect(summary).toMatchObject({ unreachable: 2, sampled: 0 });

    const failing = harness({
      listServers: () => Promise.resolve([SERVER_A, SERVER_B]),
      writeServerTick: (write) =>
        write.serverId === SERVER_A ? Promise.reject(new TypeError(SECRET_MARKER)) : Promise.resolve(),
    });
    const second = await createCollectorTick(failing.deps)();
    expect(second.outcomes).toEqual({ [SERVER_A]: 'failed', [SERVER_B]: 'sampled' });
    expect(failing.logs.some((l) => l.fields.errorKind === 'TypeError')).toBe(true);
    expectSafeLogs([...h.logs, ...failing.logs]);
  });

  it('A2: both probes failing leaves the server unwritten', async () => {
    docker.sampleHost.mockResolvedValue({ ok: false, kind: 'failed', code: 'DOCKER_UNAVAILABLE', message: SECRET_MARKER });
    docker.sampleContainers.mockResolvedValue({ ok: false, kind: 'failed', code: 'DOCKER_UNAVAILABLE', message: SECRET_MARKER });
    const h = harness();
    const summary = await createCollectorTick(h.deps)();
    expect(summary.outcomes[SERVER_A]).toBe('unreachable');
    expect(h.writes).toEqual([]);
    expectSafeLogs(h.logs);
  });

  it('A1: the deadline bounds the tick; servers not reached are left for the next tick', async () => {
    const h = harness({
      listServers: () => Promise.resolve([SERVER_A, SERVER_B]),
      serverConcurrency: 1,
      deadlineMs: 20,
      connect: (_serverId, _redactor, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener('abort', () => {
            resolve({ ok: false, code: 'SERVER_UNREACHABLE' });
          });
        }),
    });
    const summary = await createCollectorTick(h.deps)();
    expect(summary.outcomes).toEqual({ [SERVER_A]: 'deadline', [SERVER_B]: 'deadline' });
    expect(h.writes).toEqual([]);
    expect(h.prunes).toHaveLength(1);
  });

  it('H1: a server whose connection a deploy holds is skipped without connecting', async () => {
    const h = harness({
      listServers: () => Promise.resolve([SERVER_A, SERVER_B]),
      serverBusy: (serverId) => Promise.resolve(serverId === SERVER_A),
    });
    const summary = await createCollectorTick(h.deps)();
    expect(summary.outcomes).toEqual({ [SERVER_A]: 'busy', [SERVER_B]: 'sampled' });
    expect(h.connects).toEqual([SERVER_B]);
  });

  it('A3: an observation is stored only when the container state changed', async () => {
    const unchanged = container(SERVICE_1, ID_1);
    const last = new Map<string, LastContainerState>([
      [
        SERVICE_1,
        {
          containerId: ID_1,
          observedAtMs: NOW.getTime() - 60_000,
          state: {
            status: 'running',
            running: true,
            restarting: false,
            restartCount: 0,
            oomKilled: false,
            exitCode: 0,
            health: null,
            healthExitCodes: [],
            memoryLimitBytes: null,
            memoryUsedBytes: 1,
          },
        },
      ],
    ]);
    docker.sampleContainers.mockResolvedValue(ok([unchanged, container(SERVICE_2, ID_2)]));
    const h = harness({ lastStates: () => Promise.resolve(last) });
    await createCollectorTick(h.deps)();
    const write = h.writes[0];
    expect(write?.containers).toHaveLength(2);
    expect(write?.observations.map((o) => o.serviceId)).toEqual([SERVICE_2]);
    expect(write?.incidents).toEqual([]);
  });

  it('A3: a new crash loop writes one incident; one already shown in the history does not', async () => {
    const at = (ms: number, restartCount: number): ContainerStatePoint => ({
      observedAtMs: NOW.getTime() - ms,
      state: {
        status: 'restarting',
        running: false,
        restarting: true,
        restartCount,
        oomKilled: false,
        exitCode: 1,
        health: null,
        healthExitCodes: [],
        memoryLimitBytes: null,
        memoryUsedBytes: null,
      },
    });
    docker.sampleContainers.mockResolvedValue(
      ok([container(SERVICE_1, ID_1, { status: 'restarting', running: false, restarting: true, restartCount: 5, exitCode: 1, stats: null })]),
    );
    const fresh = harness({ history: () => Promise.resolve([at(120_000, 1)]) }, { [SERVER_A]: [SERVICE_1] });
    await createCollectorTick(fresh.deps)();
    expect(fresh.writes[0]?.incidents).toEqual([{ serviceId: SERVICE_1, diagnosis: 'crash_loop' }]);
    expect(fresh.logs.some((l) => l.fields.diagnosis === 'crash_loop')).toBe(true);

    const known = harness({ history: () => Promise.resolve([at(300_000, 0), at(120_000, 4)]) }, { [SERVER_A]: [SERVICE_1] });
    await createCollectorTick(known.deps)();
    expect(known.writes[0]?.observations).toHaveLength(1);
    expect(known.writes[0]?.incidents).toEqual([]);
  });

  it('A3: a new OOM writes one incident; an OOM still showing from the last point does not', async () => {
    const oom = container(SERVICE_1, ID_1, { status: 'exited', running: false, oomKilled: true, exitCode: 137, stats: null });
    docker.sampleContainers.mockResolvedValue(ok([oom]));
    const fresh = harness({}, { [SERVER_A]: [SERVICE_1] });
    await createCollectorTick(fresh.deps)();
    expect(fresh.writes[0]?.incidents).toEqual([{ serviceId: SERVICE_1, diagnosis: 'out_of_memory' }]);

    // The last stored point is an hour old (outside the window) and already showed the OOM.
    const last = new Map<string, LastContainerState>([
      [
        SERVICE_1,
        {
          containerId: ID_1,
          observedAtMs: NOW.getTime() - 3_600_000,
          state: {
            status: 'exited',
            running: false,
            restarting: false,
            restartCount: 0,
            oomKilled: true,
            exitCode: 137,
            health: null,
            healthExitCodes: [],
            memoryLimitBytes: 64,
            memoryUsedBytes: null,
          },
        },
      ],
    ]);
    const stale = harness({ lastStates: () => Promise.resolve(last) }, { [SERVER_A]: [SERVICE_1] });
    await createCollectorTick(stale.deps)();
    expect(stale.writes[0]?.observations).toHaveLength(1);
    expect(stale.writes[0]?.incidents).toEqual([]);
  });

  it('H2: one malformed container records a parse error and keeps the host sample and the others', async () => {
    const line = (id: string, name: string, extra: Record<string, unknown> = {}) =>
      `I ${JSON.stringify({
        id,
        name: `/${name}`,
        status: 'running',
        running: true,
        restarting: false,
        restartCount: 0,
        oomKilled: false,
        exitCode: 0,
        startedAt: '2026-11-04T00:00:00.000000000Z',
        finishedAt: '0001-01-01T00:00:00Z',
        health: null,
        healthExitCodes: [],
        memoryLimit: 0,
        ...extra,
      })}`;
    const stdout = [
      line(ID_1, `noodara-${SERVICE_1}`),
      `S ${ID_1}\t1.50%\t10MiB / 1GiB`,
      line(ID_2, `noodara-${SERVICE_2}`, { restartCount: -4, note: SECRET_MARKER }),
      '',
    ].join('\n');
    docker.sampleContainers.mockImplementation(async (ctx: { session: SshDeploySession }) => {
      await ctx.session.stream({} as never, {
        maxDurationMs: 1,
        idleTimeoutMs: 1,
        maxTotalBytes: 1,
        maxLineBytes: 1,
        onChunk: () => undefined,
      });
      return { ok: true, value: { kind: 'unparseable', reason: 'CONTAINER_SAMPLE_MALFORMED' }, result: {} };
    });
    const h = harness({
      connect: () => Promise.resolve({ ok: true, session: fakeSession(stdout), close: () => Promise.resolve() }),
    });
    const summary = await createCollectorTick(h.deps)();
    const write = h.writes[0];
    expect(write?.host).not.toBeNull();
    expect(write?.containers.map((c) => c.serviceId)).toEqual([SERVICE_1]);
    expect(write?.observations).toEqual([
      expect.objectContaining({ kind: 'state', serviceId: SERVICE_1 }),
      { kind: 'parse_error', serviceId: SERVICE_2, containerId: ID_2 },
    ]);
    expect(summary).toMatchObject({ sampled: 1, parseErrors: 1 });
    expect(JSON.stringify(write)).not.toContain(SECRET_MARKER);
    expectSafeLogs(h.logs);
  });

  it('H2: an unparseable host sample still writes the containers', async () => {
    docker.sampleHost.mockResolvedValue({ ok: true, value: { kind: 'unparseable', reason: 'x' }, result: {} });
    const h = harness();
    await createCollectorTick(h.deps)();
    expect(h.writes[0]?.host).toBeNull();
    expect(h.writes[0]?.containers).toHaveLength(2);
  });

  it('A4: prunes with the retention cutoff after sampling; a prune failure never throws', async () => {
    const h = harness();
    await createCollectorTick(h.deps)();
    expect(h.prunes).toEqual([new Date(NOW.getTime() - 168 * 3_600_000)]);

    const failing = harness({ prune: () => Promise.reject(new RangeError(SECRET_MARKER)) });
    const summary = await createCollectorTick(failing.deps)();
    expect(summary.pruned).toBe(0);
    expect(failing.logs.some((l) => l.fields.errorKind === 'RangeError')).toBe(true);
    expectSafeLogs(failing.logs);
  });
});
