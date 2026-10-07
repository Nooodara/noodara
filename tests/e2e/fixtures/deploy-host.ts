// 13-06: the deploy-engine host (sshd + nested dockerd, git host with node-api and failing-build,
// htpasswd registry, pinned-digest mirror) for Playwright specs. Startup is delegated entirely to
// tests/integration/helpers/deploy-engine.ts; this module only adds run-scoped labels, a bounded
// startup with a readiness check, a redacting exec() and a leak-free sweep for global-teardown.
//
// Only specs that import `test` from here start a deploy host (worker-scoped fixture); every other
// spec keeps starting exactly what it did before.
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { inspect, promisify } from 'node:util';
import { test as base } from '@playwright/test';
import {
  preloadedRefFor,
  resolveBaseImages,
  startDeployEngineStack,
  type DeployEngineStack,
} from '../../integration/helpers/deploy-engine.js';

const execFileAsync = promisify(execFile);

/** Run-scoped label every resource of one e2e run carries (never matched host-wide). */
export const RUN_LABEL_KEY = 'noodara.e2e.run';
export const RUN_ID_ENV = 'NOODARA_E2E_RUN_ID';
export const RUN_DIR_ENV = 'NOODARA_E2E_RUN_DIR';

/** Bounded startup: image build (<= 15 min uncached) + base-image transfer + seeding. */
export const DEPLOY_HOST_STARTUP_TIMEOUT_MS = 25 * 60_000;
const READINESS_TIMEOUT_MS = 60_000;
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const HOST_DOCKER_TIMEOUT_MS = 60_000;
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKSPACES_ROOT = '/opt/noodara-deploy';
const REDACTED = '<redacted>';
const PUBLIC_KEY_LINE = /^ssh-(ed25519|rsa) [A-Za-z0-9+/]+={0,3}( [^\r\n]*)?$/;
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g;

const FIXTURES_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../fixtures');
export const DEPLOY_HOST_REPOS = { nodeApi: 'node-api', failingBuild: 'failing-build' } as const;
/** 13-16: generated per run (not a committed fixture): a build that streams numbered lines, then hangs. */
export const SLOW_BUILD_REPO = 'slow-build';
/** Printed once per second by the slow build's RUN step, numbered 1..SLOW_BUILD_LINES. */
export const SLOW_BUILD_LINE_PREFIX = 'noodara-slow-line-';
export const SLOW_BUILD_LINES = 90;
/** ps marker of the slow build's RUN step (unique to the e2e slow build). */
export const SLOW_BUILD_MARKER = 'sleep 613';

function writeSlowBuildRepo(root: string): string {
  const nodeBase = resolveBaseImages().find((ref) => ref.startsWith('node:'));
  if (nodeBase === undefined) throw new DeployHostStartupError('environment', 'no node base image in fixtures/');
  const dir = path.join(root, SLOW_BUILD_REPO);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(dir, 'Dockerfile'),
    [
      `FROM ${nodeBase}`,
      `RUN for i in $(seq 1 ${String(SLOW_BUILD_LINES)}); do echo "${SLOW_BUILD_LINE_PREFIX}$i"; sleep 1; done; ${SLOW_BUILD_MARKER}`,
      '',
    ].join('\n'),
  );
  return dir;
}

export type DeployHostStage = 'environment' | 'start' | 'sshd' | 'dockerd' | 'git-host' | 'registry';

export class DeployHostStartupError extends Error {
  readonly stage: DeployHostStage;
  constructor(stage: DeployHostStage, reason: string) {
    super(`deploy host failed to start (${stage}): ${reason}`);
    this.name = 'DeployHostStartupError';
    this.stage = stage;
  }
}

export class DeployHostExecTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`deploy host exec '${command}' timed out after ${String(timeoutMs)}ms`);
    this.name = 'DeployHostExecTimeoutError';
  }
}

