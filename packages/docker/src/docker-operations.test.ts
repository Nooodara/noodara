// Docker operation wrappers against a recording fake SshDeploySession (11-15, D26, ADR 0008 G1/G4).
// The fake redacts chunks and tails with the injected redactor at stream time, like the real
// adapter, so the SEC canaries prove the registry password was registered before any output.
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRedactor, revealSecret, secretValue, type Redactor } from '@noodara/domain/security';
import {
  deployWorkspaceFor,
  validateContainerPort,
  validateImageRef,
  validateRegistryHost,
  validateRegistryUsername,
  validateResourceId,
  validateServiceSource,
  type ContainerPort,
  type DeployWorkspace,
  type ImageRef,
  type ResourceId,
  type ServiceSource,
} from '@noodara/domain/validators';
import type {
  DeployCommandName,
  ExecResult,
  RemoteCommand,
  SshDeploySession,
  StreamChunk,
  StreamOptions,
  StreamResult,
} from '@noodara/ssh';
import { describe, expect, it } from 'vitest';
import {
  buildImage,
  createContainer,
  ensureNetwork,
  inspectContainerState,
  listManagedContainers,
  pullImage,
  removeContainer,
  pruneBuilderCache,
  removeImage,
  removeNetwork,
  removeWorkspace,
  restartContainer,
  startContainer,
  stopContainer,
  type DockerStepContext,
  type RegistryCredential,
} from './docker-operations.js';
import type { StepLimits } from './step-result.js';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
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
const CONTAINER = `noodara-${SERVICE_ID}`;
const NETWORK = `noodara-net-${SERVICE_ID}`;
const BUILT_IMAGE = `noodara/${SERVICE_ID}:${DEPLOYMENT_ID}`;
const REGISTRY_IMAGE: ImageRef = unwrap(validateImageRef('registry.example.com:5000/acme/api:1.4.2'));
const PORT_3000: ContainerPort = unwrap(validateContainerPort(3000));
const PORT_13100: ContainerPort = unwrap(validateContainerPort(13100));

// Captures from packages/ssh/src/fixtures/deploy-errors/ubuntu-24.04 (ADR 0008).
const LOGIN_FAILED_STDERR =
  'Error response from daemon: login attempt to http://registry.example.com:5000/v2/ failed with status: 401 Unauthorized\n';
const IMAGE_NOT_FOUND_STDERR =
  'Error response from daemon: failed to resolve reference "registry.example.com:5000/acme/api:1.4.2": registry.example.com:5000/acme/api:1.4.2: not found\n';
const PULL_UNAUTHORIZED_STDERR =
  'Error response from daemon: failed to resolve reference "registry.example.com:5000/acme/api:1.4.2": pull access denied, repository does not exist or may require authorization: authorization failed: no basic auth credentials\n';
const BUILD_FAILED_STDERR = [
  '#5 [2/3] RUN exit 42',
  '#5 ERROR: process "/bin/sh -c exit 42" did not complete successfully: exit code: 42',
  '------',
  ' > [2/3] RUN exit 42:',
  '------',
  'ERROR: failed to build: failed to solve: process "/bin/sh -c exit 42" did not complete successfully: exit code: 42',
  '',
].join('\n');
const BUILDKIT_MISSING_STDERR =
  'ERROR: BuildKit is enabled but the buildx component is missing or broken.\n       Install the buildx component to build images with BuildKit:\n';
const DOCKERFILE_MISSING_STDERR =
  'ERROR: failed to build: failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory\n';
const PORT_IN_USE_STDERR =
  'Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint noodara-x (abc): Bind for 0.0.0.0:13100 failed: port is already allocated\n';
const DAEMON_DOWN_STDERR =
  'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n';
const NETWORK_EXISTS_STDERR = `Error response from daemon: network with name ${NETWORK} already exists\n`;

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
  /** Revealed by the fake only, for assertions. */
  readonly stdin: string | undefined;
  /** Raw values that the redactor already scrubbed when this call started. */
  readonly redactedAtCall: readonly string[];
}

class RecordingSession implements SshDeploySession {
  readonly calls: Call[] = [];

