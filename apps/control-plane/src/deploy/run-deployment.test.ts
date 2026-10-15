// 12-11: the deploy pipeline against a scripted fake SshDeploySession (C1, C2, A6, ERR, SEC, H2).
// The fake keys scripts by command name; `process.supervise` is keyed by the supervised op
// (`supervise:clone|build|pull`) read from its pidfile argument.
import { randomBytes } from 'node:crypto';
import type { DeploymentExit, DeploymentStatus, HealthcheckConfig } from '@noodara/domain/deployment';
import {
  createResourceLedger,
  DEFAULT_POST_START_POLL_POLICY,
  isCleanupSettled,
  recordResource,
  V03_DEPLOYMENT_ERROR_MESSAGES,
  validateHealthcheckConfig,
} from '@noodara/domain/deployment';
import { createRedactor, revealSecret, secretValue, type Redactor } from '@noodara/domain/security';
import {
  deployWorkspaceFor,
  parseGitHostKeyLine,
  validateContainerPort,
  validateImageRef,
  validateRegistryHost,
  validateRegistryUsername,
  validateResourceId,
  validateServiceSource,
  type ContainerPort,
  type GitHostKey,
  type ResourceId,
  type ServiceSource,
} from '@noodara/domain/validators';
import type { ExecResult, RemoteCommand, SshDeploySession, StreamOptions, StreamResult } from '@noodara/ssh';
import { describe, expect, it, vi } from 'vitest';
import type { DeploymentLogEntry, DeploymentLogSink } from './log-sink.js';
import {
  CANCEL_UNCONFIRMED,
  CANCEL_UNCONFIRMED_ERROR_CODE,
  DEFAULT_ROLLBACK_MAX_MS,
  DEPLOY_MESSAGES,
  rollbackBudgetMs,
  runDeployment,
  runLedgerCleanup,
  type AdvanceRecord,
  type DeployCredential,
  type DeployRunLimits,
  type DeploymentProgress,
  type GitHostKeyPinResult,
  type GitHostKeyStore,
  type PinnedGitHostKeys,
  type RunDeploymentInput,
} from './run-deployment.js';

function unwrap<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error('test setup: invalid fixture value');
  return result.value;
}

const SERVICE_ID: ResourceId = unwrap(validateResourceId('7c9e6679-7425-40de-944b-e07fc1f90ae7'));
const DEPLOYMENT_ID: ResourceId = unwrap(validateResourceId('3f2b8c1e-9d4a-4f6b-8a2c-1e5d7f9b0c3a'));
const OLD_DEPLOYMENT_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OTHER_SERVICE_ID = '5d6e7f80-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
const CONTAINER = `noodara-${SERVICE_ID}`;
const NETWORK = `noodara-net-${SERVICE_ID}`;
const BUILT_IMAGE = `noodara/${SERVICE_ID}:${DEPLOYMENT_ID}`;
const OLD_IMAGE = `noodara/${SERVICE_ID}:${OLD_DEPLOYMENT_ID}`;
const PULLED_IMAGE = 'registry.example.com:5000/acme/api:1.4.2';
const SHA = 'a'.repeat(40);
const WORKSPACE = unwrap(deployWorkspaceFor(DEPLOYMENT_ID));
const PORT_3000: ContainerPort = unwrap(validateContainerPort(3000));
const PORT_13100: ContainerPort = unwrap(validateContainerPort(13100));

const LIMITS: DeployRunLimits = {
  deployMaxMs: 600_000,
  idleMs: 120_000,
  maxTotalBytes: 8_388_608,
  maxLineBytes: 16_384,
  stopTimeoutSeconds: 10,
  killConfirmMs: 5_000,
  killPollMs: 100,
  cleanupStepMs: 30_000,
};

const BUILD_FAILED_STDERR =
  'ERROR: failed to build: failed to solve: process "/bin/sh -c exit 42" did not complete successfully: exit code: 42\n';
const DAEMON_DOWN_STDERR =
  'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n';
const NETWORK_EXISTS_STDERR = `Error response from daemon: network with name ${NETWORK} already exists\n`;
const IMAGE_IN_USE_STDERR = `Error response from daemon: conflict: unable to remove repository reference "${OLD_IMAGE}" (must force) - container abc is using its referenced image\n`;

function inspectJson(status: string, startedAt = '2026-10-05T10:00:00Z', exitCode = 0): string {
  return `${JSON.stringify({
    Status: status,
    Running: status === 'running',
    ExitCode: exitCode,
    OOMKilled: false,
    StartedAt: startedAt,
    FinishedAt: '0001-01-01T00:00:00Z',
  })}\n`;
}

function psLine(fields: { name: string; image: string; state?: string; ports?: string; serviceId?: string }): string {
  return JSON.stringify({
    ID: 'b'.repeat(64),
    Image: fields.image,
    Names: fields.name,
    State: fields.state ?? 'running',
    Status: 'Up 2 hours',
    Labels: `noodara.managed=true,noodara.service_id=${fields.serviceId ?? SERVICE_ID}`,
    Ports: fields.ports ?? '',
  });
}

interface Script {
  readonly outcome?: StreamResult['outcome'];
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly reject?: Error;
}

const DEFAULT_SCRIPTS: Record<string, Script | Script[]> = {
  'git.head_sha': { stdout: `${SHA}\n` },
  'git.probe_features': { stdout: 'submodules=0\nlfs=0\n' },
  'docker.ps': { stdout: '' },
  'docker.inspect': { stdout: inspectJson('running') },
  'process.group_alive': { exitCode: 1 },
};

function keyOf(command: RemoteCommand): string {
  if (command.name !== 'process.supervise') return command.name;
  const pidFile = command.argv[5] ?? '';
  const op = /\/run\/(\w+)\.pid$/.exec(pidFile)?.[1] ?? 'unknown';
  return `supervise:${op}`;
}

class FakeSession implements SshDeploySession {
  readonly calls: { key: string; command: RemoteCommand; options: StreamOptions }[] = [];
  private readonly cursors = new Map<string, number>();
  private readonly scripts: Record<string, Script | Script[]>;
  /** Called with each command key as it starts (e.g. to cancel mid-run). */
  onStream: ((key: string) => void) | null = null;

  /** `redactor` null: a leaky session that does not redact, to prove the pipeline does. */
  constructor(
    scripts: Record<string, Script | Script[]> = {},
    private readonly redactor: Redactor | null = null,
  ) {
    this.scripts = { ...DEFAULT_SCRIPTS, ...scripts };
  }