export class DeployHostLeakError extends Error {
  constructor(runId: string, leftovers: readonly string[]) {
    super(`e2e run ${runId} left resources behind: ${leftovers.join(', ')}`);
    this.name = 'DeployHostLeakError';
  }
}

export interface DeployHostExecOptions {
  readonly user?: string;
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

export interface DeployHostExecResult {
  readonly exitCode: number;
  /** Known per-run secrets and any PEM private key block replaced with `<redacted>`. */
  readonly stdout: string;
  readonly stderr: string;
}

export interface CurlResult {
  readonly status: number;
  readonly body: string;
}

export interface DeployHost {
  readonly runId: string;
  readonly ssh: {
    readonly host: string;
    readonly port: number;
    readonly user: 'deployer';
    readonly privateKey: string;
    /** 0600 copy of `privateKey` inside the run temp dir (for file-upload flows). */
    readonly privateKeyPath: string;
  };
  readonly deployKey: { readonly privateKey: string; readonly publicKey: string };
  readonly registry: { readonly host: string; readonly username: string; readonly password: string };
  readonly repos: { readonly nodeApi: string; readonly failingBuild: string; readonly slowBuild: string };
  gitRepoUrl(name: string): string;
  readonly baseImages: readonly string[];
  /** `<registry>/fixtures/<image>` refs preloaded in the nested dockerd. */
  readonly preloadedImages: readonly string[];
  exec(command: readonly string[], options?: DeployHostExecOptions): Promise<DeployHostExecResult>;
  /** Lets a deploy key Noodara generated (its public half, as the UI shows it) read the git host. */
  authorizeGitKey(publicKey: string): Promise<void>;
  /** curl http://127.0.0.1:<port><path> from inside the deploy host. */
  curlPublishedPort(port: number, urlPath?: string): Promise<CurlResult>;
  listContainers(): Promise<readonly string[]>;
  listImages(): Promise<readonly string[]>;
  listNetworks(): Promise<readonly string[]>;
  listWorkspaces(): Promise<readonly string[]>;
  /** Idempotent. */
  stop(): Promise<void>;
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text.replace(PEM_PRIVATE_KEY, REDACTED);
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join(REDACTED);
    // Multi-line secrets (keys) can be echoed line by line.
    for (const line of secret.split('\n')) {
      if (line.trim().length >= 16) out = out.split(line).join(REDACTED);
    }
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(onTimeout());
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function assertRunId(runId: string | undefined): string {
  if (runId === undefined || !RUN_ID_PATTERN.test(runId)) {
    throw new Error(`invalid e2e run id '${String(runId)}': refusing to touch docker resources`);
  }
  return runId;
}

/** Reads the run id/dir global-setup.ts exported to every worker. */
export function currentRun(): { readonly runId: string; readonly runDir: string } {
  const runId = process.env[RUN_ID_ENV];
  const runDir = process.env[RUN_DIR_ENV];
  if (runId === undefined || runDir === undefined || runDir === '') {
    throw new DeployHostStartupError('environment', `${RUN_ID_ENV}/${RUN_DIR_ENV} unset (global-setup did not run)`);
  }
  return { runId: assertRunId(runId), runDir };
}

/** SSH banner straight from the runner: the mapped port really answers as sshd. */
function readSshBanner(host: string, port: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no SSH banner from ${host}:${String(port)} within ${String(timeoutMs)}ms`));
    }, timeoutMs);
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (data.includes('\n')) {
        clearTimeout(timer);
        socket.destroy();
        resolve(data.split('\n')[0] ?? '');
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function checkReadiness(stack: DeployEngineStack, exec: DeployHost['exec'], repoUrls: readonly string[]): Promise<void> {
  const banner = await readSshBanner(stack.ssh.host, stack.ssh.port, 10_000).catch((err: unknown) => {
    throw new DeployHostStartupError('sshd', errorMessage(err));
  });
  if (!banner.startsWith('SSH-2.0-')) throw new DeployHostStartupError('sshd', `unexpected banner '${banner}'`);

  const docker = await exec(['docker', 'info', '--format', '{{.ServerVersion}}'], { user: 'deployer' });
  if (docker.exitCode !== 0 || docker.stdout.trim() === '') {
    throw new DeployHostStartupError('dockerd', `docker info exited ${String(docker.exitCode)}: ${docker.stderr.trim()}`);
  }

  for (const url of repoUrls) {
    const git = await exec(
      [
        'sh',
        '-c',
        'k=$(mktemp); cat > "$k"; ' +
          'GIT_SSH_COMMAND="ssh -i $k -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR" ' +
          'git ls-remote "$1" >/dev/null; rc=$?; rm -f "$k"; exit $rc',
        'sh',
        url,
      ],
      { user: 'deployer', stdin: stack.deployKey.privateKey },
    );
    if (git.exitCode !== 0) {
      throw new DeployHostStartupError('git-host', `ls-remote ${url} exited ${String(git.exitCode)}: ${git.stderr.trim()}`);
    }
  }

  const registry = await exec([
    'curl', '-sS', '-o', '/dev/null', '-m', '10', '-w', '%{http_code}', `http://${stack.registry.host}/v2/`,
  ]);
  // 401 = the htpasswd registry is up and enforcing auth.
  if (registry.stdout.trim() !== '401') {
    throw new DeployHostStartupError('registry', `GET /v2/ answered '${registry.stdout.trim()}': ${registry.stderr.trim()}`);
  }
}

