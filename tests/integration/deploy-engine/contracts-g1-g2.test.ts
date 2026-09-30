// G1/G2 empirical contracts (11-06-PLAN.md, QA-10, D-02, D-04). Permanent: every assertion here is
// what was measured against the real sshd + dockerd fixture (11-03) on Ubuntu 22.04 and 24.04, and
// fails if a new OpenSSH, git or Docker changes it. Raw ssh2 via `@noodara/ssh/testing` only,
// never the adapter and never a mock. Remote scripts are constant strings; the only variable parts
// (fresh-UUID paths, registry host, user) travel as positional parameters. Measurements are
// printed as `[G1]` / `[G2]` JSON lines and recorded in 11-06-SUMMARY.md for ADR 0008.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@noodara/ssh/testing';
import type { ClientChannel } from '@noodara/ssh/testing';
import {
  DEPLOY_ENGINE_UBUNTU_VERSIONS,
  startDeployEngineStack,
  type DeployEngineStack,
} from '../helpers/deploy-engine.js';
import { generateDeployKeyPair } from '../helpers/deploy-keys.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE_API_FIXTURE = path.resolve(HERE, '../../../fixtures/node-api');
const DEPLOY_ERRORS_DIR = path.resolve(HERE, '../../../packages/ssh/src/fixtures/deploy-errors');
const CAPTURE_FIXTURES = process.env['NOODARA_CAPTURE_FIXTURES'] === '1';
const STACK_TIMEOUT_MS = 900_000;
const SSH_COMMAND_TIMEOUT_MS = 180_000;
const WORKSPACE_ROOT = '/opt/noodara-deploy';

/**
 * Measured, not assumed: the umask sftp-server applies to a raw open(mode 0666). Ubuntu's
 * pam_umask + USERGROUPS_ENAB give a user-private-group account umask 002, so a mode that is not
 * already 0600 is NOT safe through SFTP's open alone.
 */
const SFTP_RAW_0666_MODE: Record<string, string> = {
  '22.04': '664 deployer',
  '24.04': '664 deployer',
};

// --- Raw ssh2 plumbing ------------------------------------------------------------------------

interface RunResult {
  readonly exitCode: number | null;
  readonly signal: string | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

interface Running {
  readonly channel: ClientChannel;
  stdout(): string;
  stderr(): string;
  /** When ssh2 received exit-status/exit-signal, if it has. */
  exitedAt(): number | undefined;
  /** Settles on the channel's 'close'; exit code/signal as ssh2 reported them. */
  readonly done: Promise<RunResult>;
}

/** ssh2's SFTPWrapper, derived from Client so no bare `ssh2` specifier is needed here. */
type Sftp = Parameters<Parameters<Client['sftp']>[0]>[1];

function connect(stack: DeployEngineStack): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once('ready', () => {
      resolve(client);
    });
    client.once('error', reject);
    client.connect({
      host: stack.ssh.host,
      port: stack.ssh.port,
      username: stack.ssh.user,
      privateKey: stack.ssh.privateKey,
      readyTimeout: 20_000,
    });
  });
}

function start(client: Client, command: string): Promise<Running> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err: Error | undefined, channel: ClientChannel) => {
      if (err !== undefined) {
        reject(err);
        return;
      }
      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;
      let signal: string | undefined;
      let exitedAt: number | undefined;
      channel.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      channel.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      channel.on('exit', (code: number | null, signalName?: string) => {
        exitCode = code;
        signal = signalName;
        exitedAt = Date.now();
      });
      const done = new Promise<RunResult>((settle, fail) => {
        const timer = setTimeout(() => {
          fail(new Error(`ssh exec timed out after ${String(SSH_COMMAND_TIMEOUT_MS)}ms`));
        }, SSH_COMMAND_TIMEOUT_MS);
        timer.unref();
        channel.on('close', () => {
          clearTimeout(timer);
          settle({ exitCode, signal, stdout, stderr });
        });
      });
      resolve({
        channel,
        stdout: () => stdout,
        stderr: () => stderr,
        exitedAt: () => exitedAt,
        done,
      });
    });
  });
}

async function run(client: Client, command: string, stdin?: string): Promise<RunResult> {
  const running = await start(client, command);
  if (stdin !== undefined) running.channel.write(stdin);
  running.channel.end();
  return running.done;
}

/** POSIX single-quote for the few positional parameters (UUID paths, hostnames) passed to sh -c. */
function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function pollUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100,
): Promise<{ readonly ok: boolean; readonly elapsedMs: number }> {
  const startedAt = Date.now();
  for (;;) {
    if (await check()) return { ok: true, elapsedMs: Date.now() - startedAt };
    if (Date.now() - startedAt >= timeoutMs)
      return { ok: false, elapsedMs: Date.now() - startedAt };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Resolves `undefined` after `ms`: races a channel close without ever rejecting. */
function settleAfter(ms: number): Promise<undefined> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(undefined);
    }, ms);
  });
}