  exec(): Promise<ExecResult> {
    return Promise.reject(new Error('exec is not part of the deploy path'));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  stream(command: RemoteCommand, options: StreamOptions): Promise<StreamResult> {
    const key = keyOf(command);
    this.calls.push({ key, command, options });
    this.onStream?.(key);
    const entry = this.scripts[key] ?? {};
    let script: Script;
    if (Array.isArray(entry)) {
      const index = this.cursors.get(key) ?? 0;
      this.cursors.set(key, index + 1);
      script = entry[Math.min(index, entry.length - 1)] ?? {};
    } else {
      script = entry;
    }
    if (script.reject !== undefined) return Promise.reject(script.reject);
    const scrub = (text: string): string => (this.redactor === null ? text : this.redactor.redact(text));
    const stdout = scrub(script.stdout ?? '');
    const stderr = scrub(script.stderr ?? '');
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

  keys(): string[] {
    return this.calls.map((call) => call.key);
  }

  argv(key: string, index = 0): readonly string[] {
    const found = this.calls.filter((call) => call.key === key)[index];
    if (found === undefined) throw new Error(`no ${key} call #${String(index)}`);
    return found.command.argv;
  }

  allArgv(): string[] {
    return this.calls.flatMap((call) => [...call.command.argv]);
  }
}

class RecordingProgress implements DeploymentProgress {
  readonly advances: [DeploymentStatus, DeploymentStatus][] = [];
  readonly records: { readonly to: DeploymentStatus; readonly record: AdvanceRecord }[] = [];
  readonly shas: string[] = [];
  failOn: DeploymentStatus | null = null;

  advance(from: DeploymentStatus, to: DeploymentStatus, record?: AdvanceRecord): Promise<void> {
    if (to === this.failOn) return Promise.reject(new Error('connection to postgres://u:pw@db lost'));
    this.advances.push([from, to]);
    if (record !== undefined) this.records.push({ to, record });
    return Promise.resolve();
  }

  recordCommitSha(sha: string): Promise<void> {
    this.shas.push(sha);
    return Promise.resolve();
  }
}

class RecordingSink implements DeploymentLogSink {
  readonly entries: DeploymentLogEntry[] = [];
  write(entry: DeploymentLogEntry): void {
    this.entries.push(entry);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function gitSource(fields: Record<string, unknown> = {}): ServiceSource {
  return unwrap(
    validateServiceSource({ kind: 'git', repositoryUrl: 'https://github.com/acme/api.git', branch: 'main', ...fields }),
  );
}

const IMAGE_SOURCE: ServiceSource = { kind: 'image', imageRef: unwrap(validateImageRef(PULLED_IMAGE)) };

interface Harness {
  readonly session: FakeSession;
  readonly progress: RecordingProgress;
  readonly sink: RecordingSink;
  readonly redactor: Redactor;
  readonly sleeps: number[];
  readonly input: RunDeploymentInput;
}

function harness(options: {
  scripts?: Record<string, Script | Script[]>;
  source?: ServiceSource;
  credential?: DeployCredential;
  publishedPort?: ContainerPort | null;
  otherServices?: RunDeploymentInput['otherServices'];
  leakySession?: boolean;
  signal?: AbortSignal;
  limits?: Partial<DeployRunLimits>;
  healthcheck?: HealthcheckConfig | null;
  /** 17-07: rollback inputs and other overrides, spread last. */
  extra?: Partial<RunDeploymentInput>;
}): Harness {
  const redactor = createRedactor();
  const session = new FakeSession(options.scripts, options.leakySession === true ? null : redactor);
  const progress = new RecordingProgress();
  const sink = new RecordingSink();
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const input: RunDeploymentInput = {
    session,
    redactor,
    serviceId: SERVICE_ID,
    deploymentId: DEPLOYMENT_ID,
    source: options.source ?? gitSource(),
    internalPort: PORT_3000,
    publishedPort: options.publishedPort === undefined ? PORT_13100 : options.publishedPort,
    credential: options.credential ?? { kind: 'none' },
    otherServices: options.otherServices ?? [],
    panelPorts: [{ port: 3100, label: 'Noodara API' }],
    limits: { ...LIMITS, ...options.limits },
    pollPolicy: DEFAULT_POST_START_POLL_POLICY,
    progress,
    sink,
    clock: {
      now: () => (clock += 10),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.healthcheck === undefined ? {} : { healthcheck: options.healthcheck }),
    ...options.extra,
  };
  return { session, progress, sink, redactor, sleeps, input };
}

const SUCCESS_TAIL = ['docker.ps', 'docker.network_create', 'docker.create', 'docker.start', 'docker.inspect', 'docker.inspect'];

describe('runDeployment: git source (C1)', () => {
  it('clones, builds, preflights, creates, starts and polls, moving status through the state machine', async () => {
    const h = harness({});

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'SUCCESS', errorCode: null, commitSha: SHA, container: { kind: 'running' } });
    expect(h.progress.advances).toEqual([
      ['PREPARING', 'BUILDING'],
      ['BUILDING', 'DEPLOYING'],
      // 16-02 A7: the post-start polls are the HEALTHCHECK step; the worker's finish ends SUCCESS.
      ['DEPLOYING', 'HEALTHCHECK'],
    ]);
    expect(h.progress.shas).toEqual([SHA]);
    expect(h.session.keys()).toEqual([
      'fs.prepare_workspace',
      'supervise:clone',
      'git.head_sha',
      'git.probe_features',
      'supervise:build',
      ...SUCCESS_TAIL,
      'fs.remove_deploy_dir',
    ]);
    expect(h.session.argv('docker.create')).toContain(BUILT_IMAGE);
    // The first deploy created the network and attached the container: nothing else to remove.
    expect(h.session.keys()).not.toContain('docker.image_remove');
    expect(h.session.keys()).not.toContain('docker.network_remove');
    expect(h.sleeps).toEqual([1000, 2000]);
    expect(outcome.cleanup).toEqual([{ resource: 'workspace', outcome: 'removed' }]);
  });

  it('bounds every step by what is left of the deploy deadline and the idle timeout', async () => {
    const h = harness({});
    await runDeployment(h.input);
    const budgets = h.session.calls.filter((c) => c.key !== 'fs.remove_deploy_dir').map((c) => c.options.maxDurationMs);
    expect(Math.max(...budgets)).toBeLessThan(LIMITS.deployMaxMs);
    expect([...budgets].sort((a, b) => b - a)).toEqual(budgets);
    expect(h.session.calls.every((c) => c.options.idleTimeoutMs <= LIMITS.idleMs)).toBe(true);
  });

  it('fails BUILD_TIMEOUT without a remote command when the deadline is already spent', async () => {
    const h = harness({ limits: { deployMaxMs: 5 } });
    const outcome = await runDeployment(h.input);
    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'BUILD_TIMEOUT' });
    expect(h.session.keys()).not.toContain('supervise:clone');
  });

  it('replaces the previous container only after the build, and keeps the superseded image for retention (17-04)', async () => {
    const previous = psLine({ name: CONTAINER, image: OLD_IMAGE, ports: '0.0.0.0:13100->3000/tcp' });
    const h = harness({
      scripts: {
        'docker.ps': { stdout: `${previous}\n` },
        'docker.network_create': { exitCode: 1, stderr: NETWORK_EXISTS_STDERR },
      },
    });

    const outcome = await runDeployment(h.input);

    expect(outcome.status).toBe('SUCCESS');
    const keys = h.session.keys();
    expect(keys.indexOf('supervise:build')).toBeLessThan(keys.indexOf('docker.stop'));
    expect(keys.slice(keys.indexOf('docker.ps'))).toEqual([
      'docker.ps',
      'docker.network_create',
      'docker.stop',
      // 17-02 A1: the previous container is kept as -prev, removed only after the check passed.
      'docker.rename_to_prev',
      'docker.create',
      'docker.start',
      'docker.inspect',
      'docker.inspect',
      'docker.remove_prev',
      'fs.remove_deploy_dir',
    ]);
    expect(h.session.argv('docker.stop')).toContain(CONTAINER);
    // 17-04: the superseded image is a known-good rollback target; image retention decides.
    expect(keys).not.toContain('docker.image_remove');
    // The network existed already: it was not this attempt's to remove.
    expect(keys).not.toContain('docker.network_remove');
  });

  it('a failed build never touches the running container (C2)', async () => {
    const previous = psLine({ name: CONTAINER, image: OLD_IMAGE });
    const h = harness({
      scripts: {
        'docker.ps': { stdout: `${previous}\n` },
        'supervise:build': { exitCode: 1, stderr: BUILD_FAILED_STDERR },
      },
    });

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'BUILD_FAILED', container: null });
    expect(outcome.errorMessage).toMatch(/^The Docker build failed/);
    for (const key of ['docker.ps', 'docker.stop', 'docker.remove', 'docker.create', 'docker.start', 'docker.image_remove']) {
      expect(h.session.keys()).not.toContain(key);
    }
    expect(h.progress.advances).toEqual([['PREPARING', 'BUILDING']]);
    expect(h.session.keys().at(-1)).toBe('fs.remove_deploy_dir');
  });
});

describe('runDeployment: image source (C1)', () => {
  it('pulls instead of cloning and never removes a pulled image', async () => {
    const password = `noodara-canary-${randomBytes(16).toString('hex')}`;
    const h = harness({
      source: IMAGE_SOURCE,
      credential: {
        kind: 'registry',
        registry: {
          host: unwrap(validateRegistryHost('registry.example.com:5000')),
          username: unwrap(validateRegistryUsername('ci')),
          password: secretValue(password, 'api_key'),
        },
      },
    });

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'SUCCESS', commitSha: null });
    expect(h.progress.shas).toEqual([]);
    expect(h.session.keys()).toEqual([
      'fs.prepare_workspace',
      'docker.login',
      'supervise:pull',
      'docker.logout',
      ...SUCCESS_TAIL,
      'fs.remove_deploy_dir',
    ]);
    expect(h.session.argv('docker.create')).toContain(PULLED_IMAGE);
    expect(h.session.allArgv().join(' ')).not.toContain(password);
  });

  it('fails with the classified code when a public pull fails', async () => {
    const h = harness({ source: IMAGE_SOURCE, scripts: { 'supervise:pull': { exitCode: 1, stderr: DAEMON_DOWN_STDERR } } });
    const outcome = await runDeployment(h.input);
    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'DOCKER_UNAVAILABLE' });
    expect(h.session.keys()).not.toContain('docker.login');
  });
});

