// 12-15: the reconcile tick (A1-A4, H1) against fake ports; the real-infra proof is
// tests/integration/deploy-engine/runtime-reconcile.test.ts.
import { createRedactor } from '@noodara/domain/security';
import type { ServiceStatus } from '@noodara/domain/deployment';
import type { RemoteCommand, SshDeploySession, StreamChunk, StreamOptions, StreamResult } from '@noodara/ssh';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectResult } from '../deploy/deploy-worker.js';
import type { ServerEvent } from '../events/server-event-publisher.js';
import type { ServiceView } from '../services/service-view.js';
import { createReconcileTick, type ReconcileServiceRow, type ReconcileTickDeps } from './reconcile-tick.js';

const SERVER_A = '5d6e7f80-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
const SERVER_B = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SVC_1 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const SVC_2 = '3f2b8c1e-9d4a-4f6b-8a2c-1e5d7f9b0c3a';
const SVC_3 = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';
const COMMAND_MS = 4_321;

function psLine(serviceId: string, state: 'running' | 'exited', exitCode = 0): string {
  return JSON.stringify({
    ID: `id-${serviceId}`,
    Image: `noodara/${serviceId}:x`,
    Names: `noodara-${serviceId}`,
    State: state,
    Status: state === 'running' ? 'Up 2 minutes' : `Exited (${String(exitCode)}) 3 seconds ago`,
    Labels: 'noodara.managed=true',
    Ports: '',
  });
}

interface FakeServer {
  stdout: string;
  exitCode?: number;
  stderr?: string;
  unreachable?: boolean;
  delayMs?: number;
}

function fakeSessions(servers: Record<string, FakeServer>) {
  const calls: { serverId: string; command: RemoteCommand; options: StreamOptions }[] = [];
  const closed: string[] = [];
  const connect = vi.fn<(serverId: string) => Promise<ConnectResult>>((serverId: string) => {
    const server = servers[serverId];
    if (server === undefined || server.unreachable === true) {
      return Promise.resolve({ ok: false as const, code: 'SERVER_UNREACHABLE' as const });
    }
    const session = {
      exec: () => Promise.reject(new Error('unused')),
      close: () => Promise.resolve(),
      stream: async (command: RemoteCommand, options: StreamOptions): Promise<StreamResult> => {
        calls.push({ serverId, command, options });
        if (server.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, server.delayMs));
        const chunk: StreamChunk = { stream: 'stdout', text: server.stdout, seq: 1, truncatedLine: false };
        options.onChunk(chunk);
        return {
          commandName: command.name,
          outcome: 'completed',
          exitCode: server.exitCode ?? 0,
          exitSignal: null,
          durationMs: 1,
          totalBytes: server.stdout.length,
          truncated: false,
          stdoutTail: server.stdout,
          stderrTail: server.stderr ?? '',
        };
      },
    } as unknown as SshDeploySession;
    return Promise.resolve({
      ok: true as const,
      session,
      close: () => {
        closed.push(serverId);
        return Promise.resolve();
      },
    });
  });
  return { connect, calls, closed };
}

function row(serviceId: string, cachedStatus: ServiceStatus, overrides: Partial<ReconcileServiceRow> = {}): ReconcileServiceRow {
  return {
    serviceId,
    cachedStatus,
    latestDeployment: { status: 'SUCCESS' },
    activeDeployment: false,
    ...overrides,
  };
}

function viewOf(serviceId: string, serverId: string, status: ServiceStatus): ServiceView {
  return {
    id: serviceId,
    projectId: 'p',
    environmentId: 'e',
    serverId,
    name: 'api',
    sourceType: 'image',
    repositoryUrl: null,
    branch: null,
    buildContext: null,
    dockerfilePath: null,
    buildTarget: null,
    imageRef: 'nginx:1.27',
    internalPort: 80,
    publishedPort: null,
    status,
    createdAt: '2026-10-05T10:00:00.000Z',
    updatedAt: '2026-10-05T10:00:01.000Z',
  };
}

function harness(input: {
  servers: Record<string, FakeServer>;
  rows: Record<string, ReconcileServiceRow[]>;
  inFlight?: string[];
  overrides?: Partial<ReconcileTickDeps>;
}) {
  const sessions = fakeSessions(input.servers);
  const events: ServerEvent[] = [];
  const statusWrites: { serviceId: string; expected: ServiceStatus; status: ServiceStatus }[] = [];
  const discrepancies: { serviceId: string; serverId: string; kind: string }[] = [];
  const logs: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const deps: ReconcileTickDeps = {
    listServers: () => Promise.resolve(Object.keys(input.rows)),
    loadServices: (serverId) => Promise.resolve(input.rows[serverId] ?? []),
    operationInFlight: (serviceId) => Promise.resolve(input.inFlight?.includes(serviceId) ?? false),
    connect: sessions.connect,
    createRedactor,
    commandMs: COMMAND_MS,
    writeStatus: (write) => {
      statusWrites.push(write);
      const serverId = Object.keys(input.rows).find((id) => input.rows[id]?.some((r) => r.serviceId === write.serviceId));
      return Promise.resolve(viewOf(write.serviceId, serverId ?? '', write.status));
    },
    recordDiscrepancy: (discrepancy) => {
      discrepancies.push({ serviceId: discrepancy.serviceId, serverId: discrepancy.serverId, kind: discrepancy.kind });
      return Promise.resolve(viewOf(discrepancy.serviceId, discrepancy.serverId, 'STOPPED'));
    },
    events: {
      publish: (event) => {
        events.push(event);
        return Promise.resolve();
      },
    },
    logger: {
      info: (fields, message) => logs.push({ level: 'info', fields, message }),
      warn: (fields, message) => logs.push({ level: 'warn', fields, message }),
      error: (fields, message) => logs.push({ level: 'error', fields, message }),
    },
    ...input.overrides,
  };
  return { tick: createReconcileTick(deps), sessions, events, statusWrites, discrepancies, logs };
}