  constructor(
    private readonly redactor: Redactor,
    private readonly scripts: Partial<Record<DeployCommandName, Script>> = {},
    private readonly watched: readonly string[] = [],
  ) {}

  exec(): Promise<ExecResult> {
    return Promise.reject(new Error('exec is not part of the deploy path'));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  stream(command: RemoteCommand, options: StreamOptions): Promise<StreamResult> {
    this.calls.push({
      command,
      options,
      stdin: options.stdin === undefined ? undefined : revealSecret(options.stdin),
      redactedAtCall: this.watched.filter((value) => this.redactor.redact(value) !== value),
    });
    const script = this.scripts[command.name] ?? {};
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

  call(name: DeployCommandName, index = 0): Call {
    const found = this.calls.filter((entry) => entry.command.name === name)[index];
    if (found === undefined) throw new Error(`no ${name} call #${String(index)}`);
    return found;
  }

  argv(name: DeployCommandName, index = 0): readonly string[] {
    return this.call(name, index).command.argv;
  }
}

function workspace(): DeployWorkspace {
  return unwrap(deployWorkspaceFor(DEPLOYMENT_ID));
}

function gitSource(fields: Record<string, unknown> = {}): Extract<ServiceSource, { kind: 'git' }> {
  const source = unwrap(
    validateServiceSource({
      kind: 'git',
      repositoryUrl: 'git@github.com:acme/api.git',
      branch: 'main',
      ...fields,
    }),
  );
  if (source.kind !== 'git') throw new Error('test setup: source');
  return source;
}

function context(session: SshDeploySession, redactor: Redactor, extra: Partial<DockerStepContext> = {}) {
  return { session, redactor, limits: LIMITS, ...extra } satisfies DockerStepContext;
}

/** A fresh password per run (SEC: per-run secrets from crypto.randomBytes). */
function canaryPassword(): string {
  return `noodara-canary-${randomBytes(24).toString('hex')}`;
}

function registry(password: string): RegistryCredential {
  return {
    host: unwrap(validateRegistryHost('registry.example.com:5000')),
    username: unwrap(validateRegistryUsername('deployer')),
    password: secretValue(password, 'api_key'),
  };
}

function expectAbsent(haystack: string, secret: string, where: string): void {
  expect(haystack.includes(secret), `${where} carries the secret`).toBe(false);
}

describe('pullImage with a registry credential', () => {
  it('logs in over stdin into the per-deployment config, pulls supervised with it, then logs out', async () => {
    const redactor = createRedactor();
    const password = canaryPassword();
    const session = new RecordingSession(redactor);
    const ws = workspace();

    const result = await pullImage(context(session, redactor), {
      workspace: ws,
      image: REGISTRY_IMAGE,
      registry: registry(password),
    });

    expect(result).toMatchObject({ ok: true, value: REGISTRY_IMAGE });
    expect(session.names()).toEqual([
      'fs.prepare_workspace',
      'docker.login',
      'process.supervise',
      'docker.logout',
    ]);
    const login = session.call('docker.login');
    expect(login.stdin).toBe(password);
    expect(login.command.argv).toEqual(
      expect.arrayContaining(['--config', ws.dockerConfigDir, '--password-stdin', 'deployer']),
    );
    expect(login.command.argv.at(-1)).toBe('registry.example.com:5000');
    const pull = session.argv('process.supervise');
    expect(pull).toContain(ws.pidFile('pull'));
    expect(pull.slice(pull.indexOf('docker'))).toEqual([
      'docker',
      '--config',
      ws.dockerConfigDir,
      'pull',
      '--',
      REGISTRY_IMAGE,
    ]);
    expect(session.argv('docker.logout')).toEqual(
      expect.arrayContaining(['--config', ws.dockerConfigDir, 'registry.example.com:5000']),
    );
    expect(session.call('process.supervise').stdin).toBeUndefined();
  });

  it('keeps the password out of argv, results and chunks, registered for the call and released after', async () => {
    const redactor = createRedactor();
    const password = canaryPassword();
    const chunks: StreamChunk[] = [];
    // A hostile remote echoes the password back on every step.
    const echo: Script = { stderr: `${password}\n${LOGIN_FAILED_STDERR}`, exitCode: 1 };
    const session = new RecordingSession(redactor, { 'docker.login': echo }, [password]);

    const result = await pullImage(
      context(session, redactor, { onChunk: (chunk) => chunks.push(chunk) }),
      { workspace: workspace(), image: REGISTRY_IMAGE, registry: registry(password) },
    );

    expect(result).toMatchObject({ ok: false, kind: 'failed', code: 'REGISTRY_AUTH_FAILED' });
    for (const call of session.calls) {
      expectAbsent(call.command.argv.join('\u0000'), password, `${call.command.name} argv`);
      expect(call.redactedAtCall).toEqual([password]);
    }
    expectAbsent(JSON.stringify(result), password, 'result');
    expectAbsent(JSON.stringify(chunks), password, 'chunks');
    expect(chunks.length).toBeGreaterThan(0);
    expect(redactor.redact(password)).toBe(password);
  });

  it('does not pull or log out when the login is rejected', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor, {
      'docker.login': { exitCode: 1, stderr: LOGIN_FAILED_STDERR },
    });

    const result = await pullImage(context(session, redactor), {
      workspace: workspace(),
      image: REGISTRY_IMAGE,
      registry: registry(canaryPassword()),
    });

    expect(result).toMatchObject({ ok: false, kind: 'failed', code: 'REGISTRY_AUTH_FAILED' });
    expect(session.names()).toEqual(['fs.prepare_workspace', 'docker.login']);
  });

  it('classifies a failed pull and still logs out', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor, {
      'process.supervise': { exitCode: 1, stderr: IMAGE_NOT_FOUND_STDERR },
    });

    const result = await pullImage(context(session, redactor), {
      workspace: workspace(),
      image: REGISTRY_IMAGE,
      registry: registry(canaryPassword()),
    });

    expect(result).toMatchObject({ ok: false, kind: 'failed', code: 'IMAGE_NOT_FOUND' });
    expect(session.names().at(-1)).toBe('docker.logout');
  });

  it('reports an interrupted pull and still logs out without the caller signal', async () => {
    const redactor = createRedactor();
    const controller = new AbortController();
    const session = new RecordingSession(redactor, { 'process.supervise': { outcome: 'aborted', exitCode: null } });

    const result = await pullImage(context(session, redactor, { signal: controller.signal }), {
      workspace: workspace(),
      image: REGISTRY_IMAGE,
      registry: registry(canaryPassword()),
    });

    expect(result).toEqual({ ok: false, kind: 'interrupted', outcome: 'aborted' });
    expect(session.names().at(-1)).toBe('docker.logout');
    expect(session.call('docker.logout').options.signal).toBeUndefined();
    expect(session.call('docker.logout').options).toMatchObject(LIMITS);
  });

  it('releases the password even when the connection is lost', async () => {
    const redactor = createRedactor();
    const password = canaryPassword();
    const session = new RecordingSession(redactor, {
      'docker.login': { reject: new Error(`socket closed ${password}`) },
    });

    const result = await pullImage(context(session, redactor), {
      workspace: workspace(),
      image: REGISTRY_IMAGE,
      registry: registry(password),
    });

    expect(result).toMatchObject({ ok: false, kind: 'failed', code: 'SERVER_UNREACHABLE' });
    expectAbsent(JSON.stringify(result), password, 'result');
    expect(redactor.redact(password)).toBe(password);
  });
});