describe('runDeployment: deploy phase failures (C1, ERR)', () => {
  it('ends START_FAILED when the new container exits, keeps the superseded image and reports it stopped', async () => {
    const previous = psLine({ name: CONTAINER, image: OLD_IMAGE });
    const h = harness({
      scripts: {
        'docker.ps': { stdout: `${previous}\n` },
        'docker.inspect': { stdout: inspectJson('exited', '2026-10-05T10:00:00Z', 3) },
      },
    });

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({
      status: 'FAILED',
      errorCode: 'START_FAILED',
      container: { kind: 'stopped', exitCode: 3 },
    });
    expect(outcome.errorMessage).toContain('exit code 3');
    // 16-02 A7: the polls that saw the exit are the HEALTHCHECK step (HEALTHCHECK -> FAILED).
    expect(h.progress.advances.at(-1)).toEqual(['DEPLOYING', 'HEALTHCHECK']);
    // No auto-restore, and the superseded image stays for a manual rollback.
    expect(h.session.keys()).not.toContain('docker.image_remove');
    expect(h.session.keys().filter((k) => k === 'docker.start')).toHaveLength(1);
  });

  it('ends START_FAILED (not_stable) when the container never stays running', async () => {
    const h = harness({
      scripts: {
        'docker.inspect': [
          { stdout: inspectJson('running', '2026-10-05T10:00:00Z') },
          { stdout: inspectJson('restarting') },
          { stdout: inspectJson('running', '2026-10-05T10:00:05Z') },
          { stdout: inspectJson('restarting') },
          { stdout: inspectJson('running', '2026-10-05T10:00:09Z') },
        ],
      },
    });
    const outcome = await runDeployment(h.input);
    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'START_FAILED' });
    expect(h.session.keys().filter((k) => k === 'docker.inspect')).toHaveLength(5);
  });

  it('fails PORT_IN_USE before stopping anything when another service owns the published port', async () => {
    const previous = psLine({ name: CONTAINER, image: OLD_IMAGE });
    const h = harness({
      scripts: { 'docker.ps': { stdout: `${previous}\n` } },
      otherServices: [{ serviceId: OTHER_SERVICE_ID, publishedPort: 13100 }],
    });

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'PORT_IN_USE', container: null });
    expect(outcome.errorMessage).toMatch(/13100/);
    expect(h.session.keys()).not.toContain('docker.stop');
    expect(h.session.keys()).not.toContain('docker.create');
    // The built image is unused by any container of this attempt: it goes.
    expect(h.session.argv('docker.image_remove')).toContain(BUILT_IMAGE);
  });

  it('fails PORT_IN_USE when the panel owns the port', async () => {
    const port = unwrap(validateContainerPort(3100));
    const h = harness({ publishedPort: port });
    const outcome = await runDeployment(h.input);
    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'PORT_IN_USE' });
    expect(outcome.errorMessage).toContain('Noodara');
  });

  it('maps an unreachable daemon on docker ps to DOCKER_UNAVAILABLE', async () => {
    const h = harness({ scripts: { 'docker.ps': { exitCode: 1, stderr: DAEMON_DOWN_STDERR } } });
    const outcome = await runDeployment(h.input);
    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'DOCKER_UNAVAILABLE' });
    expect(h.session.keys()).not.toContain('docker.create');
  });

  it('removes the network it created when the create fails, and the unused image', async () => {
    const h = harness({ scripts: { 'docker.create': { exitCode: 1, stderr: DAEMON_DOWN_STDERR } } });
    const outcome = await runDeployment(h.input);
    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'DOCKER_UNAVAILABLE' });
    expect(h.session.keys().slice(-3)).toEqual(['fs.remove_deploy_dir', 'docker.image_remove', 'docker.network_remove']);
  });

  it('a transport failure becomes SERVER_UNREACHABLE and never throws', async () => {
    const dropped = { reject: new Error('socket hang up 10.0.0.5:22 stderr: secret') };
    // The session is gone: the A3 stop of the new container (17-07) fails the same way.
    const h = harness({ scripts: { 'docker.start': dropped, 'docker.stop': dropped } });
    const outcome = await runDeployment(h.input);
    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'SERVER_UNREACHABLE' });
    expect(outcome.errorMessage).not.toContain('socket hang up');
    expect(outcome.container).toEqual({ kind: 'unknown' });
  });
});

describe('runDeployment: timeouts and cleanup in finally (C2)', () => {
  it.each([
    ['timed_out', 'BUILD_TIMEOUT'],
    ['idle_timeout', 'BUILD_STALLED'],
  ] as const)('a %s build ends %s, kills the supervised group and still cleans up', async (outcome, code) => {
    const h = harness({ scripts: { 'supervise:build': { outcome, exitCode: null } } });

    const result = await runDeployment(h.input);

    expect(result).toMatchObject({ status: 'FAILED', errorCode: code });
    const keys = h.session.keys();
    expect(keys.slice(keys.indexOf('supervise:build'))).toEqual([
      'supervise:build',
      'process.kill_group',
      'process.group_alive',
      'fs.remove_deploy_dir',
    ]);
    expect(h.session.argv('process.kill_group').join(' ')).toContain(WORKSPACE.pidFile('build'));
    expect(keys).not.toContain('docker.stop');
  });

  it('an aborted step ends CANCELLED and still cleans up', async () => {
    const controller = new AbortController();
    const h = harness({ scripts: { 'supervise:clone': { outcome: 'aborted', exitCode: null } }, signal: controller.signal });
    const result = await runDeployment(h.input);
    expect(result).toMatchObject({ status: 'CANCELLED', errorCode: null });
    expect(h.session.keys()).toContain('process.kill_group');
    expect(h.session.keys().at(-1)).toBe('fs.remove_deploy_dir');
  });

  it('a cancel mid-build kills the group, confirms it gone, ends CANCELLED and cleans up (A2)', async () => {
    const controller = new AbortController();
    const h = harness({ scripts: { 'supervise:build': { outcome: 'aborted', exitCode: null } }, signal: controller.signal });
    h.session.onStream = (key) => {
      if (key === 'supervise:build') controller.abort();
    };

    const result = await runDeployment(h.input);

    expect(result).toMatchObject({ status: 'CANCELLED', errorCode: null });
    expect(result.warning).toBeUndefined();
    const keys = h.session.keys();
    expect(keys.slice(keys.indexOf('supervise:build'))).toEqual([
      'supervise:build',
      'process.kill_group',
      'process.group_alive',
      'fs.remove_deploy_dir',
    ]);
    expect(h.session.argv('process.kill_group').join(' ')).toContain(WORKSPACE.pidFile('build'));
    expect(keys).not.toContain('docker.stop');
  });

  it('a cancel seen between steps ends CANCELLED before the next remote command (A2)', async () => {
    const controller = new AbortController();
    const h = harness({ signal: controller.signal });
    const advance = h.progress.advance.bind(h.progress);
    h.progress.advance = (from, to) => {
      if (to === 'BUILDING') controller.abort();
      return advance(from, to);
    };

    const result = await runDeployment(h.input);

    expect(result).toMatchObject({ status: 'CANCELLED', errorCode: null });
    expect(h.session.keys()).not.toContain('supervise:build');
    expect(h.session.keys()).not.toContain('process.kill_group');
    expect(h.session.keys().at(-1)).toBe('fs.remove_deploy_dir');
  });

  it('an already aborted signal runs no remote command but the workspace cleanup (A1)', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ signal: controller.signal });

    const result = await runDeployment(h.input);

    expect(result).toMatchObject({ status: 'CANCELLED' });
    expect(h.session.keys()).toEqual(['fs.remove_deploy_dir']);
  });

  it('an unconfirmed kill ends FAILED with the named warning, still cleans up and stays bounded (H2)', async () => {
    const controller = new AbortController();
    const h = harness({
      scripts: { 'supervise:build': { outcome: 'aborted', exitCode: null }, 'process.group_alive': { exitCode: 0 } },
      signal: controller.signal,
      limits: { killConfirmMs: 300, killPollMs: 50 },
    });
    h.session.onStream = (key) => {
      if (key === 'supervise:build') controller.abort();
    };
    const started = Date.now();

    const result = await runDeployment(h.input);

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toMatchObject({
      status: 'FAILED',
      errorCode: CANCEL_UNCONFIRMED_ERROR_CODE,
      errorMessage: DEPLOY_MESSAGES.CANCEL_UNCONFIRMED,
      warning: CANCEL_UNCONFIRMED,
    });
    expect(h.session.keys().filter((key) => key === 'process.group_alive').length).toBeGreaterThan(0);
    expect(h.session.keys().at(-1)).toBe('fs.remove_deploy_dir');
  });

  it('a cancel after the container swap started is ignored: the attempt ends SUCCESS (H1)', async () => {
    const controller = new AbortController();
    const h = harness({ signal: controller.signal });
    h.session.onStream = (key) => {
      if (key === 'docker.create') controller.abort();
    };

    const result = await runDeployment(h.input);

    expect(result).toMatchObject({ status: 'SUCCESS', container: { kind: 'running' } });
    const createIndex = h.session.calls.findIndex((call) => call.key === 'docker.create');
    for (const call of h.session.calls.slice(createIndex + 1)) {
      expect(call.options.signal).toBeUndefined();
    }
  });

  it('a thrown error (store down) ends FAILED WORKER_CRASHED without leaking it, and still cleans up', async () => {
    const h = harness({});
    h.progress.failOn = 'DEPLOYING';

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'WORKER_CRASHED' });
    expect(JSON.stringify(outcome)).not.toContain('pw@db');
    expect(h.session.keys()).not.toContain('docker.create');
    // Workspace first, then the unused built image (same order as the cleanup report).
    expect(h.session.keys().slice(-2)).toEqual(['fs.remove_deploy_dir', 'docker.image_remove']);
    expect(h.session.argv('docker.image_remove')).toContain(BUILT_IMAGE);
  });

  it('a store failure entering HEALTHCHECK ends FAILED WORKER_CRASHED before any post-start poll', async () => {
    const h = harness({});
    h.progress.failOn = 'HEALTHCHECK';

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'WORKER_CRASHED' });
    expect(JSON.stringify(outcome)).not.toContain('pw@db');
    expect(h.session.keys()).toContain('docker.start');
    expect(h.session.keys()).not.toContain('docker.inspect');
  });

  it('reports in-use and failed cleanup without failing the deployment or throwing', async () => {
    const previous = psLine({ name: CONTAINER, image: OLD_IMAGE });
    const h = harness({
      scripts: {
        'docker.ps': { stdout: `${previous}\n` },
        'docker.image_remove': { exitCode: 1, stderr: IMAGE_IN_USE_STDERR },
        'fs.remove_deploy_dir': { reject: new Error('channel closed') },
      },
    });
    const outcome = await runDeployment(h.input);
    expect(outcome.status).toBe('SUCCESS');
    // 17-04: the superseded image is not in the SUCCESS cleanup set; retention owns it.
    expect(outcome.cleanup).toEqual([{ resource: 'workspace', outcome: 'failed' }]);
  });

  it('reports an in-use attempt image on a failed exit without throwing', async () => {
    const h = harness({
      scripts: {
        'docker.create': { exitCode: 1, stderr: 'Error response from daemon: boom' },
        'docker.image_remove': { exitCode: 1, stderr: IMAGE_IN_USE_STDERR },
      },
    });
    const outcome = await runDeployment(h.input);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.cleanup).toContainEqual({ resource: 'image', outcome: 'in_use' });
  });
});

