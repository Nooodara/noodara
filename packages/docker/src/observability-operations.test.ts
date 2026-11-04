// 27-01 (ADR 0012): observability reads against a recording fake SshDeploySession. Unlike the
// deploy fakes, `rawStream` lets a test return output the session did NOT redact, proving the
// wrapper redacts on its own before parsing (A3).
import { createRedactor, type Redactor } from '@noodara/domain/security';
import { validateResourceId, type ResourceId } from '@noodara/domain/validators';
import {
  OBSERVABILITY_LIMITS,
  type DeployCommandName,
  type ExecResult,
  type RemoteCommand,
  type SshDeploySession,
  type StreamChunk,
  type StreamOptions,
  type StreamResult,
} from '@noodara/ssh';
import { describe, expect, it } from 'vitest';
import type { DockerStepContext } from './docker-operations.js';
import {
  fetchLogsWindow,
  inspectContainerStates,
  sampleContainers,
  sampleHost,
} from './observability-operations.js';
import type { StepLimits } from './step-result.js';

const LIMITS: StepLimits = {
  maxDurationMs: 600_000,
  idleTimeoutMs: 120_000,
  maxTotalBytes: 8_388_608,
  maxLineBytes: 16_384,
};

function unwrap<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error('test setup: invalid fixture value');
  return result.value;
}

const SERVICE_ID: ResourceId = unwrap(validateResourceId('7c9e6679-7425-40de-944b-e07fc1f90ae7'));
const CONTAINER_ID = 'a'.repeat(64);
const SINCE = '2026-11-03T18:00:00Z';

const HOST_SAMPLE = [
  'CPU cpu  10000 0 5000 80000 1000 0 0 0 0 0',
  'CPU cpu  10060 0 5030 80100 1010 0 0 0 0 0',
  'MEM MemTotal:        4000000 kB',
  'MEM MemAvailable:    1000000 kB',
  'DF /                62725623808 12000000000 47500000000',
  'UP 12345.67 40000.12',
  '',
].join('\n');

const INSPECT_LINE = `I ${JSON.stringify({
  id: CONTAINER_ID,
  name: `/noodara-${SERVICE_ID}`,
  status: 'running',
  running: true,
  restarting: false,
  restartCount: 0,
  oomKilled: false,
  exitCode: 0,
  startedAt: '2026-11-03T18:37:14.689777509Z',
  finishedAt: '0001-01-01T00:00:00Z',
  health: null,
  healthExitCodes: [],
  memoryLimit: 67108864,
})}`;
const STATS_LINE = `S ${CONTAINER_ID}\t12.34%\t4.5MiB / 64MiB`;

const DAEMON_DOWN =
  'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n';

interface Script {
  readonly outcome?: StreamResult['outcome'];
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly reject?: Error;
}

interface Call {
  readonly command: RemoteCommand;
  readonly options: StreamOptions;
}

class RecordingSession implements SshDeploySession {
  readonly calls: Call[] = [];

  constructor(
    private readonly redactor: Redactor | null,
    private readonly scripts: Partial<Record<DeployCommandName, Script>> = {},
  ) {}

