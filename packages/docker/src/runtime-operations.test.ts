// 17-01 (ADR 0010): healthcheck probes, the -prev container and per-service images against a
// recording fake SshDeploySession. The fake redacts output with the injected redactor at stream
// time, like the real adapter.
import { randomBytes } from 'node:crypto';
import { validateHealthcheckConfig, type HealthcheckConfig } from '@noodara/domain/deployment';
import { createRedactor, type Redactor } from '@noodara/domain/security';
import { validateResourceId, type ResourceId } from '@noodara/domain/validators';
import {
  PROBE_OUTPUT_MAX_BYTES,
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
  listServiceImages,
  probeContainerHealth,
  removePrevious,
  removeServiceImage,
  renameToPrevious,
  restorePrevious,
  startPrevious,
  stopPrevious,
} from './runtime-operations.js';
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
const DEPLOYMENT_ID: ResourceId = unwrap(validateResourceId('3f2b8c1e-9d4a-4f6b-8a2c-1e5d7f9b0c3a'));
const OTHER_DEPLOYMENT_ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const CONTAINER = `noodara-${SERVICE_ID}`;
const PREV = `${CONTAINER}-prev`;
const NETWORK = `noodara-net-${SERVICE_ID}`;
const IMAGE = `noodara/${SERVICE_ID}:${DEPLOYMENT_ID}`;

const RUNNING_STATE = JSON.stringify({
  Status: 'running',
  Running: true,
  Paused: false,
  Restarting: false,
  OOMKilled: false,
  Dead: false,
  Pid: 42,
  ExitCode: 0,
  Error: '',
  StartedAt: '2026-10-15T10:00:00.000000000Z',
  FinishedAt: '0001-01-01T00:00:00Z',
});
const EXITED_STATE = JSON.stringify({
  Status: 'exited',
  Running: false,
  Paused: false,
  Restarting: false,
  OOMKilled: false,
  Dead: false,
  Pid: 0,
  ExitCode: 1,
  Error: '',
  StartedAt: '2026-10-15T10:00:00.000000000Z',
  FinishedAt: '2026-10-15T10:00:05.000000000Z',
});
const networks = (ip: string): string =>
  JSON.stringify({ [NETWORK]: { IPAddress: ip, Gateway: '172.18.0.1', MacAddress: '02:42:ac:12:00:02' } });
const NO_SUCH_CONTAINER = `Error response from daemon: No such container: ${CONTAINER}\n`;
const RENAME_CONFLICT = `Error response from daemon: Conflict. The container name "/${PREV}" is already in use by container "0123abcd". You have to remove (or rename) that container to be able to reuse that name.\n`;
const IMAGE_IN_USE = `Error response from daemon: conflict: unable to remove repository reference "${IMAGE}" (must force) - container 0123abcd is using its referenced image 4567ef01\n`;
const NO_SUCH_IMAGE = `Error response from daemon: No such image: ${IMAGE}\n`;
const DAEMON_DOWN =
  'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n';

interface Script {
  readonly outcome?: StreamResult['outcome'];
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly truncated?: boolean;
  readonly reject?: Error;
}

interface Call {
  readonly command: RemoteCommand;
  readonly options: StreamOptions;
}

/** Each name maps to one script, or to a sequence consumed one call at a time. */
class RecordingSession implements SshDeploySession {
  readonly calls: Call[] = [];
  private readonly used = new Map<DeployCommandName, number>();

  constructor(
    private readonly redactor: Redactor,
    private readonly scripts: Partial<Record<DeployCommandName, Script | readonly Script[]>> = {},
  ) {}

  exec(): Promise<ExecResult> {
    return Promise.reject(new Error('exec is not part of the deploy path'));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  stream(command: RemoteCommand, options: StreamOptions): Promise<StreamResult> {
    this.calls.push({ command, options });
    const entry = this.scripts[command.name];
    const index = this.used.get(command.name) ?? 0;
    this.used.set(command.name, index + 1);
    const script: Script = (Array.isArray(entry) ? (entry as readonly Script[])[index] : (entry as Script)) ?? {};
    if (script.reject !== undefined) return Promise.reject(script.reject);
    const stdout = this.redactor.redact(script.stdout ?? '');
    const stderr = this.redactor.redact(script.stderr ?? '');
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
      truncated: script.truncated ?? false,
      stdoutTail: stdout,
      stderrTail: stderr,
    });
  }

  names(): DeployCommandName[] {
    return this.calls.map((call) => call.command.name);
  }

  call(name: DeployCommandName): Call {
    const found = this.calls.find((entry) => entry.command.name === name);
    if (found === undefined) throw new Error(`no ${name} call`);
    return found;
  }
}

