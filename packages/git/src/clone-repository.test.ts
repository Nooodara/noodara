// cloneRepository against a recording fake SshDeploySession (11-15, DEP-08, D-09, ADR 0008 G1).
// The fake redacts chunks and tails with the injected redactor at stream time, like the real
// adapter, so the SEC canaries prove a secret was registered before any output could carry it.
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRedactor, revealSecret, secretValue, type Redactor } from '@noodara/domain/security';
import {
  deployWorkspaceFor,
  validateServiceSource,
  type DeployWorkspace,
  type ServiceSource,
} from '@noodara/domain/validators';
import {
  ASKPASS_SCRIPT_CONTENT,
  type DeployCommandName,
  type ExecResult,
  type RemoteCommand,
  type SshDeploySession,
  type StreamChunk,
  type StreamOptions,
  type StreamResult,
} from '@noodara/ssh';
import { describe, expect, it } from 'vitest';
import { cloneRepository, type CloneRepositoryInput, type GitCredential } from './clone-repository.js';
import type { StepLimits } from './step-result.js';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEPLOYMENT_ID = '3f2b8c1e-9d4a-4f6b-8a2c-1e5d7f9b0c3a';
const SHA = 'a'.repeat(40);
const LIMITS: StepLimits = {
  maxDurationMs: 60_000,
  idleTimeoutMs: 30_000,
  maxTotalBytes: 1_048_576,
  maxLineBytes: 16_384,
};
const AUTH_FAILED_STDERR = [
  "Cloning into 'repo'...",
  'git@github.com: Permission denied (publickey).',
  'fatal: Could not read from remote repository.',
  '',
].join('\n');

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

const DEFAULT_SCRIPTS: Partial<Record<DeployCommandName, Script>> = {
  'git.head_sha': { stdout: `${SHA}\n` },
  'git.probe_features': { stdout: 'submodules=0\nlfs=0\n' },
};

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
    const script = this.scripts[command.name] ?? DEFAULT_SCRIPTS[command.name] ?? {};
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
}

function workspace(): DeployWorkspace {
  const ws = deployWorkspaceFor(DEPLOYMENT_ID);
  if (!ws.ok) throw new Error('test setup: workspace');
  return ws.value;
}

function gitSource(): Extract<ServiceSource, { kind: 'git' }> {
  const source = validateServiceSource({
    kind: 'git',
    repositoryUrl: 'git@github.com:acme/api.git',
    branch: 'main',
  });
  if (!source.ok || source.value.kind !== 'git') throw new Error('test setup: source');
  return source.value;
}

/** A fresh PEM-shaped canary per run (SEC: per-run secrets from crypto.randomBytes). */
function canaryKey(): string {
  return [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    randomBytes(48).toString('base64'),
    randomBytes(48).toString('base64'),
    '-----END OPENSSH PRIVATE KEY-----',
    '',
  ].join('\n');
}

function canaryToken(): string {
  return `noodara-canary-${randomBytes(24).toString('hex')}`;
}

function secretLines(raw: string): string[] {
  return raw.split('\n').filter((line) => line.length >= 8 && !line.startsWith('-----'));
}

function run(
  session: SshDeploySession,
  redactor: Redactor,
  credential: GitCredential,
  overrides: Partial<CloneRepositoryInput> = {},
) {
  return cloneRepository({
    session,
    redactor,
    workspace: workspace(),
    source: gitSource(),
    credential,
    limits: LIMITS,
    ...overrides,
  });
}

function expectNoSecretInArgv(session: RecordingSession, secrets: readonly string[]): void {
  for (const call of session.calls) {
    const argv = call.command.argv.join('\u0000');
    for (const secret of secrets) {
      expect(argv.includes(secret), `${call.command.name} argv carries a secret`).toBe(false);
    }
  }
}