describe('pullImage without a credential', () => {
  it('pulls supervised with no login, no logout and no --config', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor);
    const ws = workspace();

    const result = await pullImage(context(session, redactor), {
      workspace: ws,
      image: REGISTRY_IMAGE,
      registry: null,
    });

    expect(result).toMatchObject({ ok: true, value: REGISTRY_IMAGE });
    expect(session.names()).toEqual(['fs.prepare_workspace', 'process.supervise']);
    const pull = session.argv('process.supervise');
    expect(pull).not.toContain('--config');
    expect(pull.slice(-3)).toEqual(['pull', '--', REGISTRY_IMAGE]);
  });

  it('classifies an anonymous pull of a private image as REGISTRY_AUTH_FAILED', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor, {
      'process.supervise': { exitCode: 1, stderr: PULL_UNAUTHORIZED_STDERR },
    });

    const result = await pullImage(context(session, redactor), {
      workspace: workspace(),
      image: REGISTRY_IMAGE,
      registry: null,
    });

    expect(result).toMatchObject({ ok: false, kind: 'failed', code: 'REGISTRY_AUTH_FAILED' });
  });
});

describe('buildImage', () => {
  it('builds the deployment image supervised from the resolved repo paths', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor);
    const ws = workspace();

    const result = await buildImage(context(session, redactor), {
      workspace: ws,
      source: gitSource({ buildContext: 'apps/api', dockerfilePath: 'apps/api/Dockerfile', target: 'runtime' }),
      serviceId: SERVICE_ID,
      deploymentId: DEPLOYMENT_ID,
    });

    expect(result).toMatchObject({ ok: true, value: BUILT_IMAGE });
    expect(session.names()).toEqual(['process.supervise']);
    const argv = session.argv('process.supervise');
    expect(argv).toContain(ws.pidFile('build'));
    const build = argv.slice(argv.indexOf('docker'));
    expect(build.slice(0, 2)).toEqual(['docker', 'build']);
    expect(build[build.indexOf('--file') + 1]).toBe(`${ws.repo}/apps/api/Dockerfile`);
    expect(build[build.indexOf('--tag') + 1]).toBe(BUILT_IMAGE);
    expect(build[build.indexOf('--target') + 1]).toBe('runtime');
    expect(build.at(-1)).toBe(`${ws.repo}/apps/api`);
  });

  it('uses the repository root as the context for "." and never passes build args or env', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor);
    const ws = workspace();

    await buildImage(context(session, redactor), {
      workspace: ws,
      source: gitSource(),
      serviceId: SERVICE_ID,
      deploymentId: DEPLOYMENT_ID,
    });

    const argv = session.argv('process.supervise');
    expect(argv.at(-1)).toBe(ws.repo);
    expect(argv).not.toContain('--target');
    expect(argv.some((token) => /^--(build-arg|env|secret)/.test(token))).toBe(false);
  });

  it.each([
    [BUILD_FAILED_STDERR, 'BUILD_FAILED'],
    [BUILDKIT_MISSING_STDERR, 'BUILDKIT_UNAVAILABLE'],
    [DOCKERFILE_MISSING_STDERR, 'DOCKERFILE_NOT_FOUND'],
    ['no space left on device\n', 'DISK_FULL'],
  ])('classifies a failed build (%#) as %s', async (stderr, code) => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor, { 'process.supervise': { exitCode: 1, stderr } });

    const result = await buildImage(context(session, redactor), {
      workspace: workspace(),
      source: gitSource(),
      serviceId: SERVICE_ID,
      deploymentId: DEPLOYMENT_ID,
    });

    expect(result).toMatchObject({ ok: false, kind: 'failed', code });
  });

  it.each(['aborted', 'timed_out', 'idle_timeout'] as const)('reports a %s build as interrupted', async (outcome) => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor, { 'process.supervise': { outcome, exitCode: null } });

    const result = await buildImage(context(session, redactor), {
      workspace: workspace(),
      source: gitSource(),
      serviceId: SERVICE_ID,
      deploymentId: DEPLOYMENT_ID,
    });

    expect(result).toEqual({ ok: false, kind: 'interrupted', outcome });
  });
});