function setup(
  scripts: Partial<Record<DeployCommandName, Script | readonly Script[]>>,
  extra: Partial<DockerStepContext> = {},
) {
  const redactor = createRedactor();
  const session = new RecordingSession(redactor, scripts);
  const chunks: StreamChunk[] = [];
  const context: DockerStepContext = {
    session,
    redactor,
    limits: LIMITS,
    onChunk: (chunk) => chunks.push(chunk),
    ...extra,
  };
  return { session, redactor, chunks, context };
}

function healthcheck(fields: Record<string, unknown>): HealthcheckConfig {
  return unwrap(
    validateHealthcheckConfig({ probeTimeoutS: 5, intervalS: 5, retries: 3, startPeriodS: 0, ...fields }),
  );
}

const HTTP = healthcheck({ type: 'http', path: '/health', port: 3000 });
const TCP = healthcheck({ type: 'tcp', port: 5432, probeTimeoutS: 2 });
const CONTAINER_ONLY = healthcheck({ type: 'container' });
const READY = {
  'docker.inspect': { stdout: `${RUNNING_STATE}\n` },
  'docker.inspect_networks': { stdout: `${networks('172.18.0.2')}\n` },
} as const;

describe('probeContainerHealth (ADR 0010 A1)', () => {
  it('reads the state, then the IP on noodara-net-<serviceId>, then probes that IP', async () => {
    const { session, context } = setup({ ...READY, 'probe.http': { stdout: 'NOODARA_PROBE http 200\n' } });

    const result = await probeContainerHealth(context, { serviceId: SERVICE_ID, config: HTTP });

    expect(result).toMatchObject({ ok: true, value: { kind: 'http', status: 200 } });
    expect(session.names()).toEqual(['docker.inspect', 'docker.inspect_networks', 'probe.http']);
    expect(session.call('docker.inspect_networks').command.argv.at(-1)).toBe(CONTAINER);
    expect(session.call('probe.http').command.argv.slice(-4)).toEqual(['noodara-probe', '172.18.0.2', '3000', '/health']);
  });

  it('tcp: open', async () => {
    const { session, context } = setup({ ...READY, 'probe.tcp': { stdout: 'NOODARA_PROBE open\n' } });

    const result = await probeContainerHealth(context, { serviceId: SERVICE_ID, config: TCP });

    expect(result).toMatchObject({ ok: true, value: { kind: 'open' } });
    expect(session.call('probe.tcp').command.argv.slice(-3)).toEqual(['noodara-probe', '172.18.0.2', '5432']);
  });

  it.each([
    ['NOODARA_PROBE refused\n', { kind: 'refused' }],
    ['NOODARA_PROBE http 503\n', { kind: 'http', status: 503 }],
    ['NOODARA_PROBE malformed\n', { kind: 'malformed' }],
    ['NOODARA_PROBE empty\n', { kind: 'empty' }],
    ['garbage\n', { kind: 'error' }],
  ] as const)('maps %j to its observation', async (stdout, observation) => {
    const { context } = setup({ ...READY, 'probe.http': { stdout } });

    const result = await probeContainerHealth(context, { serviceId: SERVICE_ID, config: HTTP });

    expect(result).toMatchObject({ ok: true, value: observation });
  });

  it('a container check needs no IP and no probe', async () => {
    const { session, context } = setup(READY);

    const result = await probeContainerHealth(context, { serviceId: SERVICE_ID, config: CONTAINER_ONLY });

    expect(result).toMatchObject({ ok: true, value: { kind: 'running' } });
    expect(session.names()).toEqual(['docker.inspect']);
  });

  it.each([
    ['a stopped container', { 'docker.inspect': { stdout: EXITED_STATE } }],
    ['a missing container', { 'docker.inspect': { exitCode: 1, stderr: NO_SUCH_CONTAINER } }],
    [
      'an empty IP (never a stale address)',
      { 'docker.inspect': { stdout: RUNNING_STATE }, 'docker.inspect_networks': { stdout: networks('') } },
    ],
    [
      'a container gone between the two inspects',
      { 'docker.inspect': { stdout: RUNNING_STATE }, 'docker.inspect_networks': { exitCode: 1, stderr: NO_SUCH_CONTAINER } },
    ],
  ] as const)('%s is `exited` and is never probed', async (_label, scripts) => {
    const { session, context } = setup(scripts);

    const result = await probeContainerHealth(context, { serviceId: SERVICE_ID, config: HTTP });

    expect(result).toMatchObject({ ok: true, value: { kind: 'exited' } });
    expect(session.names()).not.toContain('probe.http');
  });

  it.each([
    ['detached from its network', JSON.stringify({ bridge: { IPAddress: '172.17.0.2' } })],
    ['an invalid IP', networks('127.0.0.1')],
    ['unparseable JSON', '{not json'],
  ])('a running container %s is an `error` observation and is never probed', async (_label, stdout) => {
    const { session, context } = setup({ 'docker.inspect': { stdout: RUNNING_STATE }, 'docker.inspect_networks': { stdout } });

    const result = await probeContainerHealth(context, { serviceId: SERVICE_ID, config: HTTP });

    expect(result).toMatchObject({ ok: true, value: { kind: 'error' } });
    expect(session.names()).not.toContain('probe.http');
  });

  it('a daemon failure on inspect is a classified failure', async () => {
    const { context } = setup({ 'docker.inspect': { exitCode: 1, stderr: DAEMON_DOWN } });

    const result = await probeContainerHealth(context, { serviceId: SERVICE_ID, config: HTTP });

    expect(result).toMatchObject({ ok: false, kind: 'failed', code: 'DOCKER_UNAVAILABLE' });
  });

  it('a lost connection is SERVER_UNREACHABLE, never an exception', async () => {
    const { context } = setup({ ...READY, 'probe.http': { reject: new Error('channel closed') } });

    const result = await probeContainerHealth(context, { serviceId: SERVICE_ID, config: HTTP });

    expect(result).toMatchObject({ ok: false, kind: 'failed', code: 'SERVER_UNREACHABLE' });
  });

  it('an aborted probe is interrupted (aborted)', async () => {
    const { context } = setup({ ...READY, 'probe.http': { outcome: 'aborted', exitCode: null } });

    const result = await probeContainerHealth(context, { serviceId: SERVICE_ID, config: HTTP });

    expect(result).toEqual({ ok: false, kind: 'interrupted', outcome: 'aborted' });
  });
});

