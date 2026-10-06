// 12-11: the deploy pipeline against a scripted fake SshDeploySession (C1, C2, A6, ERR, SEC, H2).
// The fake keys scripts by command name; `process.supervise` is keyed by the supervised op
// (`supervise:clone|build|pull`) read from its pidfile argument.
import { randomBytes } from 'node:crypto';
import type { DeploymentStatus } from '@noodara/domain/deployment';
import { DEFAULT_POST_START_POLL_POLICY } from '@noodara/domain/deployment';
import { createRedactor, secretValue, type Redactor } from '@noodara/domain/security';
import {
  deployWorkspaceFor,
  validateContainerPort,
  validateImageRef,
  validateRegistryHost,
  validateRegistryUsername,
  validateResourceId,
  validateServiceSource,
  type ContainerPort,
  type ResourceId,
  type ServiceSource,
} from '@noodara/domain/validators';
import type { ExecResult, RemoteCommand, SshDeploySession, StreamOptions, StreamResult } from '@noodara/ssh';
import { describe, expect, it, vi } from 'vitest';
import type { DeploymentLogEntry, DeploymentLogSink } from './log-sink.js';
import {
  CANCEL_UNCONFIRMED,
  CANCEL_UNCONFIRMED_ERROR_CODE,
  DEPLOY_MESSAGES,
  runDeployment,
  type DeployCredential,
  type DeployRunLimits,
  type DeploymentProgress,
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
  readonly shas: string[] = [];
  verifyEntered = 0;
  failOn: DeploymentStatus | null = null;

  advance(from: DeploymentStatus, to: DeploymentStatus): Promise<void> {
    if (to === this.failOn) return Promise.reject(new Error('connection to postgres://u:pw@db lost'));
    this.advances.push([from, to]);
    return Promise.resolve();
  }

  enterVerify(): Promise<void> {
    this.verifyEntered += 1;
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
    ]);
    // 13-03: the verify step begins once the container started, before the post-start polls.
    expect(h.progress.verifyEntered).toBe(1);
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

  it('replaces the previous container only after the build, and removes the superseded own image last', async () => {
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
      'docker.remove',
      'docker.create',
      'docker.start',
      'docker.inspect',
      'docker.inspect',
      'fs.remove_deploy_dir',
      'docker.image_remove',
    ]);
    expect(h.session.argv('docker.stop')).toContain(CONTAINER);
    expect(h.session.argv('docker.image_remove')).toContain(OLD_IMAGE);
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
    expect(h.progress.verifyEntered).toBe(0);
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
    const h = harness({ scripts: { 'docker.start': { reject: new Error('socket hang up 10.0.0.5:22 stderr: secret') } } });
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
    expect(outcome.cleanup).toEqual([
      { resource: 'workspace', outcome: 'failed' },
      { resource: 'image', outcome: 'in_use' },
    ]);
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
    const allowed = new Set([CONTAINER, NETWORK, BUILT_IMAGE, OLD_IMAGE]);
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