describe('networks', () => {
  it('ensureNetwork creates the service network with managed labels', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor);

    const result = await ensureNetwork(context(session, redactor), { serviceId: SERVICE_ID });

    expect(result).toMatchObject({ ok: true, value: NETWORK });
    expect(session.names()).toEqual(['docker.network_create']);
    expect(session.argv('docker.network_create')).toEqual(
      expect.arrayContaining(['noodara.managed=true', `noodara.service_id=${SERVICE_ID}`]),
    );
    expect(session.argv('docker.network_create').at(-1)).toBe(NETWORK);
  });

  it('ensureNetwork treats an existing network as success', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor, {
      'docker.network_create': { exitCode: 1, stderr: NETWORK_EXISTS_STDERR },
    });

    const result = await ensureNetwork(context(session, redactor), { serviceId: SERVICE_ID });

    expect(result).toMatchObject({ ok: true, value: NETWORK });
  });

  it('ensureNetwork classifies any other failure', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor, {
      'docker.network_create': { exitCode: 1, stderr: DAEMON_DOWN_STDERR },
    });

    const result = await ensureNetwork(context(session, redactor), { serviceId: SERVICE_ID });

    expect(result).toMatchObject({ ok: false, kind: 'failed', code: 'DOCKER_UNAVAILABLE' });
  });

  it('removeNetwork removes the service network', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor);

    const result = await removeNetwork(context(session, redactor), { serviceId: SERVICE_ID });

    expect(result).toMatchObject({ ok: true, value: NETWORK });
    expect(session.names()).toEqual(['docker.network_remove']);
    expect(session.argv('docker.network_remove').at(-1)).toBe(NETWORK);
  });
});

