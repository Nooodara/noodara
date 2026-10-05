// 12-16: runtime container logs on demand (tail and a bounded follow). The fake session answers
// each allowlisted template by name; a follow is held open until it is aborted or times out.
import { createRedactor } from '@noodara/domain/security';
import type { RemoteCommand, SshDeploySession, StreamOptions, StreamResult } from '@noodara/ssh';
import { describe, expect, it } from 'vitest';
import {
  CONTAINER_LOGS_MESSAGES,
  createContainerLogs,
  DEFAULT_CONTAINER_LOGS_LIMITS,
  resolveTail,
  type ContainerLogLine,
  type ContainerLogsDeps,
  type ContainerLogsLimits,
} from './container-logs.js';

const SERVICE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const SERVER_ID = '5d6e7f80-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
const OTHER_SERVER_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const USER_ID = 'user-1';
const CONTAINER = `noodara-${SERVICE_ID}`;
const STREAM_ID = '3f2b8c1e-9d4a-4f6b-8a2c-1e5d7f9b0c3a';
const WORKSPACE = `/opt/noodara-deploy/${STREAM_ID}`;
const PID_FILE = `${WORKSPACE}/run/logs.pid`;
const RAW = 'permission denied for user root password=hunter2 at /var/lib/docker';
const TS = '2026-10-05T10:00:00.123456789Z';

const LIMITS: ContainerLogsLimits = {
  ...DEFAULT_CONTAINER_LOGS_LIMITS,
  defaultTail: 100,
  followMaxMs: 60_000,
  maxFollowsPerServer: 2,
  maxFollowsPerUser: 2,
  killConfirmTimeoutMs: 1_000,
  killPollIntervalMs: 1,
};

function psLine(name = CONTAINER): string {
  return JSON.stringify({
    ID: 'b'.repeat(64),
    Image: `noodara/${SERVICE_ID}:x`,
    Names: name,
    State: 'running',
    Status: 'Up 2 hours',
    Labels: `noodara.managed=true,noodara.service_id=${SERVICE_ID}`,
    Ports: '',
  });
}

interface Script {
  readonly outcome?: StreamResult['outcome'];
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly reject?: Error;
  /** process.supervise only: emit these chunks, then wait for abort (or end at once). */
  readonly hold?: boolean;
}

interface Call {
  readonly name: string;
  readonly argv: readonly string[];
  readonly options: StreamOptions;
}

class FakeSession {
  readonly calls: Call[] = [];
  closed = 0;
  /** Group state the kill template and group_alive agree on. */
  groupAlive = false;
  private readonly cursors = new Map<string, number>();

  constructor(private readonly scripts: Record<string, Script | Script[]> = {}) {}

  exec(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }

  close(): Promise<void> {
    this.closed += 1;
    return Promise.resolve();
  }

  private next(name: string): Script {
    const entry = this.scripts[name] ?? {};
    if (!Array.isArray(entry)) return entry;
    const index = this.cursors.get(name) ?? 0;
    this.cursors.set(name, index + 1);
    return entry[Math.min(index, entry.length - 1)] ?? {};
  }

  stream(command: RemoteCommand, options: StreamOptions): Promise<StreamResult> {
    this.calls.push({ name: command.name, argv: command.argv, options });
    const defaults: Record<string, Script> = {
      'docker.ps': { stdout: `${psLine()}\n` },
      'process.group_alive': { exitCode: this.groupAlive ? 0 : 1 },
    };
    const script = this.scripts[command.name] === undefined ? (defaults[command.name] ?? {}) : this.next(command.name);
    if (command.name === 'process.kill_group') this.groupAlive = false;
    if (script.reject !== undefined) return Promise.reject(script.reject);
    const stdout = script.stdout ?? '';
    const stderr = script.stderr ?? '';
    let seq = 0;
    if (stdout.length > 0) options.onChunk({ stream: 'stdout', text: stdout, seq: seq++, truncatedLine: false });
    if (stderr.length > 0) options.onChunk({ stream: 'stderr', text: stderr, seq: seq++, truncatedLine: false });
    const result = (outcome: StreamResult['outcome'], exitCode: number | null): StreamResult => ({
      commandName: command.name,
      outcome,
      exitCode,
      exitSignal: null,
      durationMs: 1,
      totalBytes: stdout.length + stderr.length,
      truncated: false,
      stdoutTail: stdout,
      stderrTail: stderr,
    });
    if (command.name === 'process.supervise' && script.hold === true) {
      this.groupAlive = true;
      if (options.signal?.aborted === true) return Promise.resolve(result('aborted', null));
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolve(result('timed_out', null));
        }, options.maxDurationMs);
        options.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve(result('aborted', null));
        });
      });
    }
    return Promise.resolve(result(script.outcome ?? 'completed', script.exitCode === undefined ? 0 : script.exitCode));
  }

  names(): string[] {
    return this.calls.map((call) => call.name);
  }

  call(name: string): Call {
    const found = this.calls.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`no ${name} call`);
    return found;
  }

  asSession(): SshDeploySession {
    return this;
  }
}