function lines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * Starts the deploy host for the current e2e run, bounded by `startupTimeoutMs`, and resolves
 * only once sshd, dockerd, the git host and the registry all answer. Throws DeployHostStartupError
 * naming the failed stage; anything half-started is stopped (and swept by label at teardown).
 */
export async function startDeployHost(
  options: { readonly startupTimeoutMs?: number } = {},
): Promise<DeployHost> {
  const { runId, runDir } = currentRun();
  const hostDir = path.join(runDir, `deploy-host-${String(process.pid)}`);
  const tmpDir = path.join(hostDir, 'tmp');
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  chmodSync(hostDir, 0o700);

  // Per-run keys and build contexts are generated under os.tmpdir(); point it at the run dir for
  // the duration of startup so they are only ever written inside the run temp dir.
  const slowBuildDir = writeSlowBuildRepo(hostDir);
  const previousTmp = process.env['TMPDIR'];
  process.env['TMPDIR'] = tmpDir;
  const starting = startDeployEngineStack({
    ubuntu: '24.04',
    labels: { [RUN_LABEL_KEY]: runId },
    seedRepositories: [
      ...Object.values(DEPLOY_HOST_REPOS).map((name) => ({ name, sourceDir: path.join(FIXTURES_DIR, name) })),
      { name: SLOW_BUILD_REPO, sourceDir: slowBuildDir },
    ],
  });
  let stack: DeployEngineStack;
  try {
    stack = await withTimeout(
      starting,
      options.startupTimeoutMs ?? DEPLOY_HOST_STARTUP_TIMEOUT_MS,
      () => new DeployHostStartupError('start', `not ready within ${String(options.startupTimeoutMs ?? DEPLOY_HOST_STARTUP_TIMEOUT_MS)}ms`),
    );
  } catch (err) {
    // A late success must not outlive the failed run.
    void starting.then((late) => late.stop()).catch(() => undefined);
    if (err instanceof DeployHostStartupError) throw err;
    throw new DeployHostStartupError('start', errorMessage(err));
  } finally {
    if (previousTmp === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = previousTmp;
  }

  const secrets = [stack.ssh.privateKey, stack.deployKey.privateKey, stack.registry.password];
  const redact = (text: string): string => redactSecrets(text, secrets);

  const exec: DeployHost['exec'] = async (command, opts = {}) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const result = await withTimeout(
      // The helper's own timeout is set past ours so this one always fires first with a named error.
      stack.exec(command, {
        ...(opts.user === undefined ? {} : { user: opts.user }),
        ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
        timeoutMs: timeoutMs + 5_000,
      }),
      timeoutMs,
      () => new DeployHostExecTimeoutError(redact(command.join(' ')).slice(0, 120), timeoutMs),
    );
    return { exitCode: result.exitCode, stdout: redact(result.stdout), stderr: redact(result.stderr) };
  };

  const listing = async (label: string, command: readonly string[]): Promise<readonly string[]> => {
    const result = await exec(command, { user: 'deployer' });
    if (result.exitCode !== 0) throw new Error(`deploy host: ${label} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
    return lines(result.stdout);
  };

  const repos = {
    nodeApi: stack.gitRepoUrl(DEPLOY_HOST_REPOS.nodeApi),
    failingBuild: stack.gitRepoUrl(DEPLOY_HOST_REPOS.failingBuild),
    slowBuild: stack.gitRepoUrl(SLOW_BUILD_REPO),
  };

  try {
    await withTimeout(
      checkReadiness(stack, exec, Object.values(repos)),
      READINESS_TIMEOUT_MS,
      () => new DeployHostStartupError('start', `readiness check exceeded ${String(READINESS_TIMEOUT_MS)}ms`),
    );
  } catch (err) {
    await stack.stop().catch(() => undefined);
    throw err instanceof DeployHostStartupError ? err : new DeployHostStartupError('start', redact(errorMessage(err)));
  }

  const privateKeyPath = path.join(hostDir, 'id_ed25519');
  writeFileSync(privateKeyPath, stack.ssh.privateKey, { mode: 0o600 });

  const handle: DeployHost = {
    runId,
    ssh: { ...stack.ssh, privateKeyPath },
    deployKey: stack.deployKey,
    registry: stack.registry,
    repos,
    gitRepoUrl: (name) => stack.gitRepoUrl(name),
    baseImages: stack.baseImages,
    preloadedImages: stack.baseImages.map((image) => preloadedRefFor(stack.registry.host, image)),
    exec,
    async authorizeGitKey(publicKey) {
      const key = publicKey.trim();
      if (!PUBLIC_KEY_LINE.test(key)) throw new Error('authorizeGitKey: not a single OpenSSH public key line');
      const result = await exec([
        'sh',
        '-c',
        'printf "no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty %s\\n" "$1" >> /home/git/.ssh/authorized_keys',
        'sh',
        key,
      ]);
      if (result.exitCode !== 0) throw new Error(`authorizeGitKey exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
    },
    async curlPublishedPort(port, urlPath = '/') {
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`invalid port ${String(port)}`);
      const result = await exec([
        'curl', '-sS', '-m', '10', '-w', '\n%{http_code}', `http://127.0.0.1:${String(port)}${urlPath}`,
      ]);
      const cut = result.stdout.lastIndexOf('\n');
      return { status: Number(result.stdout.slice(cut + 1)) || 0, body: result.stdout.slice(0, Math.max(cut, 0)) };
    },
    listContainers: () => listing('docker ps', ['docker', 'ps', '-a', '--size=false', '--format', '{{.Names}}']),
    listImages: () => listing('docker images', ['docker', 'images', '--format', '{{.Repository}}:{{.Tag}}']),
    listNetworks: () => listing('docker network ls', ['docker', 'network', 'ls', '--format', '{{.Name}}']),
    listWorkspaces: () => listing('ls workspaces', ['sh', '-c', `ls -1 ${WORKSPACES_ROOT} 2>/dev/null || true`]),
    stop: () => stack.stop(),
  };

  // Never let a secret reach a reporter, trace or console via serialization.
  const safeView = (): Record<string, unknown> => ({
    runId,
    ssh: { host: stack.ssh.host, port: stack.ssh.port, user: stack.ssh.user, privateKey: REDACTED, privateKeyPath },
    registry: { host: stack.registry.host, username: stack.registry.username, password: REDACTED },
    repos,
  });
  Object.defineProperty(handle, 'toJSON', { value: safeView, enumerable: false });
  Object.defineProperty(handle, inspect.custom, { value: () => safeView(), enumerable: false });
  return handle;
}