describe('cloneRepository with a deploy key', () => {
  it('prepares the workspace, writes the key and known_hosts over stdin, clones supervised, then reads the SHA and probes features', async () => {
    const redactor = createRedactor();
    const key = canaryKey();
    const session = new RecordingSession(redactor);
    const ws = workspace();

    const result = await run(session, redactor, {
      kind: 'deploy_key',
      privateKey: secretValue(key, 'ssh_private_key'),
    });

    expect(result).toMatchObject({ ok: true, value: { commitSha: SHA } });
    expect(session.names()).toEqual([
      'fs.prepare_workspace',
      'secrets.write_file',
      'secrets.write_file',
      'process.supervise',
      'git.head_sha',
      'git.probe_features',
    ]);
    const keyWrite = session.call('secrets.write_file', 0);
    expect(keyWrite.command.argv.at(-1)).toBe(ws.secretFile('deploy_key'));
    expect(keyWrite.stdin).toBe(key);
    const knownHostsWrite = session.call('secrets.write_file', 1);
    expect(knownHostsWrite.command.argv.at(-1)).toBe(ws.secretFile('known_hosts'));
    expect(knownHostsWrite.stdin).toBe('');

    const clone = session.call('process.supervise').command.argv;
    expect(clone).toContain(ws.pidFile('clone'));
    expect(clone).toContain('clone');
    expect(clone).toContain('--depth');
    expect(clone).toContain('--no-recurse-submodules');
    expect(clone.at(-1)).toBe(ws.repo);
    expect(clone.find((token) => token.startsWith('GIT_SSH_COMMAND='))).toContain(ws.secretFile('deploy_key'));
  });

  it('passes the caller limits and signal to every stream call', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor);
    const controller = new AbortController();

    await run(
      session,
      redactor,
      { kind: 'deploy_key', privateKey: secretValue(canaryKey(), 'ssh_private_key') },
      { signal: controller.signal },
    );

    expect(session.calls).toHaveLength(6);
    for (const { options } of session.calls) {
      expect(options).toMatchObject(LIMITS);
      expect(options.signal).toBe(controller.signal);
    }
  });

  it('never puts the key or any line of it in argv, the result or the forwarded chunks', async () => {
    const redactor = createRedactor();
    const key = canaryKey();
    const lines = secretLines(key);
    const session = new RecordingSession(
      redactor,
      // A hostile remote echoes the key back on stderr while the clone runs.
      { 'process.supervise': { exitCode: 128, stderr: `${key}\n${AUTH_FAILED_STDERR}` } },
      lines,
    );
    const chunks: StreamChunk[] = [];

    const result = await run(
      session,
      redactor,
      { kind: 'deploy_key', privateKey: secretValue(key, 'ssh_private_key') },
      { onChunk: (chunk) => chunks.push(chunk) },
    );

    expectNoSecretInArgv(session, [key, ...lines]);
    expect(session.call('process.supervise').redactedAtCall).toEqual(lines);
    const delivered = JSON.stringify({ result, chunks });
    for (const line of lines) expect(delivered.includes(line)).toBe(false);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('releases the key from the redactor once the call ends', async () => {
    const redactor = createRedactor();
    const key = canaryKey();
    const lines = secretLines(key);
    const session = new RecordingSession(redactor, {}, lines);

    await run(session, redactor, { kind: 'deploy_key', privateKey: secretValue(key, 'ssh_private_key') });

    for (const line of lines) expect(redactor.redact(line)).toBe(line);
  });
});