describe('containers', () => {
  it('createContainer issues one docker create with the deterministic names and no env', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor);

    const result = await createContainer(context(session, redactor), {
      serviceId: SERVICE_ID,
      deploymentId: DEPLOYMENT_ID,
      image: REGISTRY_IMAGE,
      internalPort: PORT_3000,
      publishedPort: PORT_13100,
    });

    expect(result).toMatchObject({ ok: true, value: CONTAINER });
    expect(session.names()).toEqual(['docker.create']);
    const argv = session.argv('docker.create');
    expect(argv[argv.indexOf('--name') + 1]).toBe(CONTAINER);
    expect(argv[argv.indexOf('--network') + 1]).toBe(NETWORK);
    expect(argv[argv.indexOf('--publish') + 1]).toBe('13100:3000');
    expect(argv).toEqual(expect.arrayContaining([`noodara.deployment_id=${DEPLOYMENT_ID}`, 'max-size=10m']));
    expect(argv.at(-1)).toBe(REGISTRY_IMAGE);
    expect(argv.some((token) => /^(-e|--env|--env-file|--volume|-v|--privileged)$/.test(token))).toBe(false);
  });

  it('createContainer classifies a port collision as PORT_IN_USE', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor, {
      'docker.create': { exitCode: 125, stderr: PORT_IN_USE_STDERR },
    });

    const result = await createContainer(context(session, redactor), {
      serviceId: SERVICE_ID,
      deploymentId: DEPLOYMENT_ID,
      image: REGISTRY_IMAGE,
      internalPort: PORT_3000,
      publishedPort: PORT_13100,
    });

    expect(result).toMatchObject({ ok: false, kind: 'failed', code: 'PORT_IN_USE' });
    if (!result.ok && result.kind === 'failed') expect(result.message).toContain('13100');
  });

  it('startContainer issues one docker start and classifies a port collision', async () => {
    const redactor = createRedactor();
    const ok = new RecordingSession(redactor);
    expect(await startContainer(context(ok, redactor), { serviceId: SERVICE_ID })).toMatchObject({
      ok: true,
      value: CONTAINER,
    });
    expect(ok.names()).toEqual(['docker.start']);
    expect(ok.argv('docker.start').at(-1)).toBe(CONTAINER);

    const clash = new RecordingSession(redactor, { 'docker.start': { exitCode: 1, stderr: PORT_IN_USE_STDERR } });
    expect(await startContainer(context(clash, redactor), { serviceId: SERVICE_ID })).toMatchObject({
      ok: false,
      kind: 'failed',
      code: 'PORT_IN_USE',
    });
  });

  it('stopContainer and restartContainer pass the stop timeout', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor);

    expect(
      await stopContainer(context(session, redactor), { serviceId: SERVICE_ID, timeoutSeconds: 15 }),
    ).toMatchObject({ ok: true, value: CONTAINER });
    expect(
      await restartContainer(context(session, redactor), { serviceId: SERVICE_ID, timeoutSeconds: 20 }),
    ).toMatchObject({ ok: true, value: CONTAINER });

    expect(session.names()).toEqual(['docker.stop', 'docker.restart']);
    expect(session.argv('docker.stop')).toEqual(['docker', 'stop', '--timeout', '15', '--', CONTAINER]);
    expect(session.argv('docker.restart')).toEqual(['docker', 'restart', '--timeout', '20', '--', CONTAINER]);
  });

  it('removeContainer force-removes the service container', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor);

    const result = await removeContainer(context(session, redactor), { serviceId: SERVICE_ID });

    expect(result).toMatchObject({ ok: true, value: CONTAINER });
    expect(session.argv('docker.remove')).toEqual(['docker', 'rm', '--force', '--', CONTAINER]);
  });

  it('removeImage removes exactly the given image', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor);

    const result = await removeImage(context(session, redactor), { image: REGISTRY_IMAGE });

    expect(result).toMatchObject({ ok: true, value: REGISTRY_IMAGE });
    expect(session.argv('docker.image_remove')).toEqual(['docker', 'image', 'rm', '--', REGISTRY_IMAGE]);
  });

  it('pruneBuilderCache runs the fixed age-based prune and never streams its output to the log', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor);
    const chunks: unknown[] = [];

    const result = await pruneBuilderCache({ ...context(session, redactor), onChunk: (c) => chunks.push(c) });

    expect(result.ok).toBe(true);
    expect(session.argv('docker.builder_prune')).toEqual(['docker', 'builder', 'prune', '--force', '--filter', 'until=168h']);
    expect(chunks).toEqual([]);
  });

  it('pruneBuilderCache classifies a stopped daemon', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor, {
      'docker.builder_prune': { exitCode: 1, stderr: DAEMON_DOWN_STDERR },
    });

    const result = await pruneBuilderCache(context(session, redactor));

    expect(result).toMatchObject({ ok: false, kind: 'failed' });
  });

  it('classifies a stopped daemon on any container operation', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor, {
      'docker.stop': { exitCode: 1, stderr: DAEMON_DOWN_STDERR },
      'docker.remove': { exitCode: 1, stderr: DAEMON_DOWN_STDERR },
    });

    expect(
      await stopContainer(context(session, redactor), { serviceId: SERVICE_ID, timeoutSeconds: 10 }),
    ).toMatchObject({ ok: false, code: 'DOCKER_UNAVAILABLE' });
    expect(await removeContainer(context(session, redactor), { serviceId: SERVICE_ID })).toMatchObject({
      ok: false,
      code: 'DOCKER_UNAVAILABLE',
    });
  });
});