function depsFor(
  sessions: FakeSession | FakeSession[],
  overrides: Partial<ContainerLogsDeps> = {},
): ContainerLogsDeps & { connects: string[]; warnings: Record<string, unknown>[] } {
  const queue = Array.isArray(sessions) ? [...sessions] : [sessions];
  const connects: string[] = [];
  const warnings: Record<string, unknown>[] = [];
  return {
    connects,
    warnings,
    connect: (serverId) => {
      connects.push(serverId);
      const session = queue.length > 1 ? queue.shift() : queue[0];
      if (session === undefined) throw new Error('no session');
      return Promise.resolve({ ok: true, session: session.asSession(), close: () => session.close() });
    },
    createRedactor,
    limits: LIMITS,
    newStreamId: () => STREAM_ID,
    logger: { warn: (fields) => warnings.push(fields) },
    ...overrides,
  };
}

async function openAndPump(
  deps: ContainerLogsDeps,
  request: { serverId?: string; userId?: string; signal?: AbortSignal; tail?: number } = {},
) {
  const logs = createContainerLogs(deps);
  const opened = await logs.openFollow({
    serverId: request.serverId ?? SERVER_ID,
    serviceId: SERVICE_ID,
    userId: request.userId ?? USER_ID,
    tail: request.tail ?? 10,
    signal: request.signal ?? new AbortController().signal,
  });
  return { logs, opened };
}

describe('resolveTail', () => {
  it('defaults to the configured tail when absent', () => {
    expect(resolveTail(undefined, LIMITS)).toEqual({ ok: true, value: 100 });
  });

  it.each(['1', '250', '10000'])('accepts %s', (raw) => {
    expect(resolveTail(raw, LIMITS)).toEqual({ ok: true, value: Number(raw) });
  });

  it.each(['0', '-1', '1.5', 'abc', '', ' 5', '10001', '1e3', '0x10', '00012', '99999999999999999999'])(
    'rejects %j with RUNTIME_LOG_TAIL_INVALID',
    (raw) => {
      const result = resolveTail(raw, LIMITS);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('RUNTIME_LOG_TAIL_INVALID');
      expect(result.message).not.toContain(raw.length > 0 ? raw : '\u0000');
    },
  );
});