async function hostDocker(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', [...args], { timeout: HOST_DOCKER_TIMEOUT_MS });
  return stdout;
}

/** Like hostDocker, but keeps the stdout of a partially failed call (e.g. inspect racing a removal). */
async function hostDockerLenient(args: readonly string[]): Promise<string> {
  try {
    return await hostDocker(args);
  } catch (err) {
    const stdout = (err as { stdout?: unknown }).stdout;
    return typeof stdout === 'string' ? stdout : '';
  }
}

async function runResources(runId: string): Promise<{ containers: string[]; networks: string[]; volumes: string[] }> {
  const filter = `label=${RUN_LABEL_KEY}=${runId}`;
  const networkRows = lines(await hostDocker(['network', 'ls', '--filter', filter, '--format', '{{.ID}} {{.Name}}']));
  const networks = networkRows.map((row) => row.split(' ')[0] ?? row);
  const networkNames = new Set(networkRows.map((row) => row.split(' ')[1] ?? ''));
  const containers = new Set(lines(await hostDocker(['ps', '-aq', '--filter', filter])));
  // The registry and mirror carry no run label but only ever join this run's labelled network.
  for (const network of networks) {
    for (const id of lines(await hostDocker(['ps', '-aq', '--filter', `network=${network}`]))) containers.add(id);
  }
  // `ps --filter network=` misses containers that were created but never started.
  if (networkNames.size > 0) {
    const candidates = lines(await hostDocker(['ps', '-aq', '--filter', 'label=noodara.test=true', '--filter', 'status=created']));
    if (candidates.length > 0) {
      for (const row of lines(await hostDockerLenient(['inspect', '--format', '{{.Id}} {{.HostConfig.NetworkMode}}', ...candidates]))) {
        const [id, mode] = row.split(' ');
        if (id !== undefined && mode !== undefined && networkNames.has(mode)) containers.add(id.slice(0, 12));
      }
    }
  }
  const volumes = lines(await hostDocker(['volume', 'ls', '-q', '--filter', filter]));
  return { containers: [...containers], networks, volumes };
}