describe('observation', () => {
  const STATE_JSON = JSON.stringify({
    Status: 'running',
    Running: true,
    ExitCode: 0,
    OOMKilled: false,
    StartedAt: '2026-10-01T10:00:00Z',
    FinishedAt: '0001-01-01T00:00:00Z',
  });

  it('inspectContainerState returns the parsed container state', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor, { 'docker.inspect': { stdout: `${STATE_JSON}\n` } });

    const result = await inspectContainerState(context(session, redactor), { serviceId: SERVICE_ID });

    expect(result).toMatchObject({ ok: true, value: { kind: 'ok', status: 'running', running: true } });
    expect(session.argv('docker.inspect').at(-1)).toBe(CONTAINER);
  });

  it('inspectContainerState reports truncated output as unparseable and classifies a failed inspect', async () => {
    const redactor = createRedactor();
    const truncated = new RecordingSession(redactor, {
      'docker.inspect': { stdout: STATE_JSON, truncated: true },
    });
    expect(await inspectContainerState(context(truncated, redactor), { serviceId: SERVICE_ID })).toMatchObject({
      ok: true,
      value: { kind: 'unparseable' },
    });

    const down = new RecordingSession(redactor, { 'docker.inspect': { exitCode: 1, stderr: DAEMON_DOWN_STDERR } });
    expect(await inspectContainerState(context(down, redactor), { serviceId: SERVICE_ID })).toMatchObject({
      ok: false,
      code: 'DOCKER_UNAVAILABLE',
    });
  });

  it('listManagedContainers returns the parsed docker ps output', async () => {
    const redactor = createRedactor();
    const line = JSON.stringify({
      ID: 'a'.repeat(64),
      Image: BUILT_IMAGE,
      Names: CONTAINER,
      State: 'exited',
      Status: 'Exited (3) 2 minutes ago',
      Labels: `noodara.managed=true,noodara.service_id=${SERVICE_ID}`,
      Ports: '',
    });
    const session = new RecordingSession(redactor, { 'docker.ps': { stdout: `${line}\n` } });

    const result = await listManagedContainers(context(session, redactor));

    expect(session.names()).toEqual(['docker.ps']);
    expect(result).toMatchObject({
      ok: true,
      value: { kind: 'ok', containers: [{ name: CONTAINER, state: 'exited', exitCode: 3 }] },
    });
  });

  it('listManagedContainers passes a daemon failure to the parser', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor, { 'docker.ps': { exitCode: 1, stderr: DAEMON_DOWN_STDERR } });

    const result = await listManagedContainers(context(session, redactor));

    expect(result).toMatchObject({ ok: true, value: { kind: 'daemon_unreachable' } });
  });
});