describe('tail', () => {
  it('returns the last N lines with timestamps, redacted and sanitized, from a plain bounded docker logs', async () => {
    const session = new FakeSession({
      'docker.logs': {
        stdout: `${TS} hello \u001b[31mred\u001b[0m\n${TS} bin\u0000ary\n`,
        stderr: `${TS} oops\n`,
      },
    });
    const deps = depsFor(session);
    const result = await createContainerLogs(deps).tail({ serverId: SERVER_ID, serviceId: SERVICE_ID, tail: 25 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines).toEqual<ContainerLogLine[]>([
      { stream: 'stdout', timestamp: TS, text: 'hello red' },
      { stream: 'stdout', timestamp: TS, text: 'bin�ary' },
      { stream: 'stderr', timestamp: TS, text: 'oops' },
    ]);
    expect(session.names()).toEqual(['docker.ps', 'docker.logs']);
    expect(session.call('docker.logs').argv).toEqual(['docker', 'logs', '--tail', '25', '--timestamps', '--', CONTAINER]);
    const options = session.call('docker.logs').options;
    expect(options.maxDurationMs).toBe(LIMITS.stepMs);
    expect(options.maxTotalBytes).toBe(LIMITS.tailMaxTotalBytes);
    expect(session.closed).toBe(1);
  });

  it('keeps a line without a timestamp as text with a null timestamp', async () => {
    const session = new FakeSession({ 'docker.logs': { stdout: 'no stamp here\n' } });
    const result = await createContainerLogs(depsFor(session)).tail({ serverId: SERVER_ID, serviceId: SERVICE_ID, tail: 5 });

    expect(result.ok && result.lines).toEqual([{ stream: 'stdout', timestamp: null, text: 'no stamp here' }]);
  });

  it('reports CONTAINER_NOT_FOUND when the service has no managed container, without running docker logs', async () => {
    const session = new FakeSession({ 'docker.ps': { stdout: `${psLine('noodara-other')}\n` } });
    const result = await createContainerLogs(depsFor(session)).tail({ serverId: SERVER_ID, serviceId: SERVICE_ID, tail: 5 });

    expect(result).toEqual({ ok: false, code: 'CONTAINER_NOT_FOUND', message: CONTAINER_LOGS_MESSAGES.CONTAINER_NOT_FOUND });
    expect(session.names()).toEqual(['docker.ps']);
  });

  it.each([
    ['a failed connect', { connect: () => Promise.resolve({ ok: false as const, code: 'SERVER_UNREACHABLE' as const }) }, 'SERVER_UNREACHABLE'],
    ['a connect without docker', { connect: () => Promise.resolve({ ok: false as const, code: 'DOCKER_UNAVAILABLE' as const }) }, 'SERVER_DOCKER_UNAVAILABLE'],
    ['a connect that throws', { connect: () => Promise.reject(new Error(RAW)) }, 'SERVER_UNREACHABLE'],
  ])('maps %s to a closed code', async (_label, overrides, code) => {
    const result = await createContainerLogs(depsFor(new FakeSession(), overrides)).tail({
      serverId: SERVER_ID,
      serviceId: SERVICE_ID,
      tail: 5,
    });

    expect(result).toEqual({ ok: false, code, message: CONTAINER_LOGS_MESSAGES[code as keyof typeof CONTAINER_LOGS_MESSAGES] });
  });

  it.each<[string, Record<string, Script>, string]>([
    ['a dropped connection', { 'docker.logs': { reject: new Error(RAW) } }, 'SERVER_UNREACHABLE'],
    ['a docker logs failure', { 'docker.logs': { exitCode: 1, stderr: RAW } }, 'RUNTIME_LOGS_FAILED'],
    ['a missing docker CLI', { 'docker.logs': { exitCode: 127, stderr: RAW } }, 'SERVER_DOCKER_UNAVAILABLE'],
    ['a timed out docker logs', { 'docker.logs': { outcome: 'timed_out', exitCode: null } }, 'RUNTIME_LOGS_TIMEOUT'],
    ['a daemon that is down', { 'docker.ps': { exitCode: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' } }, 'SERVER_DOCKER_UNAVAILABLE'],
  ])('maps %s to a closed code and never returns remote stderr', async (_label, scripts, code) => {
    const session = new FakeSession(scripts);
    const result = await createContainerLogs(depsFor(session)).tail({ serverId: SERVER_ID, serviceId: SERVICE_ID, tail: 5 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(code);
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(JSON.stringify(result)).not.toContain('/var/lib/docker');
    expect(session.closed).toBe(1);
  });

  it('refuses a tail outside the bound before touching the server (defense in depth)', async () => {
    const deps = depsFor(new FakeSession());
    const result = await createContainerLogs(deps).tail({ serverId: SERVER_ID, serviceId: SERVICE_ID, tail: 10_001 });

    expect(result.ok === false && result.code).toBe('RUNTIME_LOG_TAIL_INVALID');
    expect(deps.connects).toEqual([]);
  });
});

describe('follow', () => {
  it('prepares a run dir, launches docker logs --follow under setsid -w with a pidfile, and streams sanitized lines', async () => {
    const session = new FakeSession({
      'process.supervise': { hold: true, stdout: `${TS} tick \u001b[1mbold\u001b[0m\n` },
    });
    const client = new AbortController();
    const { opened } = await openAndPump(depsFor(session), { signal: client.signal });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const lines: ContainerLogLine[] = [];
    const ended = opened.stream.pump((line) => {
      lines.push(line);
      client.abort();
    });
    const end = await ended;

    expect(lines).toEqual([{ stream: 'stdout', timestamp: TS, text: 'tick bold' }]);
    expect(end).toEqual({ reason: 'client_closed', remoteStopped: true });
    expect(session.names()).toEqual([
      'docker.ps',
      'fs.prepare_workspace',
      'process.supervise',
      'process.kill_group',
      'process.group_alive',
      'fs.remove_deploy_dir',
    ]);
    expect(session.call('fs.prepare_workspace').argv.at(-1)).toBe(WORKSPACE);
    expect(session.call('process.supervise').argv).toEqual([
      'setsid',
      '-w',
      'sh',
      '-c',
      'echo $$ > "$0"; exec "$@"',
      PID_FILE,
      'docker',
      'logs',
      '--tail',
      '10',
      '--timestamps',
      '--follow',
      '--',
      CONTAINER,
    ]);
    expect(session.call('process.kill_group').argv.at(-1)).toBe(PID_FILE);
    expect(session.call('fs.remove_deploy_dir').argv.at(-1)).toBe(WORKSPACE);
    expect(session.closed).toBe(1);
  });

  it('ends at the configured max duration and kills the remote group', async () => {
    const session = new FakeSession({ 'process.supervise': { hold: true } });
    const { opened } = await openAndPump(depsFor(session, { limits: { ...LIMITS, followMaxMs: 20 } }));
    if (!opened.ok) throw new Error('expected open');

    const end = await opened.stream.pump(() => undefined);

    expect(end).toEqual({ reason: 'max_duration', remoteStopped: true });
    expect(session.call('process.supervise').options.maxDurationMs).toBe(20);
    expect(session.names()).toContain('process.kill_group');
  });

  it('reports container_exited when docker logs ends on its own, and still confirms the group is gone', async () => {
    const session = new FakeSession({ 'process.supervise': { stdout: `${TS} last\n` } });
    const { opened } = await openAndPump(depsFor(session));
    if (!opened.ok) throw new Error('expected open');

    const end = await opened.stream.pump(() => undefined);

    expect(end).toEqual({ reason: 'container_exited', remoteStopped: true });
    expect(session.names()).toContain('process.group_alive');
  });

  it('stops at the output cap', async () => {
    const big = `${TS} ${'x'.repeat(200)}\n`;
    const session = new FakeSession({ 'process.supervise': { hold: true, stdout: big.repeat(3) } });
    const { opened } = await openAndPump(depsFor(session, { limits: { ...LIMITS, followMaxTotalBytes: 300 } }));
    if (!opened.ok) throw new Error('expected open');

    const end = await opened.stream.pump(() => undefined);

    expect(end.reason).toBe('output_limit');
    expect(end.remoteStopped).toBe(true);
  });

  it('cleans up without launching when the client left before the pump', async () => {
    const session = new FakeSession({ 'process.supervise': { hold: true } });
    const client = new AbortController();
    const { logs, opened } = await openAndPump(depsFor(session), { signal: client.signal });
    if (!opened.ok) throw new Error('expected open');
    client.abort();

    const end = await opened.stream.pump(() => undefined);

    expect(end).toEqual({ reason: 'client_closed', remoteStopped: true });
    expect(session.names()).not.toContain('process.supervise');
    expect(session.names()).toContain('fs.remove_deploy_dir');
    expect(logs.activeFollows()).toBe(0);
  });

  it('retries the kill on a fresh connection when the stream connection dropped, and only then removes the run dir', async () => {
    const first = new FakeSession({
      'process.supervise': { reject: new Error(RAW) },
      'process.kill_group': { reject: new Error(RAW) },
    });
    first.groupAlive = true;
    const second = new FakeSession();
    second.groupAlive = true;
    const deps = depsFor([first, second]);
    const { opened } = await openAndPump(deps);
    if (!opened.ok) throw new Error('expected open');

    const end = await opened.stream.pump(() => undefined);

    expect(end).toEqual({ reason: 'connection_lost', remoteStopped: true });
    expect(deps.connects).toEqual([SERVER_ID, SERVER_ID]);
    expect(second.names()).toEqual(['process.kill_group', 'process.group_alive', 'fs.remove_deploy_dir']);
    expect(first.names()).not.toContain('fs.remove_deploy_dir');
    expect(first.closed).toBe(1);
    expect(second.closed).toBe(1);
  });

  it('keeps the pidfile and logs ids only when the kill cannot be confirmed', async () => {
    const session = new FakeSession({
      'process.supervise': { hold: true },
      'process.group_alive': { exitCode: 0 },
    });
    const deps = depsFor(session, { limits: { ...LIMITS, followMaxMs: 10, killConfirmTimeoutMs: 20 } });
    const { opened } = await openAndPump(deps);
    if (!opened.ok) throw new Error('expected open');

    const end = await opened.stream.pump(() => undefined);

    expect(end).toEqual({ reason: 'max_duration', remoteStopped: false });
    expect(session.names()).not.toContain('fs.remove_deploy_dir');
    expect(deps.warnings).toHaveLength(1);
    expect(JSON.stringify(deps.warnings)).not.toContain('hunter2');
    expect(deps.warnings[0]).toMatchObject({ serverId: SERVER_ID, serviceId: SERVICE_ID });
  });

  it.each<[string, Record<string, Script>, string]>([
    ['a missing container', { 'docker.ps': { stdout: '' } }, 'CONTAINER_NOT_FOUND'],
    ['a failed run dir', { 'fs.prepare_workspace': { exitCode: 1, stderr: RAW } }, 'RUNTIME_LOGS_FAILED'],
    ['a dropped connection while preparing', { 'fs.prepare_workspace': { reject: new Error(RAW) } }, 'SERVER_UNREACHABLE'],
  ])('fails the open on %s with a closed code, closing the connection and freeing the slot', async (_l, scripts, code) => {
    const session = new FakeSession(scripts);
    const { logs, opened } = await openAndPump(depsFor(session));

    expect(opened).toEqual({ ok: false, code, message: CONTAINER_LOGS_MESSAGES[code as keyof typeof CONTAINER_LOGS_MESSAGES] });
    expect(session.names()).not.toContain('process.supervise');
    expect(session.closed).toBe(1);
    expect(logs.activeFollows()).toBe(0);
  });
});

describe('follow caps (H1)', () => {
  function holdingDeps(limits: Partial<ContainerLogsLimits> = {}) {
    return depsFor(new FakeSession({ 'process.supervise': { hold: true } }), { limits: { ...LIMITS, ...limits } });
  }

  it('caps concurrent follows per server with RUNTIME_LOG_FOLLOW_LIMIT_REACHED, before connecting', async () => {
    const deps = holdingDeps({ maxFollowsPerServer: 1, maxFollowsPerUser: 5 });
    const logs = createContainerLogs(deps);
    const request = { serviceId: SERVICE_ID, tail: 5, signal: new AbortController().signal };

    const first = await logs.openFollow({ ...request, serverId: SERVER_ID, userId: 'a' });
    const second = await logs.openFollow({ ...request, serverId: SERVER_ID, userId: 'b' });
    const otherServer = await logs.openFollow({ ...request, serverId: OTHER_SERVER_ID, userId: 'b' });

    expect(first.ok).toBe(true);
    expect(second).toEqual({
      ok: false,
      code: 'RUNTIME_LOG_FOLLOW_LIMIT_REACHED',
      message: CONTAINER_LOGS_MESSAGES.RUNTIME_LOG_FOLLOW_LIMIT_REACHED,
    });
    expect(otherServer.ok).toBe(true);
    expect(deps.connects).toEqual([SERVER_ID, OTHER_SERVER_ID]);
    await logs.closeAll();
  });

  it('caps concurrent follows per user', async () => {
    const logs = createContainerLogs(holdingDeps({ maxFollowsPerServer: 5, maxFollowsPerUser: 1 }));
    const request = { serviceId: SERVICE_ID, tail: 5, signal: new AbortController().signal, userId: USER_ID };

    expect((await logs.openFollow({ ...request, serverId: SERVER_ID })).ok).toBe(true);
    const second = await logs.openFollow({ ...request, serverId: OTHER_SERVER_ID });

    expect(second.ok === false && second.code).toBe('RUNTIME_LOG_FOLLOW_LIMIT_REACHED');
    await logs.closeAll();
  });

  it('frees the slot when the stream ends', async () => {
    const logs = createContainerLogs(holdingDeps({ maxFollowsPerServer: 1, followMaxMs: 5 }));
    const request = { serverId: SERVER_ID, serviceId: SERVICE_ID, userId: USER_ID, tail: 5, signal: new AbortController().signal };

    const first = await logs.openFollow(request);
    if (!first.ok) throw new Error('expected open');
    expect(logs.activeFollows()).toBe(1);
    await first.stream.pump(() => undefined);

    expect(logs.activeFollows()).toBe(0);
    const again = await logs.openFollow(request);
    expect(again.ok).toBe(true);
    await logs.closeAll();
  });

  it('closeAll ends every open follow and kills its remote group (shutdown)', async () => {
    const session = new FakeSession({ 'process.supervise': { hold: true } });
    const logs = createContainerLogs(depsFor(session));
    const opened = await logs.openFollow({
      serverId: SERVER_ID,
      serviceId: SERVICE_ID,
      userId: USER_ID,
      tail: 5,
      signal: new AbortController().signal,
    });
    if (!opened.ok) throw new Error('expected open');
    const ended = opened.stream.pump(() => undefined);

    await logs.closeAll();

    expect(await ended).toEqual({ reason: 'shutdown', remoteStopped: true });
    expect(session.names()).toContain('process.kill_group');
    expect(logs.activeFollows()).toBe(0);
  });

  it('a throwing onLine never crashes the pump; the stream ends and the group is killed', async () => {
    const session = new FakeSession({ 'process.supervise': { hold: true, stdout: `${TS} a\n` } });
    const { opened } = await openAndPump(depsFor(session));
    if (!opened.ok) throw new Error('expected open');

    const end = await opened.stream.pump(() => {
      throw new Error('socket gone');
    });

    expect(end).toEqual({ reason: 'client_closed', remoteStopped: true });
  });
});