function measure(tag: 'G1' | 'G2', ubuntu: string, data: Record<string, unknown>): void {
  const line = `[${tag}] ${JSON.stringify({ ubuntu, ...data })}`;
  console.log(line);
  // Vitest hides console output of passing tests; this is how the SUMMARY numbers are collected.
  const file = process.env['NOODARA_MEASUREMENTS_FILE'];
  if (file !== undefined && file !== '') appendFileSync(file, `${line}\n`);
}

/** Every process's argv on the deploy host, seen as root (no hidepid in the fixture). */
async function psArgs(stack: DeployEngineStack): Promise<string> {
  const result = await stack.exec(['ps', '-eo', 'pid,args']);
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

/** Every readable /proc/<pid>/environ concatenated, read as root; searched locally, never remotely. */
async function allEnvirons(stack: DeployEngineStack): Promise<string> {
  const result = await stack.exec([
    'sh',
    '-c',
    'for f in /proc/[0-9]*/environ; do tr "\\000" "\\n" < "$f" 2>/dev/null; done; true',
  ]);
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

/** stdout + stderr of the deploy host container: sshd runs with -e, so this is its whole log. */
function deployHostLogs(ubuntu: string): string {
  const names = spawnSync(
    'docker',
    [
      'ps',
      '--filter',
      'label=noodara.test=true',
      '--filter',
      `name=noodara-deploy-host-${ubuntu}-`,
      '--format',
      '{{.Names}}',
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  const [name] = names.stdout.trim().split('\n');
  if (name === undefined || name === '') throw new Error('deploy host container not found');
  const logs = spawnSync('docker', ['logs', name], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return `${logs.stdout}${logs.stderr}`;
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

/** Random hex body wrapped in PEM armour so the structural redactor pattern applies too. */
function pemCanary(): { readonly pem: string; readonly bodyLines: readonly string[] } {
  const bodyLines = Array.from({ length: 4 }, () => randomBytes(32).toString('hex'));
  return {
    pem: `-----BEGIN OPENSSH PRIVATE KEY-----\n${bodyLines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`,
    bodyLines,
  };
}

// Constant remote scripts (the shape 11-13 freezes in the allowlist). $0 is always the workspace.
const MAKE_WORKSPACE = `sh -c 'umask 077 && mkdir -p "$0/secrets" "$0/run"'`;
const WRITE_SECRET = `sh -c 'umask 077 && cat > "$0"'`;
const GIT_CLONE =
  `sh -c 'cd "$0" && GIT_SSH_COMMAND="ssh -i $0/secrets/deploy_key -o IdentitiesOnly=yes ` +
  `-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$0/secrets/known_hosts" ` +
  `git clone --depth 1 --branch "$1" -- "$2" "$3"'`;
const DOCKER_LOGIN = `sh -c 'docker --config "$0/secrets/docker" login --username "$1" --password-stdin "$2"'`;

async function makeWorkspace(client: Client): Promise<string> {
  const ws = `${WORKSPACE_ROOT}/${randomUUID()}`;
  const made = await run(client, `${MAKE_WORKSPACE} ${q(ws)}`);
  expect(made.exitCode).toBe(0);
  return ws;
}

async function removeWorkspace(client: Client, ws: string): Promise<void> {
  const removed = await run(client, `rm -rf -- ${q(ws)}`);
  expect(removed.exitCode).toBe(0);
}

// --- Git failure captures (for classifyGitError, 11-11) ---------------------------------------

interface GitFailureCase {
  readonly file: string;
  readonly marker: RegExp;
  readonly branch: string;
  readonly repo: 'authorized' | 'unauthorized-key' | 'missing-repo' | 'unknown-host';
}

/** Marker regexes are mirrored in packages/ssh/src/fixtures/deploy-errors/README.md. */
const GIT_FAILURES: readonly GitFailureCase[] = [
  {
    file: 'git-auth-failed.txt',
    marker: /Permission denied \(publickey[,)]/,
    branch: 'main',
    repo: 'unauthorized-key',
  },
  {
    file: 'git-repository-not-found.txt',
    marker: /does not appear to be a git repository/,
    branch: 'main',
    repo: 'missing-repo',
  },
  {
    file: 'git-branch-not-found.txt',
    marker: /Remote branch does-not-exist not found in upstream origin/,
    branch: 'does-not-exist',
    repo: 'authorized',
  },
  {
    file: 'git-host-unreachable.txt',
    marker: /Could not resolve hostname nohost\.noodara-test\.internal/,
    branch: 'main',
    repo: 'unknown-host',
  },
];

// --- G1 -----------------------------------------------------------------------------------------

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)(
  'G1 / ADR 0008: secret transfer without argv on Ubuntu %s',
  (ubuntu) => {
    let stack: DeployEngineStack | undefined;
    let client: Client | undefined;

    const s = (): DeployEngineStack => {
      if (stack === undefined) throw new Error('stack not started');
      return stack;
    };
    const c = (): Client => {
      if (client === undefined) throw new Error('client not connected');
      return client;
    };

    beforeAll(async () => {
      stack = await startDeployEngineStack({
        ubuntu,
        seedRepositories: [{ name: 'node-api', sourceDir: NODE_API_FIXTURE }],
      });
      client = await connect(stack);
      const versions = await stack.exec([
        'sh',
        '-c',
        'ssh -V 2>&1; git --version; docker version --format "{{.Server.Version}}"',
      ]);
      measure('G1', ubuntu, { versions: versions.stdout.trim().split('\n') });
    }, STACK_TIMEOUT_MS);

    afterAll(async () => {
      client?.end();
      await stack?.stop();
      await assertNoStrayTestContainers();
    }, STACK_TIMEOUT_MS);

    it('G1 / ADR 0008: stdin to `umask 077 && cat > <path>` lands byte-identical, 0600, owned by deployer, and never shows in ps args, /proc/*/environ or sshd logs while the channel is held open', async () => {
      const ws = await makeWorkspace(c());
      const target = `${ws}/secrets/deploy_key`;
      const canary = pemCanary();
      try {
        const running = await start(c(), `${WRITE_SECRET} ${q(target)}`);
        running.channel.write(canary.pem);
        // Channel held open (no end() yet): `cat` is alive with the canary in its pipe.
        const catAlive = await pollUntil(async () => (await psArgs(s())).includes(target), 5_000);
        const psDuring = await psArgs(s());
        const environDuring = await allEnvirons(s());
        running.channel.end();
        const result = await running.done;
        const remote = await run(c(), `sh -c 'sha256sum "$0"; stat -c "%a %U" "$0"' ${q(target)}`);
        const [shaLine, statLine] = remote.stdout.trim().split('\n');
        const logs = deployHostLogs(ubuntu);

        measure('G1', ubuntu, {
          candidate: 'stdin',
          exitCode: result.exitCode,
          shaMatch: shaLine?.split(' ')[0] === sha256(canary.pem),
          modeOwner: statLine,
          catSeenInPs: catAlive.ok,
          canaryInPs: containsAny(psDuring, canary.bodyLines),
          canaryInEnviron: containsAny(environDuring, canary.bodyLines),
          canaryInSshdLog: containsAny(logs, canary.bodyLines),
        });
        expect(result.exitCode).toBe(0);
        expect(shaLine?.split(' ')[0]).toBe(sha256(canary.pem));
        expect(statLine).toBe('600 deployer');
        expect(containsAny(psDuring, canary.bodyLines)).toBe(false);
        expect(containsAny(environDuring, canary.bodyLines)).toBe(false);
        expect(containsAny(logs, canary.bodyLines)).toBe(false);
      } finally {
        await removeWorkspace(c(), ws);
      }
    });

    it('G1 / ADR 0008: SFTP raw open with mode 0666 keeps group-write (sftp-server umask 002), while createWriteStream({ mode: 0o600 }) lands byte-identical at 0600 before and after close', async () => {
      const ws = await makeWorkspace(c());
      const umaskProbe = `${ws}/secrets/umask-probe`;
      const target = `${ws}/secrets/deploy_key_sftp`;
      const canary = pemCanary();
      const sftp = await new Promise<Sftp>((resolve, reject) => {
        c().sftp((err: Error | undefined, wrapper: Sftp) => {
          if (err !== undefined) reject(err);
          else resolve(wrapper);
        });
      });
      const statModes = async (file: string): Promise<string> =>
        (await run(c(), `stat -c "%a %U" ${q(file)}`)).stdout.trim();
      try {
        // Raw open(2) through sftp-server: shows the umask the subsystem inherits from sshd.
        const probeHandle = await new Promise<Buffer>((resolve, reject) => {
          sftp.open(umaskProbe, 'w', { mode: 0o666 }, (err: Error | undefined, handle: Buffer) => {
            if (err !== undefined) reject(err);
            else resolve(handle);
          });
        });
        const probeMode = await statModes(umaskProbe);
        await new Promise<void>((resolve, reject) => {
          sftp.close(probeHandle, (err?: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        });

        const stream = sftp.createWriteStream(target, { mode: 0o600 });
        await new Promise<void>((resolve, reject) => {
          stream.once('open', () => {
            resolve();
          });
          stream.once('error', reject);
        });
        const modeAfterOpen = await statModes(target);
        await new Promise<void>((resolve, reject) => {
          stream.once('close', () => {
            resolve();
          });
          stream.once('error', reject);
          stream.end(Buffer.from(canary.pem, 'utf8'));
        });
        const modeAfterClose = await statModes(target);
        const remoteSha = (await run(c(), `sha256sum ${q(target)}`)).stdout.split(' ')[0];
        const psAfter = await psArgs(s());
        const logs = deployHostLogs(ubuntu);

        measure('G1', ubuntu, {
          candidate: 'sftp',
          rawOpen0666Mode: probeMode,
          modeAfterOpen,
          modeAfterClose,
          shaMatch: remoteSha === sha256(canary.pem),
          canaryInPs: containsAny(psAfter, canary.bodyLines),
          canaryInSshdLog: containsAny(logs, canary.bodyLines),
        });
        expect(probeMode).toBe(SFTP_RAW_0666_MODE[ubuntu]);
        expect(modeAfterOpen).toBe('600 deployer');
        expect(modeAfterClose).toBe('600 deployer');
        expect(remoteSha).toBe(sha256(canary.pem));
        expect(containsAny(logs, canary.bodyLines)).toBe(false);
      } finally {
        sftp.end();
        await removeWorkspace(c(), ws);
      }
    });

    it('G1 / ADR 0008: a deploy key delivered over stdin clones through GIT_SSH_COMMAND and leaves neither the key nor its path in .git/config', async () => {
      const ws = await makeWorkspace(c());
      try {
        const written = await run(
          c(),
          `${WRITE_SECRET} ${q(`${ws}/secrets/deploy_key`)}`,
          s().deployKey.privateKey,
        );
        expect(written.exitCode).toBe(0);

        const clone = await run(
          c(),
          `${GIT_CLONE} ${q(ws)} main ${q(s().gitRepoUrl('node-api'))} repo`,
        );
        const gitConfig = (await run(c(), `cat ${q(`${ws}/repo/.git/config`)}`)).stdout;
        const keyLines = s()
          .deployKey.privateKey.split('\n')
          .filter((line) => line.length > 20 && !line.startsWith('-----'));

        measure('G1', ubuntu, {
          candidate: 'stdin+git-clone',
          cloneExit: clone.exitCode,
          configHasKeyPath: gitConfig.includes('deploy_key'),
          configHasKeyMaterial: containsAny(gitConfig, keyLines),
        });
        expect(clone.exitCode).toBe(0);
        expect(gitConfig).toContain('[remote "origin"]');
        expect(gitConfig).not.toContain('deploy_key');
        expect(gitConfig).not.toContain('secrets');
        expect(containsAny(gitConfig, keyLines)).toBe(false);
      } finally {
        await removeWorkspace(c(), ws);
      }
    });

    it('G1 / ADR 0008: `docker --config <ws>/secrets/docker login --password-stdin` keeps the credential inside the workspace, out of ps and ~/.docker, and gone after rm -rf <ws>', async () => {
      const ws = await makeWorkspace(c());
      const { host, username, password } = s().registry;
      const auth = Buffer.from(`${username}:${password}`).toString('base64');
      const homeConfigBefore = (
        await run(c(), `sha256sum /home/deployer/.docker/config.json 2>/dev/null || echo absent`)
      ).stdout.trim();

      const running = await start(c(), `${DOCKER_LOGIN} ${q(ws)} ${q(username)} ${q(host)}`);
      running.channel.write(`${password}\n`);
      // --password-stdin reads to EOF: `docker login` is alive and blocked while we look.
      const loginAlive = await pollUntil(
        async () => (await psArgs(s())).includes('password-stdin'),
        5_000,
      );
      const psDuring = await psArgs(s());
      const environDuring = await allEnvirons(s());
      running.channel.end();
      const login = await running.done;

      const wsConfig = await run(
        c(),
        `sh -c 'stat -c "%a" "$0/secrets/docker" "$0/secrets/docker/config.json"; cat "$0/secrets/docker/config.json"' ${q(ws)}`,
      );
      const [dirMode, fileMode, ...jsonLines] = wsConfig.stdout.split('\n');
      const parsed = JSON.parse(jsonLines.join('\n')) as {
        auths?: Record<string, { auth?: string }>;
        credsStore?: string;
      };
      const homeConfigAfter = (
        await run(c(), `sha256sum /home/deployer/.docker/config.json 2>/dev/null || echo absent`)
      ).stdout.trim();
      const dockerdLog = (await s().exec(['cat', '/var/log/noodara-dockerd.log'])).stdout;
      const logs = deployHostLogs(ubuntu);

      await removeWorkspace(c(), ws);
      // Needles travel on stdin (grep -f /dev/stdin), never argv. Exit 1 = no match anywhere.
      const leftovers = await run(
        c(),
        'sudo -n grep -rlF -f /dev/stdin /home/deployer /root /tmp /opt/noodara-deploy',
        `${password}\n${auth}\n`,
      );

      measure('G1', ubuntu, {
        candidate: 'docker-login-password-stdin',
        loginExit: login.exitCode,
        loginSeenInPs: loginAlive.ok,
        credentialFile: '<ws>/secrets/docker/config.json',
        dirMode,
        fileMode,
        credsStore: parsed.credsStore ?? null,
        authIsBase64UserPass: parsed.auths?.[host]?.auth === auth,
        homeConfigUnchanged: homeConfigBefore === homeConfigAfter,
        homeConfigBefore: homeConfigBefore === 'absent' ? 'absent' : 'present',
        passwordInPs: containsAny(psDuring, [password, auth]),
        passwordInEnviron: containsAny(environDuring, [password, auth]),
        passwordInLogs: containsAny(logs + dockerdLog, [password, auth]),
        grepAfterRmExit: leftovers.exitCode,
      });
      expect(login.exitCode).toBe(0);
      expect(loginAlive.ok).toBe(true);
      expect(parsed.auths?.[host]?.auth).toBe(auth);
      expect(parsed.credsStore).toBeUndefined();
      expect(homeConfigAfter).toBe(homeConfigBefore);
      expect(containsAny(psDuring, [password, auth])).toBe(false);
      expect(containsAny(environDuring, [password, auth])).toBe(false);
      expect(containsAny(logs + dockerdLog, [password, auth])).toBe(false);
      expect(leftovers.exitCode).toBe(1);
    });

    it.each(GIT_FAILURES)(
      'G1 / ADR 0008: git clone failure $file keeps its stable stderr marker and exit code',
      async (failure) => {
        const ws = await makeWorkspace(c());
        try {
          const key =
            failure.repo === 'unauthorized-key'
              ? (await generateDeployKeyPair('noodara-test-unauthorized')).privateKey
              : s().deployKey.privateKey;
          const written = await run(c(), `${WRITE_SECRET} ${q(`${ws}/secrets/deploy_key`)}`, key);
          expect(written.exitCode).toBe(0);
          const url =
            failure.repo === 'missing-repo'
              ? s().gitRepoUrl('does-not-exist')
              : failure.repo === 'unknown-host'
                ? 'git@nohost.noodara-test.internal:/srv/git/node-api.git'
                : s().gitRepoUrl('node-api');

          const clone = await run(c(), `${GIT_CLONE} ${q(ws)} ${q(failure.branch)} ${q(url)} repo`);
          const recorded = `# exit=${String(clone.exitCode)}\n${clone.stderr}`;
          const fixturePath = path.join(DEPLOY_ERRORS_DIR, `ubuntu-${ubuntu}`, failure.file);

          measure('G1', ubuntu, { gitFailure: failure.file, exitCode: clone.exitCode });
          expect(clone.stderr).not.toContain('BEGIN');
          if (CAPTURE_FIXTURES) {
            mkdirSync(path.dirname(fixturePath), { recursive: true });
            writeFileSync(fixturePath, recorded);
          }
          expect(clone.exitCode).toBe(128);
          expect(clone.stderr).toMatch(failure.marker);
          const fixture = readFileSync(fixturePath, 'utf8');
          expect(fixture.split('\n')[0]).toBe(`# exit=${String(clone.exitCode)}`);
          expect(fixture).toMatch(failure.marker);
        } finally {
          await removeWorkspace(c(), ws);
        }
      },
    );
  },
);

// --- G2 -----------------------------------------------------------------------------------------

const SLOW_BUILD_DOCKERFILE = readFileSync(
  path.join(HERE, 'fixtures/slow-build/Dockerfile'),
  'utf8',
);
const SLOW_BUILD_STARTED = 'NOODARA_SLOW_BUILD_STARTED';
const LAUNCH_IN_GROUP = `setsid sh -c 'echo $$ > "$0"; exec "$@"'`;
const LAUNCH_IN_GROUP_WAIT = `setsid -w sh -c 'echo $$ > "$0"; exec "$@"'`;
/**
 * Measured on both versions: /bin/sh is dash, whose builtin `kill -TERM -- "-$pgid"` fails with
 * `kill: Illegal number: -` (exit 2) and kills nothing. `kill -s TERM -- "-$pgid"` is the form that
 * works; the rejected form stays below as a negative contract.
 */
const KILL_GROUP_DASH_REJECTED = `sh -c 'read -r pgid < "$0" && kill -TERM -- "-$pgid"'`;
const KILL_GROUP = `sh -c 'read -r pgid < "$0" && kill -s TERM -- "-$pgid"'`;
const WRITE_DOCKERFILE = `sh -c 'umask 077 && mkdir -p "$0" && cat > "$0/Dockerfile"'`;
const BUILD_STEP = 'sleep 300';

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)(
  'G2 / ADR 0008 / D-04: confirmed remote kill on Ubuntu %s',
  (ubuntu) => {
    let stack: DeployEngineStack | undefined;
    let client: Client | undefined;

    const s = (): DeployEngineStack => {
      if (stack === undefined) throw new Error('stack not started');
      return stack;
    };
    const c = (): Client => {
      if (client === undefined) throw new Error('client not connected');
      return client;
    };

    /** Remote truth: pids whose full argv matches, seen as root. Never inferred locally. */
    const pids = async (pattern: string): Promise<string[]> => {
      const result = await s().exec(['pgrep', '-f', pattern]);
      return result.stdout.split('\n').filter((line) => line.trim() !== '');
    };
    const groupPids = async (pgid: string): Promise<string[]> => {
      const result = await s().exec(['pgrep', '-g', pgid]);
      return result.stdout.split('\n').filter((line) => line.trim() !== '');
    };
    const absent = (pattern: string, timeoutMs: number) =>
      pollUntil(async () => (await pids(pattern)).length === 0, timeoutMs);
    const present = (pattern: string, timeoutMs: number) =>
      pollUntil(async () => (await pids(pattern)).length > 0, timeoutMs);
    const groupAbsent = (pgid: string, timeoutMs: number) =>
      pollUntil(async () => (await groupPids(pgid)).length === 0, timeoutMs);
    const readPgid = async (pidfile: string): Promise<string> => {
      const found = await pollUntil(
        async () => (await run(c(), `test -s ${q(pidfile)}`)).exitCode === 0,
        5_000,
      );
      expect(found.ok).toBe(true);
      return (await run(c(), `cat ${q(pidfile)}`)).stdout.trim();
    };

    /** docker build of fixtures/slow-build, optionally under a launcher; resolves once RUN started. */
    const startSlowBuild = async (
      ws: string,
      launcher: string | undefined,
    ): Promise<{ readonly running: Running; readonly tag: string }> => {
      const tag = `noodara-test/slow:${randomUUID()}`;
      const written = await run(
        c(),
        `${WRITE_DOCKERFILE} ${q(`${ws}/build`)}`,
        SLOW_BUILD_DOCKERFILE,
      );
      expect(written.exitCode).toBe(0);
      const build = `docker build --progress=plain -t ${q(tag)} ${q(`${ws}/build`)}`;
      const running = await start(
        c(),
        launcher === undefined ? build : `${launcher} ${q(`${ws}/run/build.pid`)} ${build}`,
      );
      running.done.catch(() => undefined);
      const started = await pollUntil(
        async () => `${running.stdout()}${running.stderr()}`.includes(SLOW_BUILD_STARTED),
        120_000,
        250,
      );
      expect(started.ok).toBe(true);
      expect((await present(BUILD_STEP, 5_000)).ok).toBe(true);
      return { running, tag };
    };

    const slowImagesLeft = async (): Promise<string> =>
      (await s().exec(['docker', 'images', '-q', 'noodara-test/slow'])).stdout.trim();

    beforeAll(async () => {
      stack = await startDeployEngineStack({ ubuntu });
      client = await connect(stack);
      const versions = await stack.exec([
        'sh',
        '-c',
        'ssh -V 2>&1; docker version --format "{{.Server.Version}}"; docker buildx version; setsid --version',
      ]);
      measure('G2', ubuntu, { versions: versions.stdout.trim().split('\n') });
    }, STACK_TIMEOUT_MS);

    afterEach(async () => {
      // Fallback cleanup, then assert: no spike process or image may outlive its test.
      await s().exec(['pkill', '-KILL', '-f', 'sleep 30[0-9]']);
      expect((await absent('sleep 30[0-9]', 5_000)).ok).toBe(true);
      expect(await slowImagesLeft()).toBe('');
    });

    afterAll(async () => {
      client?.end();
      await stack?.stop();
      await assertNoStrayTestContainers();
    }, STACK_TIMEOUT_MS);

    it('G2 / ADR 0008 / D-04: negative control: destroying the channel, then ending the whole connection, leaves a no-pty `sleep` running', async () => {
      const running = await start(c(), 'sleep 301');
      running.done.catch(() => undefined);
      expect((await present('sleep 301', 5_000)).ok).toBe(true);

      running.channel.destroy();
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const afterDestroy = await pids('sleep 301');

      const second = await connect(s());
      const other = await start(second, 'sleep 301');
      other.done.catch(() => undefined);
      expect((await present('sleep 301', 5_000)).ok).toBe(true);
      second.end();
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const afterEnd = await pids('sleep 301');

      measure('G2', ubuntu, {
        candidate: 'channel.destroy / client.end',
        survivesDestroy: afterDestroy.length === 1,
        survivesConnectionEnd: afterEnd.length === 2,
      });
      expect(afterDestroy).toHaveLength(1);
      expect(afterEnd).toHaveLength(2);
    });

    it.each(['TERM', 'KILL'] as const)(
      'G2 / ADR 0008 / D-04: channel.signal(%s) on a single no-pty command removes it (pgrep) and ssh2 reports the exit signal',
      async (signalName) => {
        const running = await start(c(), 'sleep 302');
        expect((await present('sleep 302', 5_000)).ok).toBe(true);

        running.channel.signal(signalName);
        const gone = await absent('sleep 302', 5_000);
        const result = await Promise.race([running.done, settleAfter(2_000)]);

        measure('G2', ubuntu, {
          candidate: `channel.signal(${signalName})`,
          killed: gone.ok,
          timeToAbsenceMs: gone.elapsedMs,
          exit:
            result === undefined ? 'no close' : { code: result.exitCode, signal: result.signal },
        });
        expect(gone.ok).toBe(true);
        expect(result?.exitCode).toBeNull();
        expect(result?.signal).toBe(`SIG${signalName}`);
      },
    );

    it('G2 / ADR 0008 / D-04: channel.signal(TERM) on a process tree removes every member (sshd signals the session process group)', async () => {
      const running = await start(c(), `sh -c 'sleep 302 & sleep 302; wait'`);
      running.done.catch(() => undefined);
      expect((await present('sleep 302', 5_000)).ok).toBe(true);
      const before = await pids('sleep 302');

      running.channel.signal('TERM');
      const gone = await absent('sleep 302', 5_000);

      measure('G2', ubuntu, {
        candidate: 'channel.signal(TERM) tree',
        killed: gone.ok,
        timeToAbsenceMs: gone.elapsedMs,
        pidsBefore: before.length,
      });
      expect(before.length).toBeGreaterThanOrEqual(3);
      expect(gone.ok).toBe(true);
    });

    it('G2 / ADR 0008 / D-04: dash rejects `kill -TERM -- "-$pgid"` (Illegal number, exit 2) and the group survives', async () => {
      const ws = await makeWorkspace(c());
      const pidfile = `${ws}/run/clone.pid`;
      try {
        const running = await start(c(), `${LAUNCH_IN_GROUP_WAIT} ${q(pidfile)} sleep 303`);
        running.done.catch(() => undefined);
        const pgid = await readPgid(pidfile);

        const kill = await run(c(), `${KILL_GROUP_DASH_REJECTED} ${q(pidfile)}`);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const alive = await groupPids(pgid);

        measure('G2', ubuntu, {
          candidate: 'kill -TERM -- -pgid (dash)',
          killExit: kill.exitCode,
          stderr: kill.stderr.replace(ws, '<ws>').trim(),
          groupAliveAfter: alive.length,
        });
        expect(kill.exitCode).toBe(2);
        expect(kill.stderr).toMatch(/kill: Illegal number: -/);
        expect(alive.length).toBeGreaterThan(0);
      } finally {
        await removeWorkspace(c(), ws);
      }
    });

    it.each([
      { label: 'setsid', launcher: LAUNCH_IN_GROUP, exitStatus: 0, earlyExit: true },
      { label: 'setsid -w', launcher: LAUNCH_IN_GROUP_WAIT, exitStatus: 15, earlyExit: false },
    ])(
      'G2 / ADR 0008 / D-04: $label + pidfile + kill -s TERM -- "-$pgid" removes the whole tree (pgrep -g); the launch channel reports exit $exitStatus (early: $earlyExit)',
      async ({ label, launcher, exitStatus, earlyExit }) => {
        const ws = await makeWorkspace(c());
        const pidfile = `${ws}/run/clone.pid`;
        try {
          const running = await start(
            c(),
            `${launcher} ${q(pidfile)} sh -c 'sleep 303 & sleep 303; wait'`,
          );
          const pgid = await readPgid(pidfile);
          expect((await present('sleep 303', 5_000)).ok).toBe(true);
          // Long enough for an early exit-status (setsid forking) to be observable before the kill.
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          const groupBefore = await groupPids(pgid);
          const exitedBeforeKill = running.exitedAt() !== undefined;

          const killedAt = Date.now();
          const kill = await run(c(), `${KILL_GROUP} ${q(pidfile)}`);
          const [groupGone, sleepsGone] = await Promise.all([
            groupAbsent(pgid, 5_000),
            absent('sleep 303', 5_000),
          ]);
          const result = await Promise.race([running.done, settleAfter(2_000)]);

          measure('G2', ubuntu, {
            candidate: `${label}+pidfile+kill-s-TERM-pgid`,
            killExit: kill.exitCode,
            groupSizeBefore: groupBefore.length,
            killed: groupGone.ok && sleepsGone.ok,
            timeToAbsenceMs: Math.max(groupGone.elapsedMs, sleepsGone.elapsedMs),
            exitStatusBeforeKill: exitedBeforeKill,
            launchExit:
              result === undefined ? 'no close' : { code: result.exitCode, signal: result.signal },
            killToLaunchCloseMs: Date.now() - killedAt,
          });
          expect(kill.exitCode).toBe(0);
          expect(groupBefore.length).toBeGreaterThanOrEqual(3);
          expect(groupGone.ok).toBe(true);
          expect(sleepsGone.ok).toBe(true);
          expect(result?.exitCode).toBe(exitStatus);
          // Plain setsid is already a session leader under sshd, so it forks and exits 0 at once:
          // the real exit status is lost. Only `setsid -w` carries it (raw signal number, 15).
          expect(exitedBeforeKill).toBe(earlyExit);
        } finally {
          await removeWorkspace(c(), ws);
        }
      },
    );

    it('G2 / ADR 0008 / D-04: `docker kill` has no target during a BuildKit RUN step: docker ps is empty and the step runs under runc in its own process group', async () => {
      const ws = await makeWorkspace(c());
      try {
        const { running } = await startSlowBuild(ws, LAUNCH_IN_GROUP_WAIT);
        const pgid = await readPgid(`${ws}/run/build.pid`);
        const dockerPs = (await s().exec(['docker', 'ps', '-aq'])).stdout.trim();
        const [stepPid] = await pids(`^${BUILD_STEP}$`);
        const ancestry = await s().exec([
          'sh',
          '-c',
          'ps -o pgid= -p "$1"; ps -o args= -p "$(ps -o ppid= -p "$1" | tr -d " ")"',
          'sh',
          stepPid ?? '0',
        ]);
        const [stepPgid, parentArgs] = ancestry.stdout.trim().split('\n');
        await run(c(), `${KILL_GROUP} ${q(`${ws}/run/build.pid`)}`);
        await running.done;

        measure('G2', ubuntu, {
          candidate: 'docker kill (build container)',
          dockerPsDuringRun: dockerPs === '' ? 'empty' : dockerPs,
          stepPgidDiffersFromCli: stepPgid?.trim() !== pgid,
          stepParent: parentArgs?.trim().split(' ').slice(0, 1).join(' '),
        });
        expect(dockerPs).toBe('');
        expect(stepPgid?.trim()).not.toBe(pgid);
        expect(parentArgs).toMatch(/^runc .*\/var\/lib\/docker\/buildkit\/executor/);
      } finally {
        await removeWorkspace(c(), ws);
      }
    });

    it('G2 / ADR 0008 / D-04: channel.signal(TERM) on a plain `docker build` exec cancels the RUN step (confirmed with pgrep)', async () => {
      const ws = await makeWorkspace(c());
      try {
        const { running } = await startSlowBuild(ws, undefined);

        running.channel.signal('TERM');
        const [stepGone, cliGone] = await Promise.all([
          absent(BUILD_STEP, 30_000),
          absent('docker build --progress=plain', 30_000),
        ]);
        const result = await Promise.race([running.done, settleAfter(5_000)]);

        measure('G2', ubuntu, {
          candidate: 'channel.signal(TERM) docker build',
          killed: stepGone.ok && cliGone.ok,
          stepAbsentMs: stepGone.elapsedMs,
          cliAbsentMs: cliGone.elapsedMs,
          canceled: running.stderr().includes('CANCELED'),
          exit:
            result === undefined ? 'no close' : { code: result.exitCode, signal: result.signal },
        });
        expect(stepGone.ok).toBe(true);
        expect(cliGone.ok).toBe(true);
      } finally {
        await removeWorkspace(c(), ws);
      }
    });

    it('G2 / ADR 0008 / D-04: combined sequence: setsid -w + pidfile + kill -s TERM -- "-$pgid", docker kill only if a container is still alive after 2 s, success only when the RUN step is absent in ps', async () => {
      const ws = await makeWorkspace(c());
      const pidfile = `${ws}/run/build.pid`;
      try {
        const { running } = await startSlowBuild(ws, LAUNCH_IN_GROUP_WAIT);
        const pgid = await readPgid(pidfile);
        const everythingGone = async (): Promise<boolean> =>
          (await groupPids(pgid)).length === 0 && (await pids(BUILD_STEP)).length === 0;

        const killedAt = Date.now();
        const kill = await run(c(), `${KILL_GROUP} ${q(pidfile)}`);
        const first = await pollUntil(everythingGone, 2_000);
        let dockerKillTargets: string[] = [];
        if (!first.ok) {
          dockerKillTargets = (await run(c(), 'docker ps -q')).stdout.split('\n').filter(Boolean);
          for (const id of dockerKillTargets) await run(c(), `docker kill ${q(id)}`);
        }
        const confirmed = first.ok ? first : await pollUntil(everythingGone, 10_000);
        const confirmedMs = Date.now() - killedAt;
        const result = await Promise.race([running.done, settleAfter(5_000)]);

        measure('G2', ubuntu, {
          candidate: 'combined D-04 (docker build)',
          killExit: kill.exitCode,
          confirmedAbsent: confirmed.ok,
          timeToAbsenceMs: confirmedMs,
          dockerKillBranchTaken: !first.ok,
          dockerKillTargets: dockerKillTargets.length,
          canceled: running.stderr().includes('CANCELED'),
          launchExit:
            result === undefined ? 'no close' : { code: result.exitCode, signal: result.signal },
        });
        expect(kill.exitCode).toBe(0);
        expect(confirmed.ok).toBe(true);
        expect(await pids(BUILD_STEP)).toEqual([]);
        expect(first.ok).toBe(true);
        expect(running.stderr()).toContain('CANCELED');
      } finally {
        await removeWorkspace(c(), ws);
      }
    });
  },
);