describe('runDeployment: log sink and secrets (A6, SEC)', () => {
  it('writes every streamed chunk to the injected sink with its phase and an increasing seq', async () => {
    const h = harness({
      scripts: {
        'supervise:clone': { stderr: "Cloning into 'repo'...\n" },
        'supervise:build': { stdout: '#1 [internal] load build definition\n' },
        'docker.start': { stdout: `${CONTAINER}\n` },
      },
    });

    await runDeployment(h.input);

    const phases = h.sink.entries.map((e) => e.phase);
    expect(phases).toContain('prepare');
    expect(phases).toContain('build');
    expect(phases).toContain('deploy');
    expect(h.sink.entries.find((e) => e.text.includes('Cloning'))?.phase).toBe('prepare');
    expect(h.sink.entries.find((e) => e.text.includes('load build definition'))?.phase).toBe('build');
    const seqs = h.sink.entries.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('per-run canary: an HTTPS token echoed by a leaky session never reaches the sink, argv, progress or outcome', async () => {
    const token = `ghp_${randomBytes(18).toString('hex')}`;
    const h = harness({
      leakySession: true,
      credential: { kind: 'https_token', token: secretValue(token, 'api_key') },
      scripts: {
        'supervise:clone': { stderr: `fatal: could not read from https://x-access-token:${token}@github.com\n` },
        'supervise:build': { stdout: `#4 RUN echo ${token}\n${token}\n` },
      },
    });

    const release = vi.spyOn(h.redactor, 'release');

    const outcome = await runDeployment(h.input);

    expect(outcome.status).toBe('SUCCESS');
    expect(h.sink.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(h.sink.entries)).not.toContain(token);
    expect(JSON.stringify(h.sink.entries)).toContain('[REDACTED');
    expect(h.session.allArgv().join('\n')).not.toContain(token);
    expect(JSON.stringify(outcome)).not.toContain(token);
    expect(JSON.stringify(h.progress)).not.toContain(token);
    // Released once the run ends: a long-lived worker does not accumulate secrets.
    // (redact(token) alone cannot prove it: the structural ghp_ pattern still masks it.)
    expect(release).toHaveBeenCalledWith(token);
  });

  it('per-run canary: a non-structural HTTPS token stays redacted in output emitted after the clone step', async () => {
    // Plain hex: no structural pattern (ghp_, sk-, ...) masks it, only the run-level registration.
    const token = randomBytes(24).toString('hex');
    const h = harness({
      leakySession: true,
      credential: { kind: 'https_token', token: secretValue(token, 'api_key') },
      scripts: { 'supervise:build': { stdout: `#4 RUN echo ${token}\n${token}\n` } },
    });

    const outcome = await runDeployment(h.input);

    expect(outcome.status).toBe('SUCCESS');
    const buildText = h.sink.entries.filter((e) => e.phase === 'build').map((e) => e.text).join('');
    expect(buildText).toContain('[REDACTED:api_key]');
    expect(JSON.stringify(h.sink.entries)).not.toContain(token);
    expect(JSON.stringify(outcome)).not.toContain(token);
  });

  it('per-run canary: a registry password stays registered after the pull step until the run ends', async () => {
    const password = randomBytes(24).toString('hex');
    const probes: string[] = [];
    const h = harness({
      source: IMAGE_SOURCE,
      leakySession: true,
      credential: {
        kind: 'registry',
        registry: {
          host: unwrap(validateRegistryHost('registry.example.com:5000')),
          username: unwrap(validateRegistryUsername('ci')),
          password: secretValue(password, 'api_key'),
        },
      },
    });
    h.session.onStream = (key) => {
      if (key === 'docker.create') probes.push(h.redactor.redact(`echo ${password}`));
    };

    const outcome = await runDeployment(h.input);

    expect(outcome.status).toBe('SUCCESS');
    expect(probes).toEqual(['echo [REDACTED:api_key]']);
    // Released once the run ends.
    expect(h.redactor.redact(password)).toBe(password);
  });

  it('per-run canary: a deploy key and a registry password never reach argv or the sink', async () => {
    const key = `-----BEGIN OPENSSH PRIVATE KEY-----\n${randomBytes(48).toString('base64')}\n-----END OPENSSH PRIVATE KEY-----\n`;
    const h = harness({
      leakySession: true,
      credential: { kind: 'deploy_key', privateKey: secretValue(key, 'ssh_private_key') },
      scripts: { 'supervise:clone': { stderr: key } },
    });
    await runDeployment(h.input);
    const body = key.split('\n')[1] ?? 'missing';
    expect(JSON.stringify(h.sink.entries)).not.toContain(body);
    expect(h.session.allArgv().join('\n')).not.toContain(body);
  });
});

describe('runDeployment: names come only from validated ids (H2)', () => {
  // Leading '-': an option-injection attempt. A bare '-rf' would collide with the static `rm -rf --` argv.
  const HOSTILE = ['$(touch pwned)', '`id`', ';rm -rf /', '--upload-pack=touch pwned'];

  it('passes a hostile-looking branch as one argv element after --, never in a shell string', async () => {
    const branch = 'release/-rf';
    const h = harness({ source: gitSource({ branch }) });

    await runDeployment(h.input);

    const clone = h.session.argv('supervise:clone');
    expect(clone.filter((arg) => arg === branch)).toHaveLength(1);
    expect(clone.indexOf('--')).toBeLessThan(clone.indexOf('https://github.com/acme/api.git'));
    expect(clone.indexOf('--branch')).toBe(clone.indexOf(branch) - 1);
    for (const call of h.session.calls) {
      if (call.key === 'supervise:clone') continue;
      expect(call.command.argv).not.toContain(branch);
    }
  });

  it('never interpolates hostile git output into a later command', async () => {
    for (const hostile of HOSTILE) {
      const h = harness({ scripts: { 'git.head_sha': { stdout: `${hostile}\n` } } });
      const outcome = await runDeployment(h.input);
      expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'CLONE_FAILED', commitSha: null });
      expect(h.session.allArgv().some((arg) => arg.includes(hostile))).toBe(false);
      expect(h.progress.shas).toEqual([]);
    }
  });

  it('workspace, image, container and network names are derived from the ids only', async () => {
    const previous = psLine({ name: CONTAINER, image: OLD_IMAGE });
    const h = harness({ scripts: { 'docker.ps': { stdout: `${previous}\n` } } });
    await runDeployment(h.input);
    const named = h.session.allArgv().filter((arg) => arg.includes(SERVICE_ID) || arg.includes(DEPLOYMENT_ID));
    const allowed = new Set([CONTAINER, `${CONTAINER}-prev`, NETWORK, BUILT_IMAGE, OLD_IMAGE]);
    for (const arg of named) {
      const ok =
        allowed.has(arg) ||
        arg.startsWith(WORKSPACE.root) ||
        /^noodara\.(service_id|deployment_id)=[0-9a-f-]{36}$/.test(arg) ||
        /^(label=)?noodara\.\w+=[0-9a-f-]{36}$/.test(arg);
      expect(ok, arg).toBe(true);
    }
  });
});

// 14-07: TOFU pinning of a non-bundled Git host's SSH key per service (A1, H1, H2, H3).
const GIT_HOST = 'git.example.com';
const SSH_URL = `git@${GIT_HOST}:acme/api.git`;
const RESET_HINT = `noodara services reset-host-key ${SERVICE_ID}`;
const HOST_KEY_CHANGED_STDERR =
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.\nfatal: Could not read from remote repository.\n';

/** A fresh, structurally valid ssh-ed25519 blob. */
function ed25519Blob(): string {
  const u32 = (n: number): Buffer => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(n);
    return buffer;
  };
  return Buffer.concat([u32(11), Buffer.from('ssh-ed25519'), u32(32), randomBytes(32)]).toString('base64');
}

function hostKey(blob: string, host = GIT_HOST): GitHostKey {
  return unwrap(parseGitHostKeyLine(`${host} ssh-ed25519 ${blob}`));
}

class FakeHostKeyStore implements GitHostKeyStore {
  readonly pins: PinnedGitHostKeys[] = [];
  loads = 0;
  loadError: Error | null = null;
  pinResult: GitHostKeyPinResult = { kind: 'stored' };

  constructor(public stored: PinnedGitHostKeys | null = null) {}

  load(serviceId: string): Promise<PinnedGitHostKeys | null> {
    expect(serviceId).toBe(SERVICE_ID);
    this.loads += 1;
    if (this.loadError !== null) return Promise.reject(this.loadError);
    return Promise.resolve(this.stored);
  }

  pin(serviceId: string, pinned: PinnedGitHostKeys): Promise<GitHostKeyPinResult> {
    expect(serviceId).toBe(SERVICE_ID);
    this.pins.push(pinned);
    return Promise.resolve(this.pinResult);
  }
}

function tofuHarness(
  store: FakeHostKeyStore,
  options: { url?: string; scripts?: Record<string, Script | Script[]> } = {},
): Harness & { readonly input: RunDeploymentInput } {
  const h = harness({
    source: gitSource({ repositoryUrl: options.url ?? SSH_URL }),
    ...(options.scripts === undefined ? {} : { scripts: options.scripts }),
  });
  return { ...h, input: { ...h.input, gitHostKeys: store } };
}