  exec(): Promise<ExecResult> {
    return Promise.reject(new Error('exec is not part of the observability path'));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  stream(command: RemoteCommand, options: StreamOptions): Promise<StreamResult> {
    this.calls.push({ command, options });
    const script = this.scripts[command.name] ?? {};
    if (script.reject !== undefined) return Promise.reject(script.reject);
    const redact = (text: string): string => (this.redactor === null ? text : this.redactor.redact(text));
    const stdout = redact(script.stdout ?? '');
    const stderr = redact(script.stderr ?? '');
    let seq = 0;
    if (stdout.length > 0) options.onChunk({ stream: 'stdout', text: stdout, seq: seq++, truncatedLine: false });
    if (stderr.length > 0) options.onChunk({ stream: 'stderr', text: stderr, seq: seq++, truncatedLine: false });
    return Promise.resolve({
      commandName: command.name,
      outcome: script.outcome ?? 'completed',
      exitCode: script.exitCode === undefined ? 0 : script.exitCode,
      exitSignal: null,
      durationMs: 1,
      totalBytes: stdout.length + stderr.length,
      truncated: false,
      stdoutTail: stdout,
      stderrTail: stderr,
    });
  }

  only(): Call {
    const [call] = this.calls;
    if (call === undefined || this.calls.length !== 1) throw new Error('expected exactly one call');
    return call;
  }
}

function setup(scripts: Partial<Record<DeployCommandName, Script>>, options: { rawStream?: boolean } = {}) {
  const redactor = createRedactor();
  const session = new RecordingSession(options.rawStream === true ? null : redactor, scripts);
  const chunks: StreamChunk[] = [];
  const context: DockerStepContext = {
    session,
    redactor,
    limits: LIMITS,
    onChunk: (chunk) => chunks.push(chunk),
  };
  return { session, redactor, chunks, context };
}

describe('sampleHost', () => {
  it('parses a host sample and runs metrics.host_sample with its own limits, no chunks forwarded', async () => {
    const { session, chunks, context } = setup({ 'metrics.host_sample': { stdout: HOST_SAMPLE } });
    const result = await sampleHost(context, { deltaSeconds: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('ok');
    const call = session.only();
    expect(call.command.name).toBe('metrics.host_sample');
    const { timeoutSeconds, capBytes } = OBSERVABILITY_LIMITS.hostSample;
    expect(call.options.maxDurationMs).toBe(timeoutSeconds * 1000 + 5000);
    expect(call.options.idleTimeoutMs).toBe(timeoutSeconds * 1000 + 5000);
    expect(call.options.maxTotalBytes).toBe(capBytes + 4096);
    expect(chunks).toEqual([]);
  });

  it('reports output that does not match the template as unparseable without raw output', async () => {
    const { context } = setup({ 'metrics.host_sample': { stdout: 'garbage\n' } });
    const result = await sampleHost(context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('unparseable');
    expect(JSON.stringify(result.value)).not.toContain('garbage');
  });

  it('maps a rejected stream (transport loss) to SERVER_UNREACHABLE', async () => {
    const { context } = setup({ 'metrics.host_sample': { reject: new Error('ECONNRESET') } });
    expect(await sampleHost(context)).toMatchObject({ ok: false, kind: 'failed', code: 'SERVER_UNREACHABLE' });
  });

  it.each([124, 137])('maps the remote timeout exit %i to an interrupted timed_out step', async (exitCode) => {
    const { context } = setup({ 'metrics.host_sample': { exitCode } });
    expect(await sampleHost(context)).toEqual({ ok: false, kind: 'interrupted', outcome: 'timed_out' });
  });

  it.each(['timed_out', 'idle_timeout', 'aborted'] as const)(
    'maps a %s stream outcome to an interrupted step',
    async (outcome) => {
      const { context } = setup({ 'metrics.host_sample': { outcome, exitCode: null } });
      expect(await sampleHost(context)).toEqual({ ok: false, kind: 'interrupted', outcome });
    },
  );
});

describe('sampleContainers and inspectContainerStates', () => {
  it('parses states and stats from docker.stats filtered to one service', async () => {
    const { session, chunks, context } = setup({
      'docker.stats': { stdout: `${INSPECT_LINE}\n${STATS_LINE}\n` },
    });
    const result = await sampleContainers(context, { serviceId: SERVICE_ID });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== 'ok') throw new Error('expected a parsed sample');
    expect(result.value.value).toHaveLength(1);
    expect(result.value.value[0]).toMatchObject({ id: CONTAINER_ID, status: 'running' });
    expect(session.only().command.argv.join(' ')).toContain(SERVICE_ID);
    expect(session.only().options.maxTotalBytes).toBe(OBSERVABILITY_LIMITS.containerSample.capBytes + 4096);
    expect(chunks).toEqual([]);
  });

  it('parses states from docker.inspect_state', async () => {
    const { session, context } = setup({ 'docker.inspect_state': { stdout: `${INSPECT_LINE}\n` } });
    const result = await inspectContainerStates(context);
    expect(result).toMatchObject({ ok: true, value: { kind: 'ok' } });
    expect(session.only().command.name).toBe('docker.inspect_state');
    expect(session.only().options.maxDurationMs).toBe(
      OBSERVABILITY_LIMITS.inspectState.timeoutSeconds * 1000 + 5000,
    );
  });

  it('classifies a failed docker call (daemon down) instead of parsing it', async () => {
    const { context } = setup({ 'docker.inspect_state': { exitCode: 3, stdout: DAEMON_DOWN } });
    expect(await inspectContainerStates(context)).toMatchObject({
      ok: false,
      kind: 'failed',
      code: 'DOCKER_UNAVAILABLE',
    });
  });

  it('maps transport loss on docker.stats to SERVER_UNREACHABLE', async () => {
    const { context } = setup({ 'docker.stats': { reject: new Error('socket closed') } });
    expect(await sampleContainers(context)).toMatchObject({ ok: false, code: 'SERVER_UNREACHABLE' });
  });
});

describe('fetchLogsWindow', () => {
  const line = (stream: 'O' | 'E', at: string, text: string): string => `${stream} ${at} ${text}`;

  it('returns ordered lines and filters past `until`', async () => {
    const stdout = [
      line('O', '2026-11-03T18:00:02.000000000Z', 'second'),
      line('E', '2026-11-03T18:00:01.000000000Z', 'first'),
      line('O', '2026-11-03T18:10:00.000000000Z', 'too late'),
      '',
    ].join('\n');
    const { session, context } = setup({ 'docker.logs_window': { stdout } });
    const result = await fetchLogsWindow(context, {
      serviceId: SERVICE_ID,
      since: SINCE,
      until: '2026-11-03T18:05:00Z',
      tail: 100,
    });
    if (!result.ok || result.value.kind !== 'ok') throw new Error('expected a log window');
    expect(result.value.lines.map((entry) => [entry.stream, entry.text])).toEqual([
      ['stderr', 'first'],
      ['stdout', 'second'],
    ]);
    expect(result.value.capped).toBe(false);
    expect(session.only().options.maxTotalBytes).toBe(OBSERVABILITY_LIMITS.logsWindow.capBytes + 4096);
  });

  it('accepts a SIGPIPE exit with a line cut by the cap as a capped window, not a failure', async () => {
    const stdout = `${line('O', '2026-11-03T18:00:01Z', 'kept')}\n${line('O', '2026-11-03T18:00:02Z', 'cut mid-li')}`;
    const { context } = setup({ 'docker.logs_window': { stdout, exitCode: 141 } });
    const result = await fetchLogsWindow(context, { serviceId: SERVICE_ID, since: SINCE, tail: 10 });
    expect(result).toMatchObject({ ok: true, value: { kind: 'ok', capped: true, dropped: 1 } });
    if (!result.ok || result.value.kind !== 'ok') return;
    expect(result.value.lines.map((entry) => entry.text)).toEqual(['kept']);
  });

  it('reports a missing container as missing', async () => {
    const { context } = setup({ 'docker.logs_window': { stdout: 'NOODARA_LOGS missing\n' } });
    expect(await fetchLogsWindow(context, { serviceId: SERVICE_ID, since: SINCE, tail: 10 })).toMatchObject({
      ok: true,
      value: { kind: 'missing' },
    });
  });

  it('classifies a non-zero exit other than SIGPIPE', async () => {
    const { context } = setup({ 'docker.logs_window': { exitCode: 3, stdout: DAEMON_DOWN } });
    expect(await fetchLogsWindow(context, { serviceId: SERVICE_ID, since: SINCE, tail: 10 })).toMatchObject({
      ok: false,
      code: 'DOCKER_UNAVAILABLE',
    });
  });

  it('rejects an invalid input before any remote call', () => {
    const { session, context } = setup({});
    expect(() => fetchLogsWindow(context, { serviceId: SERVICE_ID, since: '$(reboot)', tail: 10 })).toThrow(
      RangeError,
    );
    expect(session.calls).toEqual([]);
  });

  it('A3: redacts a registered secret even when the session returned it unredacted', async () => {
    const secret = 'sk-live-canary-9f8e7d6c5b4a';
    const stdout = `${line('O', '2026-11-03T18:00:01Z', `token=${secret}`)}\n`;
    const { redactor, chunks, context } = setup({ 'docker.logs_window': { stdout } }, { rawStream: true });
    redactor.register(secret, 'api_key');
    const result = await fetchLogsWindow(context, { serviceId: SERVICE_ID, since: SINCE, tail: 10 });
    if (!result.ok || result.value.kind !== 'ok') throw new Error('expected a log window');
    const text = result.value.lines.map((entry) => entry.text).join('\n');
    expect(text).toContain('[REDACTED');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(chunks).toEqual([]);
  });
});