describe('cloneRepository with an HTTPS token', () => {
  it('writes the token and the askpass helper over stdin before the clone and points git at them', async () => {
    const redactor = createRedactor();
    const token = canaryToken();
    const session = new RecordingSession(redactor);
    const ws = workspace();

    const result = await run(session, redactor, { kind: 'https_token', token: secretValue(token, 'api_key') });

    expect(result.ok).toBe(true);
    expect(session.names()).toEqual([
      'fs.prepare_workspace',
      'secrets.write_file',
      'secrets.write_askpass',
      'process.supervise',
      'git.head_sha',
      'git.probe_features',
    ]);
    const tokenWrite = session.call('secrets.write_file');
    expect(tokenWrite.command.argv.at(-1)).toBe(ws.secretFile('https_token'));
    expect(tokenWrite.stdin).toBe(token);
    const askpassWrite = session.call('secrets.write_askpass');
    expect(askpassWrite.stdin).toBe(ASKPASS_SCRIPT_CONTENT);
    const clone = session.call('process.supervise').command.argv;
    expect(clone).toContain(`GIT_ASKPASS=${String(askpassWrite.command.argv.at(-1))}`);
    expect(clone).toContain(`NOODARA_ASKPASS_TOKEN_FILE=${ws.secretFile('https_token')}`);
    expectNoSecretInArgv(session, [token]);
  });

  it('keeps the token registered with the redactor for the whole call and releases it afterwards', async () => {
    const redactor = createRedactor();
    const token = canaryToken();
    const session = new RecordingSession(
      redactor,
      { 'process.supervise': { stderr: `remote: echo ${token}\n` } },
      [token],
    );
    const chunks: StreamChunk[] = [];

    await run(
      session,
      redactor,
      { kind: 'https_token', token: secretValue(token, 'api_key') },
      { onChunk: (chunk) => chunks.push(chunk) },
    );

    for (const call of session.calls) expect(call.redactedAtCall, call.command.name).toEqual([token]);
    expect(JSON.stringify(chunks).includes(token)).toBe(false);
    expect(redactor.redact(token)).toBe(token);
  });
});

describe('cloneRepository without a credential', () => {
  it('issues no secrets.* command and no auth environment', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor);

    const result = await run(session, redactor, { kind: 'none' });

    expect(result.ok).toBe(true);
    expect(session.names()).toEqual([
      'fs.prepare_workspace',
      'process.supervise',
      'git.head_sha',
      'git.probe_features',
    ]);
    const clone = session.call('process.supervise').command.argv;
    expect(clone.some((token) => token.startsWith('GIT_SSH_COMMAND=') || token.startsWith('GIT_ASKPASS='))).toBe(false);
  });
});