describe('createReconcileTick', () => {
  it('A1: runs exactly one docker ps --size=false per server, never per service, bounded by commandMs', async () => {
    const h = harness({
      servers: {
        [SERVER_A]: { stdout: `${psLine(SVC_1, 'running')}\n${psLine(SVC_2, 'running')}\n` },
        [SERVER_B]: { stdout: `${psLine(SVC_3, 'running')}\n` },
      },
      rows: {
        [SERVER_A]: [row(SVC_1, 'RUNNING'), row(SVC_2, 'RUNNING')],
        [SERVER_B]: [row(SVC_3, 'RUNNING')],
      },
    });
    await h.tick();
    expect(h.sessions.calls).toHaveLength(2);
    expect(h.sessions.calls.map((c) => c.serverId).sort()).toEqual([SERVER_A, SERVER_B].sort());
    for (const call of h.sessions.calls) {
      expect(call.command.name).toBe('docker.ps');
      expect(call.command.argv).toContain('--size=false');
      expect(call.options.maxDurationMs).toBe(COMMAND_MS);
      expect(call.options.idleTimeoutMs).toBe(COMMAND_MS);
    }
    expect(h.sessions.closed.sort()).toEqual([SERVER_A, SERVER_B].sort());
  });

  it('A2: an unchanged container state writes and emits nothing', async () => {
    const h = harness({
      servers: { [SERVER_A]: { stdout: `${psLine(SVC_1, 'running')}\n${psLine(SVC_2, 'exited', 0)}\n` } },
      rows: { [SERVER_A]: [row(SVC_1, 'RUNNING'), row(SVC_2, 'STOPPED')] },
    });
    const summary = await h.tick();
    expect(h.statusWrites).toEqual([]);
    expect(h.discrepancies).toEqual([]);
    expect(h.events).toEqual([]);
    expect(summary.updated).toBe(0);
  });

  it('A2: a changed state updates the cache (compare-and-set) and emits service.updated', async () => {
    const h = harness({
      servers: { [SERVER_A]: { stdout: `${psLine(SVC_1, 'running')}\n` } },
      rows: { [SERVER_A]: [row(SVC_1, 'STOPPED')] },
    });
    const summary = await h.tick();
    expect(h.statusWrites).toEqual([{ serviceId: SVC_1, expected: 'STOPPED', status: 'RUNNING' }]);
    expect(h.events).toEqual([{ type: 'service.updated', service: viewOf(SVC_1, SERVER_A, 'RUNNING') }]);
    expect(summary.updated).toBe(1);
  });

  it('A2: a lost compare-and-set (someone else wrote the cache) emits nothing', async () => {
    const h = harness({
      servers: { [SERVER_A]: { stdout: `${psLine(SVC_1, 'running')}\n` } },
      rows: { [SERVER_A]: [row(SVC_1, 'STOPPED')] },
      overrides: { writeStatus: () => Promise.resolve(null) },
    });
    await h.tick();
    expect(h.events).toEqual([]);
  });

  it('A3: running -> exited outside Noodara records one discrepancy and emits service.updated', async () => {
    const h = harness({
      servers: { [SERVER_A]: { stdout: `${psLine(SVC_1, 'exited', 137)}\n` } },
      rows: { [SERVER_A]: [row(SVC_1, 'RUNNING')] },
    });
    const summary = await h.tick();
    expect(h.discrepancies).toEqual([{ serviceId: SVC_1, serverId: SERVER_A, kind: 'stopped_outside_noodara' }]);
    expect(h.statusWrites).toEqual([]);
    expect(h.events).toHaveLength(1);
    expect(summary.discrepancies).toBe(1);
  });

  it('A3: running -> removed outside Noodara records one removal discrepancy', async () => {
    const h = harness({
      servers: { [SERVER_A]: { stdout: '' } },
      rows: { [SERVER_A]: [row(SVC_1, 'RUNNING')] },
    });
    await h.tick();
    expect(h.discrepancies).toEqual([{ serviceId: SVC_1, serverId: SERVER_A, kind: 'removed_outside_noodara' }]);
  });

  it('A3: the next tick over a cached STOPPED never repeats the event (exited or removed)', async () => {
    const exited = harness({
      servers: { [SERVER_A]: { stdout: `${psLine(SVC_1, 'exited', 137)}\n` } },
      rows: { [SERVER_A]: [row(SVC_1, 'STOPPED')] },
    });
    await exited.tick();
    const removed = harness({
      servers: { [SERVER_A]: { stdout: '' } },
      rows: { [SERVER_A]: [row(SVC_1, 'STOPPED')] },
    });
    await removed.tick();
    for (const h of [exited, removed]) {
      expect(h.discrepancies).toEqual([]);
      expect(h.statusWrites).toEqual([]);
      expect(h.events).toEqual([]);
    }
  });

  it('A4: an unreachable server marks its services UNKNOWN (never STOPPED) and the other server still reconciles', async () => {
    const h = harness({
      servers: {
        [SERVER_A]: { stdout: '', unreachable: true },
        [SERVER_B]: { stdout: `${psLine(SVC_3, 'exited', 1)}\n` },
      },
      rows: {
        [SERVER_A]: [row(SVC_1, 'RUNNING'), row(SVC_2, 'STOPPED')],
        [SERVER_B]: [row(SVC_3, 'RUNNING')],
      },
    });
    const summary = await h.tick();
    expect(h.statusWrites).toEqual(
      expect.arrayContaining([
        { serviceId: SVC_1, expected: 'RUNNING', status: 'UNKNOWN' },
        { serviceId: SVC_2, expected: 'STOPPED', status: 'UNKNOWN' },
      ]),
    );
    expect(h.statusWrites.some((w) => w.status === 'STOPPED')).toBe(false);
    expect(h.discrepancies).toEqual([{ serviceId: SVC_3, serverId: SERVER_B, kind: 'stopped_outside_noodara' }]);
    expect(summary.unreachable).toBe(1);
  });

  it('A4: an unreachable daemon or a failed/timed-out docker ps is UNKNOWN too', async () => {
    const h = harness({
      servers: { [SERVER_A]: { stdout: '', exitCode: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' } },
      rows: { [SERVER_A]: [row(SVC_1, 'RUNNING')] },
    });
    await h.tick();
    expect(h.statusWrites).toEqual([{ serviceId: SVC_1, expected: 'RUNNING', status: 'UNKNOWN' }]);
    expect(h.discrepancies).toEqual([]);
  });

  it('A4: a throwing connect is UNKNOWN; a throwing store for one server never crashes the tick', async () => {
    const h = harness({
      servers: { [SERVER_B]: { stdout: `${psLine(SVC_3, 'running')}\n` } },
      rows: { [SERVER_A]: [row(SVC_1, 'RUNNING')], [SERVER_B]: [row(SVC_3, 'STOPPED')] },
    });
    const real = h.sessions.connect.getMockImplementation();
    h.sessions.connect.mockImplementation((serverId: string) => {
      if (serverId === SERVER_A) return Promise.reject(new Error('ssh://user:pw@host boom'));
      if (real === undefined) throw new Error('fixture');
      return real(serverId);
    });
    await h.tick();
    expect(h.statusWrites).toContainEqual({ serviceId: SVC_1, expected: 'RUNNING', status: 'UNKNOWN' });
    expect(h.statusWrites).toContainEqual({ serviceId: SVC_3, expected: 'STOPPED', status: 'RUNNING' });

    const broken = harness({
      servers: { [SERVER_B]: { stdout: `${psLine(SVC_3, 'running')}\n` } },
      rows: { [SERVER_A]: [row(SVC_1, 'RUNNING')], [SERVER_B]: [row(SVC_3, 'STOPPED')] },
      overrides: {
        loadServices: (serverId) =>
          serverId === SERVER_A
            ? Promise.reject(new Error('postgres://user:pw@db boom'))
            : Promise.resolve([row(SVC_3, 'STOPPED')]),
      },
    });
    const summary = await broken.tick();
    expect(broken.statusWrites).toEqual([{ serviceId: SVC_3, expected: 'STOPPED', status: 'RUNNING' }]);
    expect(summary.failed).toBe(1);
    expect(JSON.stringify([h.logs, broken.logs])).not.toContain('pw@');
  });

  it('H1: a service with an active deployment or a queued operation is skipped, never written', async () => {
    const h = harness({
      servers: { [SERVER_A]: { stdout: '' } },
      rows: {
        [SERVER_A]: [
          row(SVC_1, 'DEPLOYING', { activeDeployment: true, latestDeployment: { status: 'BUILDING' } }),
          row(SVC_2, 'RUNNING'),
        ],
      },
      inFlight: [SVC_2],
    });
    const summary = await h.tick();
    expect(h.statusWrites).toEqual([]);
    expect(h.discrepancies).toEqual([]);
    expect(h.events).toEqual([]);
    expect(summary.skipped).toBe(2);
  });

  it('a server with no services left is not connected to', async () => {
    const h = harness({ servers: { [SERVER_A]: { stdout: '' } }, rows: { [SERVER_A]: [] } });
    await h.tick();
    expect(h.sessions.connect).not.toHaveBeenCalled();
  });
});