describe('probeContainerHealth H1: a hung endpoint cannot outlive the probe budget', () => {
  it('runs the probe with its own limits: probeTimeoutS + 5 s and a 1 KiB output budget', async () => {
    const { session, context } = setup({ ...READY, 'probe.tcp': { stdout: 'NOODARA_PROBE open\n' } });

    await probeContainerHealth(context, { serviceId: SERVICE_ID, config: TCP });

    const { options } = session.call('probe.tcp');
    expect(options.maxDurationMs).toBe(7_000);
    expect(options.idleTimeoutMs).toBe(7_000);
    expect(options.maxTotalBytes).toBe(PROBE_OUTPUT_MAX_BYTES);
    expect(options.maxLineBytes).toBeLessThanOrEqual(PROBE_OUTPUT_MAX_BYTES);
  });

  it.each([124, 137])('exit %i (timeout killed the probe) is a `timeout` observation', async (exitCode) => {
    const { context } = setup({ ...READY, 'probe.http': { exitCode } });

    const result = await probeContainerHealth(context, { serviceId: SERVICE_ID, config: HTTP });

    expect(result).toMatchObject({ ok: true, value: { kind: 'timeout' } });
  });

  it.each(['timed_out', 'idle_timeout'] as const)(
    'a session-side %s is a `timeout` observation, not a deploy failure',
    async (outcome) => {
      const { context } = setup({ ...READY, 'probe.http': { outcome, exitCode: null } });

      const result = await probeContainerHealth(context, { serviceId: SERVICE_ID, config: HTTP });

      expect(result).toMatchObject({ ok: true, value: { kind: 'timeout' } });
    },
  );

  it('any other non-zero exit (bash missing) is an `error` observation', async () => {
    const { context } = setup({ ...READY, 'probe.http': { exitCode: 127, stderr: 'env: bash: No such file or directory\n' } });

    const result = await probeContainerHealth(context, { serviceId: SERVICE_ID, config: HTTP });

    expect(result).toMatchObject({ ok: true, value: { kind: 'error' } });
  });
});