describe('removeWorkspace', () => {
  it('removes the deployment directory', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor);
    const ws = workspace();

    const result = await removeWorkspace(context(session, redactor), { workspace: ws });

    expect(result.ok).toBe(true);
    expect(session.argv('fs.remove_deploy_dir')).toEqual(['rm', '-rf', '--', ws.root]);
  });
});

describe('every wrapper', () => {
  type Op = (ctx: DockerStepContext) => Promise<unknown>;
  const ops: [string, Op][] = [
    ['pullImage', (c) => pullImage(c, { workspace: workspace(), image: REGISTRY_IMAGE, registry: registry('pw-1234567890') })],
    ['buildImage', (c) => buildImage(c, { workspace: workspace(), source: gitSource(), serviceId: SERVICE_ID, deploymentId: DEPLOYMENT_ID })],
    ['ensureNetwork', (c) => ensureNetwork(c, { serviceId: SERVICE_ID })],
    ['createContainer', (c) => createContainer(c, { serviceId: SERVICE_ID, deploymentId: DEPLOYMENT_ID, image: REGISTRY_IMAGE, internalPort: PORT_3000, publishedPort: null })],
    ['startContainer', (c) => startContainer(c, { serviceId: SERVICE_ID })],
    ['stopContainer', (c) => stopContainer(c, { serviceId: SERVICE_ID, timeoutSeconds: 10 })],
    ['restartContainer', (c) => restartContainer(c, { serviceId: SERVICE_ID, timeoutSeconds: 10 })],
    ['removeContainer', (c) => removeContainer(c, { serviceId: SERVICE_ID })],
    ['removeImage', (c) => removeImage(c, { image: REGISTRY_IMAGE })],
    ['removeNetwork', (c) => removeNetwork(c, { serviceId: SERVICE_ID })],
    ['inspectContainerState', (c) => inspectContainerState(c, { serviceId: SERVICE_ID })],
    ['listManagedContainers', (c) => listManagedContainers(c)],
    ['removeWorkspace', (c) => removeWorkspace(c, { workspace: workspace() })],
  ];

  it.each(ops)('%s passes the caller limits and signal to its stream calls', async (_name, op) => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor);
    const controller = new AbortController();

    await op(context(session, redactor, { signal: controller.signal }));

    expect(session.calls.length).toBeGreaterThan(0);
    for (const call of session.calls.filter((entry) => entry.command.name !== 'docker.logout')) {
      expect(call.options).toMatchObject(LIMITS);
      expect(call.options.signal).toBe(controller.signal);
    }
  });

  it.each(ops)('%s turns a lost connection into SERVER_UNREACHABLE without echoing the error', async (_name, op) => {
    const redactor = createRedactor();
    const marker = `transport-${randomBytes(8).toString('hex')}`;
    const reject = new Error(marker);
    const session = new RecordingSession(
      redactor,
      Object.fromEntries(
        (['fs.prepare_workspace', 'fs.remove_deploy_dir', 'process.supervise', 'docker.network_create', 'docker.create', 'docker.start', 'docker.stop', 'docker.restart', 'docker.remove', 'docker.image_remove', 'docker.network_remove', 'docker.inspect', 'docker.ps'] as const).map((name) => [name, { reject }]),
      ),
    );

    const result = await op(context(session, redactor));

    expect(result).toMatchObject({ ok: false, kind: 'failed', code: 'SERVER_UNREACHABLE' });
    expectAbsent(JSON.stringify(result), marker, 'result');
  });

  it('rethrows usage errors instead of hiding them as a lost connection', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor, { 'docker.start': { reject: new TypeError('bad options') } });

    await expect(startContainer(context(session, redactor), { serviceId: SERVICE_ID })).rejects.toThrow(TypeError);
  });

  it('does not let a throwing onChunk callback break an operation', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor, { 'docker.inspect': { stdout: '{}', stderr: 'warning\n' } });

    const result = await inspectContainerState(
      context(session, redactor, {
        onChunk: () => {
          throw new Error('consumer bug');
        },
      }),
      { serviceId: SERVICE_ID },
    );

    expect(result.ok).toBe(true);
  });

  it('accepts only typed inputs: no build args, env vars or raw strings (type-level)', () => {
    const ws = workspace();
    const typeChecks = (ctx: DockerStepContext) => [
      buildImage(ctx, {
        workspace: ws,
        source: gitSource(),
        serviceId: SERVICE_ID,
        deploymentId: DEPLOYMENT_ID,
        // @ts-expect-error build args are not part of the build surface (D13)
        buildArgs: { NODE_ENV: 'production' },
      }),
      createContainer(ctx, {
        serviceId: SERVICE_ID,
        deploymentId: DEPLOYMENT_ID,
        image: REGISTRY_IMAGE,
        internalPort: PORT_3000,
        publishedPort: null,
        // @ts-expect-error env vars are not part of v0.2 containers (D13)
        env: { SECRET: 'x' },
      }),
      // @ts-expect-error a raw string is not a ResourceId
      startContainer(ctx, { serviceId: 'noodara-x' }),
      // @ts-expect-error a raw string is not an ImageRef
      removeImage(ctx, { image: 'node:22' }),
      pullImage(ctx, {
        workspace: ws,
        image: REGISTRY_IMAGE,
        // @ts-expect-error the registry password must be a SecretValue
        registry: { host: registry('x').host, username: registry('x').username, password: 'plain' },
      }),
    ];
    expect(typeof typeChecks).toBe('function');
  });
});

