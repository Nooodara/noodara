// 12-16: runtime container logs on demand (tail and a bounded follow). The fake session answers
// each allowlisted template by name; a follow is held open until it is aborted or times out.
import { createRedactor, type Redactor } from '@noodara/domain/security';
import type { RemoteCommand, SshDeploySession, StreamOptions, StreamResult } from '@noodara/ssh';
import { describe, expect, it, vi } from 'vitest';
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
const WORKSPACE = `.noodara/deploy/${STREAM_ID}`;
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
  redactor?: Redactor;
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
    if (stdout.length > 0) options.onChunk({ stream: 'stdout', text: this.redactor?.redact(stdout) ?? stdout, seq: seq++, truncatedLine: false });
    if (stderr.length > 0) options.onChunk({ stream: 'stderr', text: this.redactor?.redact(stderr) ?? stderr, seq: seq++, truncatedLine: false });
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
    connect: (serverId, redactor) => {
      connects.push(serverId);
      const session = queue.length > 1 ? queue.shift() : queue[0];
      if (session === undefined) throw new Error('no session');
      session.redactor = redactor;
      return Promise.resolve({ ok: true, session: session.asSession(), close: () => session.close() });
    },
    openRedactor: () => Promise.resolve({ redactor: createRedactor(), release: () => undefined }),
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
    projectId: 'project-1', environmentId: 'environment-1', serviceId: SERVICE_ID,
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
      // Fixed copy: the raw value is never echoed back.
      expect(result.message).toBe(CONTAINER_LOGS_MESSAGES.RUNTIME_LOG_TAIL_INVALID);
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
    const result = await createContainerLogs(deps).tail({ serverId: SERVER_ID, projectId: 'project-1', environmentId: 'environment-1', serviceId: SERVICE_ID, tail: 25 });

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
    const result = await createContainerLogs(depsFor(session)).tail({ serverId: SERVER_ID, projectId: 'project-1', environmentId: 'environment-1', serviceId: SERVICE_ID, tail: 5 });

    expect(result.ok && result.lines).toEqual([{ stream: 'stdout', timestamp: null, text: 'no stamp here' }]);
  });

  // 25-03 (UAT F1): docker logs writes stdout and stderr on separate channels, so chunks arrive
  // grouped by stream; the tail must come back in timestamp order.
  it('orders interleaved stdout and stderr lines by their Docker timestamp', async () => {
    const session = new FakeSession({
      'docker.logs': {
        stdout: '2026-10-05T08:08:42.000000002Z GET / 200\n2026-10-05T08:08:44.5Z GET /a 200\n',
        stderr: '2026-10-05T08:08:38.123456789Z worker started\n2026-10-05T08:08:42.000000001Z warn: slow\n',
      },
    });
    const result = await createContainerLogs(depsFor(session)).tail({ serverId: SERVER_ID, projectId: 'project-1', environmentId: 'environment-1', serviceId: SERVICE_ID, tail: 5 });

    expect(result.ok && result.lines.map((line) => line.text)).toEqual(['worker started', 'warn: slow', 'GET / 200', 'GET /a 200']);
  });

  it('sorts stably: equal timestamps keep their arrival order', async () => {
    const session = new FakeSession({
      'docker.logs': { stdout: `${TS} out-1\n${TS} out-2\n`, stderr: `${TS} err-1\n` },
    });
    const result = await createContainerLogs(depsFor(session)).tail({ serverId: SERVER_ID, projectId: 'project-1', environmentId: 'environment-1', serviceId: SERVICE_ID, tail: 5 });

    expect(result.ok && result.lines.map((line) => line.text)).toEqual(['out-1', 'out-2', 'err-1']);
  });

  it('compares timestamps with an offset by their instant, not their text', async () => {
    const session = new FakeSession({
      'docker.logs': { stdout: '2026-10-05T10:00:00+02:00 later-text-earlier\n', stderr: '2026-10-05T09:00:00Z earlier-text-later\n' },
    });
    const result = await createContainerLogs(depsFor(session)).tail({ serverId: SERVER_ID, projectId: 'project-1', environmentId: 'environment-1', serviceId: SERVICE_ID, tail: 5 });

    expect(result.ok && result.lines.map((line) => line.text)).toEqual(['later-text-earlier', 'earlier-text-later']);
  });

  it('keeps a line without a timestamp right after the previous timestamped line of its stream', async () => {
    const session = new FakeSession({
      'docker.logs': {
        stdout: 'leading rest\n2026-10-05T08:08:42Z long line head\nlong line rest\n2026-10-05T08:08:45Z next\n',
        stderr: '2026-10-05T08:08:40Z err-a\n2026-10-05T08:08:43Z err-b\n',
      },
    });
    const result = await createContainerLogs(depsFor(session)).tail({ serverId: SERVER_ID, projectId: 'project-1', environmentId: 'environment-1', serviceId: SERVICE_ID, tail: 10 });

    expect(result.ok && result.lines.map((line) => line.text)).toEqual([
      'leading rest',
      'err-a',
      'long line head',
      'long line rest',
      'err-b',
      'next',
    ]);
  });

  it('reports CONTAINER_NOT_FOUND when the service has no managed container, without running docker logs', async () => {
    const session = new FakeSession({ 'docker.ps': { stdout: `${psLine('noodara-other')}\n` } });
    const result = await createContainerLogs(depsFor(session)).tail({ serverId: SERVER_ID, projectId: 'project-1', environmentId: 'environment-1', serviceId: SERVICE_ID, tail: 5 });

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
      projectId: 'project-1', environmentId: 'environment-1', serviceId: SERVICE_ID,
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
    const result = await createContainerLogs(depsFor(session)).tail({ serverId: SERVER_ID, projectId: 'project-1', environmentId: 'environment-1', serviceId: SERVICE_ID, tail: 5 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(code);
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(JSON.stringify(result)).not.toContain('/var/lib/docker');
    expect(session.closed).toBe(1);
  });

  it('refuses a tail outside the bound before touching the server (defense in depth)', async () => {
    const deps = depsFor(new FakeSession());
    const result = await createContainerLogs(deps).tail({ serverId: SERVER_ID, projectId: 'project-1', environmentId: 'environment-1', serviceId: SERVICE_ID, tail: 10_001 });

    expect(result.ok ? null : result.code).toBe('RUNTIME_LOG_TAIL_INVALID');
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
    const request = { projectId: 'project-1', environmentId: 'environment-1', serviceId: SERVICE_ID, tail: 5, signal: new AbortController().signal };

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
    const request = { projectId: 'project-1', environmentId: 'environment-1', serviceId: SERVICE_ID, tail: 5, signal: new AbortController().signal, userId: USER_ID };

    expect((await logs.openFollow({ ...request, serverId: SERVER_ID })).ok).toBe(true);
    const second = await logs.openFollow({ ...request, serverId: OTHER_SERVER_ID });

    expect(second.ok ? null : second.code).toBe('RUNTIME_LOG_FOLLOW_LIMIT_REACHED');
    await logs.closeAll();
  });

  it('frees the slot when the stream ends', async () => {
    const logs = createContainerLogs(holdingDeps({ maxFollowsPerServer: 1, followMaxMs: 5 }));
    const request = { serverId: SERVER_ID, projectId: 'project-1', environmentId: 'environment-1', serviceId: SERVICE_ID, userId: USER_ID, tail: 5, signal: new AbortController().signal };

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
      projectId: 'project-1', environmentId: 'environment-1', serviceId: SERVICE_ID,
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

  it('closeAll never hangs on an opened but un-pumped stream; it frees the slot and the run dir', async () => {
    const session = new FakeSession({ 'process.supervise': { hold: true } });
    const logs = createContainerLogs(depsFor(session));
    const opened = await logs.openFollow({
      serverId: SERVER_ID,
      projectId: 'project-1', environmentId: 'environment-1', serviceId: SERVICE_ID,
      userId: USER_ID,
      tail: 5,
      signal: new AbortController().signal,
    });
    if (!opened.ok) throw new Error('expected open');

    await logs.closeAll();

    expect(logs.activeFollows()).toBe(0);
    expect(session.names()).not.toContain('process.supervise');
    expect(session.names()).toContain('fs.remove_deploy_dir');
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

// Phase 33 RED: an ordinary app secret has no structural provider pattern.
describe('scoped app-secret regression', () => {
  it('opens the scoped lease before reading ordinary secret output', async () => {
    const raw = 'ordinary-app-canary-482013';
    const session = new FakeSession({ 'docker.logs': { stdout: `${raw}\n` } });
    let released = 0;
    const scoped = { openRedactor: () => {
      const redactor = createRedactor();
      redactor.register(raw, 'app_secret');
      return Promise.resolve({ redactor, release: () => { released += 1; redactor.release(raw); } });
    } };
    const result = await createContainerLogs(depsFor(session, { ...scoped })).tail({ serverId: SERVER_ID, projectId: 'project-1', environmentId: 'environment-1', serviceId: SERVICE_ID, tail: 1 });
    expect(JSON.stringify(result)).not.toContain(raw);
    expect(released).toBe(1);
  });
});

const SCOPE_REQUEST = { projectId: 'project-1', environmentId: 'environment-1', serviceId: SERVICE_ID, serverId: SERVER_ID, tail: 5 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function trackedLease() {
  const redactor = createRedactor();
  const raw = 'ordinary-lifecycle-secret-9182';
  redactor.register(raw, 'app_secret');
  const release = vi.fn(() => { redactor.release(raw); });
  return { redactor, raw, release };
}

describe('scoped lease lifetime', () => {
  it.each(['tail', 'follow'] as const)('fails closed on a rejected %s lease without SSH or logger text', async (kind) => {
    const deps = depsFor(new FakeSession(), { openRedactor: () => Promise.reject(new Error(RAW)) });
    const logs = createContainerLogs(deps);
    const result = kind === 'tail' ? await logs.tail(SCOPE_REQUEST) : await logs.openFollow({ ...SCOPE_REQUEST, userId: USER_ID, signal: new AbortController().signal });
    expect(result).toEqual({ ok: false, code: 'RUNTIME_LOGS_FAILED', message: CONTAINER_LOGS_MESSAGES.RUNTIME_LOGS_FAILED });
    expect(deps.connects).toEqual([]);
    expect(deps.warnings).toEqual([]);
    expect(logs.activeFollows()).toBe(0);
  });

  it.each(['deadline', 'abort', 'shutdown'] as const)('bounds a stalled opener on %s and releases a late lease exactly once', async (stop) => {
    vi.useFakeTimers();
    try {
      const lease = trackedLease();
      const pending = deferred<ReturnType<typeof trackedLease>>();
      const deps = depsFor(new FakeSession(), { openRedactor: () => pending.promise, limits: { ...LIMITS, stepMs: 20 } });
      const logs = createContainerLogs(deps);
      const client = new AbortController();
      const opening = logs.openFollow({ ...SCOPE_REQUEST, userId: USER_ID, signal: client.signal });
      await Promise.resolve();
      expect(logs.activeFollows()).toBe(1);
      if (stop === 'deadline') await vi.advanceTimersByTimeAsync(20);
      if (stop === 'abort') client.abort();
      if (stop === 'shutdown') await logs.closeAll();
      expect(await opening).toMatchObject({ ok: false, code: 'RUNTIME_LOGS_FAILED' });
      expect(logs.activeFollows()).toBe(0);
      pending.resolve(lease);
      await vi.runAllTimersAsync();
      expect(lease.release).toHaveBeenCalledTimes(1);
      expect(deps.connects).toEqual([]);
      expect(deps.warnings).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it.each(['deadline', 'abort', 'shutdown'] as const)('consumes a late opener rejection after %s', async (stop) => {
    vi.useFakeTimers();
    try {
      const pending = deferred<ReturnType<typeof trackedLease>>();
      const deps = depsFor(new FakeSession(), { openRedactor: () => pending.promise, limits: { ...LIMITS, stepMs: 20 } });
      const logs = createContainerLogs(deps);
      const client = new AbortController();
      const opening = logs.openFollow({ ...SCOPE_REQUEST, userId: USER_ID, signal: client.signal });
      await Promise.resolve();
      if (stop === 'deadline') await vi.advanceTimersByTimeAsync(20);
      if (stop === 'abort') client.abort();
      if (stop === 'shutdown') await logs.closeAll();
      expect(await opening).toMatchObject({ ok: false, code: 'RUNTIME_LOGS_FAILED' });
      pending.reject(new Error(RAW));
      await vi.runAllTimersAsync();
      expect(logs.activeFollows()).toBe(0);
      expect(deps.connects).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('bounds a stalled tail lease and releases its late result', async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred<ReturnType<typeof trackedLease>>();
      const lease = trackedLease();
      const deps = depsFor(new FakeSession(), { openRedactor: () => pending.promise, limits: { ...LIMITS, stepMs: 20 } });
      const tail = createContainerLogs(deps).tail(SCOPE_REQUEST);
      await vi.advanceTimersByTimeAsync(20);
      expect(await tail).toMatchObject({ ok: false, code: 'RUNTIME_LOGS_FAILED' });
      pending.resolve(lease);
      await vi.runAllTimersAsync();
      expect(lease.release).toHaveBeenCalledTimes(1);
      expect(deps.connects).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('never opens leases for invalid tail or rejected capacity', async () => {
    const openRedactor = vi.fn(() => Promise.resolve(trackedLease()));
    const logs = createContainerLogs(depsFor(new FakeSession(), { openRedactor, limits: { ...LIMITS, maxFollowsPerServer: 1 } }));
    await logs.tail({ ...SCOPE_REQUEST, tail: 0 });
    await logs.openFollow({ ...SCOPE_REQUEST, tail: 0, userId: USER_ID, signal: new AbortController().signal });
    expect(openRedactor).not.toHaveBeenCalled();
    const request = { ...SCOPE_REQUEST, userId: USER_ID, signal: new AbortController().signal };
    expect((await logs.openFollow(request)).ok).toBe(true);
    expect(await logs.openFollow(request)).toMatchObject({ ok: false, code: 'RUNTIME_LOG_FOLLOW_LIMIT_REACHED' });
    expect(openRedactor).toHaveBeenCalledTimes(1);
    await logs.closeAll();
  });

  it.each([
    ['success', {}], ['output timeout', { 'docker.logs': { outcome: 'timed_out' as const } }],
    ['container failure', { 'docker.ps': { stdout: '' } }],
    ['output failure', { 'docker.logs': { reject: new Error(RAW) } }],
  ])('holds a tail lease through session close on %s', async (_label, scripts) => {
    const lease = trackedLease();
    const session = new FakeSession(scripts);
    const close = session.close.bind(session);
    session.close = async () => {
      expect(lease.release).not.toHaveBeenCalled();
      expect(lease.redactor.redact(lease.raw)).not.toContain(lease.raw);
      await close();
    };
    await createContainerLogs(depsFor(session, { openRedactor: () => Promise.resolve(lease) })).tail(SCOPE_REQUEST);
    expect(lease.release).toHaveBeenCalledTimes(1);
    expect(session.closed).toBe(1);
  });

  it.each(['tail', 'follow'] as const)('releases a %s lease on connect failure', async (kind) => {
    const lease = trackedLease();
    const logs = createContainerLogs(depsFor(new FakeSession(), { openRedactor: () => Promise.resolve(lease), connect: () => Promise.reject(new Error(RAW)) }));
    if (kind === 'tail') await logs.tail(SCOPE_REQUEST);
    else await logs.openFollow({ ...SCOPE_REQUEST, userId: USER_ID, signal: new AbortController().signal });
    expect(lease.release).toHaveBeenCalledTimes(1);
    expect(logs.activeFollows()).toBe(0);
  });

  it.each(['success', 'timeout', 'abort', 'cap', 'drop', 'callback', 'shutdown', 'unpumped', 'unpumped-abort', 'reconnect'] as const)(
    'holds the follow lease through %s teardown, flush and close', async (mode) => {
      const lease = trackedLease();
      const session = new FakeSession({
        'process.supervise': mode === 'drop' ? { reject: new Error(RAW) } : { stdout: `${lease.raw}\n`, hold: ['abort', 'shutdown', 'callback'].includes(mode), outcome: mode === 'timeout' ? 'timed_out' : 'completed' },
        ...(mode === 'reconnect' ? { 'process.kill_group': { reject: new Error(RAW) } } : {}),
      });
      const second = new FakeSession();
      const deps = depsFor([session, second], { openRedactor: () => Promise.resolve(lease), limits: { ...LIMITS, followMaxTotalBytes: mode === 'cap' ? 1 : LIMITS.followMaxTotalBytes } });
      const connect = deps.connect;
      const guardedDeps = { ...deps, connect: async (...args: Parameters<typeof connect>) => {
        expect(args[1]).toBe(lease.redactor);
        expect(lease.release).not.toHaveBeenCalled();
        const result = await connect(...args);
        if (!result.ok) return result;
        return { ...result, close: async () => {
          expect(lease.release).not.toHaveBeenCalled();
          // Models a final buffered SSH flush while closing.
          expect(lease.redactor.redact(lease.raw)).not.toContain(lease.raw);
          await result.close();
        } };
      } };
      const logs = createContainerLogs(guardedDeps);
      const client = new AbortController();
      const opened = await logs.openFollow({ ...SCOPE_REQUEST, userId: USER_ID, signal: client.signal });
      if (!opened.ok) throw new Error('expected open');
      expect(lease.release).not.toHaveBeenCalled();
      if (mode === 'unpumped') await logs.closeAll();
      else if (mode === 'unpumped-abort') { client.abort(); await opened.stream.pump(() => undefined); }
      else {
        const done = opened.stream.pump(() => {
          if (mode === 'callback') throw new Error('callback');
          if (mode === 'abort') client.abort();
        });
        if (mode === 'shutdown') await logs.closeAll();
        await done;
      }
      expect(lease.release).toHaveBeenCalledTimes(1);
      expect(logs.activeFollows()).toBe(0);
      expect(session.closed).toBe(1);
      if (mode === 'reconnect') expect(second.closed).toBe(1);
    },
  );

  it.each([ { 'docker.ps': { stdout: '' } }, { 'fs.prepare_workspace': { exitCode: 1 } }, { 'fs.prepare_workspace': { reject: new Error(RAW) } } ])(
    'releases a lease after opening failure cleanup: %j', async (scripts) => {
      const lease = trackedLease();
      const session = new FakeSession(scripts);
      const { logs, opened } = await openAndPump(depsFor(session, { openRedactor: () => Promise.resolve(lease) }));
      expect(opened.ok).toBe(false);
      expect(lease.release).toHaveBeenCalledTimes(1);
      expect(session.closed).toBe(1);
      expect(logs.activeFollows()).toBe(0);
    },
  );

  it('keeps concurrent leases independent until each request closes', async () => {
    const a = trackedLease();
    const b = trackedLease();
    const leases = [a, b];
    const logs = createContainerLogs(depsFor([new FakeSession(), new FakeSession()], { openRedactor: () => {
      const lease = leases.shift();
      if (lease === undefined) throw new Error('no lease');
      return Promise.resolve(lease);
    } }));
    const request = { ...SCOPE_REQUEST, userId: USER_ID, signal: new AbortController().signal };
    const [one, two] = await Promise.all([logs.openFollow(request), logs.openFollow(request)]);
    if (!one.ok || !two.ok) throw new Error('expected open');
    expect(a.redactor).not.toBe(b.redactor);
    await one.stream.pump(() => undefined);
    expect(a.release).toHaveBeenCalledTimes(1);
    expect(b.release).not.toHaveBeenCalled();
    expect(b.redactor.redact(b.raw)).not.toContain(b.raw);
    await two.stream.pump(() => undefined);
    expect(b.release).toHaveBeenCalledTimes(1);
  });
});


describe('follow cancellation during SSH opening', () => {
  it.each(['abort', 'shutdown'] as const)('holds the lease until the opening session closes after %s', async (mode) => {
    const lease = trackedLease();
    const session = new FakeSession();
    const pending = deferred<{ ok: true; session: SshDeploySession; close: () => Promise<void> }>();
    const started = deferred<undefined>();
    const logs = createContainerLogs(depsFor(session, {
      openRedactor: () => Promise.resolve(lease),
      connect: () => { started.resolve(undefined); return pending.promise; },
    }));
    const client = new AbortController();
    const opening = logs.openFollow({ ...SCOPE_REQUEST, userId: USER_ID, signal: client.signal });
    await started.promise;
    const shutdown = mode === 'shutdown' ? logs.closeAll() : Promise.resolve();
    if (mode === 'abort') client.abort();
    expect(lease.release).not.toHaveBeenCalled();
    pending.resolve({ ok: true, session: session.asSession(), close: () => {
      expect(lease.release).not.toHaveBeenCalled();
      return session.close();
    } });
    expect(await opening).toMatchObject({ ok: false, code: 'RUNTIME_LOGS_FAILED' });
    await shutdown;
    expect(session.calls).toEqual([]);
    expect(session.closed).toBe(1);
    expect(lease.release).toHaveBeenCalledTimes(1);
    expect(logs.activeFollows()).toBe(0);
  });
});