function knownHostsWritten(h: Harness): string {
  const write = h.session.calls.find(
    (call) => call.key === 'secrets.write_file' && call.command.argv.some((arg) => arg.endsWith('/known_hosts')),
  );
  if (write?.options.stdin === undefined) throw new Error('no known_hosts write');
  return revealSecret(write.options.stdin);
}

function surfaceOf(h: Harness, outcome: { errorMessage: string | null }): string {
  return [outcome.errorMessage ?? '', ...h.sink.entries.map((entry) => entry.text)].join('\n');
}

describe('runDeployment: git host key pinning per service (14-07)', () => {
  it('A1: the first SSH clone of a non-bundled host pins the scanned key before the build', async () => {
    const blob = ed25519Blob();
    const store = new FakeHostKeyStore();
    const h = tofuHarness(store, { scripts: { 'git.keyscan': { stdout: `${GIT_HOST} ssh-ed25519 ${blob}\n` } } });

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'SUCCESS' });
    expect(store.pins).toEqual([{ host: GIT_HOST, keys: [hostKey(blob)] }]);
    expect(h.session.keys()).toContain('git.keyscan');
    expect(knownHostsWritten(h)).toBe(`${GIT_HOST} ssh-ed25519 ${blob}\n`);
  });

  it('A1: a later clone pins the stored key: no keyscan, nothing stored again', async () => {
    const blob = ed25519Blob();
    const store = new FakeHostKeyStore({ host: GIT_HOST, keys: [hostKey(blob)] });
    const h = tofuHarness(store);

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'SUCCESS' });
    expect(h.session.keys()).not.toContain('git.keyscan');
    expect(store.pins).toEqual([]);
    expect(knownHostsWritten(h)).toBe(`${GIT_HOST} ssh-ed25519 ${blob}\n`);
  });

  it('H1: the loser of a concurrent first clone verifies against the winner and proceeds when they agree', async () => {
    const blob = ed25519Blob();
    const store = new FakeHostKeyStore();
    store.pinResult = { kind: 'existing', pinned: { host: GIT_HOST, keys: [hostKey(blob)] } };
    const h = tofuHarness(store, { scripts: { 'git.keyscan': { stdout: `${GIT_HOST} ssh-ed25519 ${blob}\n` } } });

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'SUCCESS' });
    expect(store.pins).toHaveLength(1);
  });

  it('H1/H3: a loser that scanned a different key fails GIT_HOST_KEY_MISMATCH before the build, without key material', async () => {
    const winner = ed25519Blob();
    const offending = ed25519Blob();
    const store = new FakeHostKeyStore();
    store.pinResult = { kind: 'existing', pinned: { host: GIT_HOST, keys: [hostKey(winner)] } };
    const h = tofuHarness(store, { scripts: { 'git.keyscan': { stdout: `${GIT_HOST} ssh-ed25519 ${offending}\n` } } });

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'GIT_HOST_KEY_MISMATCH' });
    expect(outcome.errorMessage).toContain(RESET_HINT);
    expect(h.session.keys()).not.toContain('supervise:build');
    expect(h.session.keys()).toContain('fs.remove_deploy_dir');
    const surface = surfaceOf(h, outcome);
    expect(surface).not.toContain(winner);
    expect(surface).not.toContain(offending);
  });

  it('H1: a superset scan (the pinned key plus another) is not accepted by the loser', async () => {
    const winner = ed25519Blob();
    const extra = ed25519Blob();
    const store = new FakeHostKeyStore();
    store.pinResult = { kind: 'existing', pinned: { host: GIT_HOST, keys: [hostKey(winner)] } };
    const h = tofuHarness(store, {
      scripts: { 'git.keyscan': { stdout: `${GIT_HOST} ssh-ed25519 ${winner}\n${GIT_HOST} ssh-ed25519 ${extra}\n` } },
    });

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'GIT_HOST_KEY_MISMATCH' });
  });

  it('A2/H3: a rotated host key refused by ssh fails GIT_HOST_KEY_MISMATCH with the reset hint, never auto-replaced', async () => {
    const pinned = ed25519Blob();
    const store = new FakeHostKeyStore({ host: GIT_HOST, keys: [hostKey(pinned)] });
    const h = tofuHarness(store, { scripts: { 'supervise:clone': { exitCode: 128, stderr: HOST_KEY_CHANGED_STDERR } } });

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'GIT_HOST_KEY_MISMATCH' });
    expect(outcome.errorMessage).toContain(RESET_HINT);
    expect(outcome.errorMessage).not.toContain('REMOTE HOST');
    expect(store.pins).toEqual([]);
    expect(h.session.keys()).not.toContain('git.keyscan');
    expect(h.session.keys()).toContain('fs.remove_deploy_dir');
    expect(surfaceOf(h, outcome)).not.toContain(pinned);
  });

  it('H2: a pin stored for another host is neither used nor blocking: the new host is scanned and pinned', async () => {
    const stale = ed25519Blob();
    const blob = ed25519Blob();
    const store = new FakeHostKeyStore({ host: 'old.example.com', keys: [hostKey(stale, 'old.example.com')] });
    const h = tofuHarness(store, { scripts: { 'git.keyscan': { stdout: `${GIT_HOST} ssh-ed25519 ${blob}\n` } } });

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'SUCCESS' });
    expect(knownHostsWritten(h)).not.toContain(stale);
    expect(store.pins).toEqual([{ host: GIT_HOST, keys: [hostKey(blob)] }]);
  });

  it('H3: keyscan output never reaches the deployment log as a key blob', async () => {
    const blob = ed25519Blob();
    const store = new FakeHostKeyStore();
    const h = tofuHarness(store, { scripts: { 'git.keyscan': { stdout: `${GIT_HOST} ssh-ed25519 ${blob}\n` } } });

    const outcome = await runDeployment(h.input);

    expect(outcome.status).toBe('SUCCESS');
    expect(h.sink.entries.map((entry) => entry.text).join('\n')).not.toContain(blob);
  });

  it('https and bundled-host clones never read or write the store', async () => {
    for (const url of ['https://github.com/acme/api.git', 'git@github.com:acme/api.git']) {
      const store = new FakeHostKeyStore();
      store.loadError = new Error('store must not be read');
      const h = tofuHarness(store, { url });

      const outcome = await runDeployment(h.input);

      expect(outcome).toMatchObject({ status: 'SUCCESS' });
      expect(store.loads).toBe(0);
      expect(store.pins).toEqual([]);
      expect(h.session.keys()).not.toContain('git.keyscan');
    }
  });

  it('a bundled-host mismatch keeps the published-key message (a reset would not help)', async () => {
    const store = new FakeHostKeyStore();
    const h = tofuHarness(store, {
      url: 'git@github.com:acme/api.git',
      scripts: { 'supervise:clone': { exitCode: 128, stderr: HOST_KEY_CHANGED_STDERR } },
    });

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'GIT_HOST_KEY_MISMATCH' });
    expect(outcome.errorMessage).not.toContain('reset-host-key');
  });

  it('fails closed when the store cannot be read: no keyscan, no clone', async () => {
    const store = new FakeHostKeyStore();
    store.loadError = new Error('connection to postgres://u:pw@db lost');
    const h = tofuHarness(store);

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'WORKER_CRASHED' });
    expect(h.session.keys()).not.toContain('git.keyscan');
    expect(h.session.keys()).not.toContain('supervise:clone');
    expect(outcome.errorMessage).not.toContain('pw@');
  });
});

// 17-02: the kept `-prev` container, the HEALTHCHECK step and the restore on a failed swap.
const SERVICE_IP = '172.18.0.5';
const NETWORKS_ATTACHED = `${JSON.stringify({ [NETWORK]: { IPAddress: SERVICE_IP } })}\n`;
const GENERIC_DAEMON_ERROR = 'Error response from daemon: something went wrong\n';
const NO_SUCH_IMAGE = `Error response from daemon: No such image: ${OLD_IMAGE}\n`;
const PREVIOUS_RESTORED = 'The new container could not start, so the previous version was restored.';
const CURRENT_RESTARTED = 'The running version could not be replaced, so it was started again.';

const TIMING = { probeTimeoutS: 2, intervalS: 1, retries: 2, startPeriodS: 0 };
const HTTP_CHECK: HealthcheckConfig = unwrap(
  validateHealthcheckConfig({ type: 'http', path: '/healthz', port: 3000, expectedStatuses: [200], ...TIMING }),
);
const TCP_CHECK: HealthcheckConfig = unwrap(validateHealthcheckConfig({ type: 'tcp', port: 3000, ...TIMING }));

const PREVIOUS_SCRIPTS: Record<string, Script | Script[]> = {
  'docker.ps': { stdout: `${psLine({ name: CONTAINER, image: OLD_IMAGE, ports: '0.0.0.0:13100->3000/tcp' })}\n` },
  'docker.network_create': { exitCode: 1, stderr: NETWORK_EXISTS_STDERR },
  'docker.inspect_networks': { stdout: NETWORKS_ATTACHED },
};

function probing(probe: Script | Script[], extra: Record<string, Script | Script[]> = {}): Record<string, Script | Script[]> {
  return { ...PREVIOUS_SCRIPTS, 'probe.http': probe, 'probe.tcp': probe, ...extra };
}

function logText(h: Harness, phase?: string): string {
  return h.sink.entries
    .filter((entry) => phase === undefined || entry.phase === phase)
    .map((entry) => entry.text)
    .join('\n');
}