describe('cloneRepository failures', () => {
  it('classifies an auth failure on the clone and runs neither head_sha nor the probe', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor, {
      'process.supervise': { exitCode: 128, stderr: AUTH_FAILED_STDERR },
    });

    const result = await run(session, redactor, {
      kind: 'deploy_key',
      privateKey: secretValue(canaryKey(), 'ssh_private_key'),
    });

    expect(result).toMatchObject({ ok: false, kind: 'failed', code: 'REPOSITORY_AUTH_FAILED' });
    expect(session.names()).not.toContain('git.head_sha');
    expect(session.names()).not.toContain('git.probe_features');
  });

  it.each([
    ['not a SHA', { stdout: 'HEAD\n' }],
    ['a short SHA', { stdout: 'abc1234\n' }],
    ['a failed rev-parse', { exitCode: 128, stderr: 'fatal: not a git repository\n' }],
    ['truncated output', { stdout: `${SHA}\n`, truncated: true }],
  ] as const)('reports CLONE_FAILED when rev-parse returns %s', async (_label, script) => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor, { 'git.head_sha': script });

    const result = await run(session, redactor, { kind: 'none' });

    expect(result).toMatchObject({ ok: false, kind: 'failed', code: 'CLONE_FAILED' });
    expect(session.names()).not.toContain('git.probe_features');
  });

  it.each([
    ['lfs', 'submodules=0\nlfs=1\n'],
    ['submodules', 'submodules=1\nlfs=0\n'],
    ['both', 'lfs=1\nsubmodules=1\n'],
  ])('reports UNSUPPORTED_REPOSITORY_FEATURE when the probe finds %s', async (_label, stdout) => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor, { 'git.probe_features': { stdout } });

    const result = await run(session, redactor, { kind: 'none' });

    expect(result).toMatchObject({ ok: false, kind: 'failed', code: 'UNSUPPORTED_REPOSITORY_FEATURE' });
  });

  it.each([
    ['empty output', { stdout: '' }],
    ['an unknown key', { stdout: 'submodules=0\nlfs=0\nhooks=1\n' }],
    ['a non-zero exit', { exitCode: 2, stdout: '' }],
    ['truncated output', { stdout: 'submodules=0\nlfs=0\n', truncated: true }],
  ] as const)('never treats an unparseable probe (%s) as supported', async (_label, script) => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor, { 'git.probe_features': script });

    const result = await run(session, redactor, { kind: 'none' });

    expect(result).toMatchObject({ ok: false, kind: 'failed', code: 'CLONE_FAILED' });
  });

  it.each(['aborted', 'timed_out', 'idle_timeout'] as const)(
    'reports a clone that ended %s as interrupted',
    async (outcome) => {
      const redactor = createRedactor();
      const session = new RecordingSession(redactor, {
        'process.supervise': { outcome, exitCode: null },
      });

      const result = await run(session, redactor, { kind: 'none' });

      expect(result).toEqual({ ok: false, kind: 'interrupted', outcome });
      expect(session.names()).not.toContain('git.head_sha');
    },
  );

  it('stops before writing any secret when the workspace cannot be prepared', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor, {
      'fs.prepare_workspace': { exitCode: 1, stderr: 'mkdir: cannot create directory: No space left on device\n' },
    });

    const result = await run(session, redactor, {
      kind: 'deploy_key',
      privateKey: secretValue(canaryKey(), 'ssh_private_key'),
    });

    expect(result).toMatchObject({ ok: false, kind: 'failed', code: 'DISK_FULL' });
    expect(session.names()).toEqual(['fs.prepare_workspace']);
  });

  it('does not clone when a secret file cannot be written', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor, {
      'secrets.write_file': { exitCode: 2, stderr: 'sh: cannot create: Permission denied\n' },
    });

    const result = await run(session, redactor, {
      kind: 'deploy_key',
      privateKey: secretValue(canaryKey(), 'ssh_private_key'),
    });

    expect(result).toMatchObject({ ok: false, kind: 'failed', code: 'CLONE_FAILED' });
    expect(session.names()).not.toContain('process.supervise');
  });

  it('turns a lost connection into SERVER_UNREACHABLE without echoing the error and still releases secrets', async () => {
    const redactor = createRedactor();
    const token = canaryToken();
    const session = new RecordingSession(redactor, {
      'process.supervise': { reject: new Error(`socket closed ${token}`) },
    });

    const result = await run(session, redactor, { kind: 'https_token', token: secretValue(token, 'api_key') });

    expect(result).toMatchObject({ ok: false, kind: 'failed', code: 'SERVER_UNREACHABLE' });
    expect(JSON.stringify(result).includes(token)).toBe(false);
    expect(JSON.stringify(result).includes('socket closed')).toBe(false);
    expect(redactor.redact(token)).toBe(token);
  });

  it('does not let a throwing onChunk callback break the clone', async () => {
    const redactor = createRedactor();
    const session = new RecordingSession(redactor, { 'process.supervise': { stderr: "Cloning into 'repo'...\n" } });

    const result = await run(session, redactor, { kind: 'none' }, {
      onChunk: () => {
        throw new Error('consumer bug');
      },
    });

    expect(result.ok).toBe(true);
  });
});

describe('@noodara/git package boundary', () => {
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

  it('neither imports ssh2 nor reads environment variables', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
    const envAccess = ['process', 'env'].join('.');
    for (const file of sourceFiles) {
      const source = readFileSync(join(PACKAGE_ROOT, 'src', file), 'utf8');
      expect(/from\s+['"]ssh2['"]/.test(source), file).toBe(false);
      expect(source.includes(envAccess), file).toBe(false);
    }
  });

  it('exports only cloneRepository at runtime', async () => {
    const surface = await import('./index.js');
    expect(Object.keys(surface).sort()).toEqual(['cloneRepository']);
  });
});