describe('@noodara/docker package boundary', () => {
  const sourceFiles = readdirSync(join(PACKAGE_ROOT, 'src')).filter(
    (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
  );

  it('depends on exactly @noodara/domain and @noodara/ssh', () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      turbo?: { tags?: string[] };
    };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(['@noodara/domain', '@noodara/ssh']);
    expect(pkg.turbo?.tags).toEqual(['ssh-adapter']);
  });

  it('neither imports ssh2, reads environment variables nor mentions build args', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
    const envAccess = ['process', 'env'].join('.');
    const buildArgs = ['build', 'Args'].join('');
    const buildArgFlag = ['--build', 'arg'].join('-');
    for (const file of sourceFiles) {
      const source = readFileSync(join(PACKAGE_ROOT, 'src', file), 'utf8');
      expect(/from\s+['"]ssh2['"]/.test(source), file).toBe(false);
      expect(source.includes(envAccess), file).toBe(false);
      expect(source.includes(buildArgs), file).toBe(false);
      expect(source.includes(buildArgFlag), file).toBe(false);
    }
  });

  it('exports only the operation wrappers at runtime', async () => {
    const surface = await import('./index.js');
    expect(Object.keys(surface).sort()).toEqual([
      'buildImage',
      'createContainer',
      'ensureNetwork',
      'inspectContainerState',
      'listManagedContainers',
      'pruneBuilderCache',
      'pullImage',
      'removeContainer',
      'removeImage',
      'removeNetwork',
      'removeWorkspace',
      'restartContainer',
      'startContainer',
      'stopContainer',
    ]);
  });
});