/** H1: nothing after the swap ever removes the kept container or its image on a failed exit. */
function expectPreviousUntouched(h: Harness): void {
  const keys = h.session.keys();
  expect(keys).not.toContain('docker.remove_prev');
  h.session.calls
    .filter((call) => call.key === 'docker.image_remove')
    .forEach((call) => {
      expect(call.command.argv).not.toContain(OLD_IMAGE);
    });
  expect(h.session.allArgv().some((arg) => arg.includes(`${CONTAINER}-prev`) && arg.includes('rm'))).toBe(false);
}

describe('runDeployment: runtime config snapshot (17-02 A3)', () => {
  it('stores the runtime config and image ref on the BUILDING -> DEPLOYING edge', async () => {
    const h = harness({ healthcheck: HTTP_CHECK, scripts: probing({ stdout: 'NOODARA_PROBE http 200\n' }) });

    await runDeployment(h.input);

    expect(h.progress.records).toEqual([
      {
        to: 'DEPLOYING',
        record: {
          runtimeConfig: {
            version: 1,
            imageRef: BUILT_IMAGE,
            internalPort: 3000,
            publishedPort: 13100,
            healthcheck: HTTP_CHECK,
          },
        },
      },
    ]);
  });

  it('a service without healthcheck snapshots the container default and keeps the v0.2 polls', async () => {
    const h = harness({});

    const outcome = await runDeployment(h.input);

    expect(outcome.status).toBe('SUCCESS');
    const snapshot = h.progress.records[0]?.record.runtimeConfig;
    expect(snapshot?.healthcheck.type).toBe('container');
    expect(h.session.keys()).not.toContain('probe.http');
    expect(h.session.keys()).not.toContain('probe.tcp');
  });
});

describe('runDeployment: HEALTHCHECK step (17-02 A1, A2, A3)', () => {
  it('HTTP pass: logs fixed lines in the healthcheck phase and removes -prev only after the pass', async () => {
    const h = harness({
      healthcheck: HTTP_CHECK,
      scripts: probing([{ stdout: 'NOODARA_PROBE http 500\n' }, { stdout: 'NOODARA_PROBE http 200\n' }]),
    });

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'SUCCESS', container: { kind: 'running' } });
    expect(h.progress.advances.at(-1)).toEqual(['DEPLOYING', 'HEALTHCHECK']);
    const keys = h.session.keys();
    expect(keys.indexOf('docker.rename_to_prev')).toBeLessThan(keys.indexOf('docker.create'));
    expect(keys.lastIndexOf('probe.http')).toBeLessThan(keys.indexOf('docker.remove_prev'));
    expect(h.session.argv('probe.http').join(' ')).toContain(SERVICE_IP);
    const log = logText(h, 'healthcheck');
    expect(log).toContain('Healthcheck attempt 1: HTTP 500');
    expect(log).toContain('Healthcheck attempt 2: HTTP 200');
    expect(log).toContain('Healthcheck passed.');
    // A2: the probe target never reaches the log.
    expect(logText(h)).not.toContain(SERVICE_IP);
    // 17-04: even on SUCCESS the superseded image stays; image retention owns it.
    expect(keys).not.toContain('docker.image_remove');
  });

  it('TCP pass: an open port passes the check', async () => {
    const h = harness({ healthcheck: TCP_CHECK, scripts: probing({ stdout: 'NOODARA_PROBE open\n' }) });

    const outcome = await runDeployment(h.input);

    expect(outcome.status).toBe('SUCCESS');
    expect(h.session.keys()).toContain('probe.tcp');
    expect(logText(h, 'healthcheck')).toContain('Healthcheck attempt 1: port open');
  });

  it('wrong status: ends HEALTHCHECK_FAILED with the fixed message and keeps -prev and its image', async () => {
    const h = harness({ healthcheck: HTTP_CHECK, scripts: probing({ stdout: 'NOODARA_PROBE http 500\n' }) });

    const outcome = await runDeployment(h.input);

    // 17-07 A3: without auto_rollback the failed new container is stopped, -prev kept.
    expect(outcome).toMatchObject({
      status: 'FAILED',
      errorCode: 'HEALTHCHECK_FAILED',
      errorMessage: V03_DEPLOYMENT_ERROR_MESSAGES.HEALTHCHECK_FAILED,
      container: { kind: 'stopped' },
    });
    expect(h.session.keys().filter((k) => k === 'probe.http')).toHaveLength(2);
    expectPreviousUntouched(h);
  });

  it('timeout: probes that never answer end HEALTHCHECK_TIMEOUT with the fixed message', async () => {
    const h = harness({ healthcheck: HTTP_CHECK, scripts: probing({ outcome: 'timed_out', exitCode: null }) });

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({
      status: 'FAILED',
      errorCode: 'HEALTHCHECK_TIMEOUT',
      errorMessage: V03_DEPLOYMENT_ERROR_MESSAGES.HEALTHCHECK_TIMEOUT,
    });
    expect(logText(h, 'healthcheck')).toContain('no answer before the probe timeout');
    expectPreviousUntouched(h);
  });

  it('a container that exits during the check ends HEALTHCHECK_FAILED without probing', async () => {
    const h = harness({
      healthcheck: HTTP_CHECK,
      scripts: probing({ stdout: 'NOODARA_PROBE http 200\n' }, { 'docker.inspect': { stdout: inspectJson('exited', undefined, 1) } }),
    });

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'HEALTHCHECK_FAILED', container: { kind: 'stopped' } });
    expect(h.session.keys()).not.toContain('probe.http');
    expectPreviousUntouched(h);
  });
});

describe('runDeployment: the kept container across every HEALTHCHECK exit (17-02 H1)', () => {
  it.each([
    ['HEALTHCHECK_FAILED', probing({ stdout: 'NOODARA_PROBE http 500\n' }), null],
    ['HEALTHCHECK_TIMEOUT', probing({ outcome: 'timed_out', exitCode: null }), null],
    ['SERVER_UNREACHABLE', probing({ reject: new Error('socket hang up') }), null],
    ['DOCKER_UNAVAILABLE', probing({}, { 'docker.inspect': { exitCode: 1, stderr: DAEMON_DOWN_STDERR } }), null],
    ['WORKER_CRASHED', probing({ stdout: 'NOODARA_PROBE http 200\n' }), 'HEALTHCHECK'],
  ] as const)('%s never removes -prev or the previous image', async (code, scripts, failOn) => {
    const h = harness({ healthcheck: HTTP_CHECK, scripts });
    h.progress.failOn = failOn;

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: code });
    expect(h.session.keys()).toContain('docker.rename_to_prev');
    expectPreviousUntouched(h);
  });

  it('a cancel during the check is ignored once the swap started: the attempt still decides on health', async () => {
    const controller = new AbortController();
    const h = harness({
      healthcheck: HTTP_CHECK,
      signal: controller.signal,
      scripts: probing({ stdout: 'NOODARA_PROBE http 500\n' }),
    });
    h.session.onStream = (key) => {
      if (key === 'probe.http') controller.abort();
    };

    const outcome = await runDeployment(h.input);

    expect(outcome.status).not.toBe('SUCCESS');
    expectPreviousUntouched(h);
  });

  it.each(['FAILED', 'CANCELLED', 'TIMEOUT', 'WORKER_CRASHED'] as const satisfies readonly DeploymentExit[])(
    'running the %s ledger cleanup twice is idempotent and never targets -prev or its image',
    async (exit) => {
      const ledger = [
        { kind: 'workspace_created' },
        { kind: 'image_created' },
        { kind: 'previous_container_kept', imageRef: OLD_IMAGE },
        { kind: 'container_created' },
      ] as const;
      const built = ledger.reduce(recordResource, unwrap(createResourceLedger(SERVICE_ID, DEPLOYMENT_ID)));
      const session = new FakeSession({
        'docker.image_remove': [{ exitCode: 0 }, { exitCode: 1, stderr: NO_SUCH_IMAGE.replace(OLD_IMAGE, BUILT_IMAGE) }],
      });

      const first = await runLedgerCleanup(session, LIMITS, WORKSPACE, built, exit);
      const second = await runLedgerCleanup(session, LIMITS, WORKSPACE, built, exit);

      expect(first.every((report) => isCleanupSettled(report.outcome))).toBe(true);
      expect(second.every((report) => isCleanupSettled(report.outcome))).toBe(true);
      expect(second.map((report) => report.resource)).toEqual(first.map((report) => report.resource));
      expect(session.allArgv()).not.toContain(OLD_IMAGE);
      expect(session.allArgv().some((arg) => arg.endsWith('-prev'))).toBe(false);
    },
  );
});