/**
 * Removes every container, network and volume of one e2e run (by its run label, plus containers
 * attached to its labelled networks). Idempotent; never touches other runs; never prunes.
 * Throws DeployHostLeakError if anything of this run survives.
 */
export async function sweepRunResources(rawRunId: string): Promise<void> {
  const runId = assertRunId(rawRunId);
  const found = await runResources(runId);
  const attempt = async (args: readonly string[]): Promise<void> => {
    try {
      await hostDocker(args);
    } catch {
      // Already gone or still in use; the verification below decides.
    }
  };
  if (found.containers.length > 0) await attempt(['rm', '-f', '-v', ...found.containers]);
  for (const network of found.networks) await attempt(['network', 'rm', network]);
  if (found.volumes.length > 0) await attempt(['volume', 'rm', '-f', ...found.volumes]);

  const left = await runResources(runId);
  const leftovers = [
    ...left.containers.map((id) => `container ${id}`),
    ...left.networks.map((id) => `network ${id}`),
    ...left.volumes.map((id) => `volume ${id}`),
  ];
  if (leftovers.length > 0) throw new DeployHostLeakError(runId, leftovers);
}

/** Playwright fixture: `deployHost` is started once per worker, only for specs that use it. */
export const test = base.extend<object, { deployHost: DeployHost }>({
  deployHost: [
    async ({}, use) => {
      const host = await startDeployHost();
      try {
        await use(host);
      } finally {
        await host.stop();
      }
    },
    { scope: 'worker', timeout: DEPLOY_HOST_STARTUP_TIMEOUT_MS + READINESS_TIMEOUT_MS + 120_000 },
  ],
});

export { expect } from '@playwright/test';