describe('probeContainerHealth A4/H2: output budget and redaction', () => {
  it('truncated output is an `error` observation, never parsed', async () => {
    const { context } = setup({ ...READY, 'probe.http': { stdout: 'NOODARA_PROBE http 200\n', truncated: true } });

    const result = await probeContainerHealth(context, { serviceId: SERVICE_ID, config: HTTP });

    expect(result).toMatchObject({ ok: true, value: { kind: 'error' } });
  });

  it('a body canary never reaches onChunk (the log phase) or the returned result', async () => {
    const canary = `NOODARA_CANARY_${randomBytes(12).toString('hex')}`;
    const { chunks, context } = setup({
      ...READY,
      'probe.http': { stdout: `NOODARA_PROBE http 200\n${canary}\n`, stderr: `${canary}\n` },
    });

    const result = await probeContainerHealth(context, { serviceId: SERVICE_ID, config: HTTP });

    expect(result).toMatchObject({ ok: true, value: { kind: 'http', status: 200 } });
    expect(chunks).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it('a registered secret in probe output is redacted before parsing and never returned', async () => {
    const secret = `s3cr3t-${randomBytes(12).toString('hex')}`;
    const { redactor, chunks, context } = setup({
      ...READY,
      'probe.http': { stdout: `NOODARA_PROBE http 200\n`, stderr: `leak ${secret}\n` },
    });
    redactor.register(secret, 'password');

    const result = await probeContainerHealth(context, { serviceId: SERVICE_ID, config: HTTP });

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(chunks)).not.toContain(secret);
  });

  it('inspect output never reaches onChunk either (a probe loop is quiet)', async () => {
    const { chunks, context } = setup({ ...READY, 'probe.http': { stdout: 'NOODARA_PROBE http 200\n' } });

    await probeContainerHealth(context, { serviceId: SERVICE_ID, config: HTTP });

    expect(chunks).toEqual([]);
  });
});

describe('renameToPrevious (ADR 0010 A2, H1)', () => {
  it('renames noodara-<serviceId> to noodara-<serviceId>-prev', async () => {
    const { session, context } = setup({});

    const result = await renameToPrevious(context, { serviceId: SERVICE_ID });

    expect(result).toMatchObject({ ok: true, value: PREV });
    expect(session.names()).toEqual(['docker.rename_to_prev']);
  });

  it('H1: an existing -prev is an explicit previous_exists error, and nothing is removed', async () => {
    const { session, context } = setup({ 'docker.rename_to_prev': { exitCode: 1, stderr: RENAME_CONFLICT } });

    const result = await renameToPrevious(context, { serviceId: SERVICE_ID });

    expect(result).toMatchObject({ ok: false, kind: 'previous_exists', name: PREV });
    expect(session.names()).toEqual(['docker.rename_to_prev']);
    for (const call of session.calls) {
      expect(call.command.argv).not.toContain('rm');
      expect(call.command.argv).not.toContain('--force');
    }
  });

  it.each([124, 137])('H1: exit %i from the step timeout is interrupted (timed_out)', async (exitCode) => {
    const { context } = setup({ 'docker.rename_to_prev': { exitCode } });

    const result = await renameToPrevious(context, { serviceId: SERVICE_ID });

    expect(result).toEqual({ ok: false, kind: 'interrupted', outcome: 'timed_out' });
  });

  it('another failure is classified', async () => {
    const { context } = setup({ 'docker.rename_to_prev': { exitCode: 1, stderr: DAEMON_DOWN } });

    const result = await renameToPrevious(context, { serviceId: SERVICE_ID });

    expect(result).toMatchObject({ ok: false, kind: 'failed', code: 'DOCKER_UNAVAILABLE' });
  });
});

describe('restorePrevious (ADR 0010 A2 restore order)', () => {
  it('renames -prev back, keeps an attached network and starts it', async () => {
    const { session, context } = setup({ 'docker.inspect_networks': { stdout: networks('') } });

    const result = await restorePrevious(context, { serviceId: SERVICE_ID });

    expect(result).toMatchObject({ ok: true, value: CONTAINER });
    expect(session.names()).toEqual(['docker.rename_from_prev', 'docker.inspect_networks', 'docker.start']);
    expect(session.call('docker.inspect_networks').command.argv.at(-1)).toBe(CONTAINER);
  });

  it('re-attaches a detached container to its network while stopped, before start', async () => {
    const { session, context } = setup({ 'docker.inspect_networks': { stdout: '{}' } });

    const result = await restorePrevious(context, { serviceId: SERVICE_ID });

    expect(result).toMatchObject({ ok: true, value: CONTAINER });
    expect(session.names()).toEqual([
      'docker.rename_from_prev',
      'docker.inspect_networks',
      'docker.network_connect',
      'docker.start',
    ]);
  });

  it('a missing -prev stops at the rename and starts nothing', async () => {
    const { session, context } = setup({
      'docker.rename_from_prev': { exitCode: 1, stderr: `Error response from daemon: No such container: ${PREV}\n` },
    });

    const result = await restorePrevious(context, { serviceId: SERVICE_ID });

    expect(result).toMatchObject({ ok: false, kind: 'previous_missing', name: PREV });
    expect(session.names()).toEqual(['docker.rename_from_prev']);
  });

  it('never removes anything (the caller removes the new container first)', async () => {
    const { session, context } = setup({ 'docker.inspect_networks': { stdout: '{}' } });

    await restorePrevious(context, { serviceId: SERVICE_ID });

    for (const call of session.calls) {
      expect(call.command.name).not.toMatch(/remove/);
    }
  });

  it('a failed network connect stops before start', async () => {
    const { session, context } = setup({
      'docker.inspect_networks': { stdout: '{}' },
      'docker.network_connect': { exitCode: 1, stderr: DAEMON_DOWN },
    });

    const result = await restorePrevious(context, { serviceId: SERVICE_ID });

    expect(result).toMatchObject({ ok: false, kind: 'failed' });
    expect(session.names()).not.toContain('docker.start');
  });

  it('an unreadable network list stops before start', async () => {
    const { session, context } = setup({ 'docker.inspect_networks': { stdout: 'nope' } });

    const result = await restorePrevious(context, { serviceId: SERVICE_ID });

    expect(result).toMatchObject({ ok: false, kind: 'failed', code: 'ROLLBACK_FAILED' });
    expect(session.names()).not.toContain('docker.start');
  });
});

describe('start / stop / remove the -prev container', () => {
  it('startPrevious starts only -prev', async () => {
    const { session, context } = setup({});

    expect(await startPrevious(context, { serviceId: SERVICE_ID })).toMatchObject({ ok: true, value: PREV });
    expect(session.call('docker.start_prev').command.argv.at(-1)).toBe(PREV);
  });

  it('stopPrevious passes the stop timeout', async () => {
    const { session, context } = setup({});

    expect(await stopPrevious(context, { serviceId: SERVICE_ID, timeoutSeconds: 10 })).toMatchObject({ ok: true });
    expect(session.call('docker.stop_prev').command.argv).toContain('10');
  });

  it('removePrevious: an already absent -prev is success (idempotent cleanup)', async () => {
    const { context } = setup({
      'docker.remove_prev': { exitCode: 1, stderr: `Error response from daemon: No such container: ${PREV}\n` },
    });

    expect(await removePrevious(context, { serviceId: SERVICE_ID })).toMatchObject({ ok: true, value: PREV });
  });

  it('removePrevious: a running -prev is refused by Docker and reported, never forced', async () => {
    const { session, context } = setup({
      'docker.remove_prev': {
        exitCode: 1,
        stderr: `Error response from daemon: cannot remove container "/${PREV}": container is running: stop the container before removing or force remove\n`,
      },
    });

    expect(await removePrevious(context, { serviceId: SERVICE_ID })).toMatchObject({ ok: false, kind: 'failed' });
    expect(session.call('docker.remove_prev').command.argv).not.toContain('--force');
  });

  it.each([
    ['startPrevious', (c: DockerStepContext) => startPrevious(c, { serviceId: SERVICE_ID }), 'docker.start_prev'],
    ['stopPrevious', (c: DockerStepContext) => stopPrevious(c, { serviceId: SERVICE_ID, timeoutSeconds: 1 }), 'docker.stop_prev'],
    ['removePrevious', (c: DockerStepContext) => removePrevious(c, { serviceId: SERVICE_ID }), 'docker.remove_prev'],
  ] as const)('%s: exit 124 is interrupted (timed_out)', async (_label, run, name) => {
    const { context } = setup({ [name]: { exitCode: 124 } });

    expect(await run(context)).toEqual({ ok: false, kind: 'interrupted', outcome: 'timed_out' });
  });
});

describe("listServiceImages / removeServiceImage (the service's own images)", () => {
  const line = (fields: Record<string, string>): string =>
    JSON.stringify({ Containers: 'N/A', Digest: '<none>', Size: '150MB', ...fields });

  it("parses the NDJSON listing into this service's deployment images", async () => {
    const stdout = [
      line({ Repository: `noodara/${SERVICE_ID}`, Tag: DEPLOYMENT_ID, ID: 'sha256:aaa', CreatedAt: '2026-10-15 10:00:00 +0000 UTC' }),
      line({ Repository: `noodara/${SERVICE_ID}`, Tag: OTHER_DEPLOYMENT_ID, ID: 'sha256:bbb', CreatedAt: '2026-10-14 10:00:00 +0000 UTC' }),
      line({ Repository: `noodara/${SERVICE_ID}`, Tag: '<none>', ID: 'sha256:ccc', CreatedAt: '2026-10-13 10:00:00 +0000 UTC' }),
      line({ Repository: 'noodara/other', Tag: DEPLOYMENT_ID, ID: 'sha256:ddd', CreatedAt: '2026-10-13 10:00:00 +0000 UTC' }),
      '',
    ].join('\n');
    const { session, context } = setup({ 'docker.image_list_service': { stdout } });

    const result = await listServiceImages(context, { serviceId: SERVICE_ID });

    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: 'ok',
        images: [
          { deploymentId: DEPLOYMENT_ID, imageId: 'sha256:aaa', createdAt: '2026-10-15 10:00:00 +0000 UTC' },
          { deploymentId: OTHER_DEPLOYMENT_ID, imageId: 'sha256:bbb', createdAt: '2026-10-14 10:00:00 +0000 UTC' },
        ],
      },
    });
    expect(session.call('docker.image_list_service').command.argv).toContain(`reference=noodara/${SERVICE_ID}`);
  });

  it('an empty listing is no images', async () => {
    const { context } = setup({ 'docker.image_list_service': { stdout: '' } });

    expect(await listServiceImages(context, { serviceId: SERVICE_ID })).toMatchObject({
      ok: true,
      value: { kind: 'ok', images: [] },
    });
  });

  it.each([
    ['truncated output', { stdout: line({ Repository: 'x' }), truncated: true }],
    ['a line that is not JSON', { stdout: 'nope\n' }],
  ] as const)('%s is unparseable, never guessed', async (_label, script) => {
    const { context } = setup({ 'docker.image_list_service': script });

    expect(await listServiceImages(context, { serviceId: SERVICE_ID })).toMatchObject({
      ok: true,
      value: { kind: 'unparseable' },
    });
  });

  it('a daemon failure on list is classified', async () => {
    const { context } = setup({ 'docker.image_list_service': { exitCode: 1, stderr: DAEMON_DOWN } });

    expect(await listServiceImages(context, { serviceId: SERVICE_ID })).toMatchObject({
      ok: false,
      code: 'DOCKER_UNAVAILABLE',
    });
  });

  it('removes noodara/<serviceId>:<deploymentId>', async () => {
    const { session, context } = setup({});

    const result = await removeServiceImage(context, { serviceId: SERVICE_ID, deploymentId: DEPLOYMENT_ID });

    expect(result).toMatchObject({ ok: true, value: IMAGE });
    expect(session.call('docker.image_remove_service').command.argv.at(-1)).toBe(IMAGE);
  });

  it('an image used by a container (the running one or -prev) is in_use, never forced', async () => {
    const { session, context } = setup({ 'docker.image_remove_service': { exitCode: 1, stderr: IMAGE_IN_USE } });

    const result = await removeServiceImage(context, { serviceId: SERVICE_ID, deploymentId: DEPLOYMENT_ID });

    expect(result).toMatchObject({ ok: false, kind: 'in_use', image: IMAGE });
    expect(session.call('docker.image_remove_service').command.argv).not.toContain('--force');
  });

  it('an already removed image is success (idempotent retention)', async () => {
    const { context } = setup({ 'docker.image_remove_service': { exitCode: 1, stderr: NO_SUCH_IMAGE } });

    expect(
      await removeServiceImage(context, { serviceId: SERVICE_ID, deploymentId: DEPLOYMENT_ID }),
    ).toMatchObject({ ok: true, value: IMAGE });
  });
});