describe('runDeployment: a failed swap restores the previous version (17-02 H2)', () => {
  it('create fails after the rename: the new container is removed and -prev restored', async () => {
    const h = harness({
      scripts: { ...PREVIOUS_SCRIPTS, 'docker.create': { exitCode: 1, stderr: GENERIC_DAEMON_ERROR } },
    });

    const outcome = await runDeployment(h.input);

    expect(outcome.status).toBe('FAILED');
    expect(outcome.errorCode).not.toBe('ROLLBACK_FAILED');
    expect(outcome.container).toEqual({ kind: 'running' });
    const keys = h.session.keys();
    expect(keys.slice(keys.indexOf('docker.create'), keys.indexOf('docker.create') + 5)).toEqual([
      'docker.create',
      'docker.remove',
      'docker.rename_from_prev',
      'docker.inspect_networks',
      'docker.start',
    ]);
    expect(keys).not.toContain('docker.network_connect');
    expect(logText(h, 'deploy')).toContain(PREVIOUS_RESTORED);
    expectPreviousUntouched(h);
  });

  it('start fails after the rename: -prev is restored (re-attached when detached) and started', async () => {
    const h = harness({
      scripts: {
        ...PREVIOUS_SCRIPTS,
        'docker.inspect_networks': { stdout: '{}\n' },
        'docker.start': [{ exitCode: 1, stderr: GENERIC_DAEMON_ERROR }, { exitCode: 0 }],
      },
    });

    const outcome = await runDeployment(h.input);

    expect(outcome.status).toBe('FAILED');
    expect(outcome.container).toEqual({ kind: 'running' });
    const keys = h.session.keys();
    const from = keys.indexOf('docker.start');
    expect(keys.slice(from, from + 6)).toEqual([
      'docker.start',
      'docker.remove',
      'docker.rename_from_prev',
      'docker.inspect_networks',
      'docker.network_connect',
      'docker.start',
    ]);
    expect(h.progress.advances.map(([, to]) => to)).not.toContain('HEALTHCHECK');
    expect(logText(h, 'deploy')).toContain(PREVIOUS_RESTORED);
    expectPreviousUntouched(h);
  });

  it('a restore that fails too is reported, never thrown, and keeps the original error code', async () => {
    const h = harness({
      scripts: {
        ...PREVIOUS_SCRIPTS,
        'docker.create': { exitCode: 1, stderr: GENERIC_DAEMON_ERROR },
        'docker.rename_from_prev': { exitCode: 1, stderr: GENERIC_DAEMON_ERROR },
      },
    });
    const baseline = harness({
      scripts: { ...PREVIOUS_SCRIPTS, 'docker.create': { exitCode: 1, stderr: GENERIC_DAEMON_ERROR } },
    });

    const outcome = await runDeployment(h.input);
    const expected = await runDeployment(baseline.input);

    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: expected.errorCode, container: { kind: 'unknown' } });
    expect(logText(h, 'deploy')).toContain('the previous version could not be restored');
  });

  it.each([
    ['stop', { 'docker.stop': { exitCode: 1, stderr: GENERIC_DAEMON_ERROR } }],
    ['rename', { 'docker.rename_to_prev': { exitCode: 1, stderr: GENERIC_DAEMON_ERROR } }],
  ] as const)('a %s failure before the new container exists starts the current one again', async (_step, scripts) => {
    const h = harness({ scripts: { ...PREVIOUS_SCRIPTS, ...scripts } });

    const outcome = await runDeployment(h.input);

    expect(outcome.status).toBe('FAILED');
    expect(outcome.container).toEqual({ kind: 'running' });
    const keys = h.session.keys();
    expect(keys).not.toContain('docker.create');
    expect(keys).toContain('docker.start');
    expect(h.session.argv('docker.start')).toContain(CONTAINER);
    expect(logText(h, 'deploy')).toContain(CURRENT_RESTARTED);
    expectPreviousUntouched(h);
  });

  it('a -prev that already exists blocks the rename with START_FAILED and the current one runs again', async () => {
    const h = harness({
      scripts: {
        ...PREVIOUS_SCRIPTS,
        'docker.rename_to_prev': {
          exitCode: 1,
          stderr: `Error response from daemon: Conflict. The container name "/${CONTAINER}-prev" is already in use by container "abc".\n`,
        },
      },
    });

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'START_FAILED', container: { kind: 'running' } });
    expect(h.session.keys()).not.toContain('docker.create');
  });

  it('a stale -prev beside a running current one is replaced by the current one', async () => {
    const stale = psLine({ name: `${CONTAINER}-prev`, image: `noodara/${SERVICE_ID}:older`, state: 'exited' });
    const current = psLine({ name: CONTAINER, image: OLD_IMAGE, ports: '0.0.0.0:13100->3000/tcp' });
    const h = harness({ scripts: { ...PREVIOUS_SCRIPTS, 'docker.ps': { stdout: `${stale}\n${current}\n` } } });

    const outcome = await runDeployment(h.input);

    expect(outcome.status).toBe('SUCCESS');
    const keys = h.session.keys();
    expect(keys.indexOf('docker.remove_prev')).toBeLessThan(keys.indexOf('docker.rename_to_prev'));
  });

  it('a stale -prev with no running current one stays the restore target', async () => {
    const stale = psLine({ name: `${CONTAINER}-prev`, image: OLD_IMAGE, state: 'exited' });
    const h = harness({
      scripts: {
        ...PREVIOUS_SCRIPTS,
        'docker.ps': { stdout: `${stale}\n` },
        'docker.start': [{ exitCode: 1, stderr: GENERIC_DAEMON_ERROR }, { exitCode: 0 }],
      },
    });

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'FAILED', container: { kind: 'running' } });
    expect(h.session.keys()).not.toContain('docker.rename_to_prev');
    expect(h.session.keys()).toContain('docker.rename_from_prev');
    expectPreviousUntouched(h);
  });
});

// 17-07: the automatic rollback (ROLLING_BACK -> ROLLED_BACK | FAILED).
const PREVIOUS_ID: ResourceId = unwrap(validateResourceId(OLD_DEPLOYMENT_ID));
const PREVIOUS_SNAPSHOT = {
  version: 1 as const,
  imageRef: unwrap(validateImageRef(OLD_IMAGE)),
  internalPort: PORT_3000,
  publishedPort: PORT_13100,
  healthcheck: TCP_CHECK,
};
const RESTORE_KEYS = ['docker.remove', 'docker.rename_from_prev', 'docker.inspect_networks', 'docker.start'];
const HTTP_500 = { stdout: 'NOODARA_PROBE http 500\n' };

function rollbackHarness(
  scripts: Record<string, Script | Script[]>,
  options: { autoRollback?: boolean; snapshot?: typeof PREVIOUS_SNAPSHOT | null; healthcheck?: HealthcheckConfig | null } = {},
): Harness & { readonly events: (ResourceId | null)[] } {
  const events: (ResourceId | null)[] = [];
  const h = harness({
    healthcheck: options.healthcheck === undefined ? HTTP_CHECK : options.healthcheck,
    scripts,
    extra: {
      autoRollback: options.autoRollback ?? true,
      previousSuccess: { id: PREVIOUS_ID, runtimeConfig: options.snapshot === undefined ? PREVIOUS_SNAPSHOT : options.snapshot },
      recordRollbackStarted: (target) => {
        events.push(target);
        return Promise.resolve();
      },
    },
  });
  return { ...h, events };
}

function afterKey(h: Harness, key: string): string[] {
  const keys = h.session.keys();
  return keys.slice(keys.indexOf(key));
}

describe('runDeployment: automatic rollback (17-07 A1, A2)', () => {
  it('a failed healthcheck rolls back: new container removed, -prev restored and checked with the previous snapshot', async () => {
    const h = rollbackHarness(probing(HTTP_500, { 'probe.tcp': { stdout: 'NOODARA_PROBE open\n' } }));

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'ROLLED_BACK', errorCode: 'HEALTHCHECK_FAILED', container: { kind: 'running' } });
    expect(outcome.errorMessage).toContain(V03_DEPLOYMENT_ERROR_MESSAGES.HEALTHCHECK_FAILED);
    expect(outcome.errorMessage).toContain(`deployment ${OLD_DEPLOYMENT_ID}`);
    expect(h.progress.advances.slice(-2)).toEqual([
      ['DEPLOYING', 'HEALTHCHECK'],
      ['HEALTHCHECK', 'ROLLING_BACK'],
    ]);
    const keys = h.session.keys();
    const from = keys.indexOf('docker.remove');
    expect(from).toBeGreaterThan(keys.lastIndexOf('probe.http'));
    expect(keys.slice(from, from + 4)).toEqual(RESTORE_KEYS);
    // The previous deployment's snapshot (TCP) checks the restored container, not the new HTTP check.
    expect(keys.indexOf('probe.tcp')).toBeGreaterThan(from);
    expect(h.events).toEqual([PREVIOUS_ID]);
    const log = logText(h, 'rollback');
    expect(log).toContain('Healthcheck attempt 1: port open');
    expect(log).toContain('The previous version was restored and passed its healthcheck.');
    expectPreviousUntouched(h);
    // A5: the removed new container no longer pins the new image; the restored one keeps its own.
    expect(h.session.argv('docker.image_remove')).toContain(BUILT_IMAGE);
  });

  it('a start failure rolls back from DEPLOYING (the swap guard leaves the restore to the rollback)', async () => {
    const h = rollbackHarness(
      probing(HTTP_500, { 'docker.start': [{ exitCode: 1, stderr: GENERIC_DAEMON_ERROR }, { exitCode: 0 }], 'probe.tcp': { stdout: 'NOODARA_PROBE open\n' } }),
    );

    const outcome = await runDeployment(h.input);

    expect(outcome.status).toBe('ROLLED_BACK');
    expect(outcome.errorCode).not.toBe('ROLLBACK_FAILED');
    expect(h.progress.advances.at(-1)).toEqual(['DEPLOYING', 'ROLLING_BACK']);
    expect(h.session.keys().filter((k) => k === 'docker.rename_from_prev')).toHaveLength(1);
    expect(afterKey(h, 'docker.remove').slice(0, 4)).toEqual(RESTORE_KEYS);
    expect(logText(h)).not.toContain(PREVIOUS_RESTORED);
  });

  it('a previous deployment without a usable snapshot is checked with the container default', async () => {
    const h = rollbackHarness(probing(HTTP_500), { snapshot: null });

    const outcome = await runDeployment(h.input);

    expect(outcome.status).toBe('ROLLED_BACK');
    expect(h.session.keys()).not.toContain('probe.tcp');
    expect(logText(h, 'rollback')).toContain('container running');
  });

  it('a restored version that fails its own check ends FAILED/ROLLBACK_FAILED', async () => {
    const h = rollbackHarness(probing(HTTP_500, { 'probe.tcp': { exitCode: 1, stdout: 'NOODARA_PROBE refused\n' } }));

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({
      status: 'FAILED',
      errorCode: 'ROLLBACK_FAILED',
      errorMessage: V03_DEPLOYMENT_ERROR_MESSAGES.ROLLBACK_FAILED,
    });
    expect(h.progress.advances.at(-1)).toEqual(['HEALTHCHECK', 'ROLLING_BACK']);
    expect(logText(h, 'rollback')).toContain('The previous version could not be restored.');
  });
});

describe('runDeployment: a failed restore ends FAILED once, never retried (17-07 H1)', () => {
  it.each([
    ['rename', { 'docker.rename_from_prev': { exitCode: 1, stderr: GENERIC_DAEMON_ERROR } }],
    ['start', { 'docker.start': [{ exitCode: 0 }, { exitCode: 1, stderr: GENERIC_DAEMON_ERROR }] }],
    ['SSH drop', { 'docker.rename_from_prev': { reject: new Error('socket hang up') } }],
  ] satisfies [string, Record<string, Script | Script[]>][])('a %s error during the restore ends ROLLBACK_FAILED after one attempt', async (_step, extra) => {
    const h = rollbackHarness(probing(HTTP_500, extra));

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'ROLLBACK_FAILED' });
    expect(h.progress.advances.filter(([, to]) => to === 'ROLLING_BACK')).toHaveLength(1);
    expect(h.session.keys().filter((k) => k === 'docker.rename_from_prev')).toHaveLength(1);
    expect(h.events).toHaveLength(1);
  });

  it('a rollback event that cannot be recorded does not stop the restore', async () => {
    const h = rollbackHarness(probing(HTTP_500, { 'probe.tcp': { stdout: 'NOODARA_PROBE open\n' } }));
    const input = { ...h.input, recordRollbackStarted: () => Promise.reject(new Error('db down')) };

    const outcome = await runDeployment(input);

    expect(outcome.status).toBe('ROLLED_BACK');
  });

  it('a ROLLING_BACK edge that cannot be recorded ends FAILED with the original code and still restores -prev', async () => {
    const h = rollbackHarness(probing(HTTP_500));
    h.progress.failOn = 'ROLLING_BACK';

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'HEALTHCHECK_FAILED', container: { kind: 'running' } });
    expect(h.session.keys()).toContain('docker.rename_from_prev');
    expect(h.events).toEqual([]);
  });

  it('a restored check that never passes ends within the rollback budget', async () => {
    let now = 0;
    let rollingBackAt: number | null = null;
    const h = rollbackHarness(
      probing(HTTP_500, { 'probe.tcp': { outcome: 'timed_out', exitCode: null } }),
      {
        snapshot: {
          ...PREVIOUS_SNAPSHOT,
          healthcheck: unwrap(validateHealthcheckConfig({ type: 'tcp', port: 3000, probeTimeoutS: 5, intervalS: 30, retries: 10, startPeriodS: 0 })),
        },
      },
    );
    const limits = { ...LIMITS, deployMaxMs: 400_000, rollbackMaxMs: 60_000 };
    const progress: DeploymentProgress = {
      advance: (from, to, record) => {
        if (to === 'ROLLING_BACK') rollingBackAt = now;
        return h.progress.advance(from, to, record);
      },
      recordCommitSha: (sha) => h.progress.recordCommitSha(sha),
    };
    const clock = {
      now: () => now,
      sleep: (ms: number) => {
        now += ms;
        return Promise.resolve();
      },
    };

    const outcome = await runDeployment({ ...h.input, limits, progress, clock });

    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'ROLLBACK_FAILED' });
    // Assigned inside the progress closure; TS narrows the `let` to its initial null here.
    const enteredAt = rollingBackAt as number | null;
    expect(enteredAt).not.toBeNull();
    expect(now - (enteredAt ?? 0)).toBeLessThanOrEqual(60_000);
    expect(now).toBeLessThanOrEqual(limits.deployMaxMs);
  });
});

describe('runDeployment: the rollback budget (17-07 A4)', () => {
  it('is the configured budget capped at a quarter of NOODARA_DEPLOY_MAX_MS', () => {
    expect(rollbackBudgetMs({ deployMaxMs: 1_800_000 })).toBe(DEFAULT_ROLLBACK_MAX_MS);
    expect(rollbackBudgetMs({ deployMaxMs: 1_800_000, rollbackMaxMs: 30_000 })).toBe(30_000);
    expect(rollbackBudgetMs({ deployMaxMs: 200_000 })).toBe(50_000);
    expect(rollbackBudgetMs({ deployMaxMs: 200_000, rollbackMaxMs: -1 })).toBe(0);
  });

  it('with auto_rollback the main steps leave the rollback budget free; rollback steps stay inside it', async () => {
    const h = rollbackHarness(probing(HTTP_500, { 'probe.tcp': { stdout: 'NOODARA_PROBE open\n' } }));
    const limits = { ...LIMITS, rollbackMaxMs: 60_000 };

    await runDeployment({ ...h.input, limits });

    const keys = h.session.keys();
    const rollbackFrom = keys.indexOf('docker.remove');
    const budgets = h.session.calls.map((call) => call.options.maxDurationMs);
    const main = budgets.slice(0, rollbackFrom).filter((_, index) => keys[index] !== 'probe.http');
    expect(Math.max(...main)).toBeLessThanOrEqual(LIMITS.deployMaxMs - 60_000);
    const rollback = h.session.calls
      .slice(rollbackFrom)
      .filter((call) => !['fs.remove_deploy_dir', 'docker.image_remove', 'docker.network_remove'].includes(call.key));
    rollback.forEach((call) => {
      expect(call.options.maxDurationMs).toBeLessThanOrEqual(60_000);
    });
  });
});

describe('runDeployment: when no rollback fires (17-07 A3, H2)', () => {
  it('auto_rollback off: FAILED, the new container is stopped and -prev kept for a manual rollback', async () => {
    const h = rollbackHarness(probing(HTTP_500), { autoRollback: false });

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'HEALTHCHECK_FAILED', container: { kind: 'stopped' } });
    expect(h.progress.advances.map(([, to]) => to)).not.toContain('ROLLING_BACK');
    expect(afterKey(h, 'probe.http')).toContain('docker.stop');
    expect(h.session.keys()).not.toContain('docker.rename_from_prev');
    expect(h.events).toEqual([]);
    expect(logText(h, 'deploy')).toContain('The new container was stopped');
    expectPreviousUntouched(h);
  });

  it('first deploy (no -prev): FAILED with the new container stopped, nothing to roll back to', async () => {
    const h = rollbackHarness({ 'probe.http': HTTP_500, 'docker.inspect_networks': { stdout: NETWORKS_ATTACHED } });

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'HEALTHCHECK_FAILED', container: { kind: 'stopped' } });
    expect(h.progress.advances.map(([, to]) => to)).not.toContain('ROLLING_BACK');
    expect(afterKey(h, 'probe.http')).toContain('docker.stop');
    expect(h.events).toEqual([]);
  });

  it('a BUILDING timeout never rolls back', async () => {
    const h = rollbackHarness(probing(HTTP_500, { 'supervise:build': { outcome: 'timed_out', exitCode: null } }));

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'BUILD_TIMEOUT' });
    expect(h.progress.advances.map(([, to]) => to)).not.toContain('ROLLING_BACK');
    expect(h.session.keys()).not.toContain('docker.rename_from_prev');
    expect(h.session.keys()).not.toContain('docker.stop');
    expect(h.events).toEqual([]);
  });

  it('a cancelled deployment never rolls back', async () => {
    const controller = new AbortController();
    const h = rollbackHarness(probing(HTTP_500));
    h.session.onStream = (key) => {
      if (key === 'supervise:build') controller.abort();
    };

    const outcome = await runDeployment({ ...h.input, signal: controller.signal });

    expect(outcome.status).toBe('CANCELLED');
    expect(h.progress.advances.map(([, to]) => to)).not.toContain('ROLLING_BACK');
    expect(h.session.keys()).not.toContain('docker.rename_from_prev');
    expect(h.events).toEqual([]);
  });

  it('a DEPLOYING failure before the swap (port in use) has nothing kept and never rolls back', async () => {
    const taken = psLine({ name: 'other', image: 'nginx', ports: '0.0.0.0:13100->80/tcp', serviceId: OTHER_SERVICE_ID });
    const h = rollbackHarness({ ...PREVIOUS_SCRIPTS, 'docker.ps': { stdout: `${taken}\n` } });

    const outcome = await runDeployment(h.input);

    expect(outcome).toMatchObject({ status: 'FAILED', errorCode: 'PORT_IN_USE' });
    expect(h.progress.advances.map(([, to]) => to)).not.toContain('ROLLING_BACK');
    expect(h.events).toEqual([]);
  });
});
