// 11-13 deploy templates on the real sshd + dockerd fixture (SVC-08, ADR 0008 G1/G2/G4). Every
// remote command here is a builder's output passed through renderRemoteCommand, exactly as the
// engine will send it; raw strings are used only for test setup and root-side checks. Proves
// process.group_alive (not measured by the 11-06 contracts) with a supervised docker build.
// SEC: every command line and every byte of output is kept in a transcript, and the last test
// asserts that no secret (deploy key, token canary, registry password) ever appears in it.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@noodara/ssh/testing';
import type { ClientChannel } from '@noodara/ssh/testing';
import {
  dockerBuild,
  dockerCreate,
  dockerImageInspect,
  dockerImageRemove,
  dockerInspectState,
  dockerLogin,
  dockerLogout,
  dockerLogs,
  dockerNetworkCreate,
  dockerNetworkRemove,
  dockerPs,
  dockerPull,
  dockerInspectNetworks,
  dockerNetworkConnect,
  dockerRemove,
  dockerRemovePrevious,
  dockerRenameFromPrevious,
  dockerRenameToPrevious,
  dockerRestart,
  dockerStart,
  dockerStartPrevious,
  dockerStop,
  dockerStopPrevious,
  gitCheckout,
  gitClone,
  gitFetch,
  gitHeadSha,
  gitKeyscan,
  gitProbeFeatures,
  groupAlive,
  killGroup,
  prepareWorkspace,
  removeDeployDir,
  renderRemoteCommand,
  supervise,
  writeAskpassFile,
  previousContainerNameFor,
  probeHttp,
  probeTcp,
  validateContainerIp,
  writeSecretFile,
  ASKPASS_SCRIPT_CONTENT,
  PROBE_OUTPUT_MAX_BYTES,
  PROBE_SCRIPTS,
  type ContainerIp,
  type HttpHealthcheckConfig,
  type RemoteCommand,
  type TcpHealthcheckConfig,
} from '@noodara/ssh/testing/deploy-templates';
import {
  containerNameFor,
  deployWorkspaceFor,
  deploymentImageRefFor,
  gitSshEndpoint,
  knownHostsContent,
  networkNameFor,
  parseKeyscanOutput,
  resolveRepoBuildPaths,
  validateBuildContextPath,
  validateCommitSha,
  validateContainerPort,
  validateDockerfilePath,
  validateGitBranch,
  validateImageRef,
  validateRegistryHost,
  validateRegistryUsername,
  validateRepositoryUrl,
  validateResourceId,
  validateServiceSource,
  type DeployWorkspace,
  type GitHostKey,
  type ValidationResult,
} from '@noodara/domain/validators';
import {
  parseProbeOutput,
  V03_DEPLOYMENT_ERROR_MESSAGES,
  validateHealthcheckConfig,
  type HealthcheckConfig,
  type HealthcheckObservation,
} from '@noodara/domain/deployment';
import { createRedactor, secretValue } from '@noodara/domain/security';
import { classifyGitError, createSsh2Adapter, type SshDeploySession } from '@noodara/ssh';
import { cloneRepository, type StepLimits } from '@noodara/git';
import {
  DEPLOY_ENGINE_UBUNTU_VERSIONS,
  preloadedRefFor,
  startDeployEngineStack,
  type DeployEngineStack,
} from '../helpers/deploy-engine.js';
import { fixtureGitHostKey, wrongGitHostKey } from '../helpers/git-host-key.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE_API_FIXTURE = path.resolve(HERE, '../../../fixtures/node-api');
const SLOW_BUILD_DOCKERFILE = readFileSync(
  path.join(HERE, 'fixtures/slow-build/Dockerfile'),
  'utf8',
);
const SLOW_BUILD_STARTED = 'NOODARA_SLOW_BUILD_STARTED';
const DEPLOY_ERRORS_DIR = path.resolve(HERE, '../../../packages/ssh/src/fixtures/deploy-errors');
const CAPTURE_FIXTURES = process.env['NOODARA_CAPTURE_FIXTURES'] === '1';
const STACK_TIMEOUT_MS = 900_000;
const SSH_COMMAND_TIMEOUT_MS = 180_000;
// 17-01: test-only probe target (node base, no pull), same shape as contracts-v03.test.ts.
const TARGET_PORT = 8080;
const CLOSED_PORT = 9;
const PUBLISHED_PORT = 18081;
const TARGET_SERVER_JS = String.raw`
const http = require('http');
const status = Number(process.env.HEALTH_STATUS || '200');
const canary = process.env.BODY_CANARY || '';
process.on('SIGTERM', () => process.exit(0));
http.createServer((req, res) => {
  const url = req.url || '';
  if (url === '/health') { res.writeHead(status, { 'content-type': 'text/plain' }); res.end('ok ' + canary + '\n'); return; }
  if (url.startsWith('/status/')) { res.writeHead(Number(url.slice(8))); res.end(canary); return; }
  if (url === '/hang') return;
  if (url === '/big') { res.writeHead(200); res.end(canary.repeat(20000)); return; }
  res.writeHead(404); res.end();
}).listen(${String(TARGET_PORT)}, '0.0.0.0');
`;
// 18-03: repositories whose main moves past the pushed commit after seeding (see MOVE_BRANCH).
const SHA_REPOS = { direct: 'sha-direct', fallback: 'sha-fallback', forced: 'sha-forced' } as const;
const CLONE_LIMITS: StepLimits = {
  maxDurationMs: 120_000,
  idleTimeoutMs: 60_000,
  maxTotalBytes: 4 * 1024 * 1024,
  maxLineBytes: 16_384,
};
// Test setup only, run as the bare repo's owner (`git`). $1: `moved` adds a commit after the
// pushed one; `forced` pushes a commit then force-pushes it away. $2 = 1 lets the server answer
// a want for any reachable SHA (GitHub-like); 0 keeps git's default, which refuses unadvertised
// objects over protocol v0. Prints the SHA the test requests.
const MOVE_BRANCH = `set -eu
bare=/srv/git/$0.git; mode=$1; allow=$2
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git clone -q "$bare" "$work/w"
cd "$work/w"
commit() { git -c user.name='Noodara Test' -c user.email=test@noodara.invalid -c commit.gpgsign=false commit -q --allow-empty -m "$1"; }
if [ "$mode" = forced ]; then
  commit gone; requested=$(git rev-parse HEAD); git push -q origin HEAD:main
  git reset -q --hard HEAD~1; commit moved; git push -q -f origin HEAD:main
else
  requested=$(git rev-parse HEAD); commit moved; git push -q origin HEAD:main
fi
if [ "$allow" = 1 ]; then git -C "$bare" config uploadpack.allowReachableSHA1InWant true; fi
echo "$requested"
`;
// Test setup only: the slow-build Dockerfile goes under the (not cloned) repo dir.
const WRITE_DOCKERFILE = `sh -c 'umask 077 && mkdir -p "$0" && cat > "$0/Dockerfile"'`;

// --- Raw ssh2 plumbing ------------------------------------------------------------------------

interface RunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface Running {
  readonly channel: ClientChannel;
  output(): string;
  readonly done: Promise<RunResult>;
}

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

function start(client: Client, commandLine: string): Promise<Running> {
  return new Promise((resolve, reject) => {
    client.exec(commandLine, (err: Error | undefined, channel: ClientChannel) => {
      if (err !== undefined) {
        reject(err);
        return;
      }
      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;
      channel.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      channel.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      channel.on('exit', (code: number | null) => {
        exitCode = code;
      });
      const done = new Promise<RunResult>((settle, fail) => {
        const timer = setTimeout(() => {
          fail(new Error(`ssh exec timed out after ${String(SSH_COMMAND_TIMEOUT_MS)}ms`));
        }, SSH_COMMAND_TIMEOUT_MS);
        timer.unref();
        channel.on('close', () => {
          clearTimeout(timer);
          settle({ exitCode, stdout, stderr });
        });
      });
      resolve({ channel, output: () => `${stdout}${stderr}`, done });
    });
  });
}

async function runLine(client: Client, commandLine: string, stdin?: string): Promise<RunResult> {
  const running = await start(client, commandLine);
  if (stdin !== undefined) running.channel.write(stdin);
  running.channel.end();
  return running.done;
}

function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function pollUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - startedAt >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function valid<T>(result: ValidationResult<T>): T {
  if (!result.ok) throw new Error(`fixture failed validation: ${result.code}`);
  return result.value;
}

// --- Suite ------------------------------------------------------------------------------------

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)(
  '11-13 / ADR 0008: deploy templates on the real fixture, Ubuntu %s',
  (ubuntu) => {
    let stack: DeployEngineStack | undefined;
    let client: Client | undefined;
    /** Every rendered command line and every stdout/stderr chunk seen by this suite. */
    const transcript: string[] = [];
    /** Per-run secret canaries (crypto.randomBytes, never a fixed literal). */
    const tokenCanary = `noodara-canary-${randomBytes(32).toString('base64url')}`;
    const fileCanary = `noodara-canary-${randomBytes(32).toString('base64url')}`;

    const s = (): DeployEngineStack => {
      if (stack === undefined) throw new Error('stack not started');
      return stack;
    };
    const c = (): Client => {
      if (client === undefined) throw new Error('client not connected');
      return client;
    };
    const record = (commandLine: string, result: RunResult): RunResult => {
      transcript.push(commandLine, result.stdout, result.stderr);
      return result;
    };
    const run = async (command: RemoteCommand, stdin?: string): Promise<RunResult> => {
      const commandLine = renderRemoteCommand(command);
      return record(commandLine, await runLine(c(), commandLine, stdin));
    };
    const mustRun = async (command: RemoteCommand, stdin?: string): Promise<string> => {
      const result = await run(command, stdin);
      expect(result.exitCode, `${command.name}: ${result.stderr}`).toBe(0);
      return result.stdout;
    };
    /** Root-side truth, never the template under test. */
    const rootOut = async (argv: readonly string[]): Promise<string> => {
      const result = await s().exec(argv);
      transcript.push(result.stdout, result.stderr);
      return result.stdout.trim();
    };

    const withWorkspace = async (body: (ws: DeployWorkspace) => Promise<void>): Promise<void> => {
      const ws = valid(deployWorkspaceFor(randomUUID()));
      await mustRun(prepareWorkspace(ws));
      try {
        await body(ws);
      } finally {
        await mustRun(removeDeployDir(ws));
        expect(
          await rootOut(['sh', '-c', 'test -e "$0" && echo present || echo gone', ws.root]),
        ).toBe('gone');
      }
    };

    /** 14-06: StrictHostKeyChecking=yes, so every clone is pinned to an explicit known_hosts. */
    const cloneCommand = async (
      ws: DeployWorkspace,
      repoName: string,
      hostKeys: readonly GitHostKey[],
    ): Promise<RemoteCommand> => {
      await mustRun(writeSecretFile(ws.secretFile('deploy_key')), s().deployKey.privateKey);
      await mustRun(writeSecretFile(ws.secretFile('known_hosts')), knownHostsContent(hostKeys));
      const clone = gitClone({
        url: valid(validateRepositoryUrl(s().gitRepoUrl(repoName))),
        branch: valid(validateGitBranch('main')),
        target: ws.repo,
        auth: {
          kind: 'deploy_key',
          keyFile: ws.secretFile('deploy_key'),
          knownHostsFile: ws.secretFile('known_hosts'),
        },
      });
      return supervise(ws.pidFile('clone'), clone);
    };
    const cloneWithDeployKey = async (ws: DeployWorkspace, repoName: string): Promise<void> => {
      await mustRun(await cloneCommand(ws, repoName, [await fixtureGitHostKey(s())]));
    };

    beforeAll(async () => {
      stack = await startDeployEngineStack({
        ubuntu,
        seedRepositories: [
          { name: 'node-api', sourceDir: NODE_API_FIXTURE },
          {
            name: 'with-features',
            sourceDir: NODE_API_FIXTURE,
            withGitmodules: true,
            withLfsPointer: true,
          },
          ...Object.values(SHA_REPOS).map((name) => ({ name, sourceDir: NODE_API_FIXTURE })),
        ],
      });
      client = await connect(stack);
    }, STACK_TIMEOUT_MS);

    afterAll(async () => {
      client?.end();
      await stack?.stop();
      await assertNoStrayTestContainers();
    }, STACK_TIMEOUT_MS);

    it('G1: fs.prepare_workspace makes 700 secrets/run dirs and secrets.write_file lands the stdin bytes at 0600', async () => {
      await withWorkspace(async (ws) => {
        const secret = `-----BEGIN TEST SECRET-----\n${fileCanary}\n-----END TEST SECRET-----\n`;
        await mustRun(writeSecretFile(ws.secretFile('https_token')), secret);

        const modes = await rootOut([
          'stat',
          '-c',
          '%a %U %n',
          ws.secretsDir,
          ws.runDir,
          ws.secretFile('https_token'),
        ]);
        const sha = await rootOut(['sha256sum', ws.secretFile('https_token')]);

        expect(modes.split('\n').map((line) => line.split(' ').slice(0, 2).join(' '))).toEqual([
          '700 deployer',
          '700 deployer',
          '600 deployer',
        ]);
        expect(sha.split(' ')[0]).toBe(sha256(secret));
      });
    });

    it('git: a supervised deploy-key clone, head_sha, checkout --detach and probe_features (0/0); no key path in .git/config', async () => {
      await withWorkspace(async (ws) => {
        await cloneWithDeployKey(ws, 'node-api');

        const head = valid(validateCommitSha((await mustRun(gitHeadSha(ws.repo))).trim()));
        await mustRun(gitCheckout(ws.repo, head));
        const probe = await mustRun(gitProbeFeatures(ws.repo));
        const gitConfig = await rootOut(['cat', `${ws.repo}/.git/config`]);
        const detached = await s().exec(['git', '-C', ws.repo, 'symbolic-ref', '-q', 'HEAD'], {
          user: 'deployer',
        });

        expect(probe).toBe('submodules=0\nlfs=0\n');
        // symbolic-ref -q exits 1 with no output on a detached HEAD.
        expect(detached.exitCode).toBe(1);
        expect(detached.stdout).toBe('');
        expect(gitConfig).not.toContain('secrets');
        expect(gitConfig).not.toContain('deploy_key');
        expect(await rootOut(['cat', ws.pidFile('clone')])).toMatch(/^\d+$/);
      });
    });

    it('git.probe_features reports submodules=1 and lfs=1 for .gitmodules + gitlink + LFS pointer, and the clone does not recurse', async () => {
      await withWorkspace(async (ws) => {
        await cloneWithDeployKey(ws, 'with-features');

        const probe = await mustRun(gitProbeFeatures(ws.repo));
        const submoduleDir = await rootOut([
          'sh',
          '-c',
          'ls -A "$0" | wc -l',
          `${ws.repo}/vendor/sub`,
        ]);

        expect(probe).toBe('submodules=1\nlfs=1\n');
        expect(submoduleDir).toBe('0');
      });
    });

    it('14-06 A3/H3: git.keyscan returns the git host key and parseKeyscanOutput keeps only that host', async () => {
      const endpoint = gitSshEndpoint(valid(validateRepositoryUrl(s().gitRepoUrl('node-api'))));
      if (endpoint === null) throw new Error('expected an ssh endpoint');

      const scanned = await run(gitKeyscan(endpoint));
      const keys = parseKeyscanOutput(scanned.stdout, endpoint);

      expect(scanned.exitCode).toBe(0);
      expect(keys).toContainEqual(await fixtureGitHostKey(s()));
      expect(keys.every((key) => key.host === endpoint.knownHostsHost)).toBe(true);
    });

    it('14-06 A3: a clone pinned to the scanned keys succeeds under StrictHostKeyChecking=yes', async () => {
      const endpoint = gitSshEndpoint(valid(validateRepositoryUrl(s().gitRepoUrl('node-api'))));
      if (endpoint === null) throw new Error('expected an ssh endpoint');
      const keys = parseKeyscanOutput(await mustRun(gitKeyscan(endpoint)), endpoint);

      await withWorkspace(async (ws) => {
        const clone = await run(await cloneCommand(ws, 'node-api', keys));

        expect(clone.exitCode, clone.stderr).toBe(0);
        expect(clone.stderr).not.toContain('Permanently added');
      });
    });

    it('14-06 A4: a clone pinned to the wrong host key is refused and classified GIT_HOST_KEY_MISMATCH', async () => {
      const fixturePath = path.join(
        DEPLOY_ERRORS_DIR,
        `ubuntu-${ubuntu}`,
        'git-host-key-mismatch.txt',
      );
      await withWorkspace(async (ws) => {
        const clone = await run(await cloneCommand(ws, 'node-api', [wrongGitHostKey()]));
        const classified = classifyGitError(
          {
            kind: 'command',
            operation: 'clone',
            failure: {
              exitCode: clone.exitCode,
              stderr: clone.stderr,
              stdoutTail: clone.stdout,
            },
          },
          { redactor: createRedactor() },
        );

        if (CAPTURE_FIXTURES) {
          mkdirSync(path.dirname(fixturePath), { recursive: true });
          writeFileSync(fixturePath, `# exit=${String(clone.exitCode)}\n${clone.stderr}`);
        }
        expect(clone.exitCode).toBe(128);
        expect(clone.stderr).toMatch(/Host key verification failed\./);
        expect(clone.stderr).not.toContain('BEGIN');
        expect(classified.code).toBe('GIT_HOST_KEY_MISMATCH');
        expect(
          await rootOut(['sh', '-c', 'test -e "$0" && echo present || echo gone', ws.repo]),
        ).toBe('gone');
        const fixture = readFileSync(fixturePath, 'utf8');
        expect(fixture.split('\n')[0]).toBe('# exit=128');
        expect(fixture).toMatch(/Host key verification failed\./);
      });
    });

    it('G2 / ADR 0008: process.group_alive exits 0 while a supervised docker build runs; process.kill_group removes the group; group_alive then exits 1', async () => {
      await withWorkspace(async (ws) => {
        const serviceText = randomUUID();
        const serviceId = valid(validateResourceId(serviceText));
        const deploymentId = valid(validateResourceId(randomUUID()));
        const image = valid(deploymentImageRefFor(serviceText, deploymentId));
        const { contextPath, dockerfilePath } = resolveRepoBuildPaths(
          ws.repo,
          valid(validateBuildContextPath('slow')),
          valid(validateDockerfilePath('slow/Dockerfile')),
        );
        const writeLine = `${WRITE_DOCKERFILE} ${q(contextPath)}`;
        const written = record(writeLine, await runLine(c(), writeLine, SLOW_BUILD_DOCKERFILE));
        expect(written.exitCode).toBe(0);

        const pidFile = ws.pidFile('build');
        const build = dockerBuild({
          contextPath,
          dockerfilePath,
          image,
          target: null,
          serviceId,
          deploymentId,
        });
        const launchLine = renderRemoteCommand(supervise(pidFile, build));
        const running = await start(c(), launchLine);
        running.channel.end();
        try {
          const started = await pollUntil(
            () => Promise.resolve(running.output().includes(SLOW_BUILD_STARTED)),
            120_000,
          );
          expect(started, running.output()).toBe(true);
          const pgid = await rootOut(['cat', pidFile]);
          expect(await rootOut(['pgrep', '-g', pgid])).not.toBe('');

          const aliveBefore = await run(groupAlive(pidFile));
          const killed = await run(killGroup(pidFile));
          const goneFromTemplate = await pollUntil(
            async () => (await run(groupAlive(pidFile))).exitCode === 1,
            5_000,
          );
          const goneFromRoot = await pollUntil(
            async () =>
              (await rootOut(['pgrep', '-g', pgid])) === '' &&
              (await rootOut(['pgrep', '-f', 'sleep 300'])) === '',
            5_000,
          );
          const launch = record(launchLine, await running.done);

          expect(aliveBefore.exitCode).toBe(0);
          expect(killed.exitCode).toBe(0);
          expect(goneFromTemplate).toBe(true);
          expect(goneFromRoot).toBe(true);
          expect(launch.exitCode).not.toBe(0);
        } finally {
          await s().exec(['pkill', '-KILL', '-f', 'sleep 300']);
          if ((await rootOut(['docker', 'images', '-q', image])) !== '') {
            await mustRun(dockerImageRemove(image));
          }
        }
      });
    }, 300_000);

    it('process.group_alive never reports alive for a missing pidfile', async () => {
      await withWorkspace(async (ws) => {
        const result = await run(groupAlive(ws.pidFile('pull')));

        expect(result.exitCode).not.toBe(0);
        expect(result.exitCode).not.toBeNull();
      });
    });

    it('G1: docker.login --password-stdin into the per-deployment --config, docker.pull through it, docker.logout; a pull without login is refused', async () => {
      await withWorkspace(async (ws) => {
        const host = valid(validateRegistryHost(s().registry.host));
        const username = valid(validateRegistryUsername(s().registry.username));
        const base = s().baseImages.find((image) => image.startsWith('nginx:'));
        if (base === undefined) throw new Error('nginx base image not preloaded');
        const image = valid(validateImageRef(preloadedRefFor(s().registry.host, base)));
        const other = valid(deployWorkspaceFor(randomUUID()));

        const refused = await run(dockerPull({ config: other.dockerConfigDir, image }));
        await mustRun(
          dockerLogin({ config: ws.dockerConfigDir, host, username }),
          `${s().registry.password}\n`,
        );
        await mustRun(dockerPull({ config: ws.dockerConfigDir, image }));
        const configMode = await rootOut(['stat', '-c', '%a', ws.dockerConfigDir]);
        await mustRun(dockerLogout({ config: ws.dockerConfigDir, host }));
        const afterLogout = await rootOut(['cat', `${ws.dockerConfigDir}/config.json`]);
        const basicAuth = Buffer.from(`${s().registry.username}:${s().registry.password}`).toString(
          'base64',
        );

        expect(refused.exitCode).not.toBe(0);
        expect(configMode).toBe('700');
        expect(afterLogout).not.toContain(host);
        expect(afterLogout).not.toContain(basicAuth);
      });
    });

    it('docker: network_create, create, start, inspect, ps (G4 NDJSON), logs, stop, restart, remove, network_remove', async () => {
      const serviceText = randomUUID();
      const serviceId = valid(validateResourceId(serviceText));
      const deploymentId = valid(validateResourceId(randomUUID()));
      const container = valid(containerNameFor(serviceText));
      const network = valid(networkNameFor(serviceText));
      const base = s().baseImages.find((image) => image.startsWith('nginx:'));
      if (base === undefined) throw new Error('nginx base image not preloaded');
      const image = valid(validateImageRef(base));

      await mustRun(dockerNetworkCreate({ network, serviceId }));
      try {
        await mustRun(
          dockerCreate({
            container,
            network,
            image,
            internalPort: valid(validateContainerPort(80)),
            publishedPort: null,
            serviceId,
            deploymentId,
          }),
        );
        await mustRun(dockerStart(container));
        const state = JSON.parse(await mustRun(dockerInspectState(container))) as {
          Running: boolean;
        };
        const lines = (await mustRun(dockerPs()))
          .split('\n')
          .filter((line) => line !== '')
          .map(
            (line) =>
              JSON.parse(line) as {
                Names: string;
                Labels: string;
                Size: string;
              },
          );
        const mine = lines.find((line) => line.Names === container);
        await mustRun(dockerLogs({ container, tail: 10, follow: false }));
        await mustRun(dockerStop({ container, timeoutSeconds: 5 }));
        const stopped = JSON.parse(await mustRun(dockerInspectState(container))) as {
          Running: boolean;
        };
        const restart = await run(dockerRestart({ container, timeoutSeconds: 5 }));
        const labels = await rootOut([
          'docker',
          'inspect',
          '--format',
          '{{json .Config.Labels}}',
          container,
        ]);
        const logOpts = await rootOut([
          'docker',
          'inspect',
          '--format',
          '{{json .HostConfig.LogConfig.Config}} {{.HostConfig.RestartPolicy.Name}}',
          container,
        ]);

        expect(state.Running).toBe(true);
        expect(mine?.Size).toBe('0B');
        expect(mine?.Labels).toContain(`noodara.service_id=${serviceText}`);
        expect(stopped.Running).toBe(false);
        expect(restart.exitCode).toBe(0);
        expect(restart.stderr).not.toContain('deprecated');
        expect(JSON.parse(labels)).toMatchObject({
          'noodara.managed': 'true',
          'noodara.service_id': serviceText,
          'noodara.deployment_id': deploymentId,
        });
        expect(logOpts).toBe('{"max-file":"3","max-size":"10m"} unless-stopped');
      } finally {
        await run(dockerRemove(container));
        await mustRun(dockerNetworkRemove(network));
      }
      const left = (await mustRun(dockerPs()))
        .split('\n')
        .filter((line) => line.includes(container));
      expect(left).toEqual([]);
    });

    it('17-05: docker.image_inspect prints the id of a present image and reports a missing one as No such image', async () => {
      const base = s().baseImages.find((image) => image.startsWith('nginx:'));
      if (base === undefined) throw new Error('nginx base image not preloaded');
      const missing = valid(deploymentImageRefFor(randomUUID(), randomUUID()));

      const present = await run(dockerImageInspect(valid(validateImageRef(base))));
      const absent = await run(dockerImageInspect(missing));

      expect(present.exitCode).toBe(0);
      expect(present.stdout.trim()).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(absent.exitCode).toBe(1);
      expect(absent.stderr).toMatch(/No such image/i);
    });

    it('SEC: an https token reaches its 0600 file over stdin only, and the askpass helper is 0700 without it', async () => {
      await withWorkspace(async (ws) => {
        // DEPLOY_SECRET_NAMES has no askpass entry yet (Phase 12 adds it with the HTTPS clone);
        // the known_hosts slot stands in, since an https_token clone never uses one.
        const askpass = ws.secretFile('known_hosts');
        await mustRun(writeSecretFile(ws.secretFile('https_token')), tokenCanary);
        await mustRun(writeAskpassFile(askpass), ASKPASS_SCRIPT_CONTENT);

        const modes = await rootOut(['stat', '-c', '%a %U', ws.secretFile('https_token'), askpass]);
        const tokenSha = await rootOut(['sha256sum', ws.secretFile('https_token')]);
        const askpassSha = await rootOut(['sha256sum', askpass]);

        expect(modes.split('\n')).toEqual(['600 deployer', '700 deployer']);
        expect(tokenSha.split(' ')[0]).toBe(sha256(tokenCanary));
        expect(askpassSha.split(' ')[0]).toBe(sha256(ASKPASS_SCRIPT_CONTENT));
      });
    });

    // --- 17-01 / ADR 0010 A3: probe and -prev templates against the real dockerd ---------------
    describe('17-01 / ADR 0010: healthcheck probe and -prev templates', () => {
      const bodyCanary = `noodara-canary-${randomBytes(32).toString('base64url')}`;
      const serviceText = randomUUID();
      const serviceId = valid(validateResourceId(serviceText));
      const container = valid(containerNameFor(serviceText));
      const previous = previousContainerNameFor(serviceId);
      const network = valid(networkNameFor(serviceText));
      const deploymentA = randomUUID();
      const timing = { probeTimeoutS: 2, intervalS: 1, retries: 1, startPeriodS: 0 } as const;

      const http = (path: string, probeTimeoutS = 2): HealthcheckConfig =>
        valid(
          validateHealthcheckConfig({
            ...timing,
            probeTimeoutS,
            type: 'http',
            path,
            port: TARGET_PORT,
            expectedStatuses: [200],
          }),
        );
      const tcp = (port: number): HealthcheckConfig =>
        valid(validateHealthcheckConfig({ ...timing, type: 'tcp', port }));
      const asHttp = (config: HealthcheckConfig): HttpHealthcheckConfig => {
        if (config.type !== 'http') throw new Error('expected an http config');
        return config;
      };
      const asTcp = (config: HealthcheckConfig): TcpHealthcheckConfig => {
        if (config.type !== 'tcp') throw new Error('expected a tcp config');
        return config;
      };

      /** The IP on noodara-net-<serviceId>, read through the template under test. */
      const ipOf = async (which: 'current' | 'previous'): Promise<ContainerIp> => {
        const networks = JSON.parse(
          await mustRun(dockerInspectNetworks({ serviceId, container: which })),
        ) as Record<string, { IPAddress?: string }>;
        return valid(validateContainerIp(networks[network]?.IPAddress ?? ''));
      };
      const probe = async (
        command: RemoteCommand,
      ): Promise<{ result: RunResult; observation: HealthcheckObservation; ms: number }> => {
        const startedAt = performance.now();
        const result = await run(command);
        return {
          result,
          observation: parseProbeOutput(result.stdout),
          ms: performance.now() - startedAt,
        };
      };
      const httpProbe = async (path: string, probeTimeoutS = 2) =>
        probe(probeHttp({ ip: await ipOf('current'), config: asHttp(http(path, probeTimeoutS)) }));
      /** Root-side truth on the published host port, never the template under test. */
      const onPublishedPort = async (): Promise<HealthcheckObservation> => {
        const result = await s().exec([
          'bash',
          '--noprofile',
          '--norc',
          '-c',
          PROBE_SCRIPTS.http,
          'noodara-probe',
          '127.0.0.1',
          String(PUBLISHED_PORT),
          '/health',
        ]);
        return parseProbeOutput(result.stdout);
      };
      const runTarget = async (deploymentId: string, healthStatus: number): Promise<void> => {
        const node = s().baseImages.find((image) => image.startsWith('node:'));
        if (node === undefined) throw new Error('node base image not preloaded');
        const result = await s().exec([
          'docker',
          'run',
          '--detach',
          '--pull',
          'never',
          '--name',
          container,
          '--network',
          network,
          '--restart',
          'unless-stopped',
          '--label',
          'noodara.managed=true',
          '--label',
          `noodara.service_id=${serviceText}`,
          '--label',
          `noodara.deployment_id=${deploymentId}`,
          '--env',
          `HEALTH_STATUS=${String(healthStatus)}`,
          '--env',
          `BODY_CANARY=${bodyCanary}`,
          '--publish',
          `${String(PUBLISHED_PORT)}:${String(TARGET_PORT)}`,
          '--',
          node,
          'node',
          '-e',
          TARGET_SERVER_JS,
        ]);
        expect(result.exitCode, result.stderr).toBe(0);
      };
      const answers = async (status: number): Promise<boolean> =>
        pollUntil(async () => {
          const published = await onPublishedPort();
          return published.kind === 'http' && published.status === status;
        }, 30_000);

      beforeAll(async () => {
        await mustRun(dockerNetworkCreate({ network, serviceId }));
        await runTarget(deploymentA, 200);
        expect(await answers(200), 'version A answering').toBe(true);
      }, STACK_TIMEOUT_MS);

      afterAll(async () => {
        await s().exec(['docker', 'rm', '--force', '--', container, previous]);
        await s().exec(['docker', 'network', 'rm', '--', network]);
      }, STACK_TIMEOUT_MS);

      it('A3: probe.http on a listening port reports the status line only, never the body (A4/H2)', async () => {
        const health = await httpProbe('/health');
        const big = await httpProbe('/big');

        expect(health.result.exitCode).toBe(0);
        expect(health.observation).toEqual({ kind: 'http', status: 200 });
        expect(health.result.stdout).toBe('NOODARA_PROBE http 200\n');
        expect(big.observation).toEqual({ kind: 'http', status: 200 });
        expect(Buffer.byteLength(big.result.stdout + big.result.stderr)).toBeLessThanOrEqual(
          PROBE_OUTPUT_MAX_BYTES,
        );
        for (const output of [health.result, big.result]) {
          expect(`${output.stdout}${output.stderr}`).not.toContain(bodyCanary);
        }
      });

      it('A3: probe.tcp reports open on the listening port and refused on a closed one; probe.http on a closed port is refused', async () => {
        const ip = await ipOf('current');
        const open = await probe(probeTcp({ ip, config: asTcp(tcp(TARGET_PORT)) }));
        const closed = await probe(probeTcp({ ip, config: asTcp(tcp(CLOSED_PORT)) }));
        const closedHttp = await probe(
          probeHttp({
            ip,
            config: asHttp(
              valid(
                validateHealthcheckConfig({
                  ...timing,
                  type: 'http',
                  path: '/health',
                  port: CLOSED_PORT,
                }),
              ),
            ),
          }),
        );

        expect(open.observation).toEqual({ kind: 'open' });
        expect(closed.observation).toEqual({ kind: 'refused' });
        expect(closedHttp.observation).toEqual({ kind: 'refused' });
        expect([open, closed, closedHttp].map((p) => p.result.exitCode)).toEqual([0, 0, 0]);
      });

      it('A3: probe.http on a wrong status reports that status (the caller decides it failed)', async () => {
        const wrong = await httpProbe('/status/503');

        expect(wrong.result.exitCode).toBe(0);
        expect(wrong.observation).toEqual({ kind: 'http', status: 503 });
        expect(wrong.result.stdout).not.toContain(bodyCanary);
      });

      it('A3/H1: probe.http on a hung endpoint is killed by the timeout wrapper within its budget (exit 124)', async () => {
        const hung = await httpProbe('/hang', 2);

        expect(hung.result.exitCode).toBe(124);
        expect(hung.observation).toEqual({ kind: 'error' });
        expect(hung.ms).toBeGreaterThanOrEqual(1_900);
        // probeTimeoutS + the 1 s kill grace + SSH round trips.
        expect(hung.ms).toBeLessThan(6_000);
        expect(`${hung.result.stdout}${hung.result.stderr}`).not.toContain(bodyCanary);
      });

      it('A3/H1: rename to -prev frees the name and port, a second rename is refused (never overwrites), restore keeps the published port', async () => {
        await mustRun(dockerStop({ container, timeoutSeconds: 10 }));
        await mustRun(dockerRenameToPrevious(serviceId));
        expect(await onPublishedPort()).toEqual({ kind: 'refused' });

        // Version B takes the name and the published port.
        await runTarget(randomUUID(), 202);
        expect(await answers(202), 'version B answering').toBe(true);

        // H1: -prev exists, so a rename onto it is a Conflict and -prev is left alone.
        await mustRun(dockerStop({ container, timeoutSeconds: 10 }));
        const conflict = await run(dockerRenameToPrevious(serviceId));
        expect(conflict.exitCode).not.toBe(0);
        expect(conflict.stderr).toMatch(/Conflict|already in use/);
        const kept = await rootOut([
          'docker',
          'inspect',
          '--type',
          'container',
          '--format',
          '{{index .Config.Labels "noodara.deployment_id"}}',
          '--',
          previous,
        ]);
        expect(kept).toBe(deploymentA);

        // ADR 0010 A2 restore: remove the new container, rename -prev back, start it.
        await mustRun(dockerRemove(container));
        await mustRun(dockerRenameFromPrevious(serviceId));
        const networks = JSON.parse(
          await mustRun(dockerInspectNetworks({ serviceId, container: 'current' })),
        ) as Record<string, unknown>;
        expect(Object.keys(networks)).toEqual([network]);
        await mustRun(dockerStart(container));

        expect(await answers(200), 'version A restored').toBe(true);
        const port = await rootOut(['docker', 'port', '--', container]);
        expect(port).toContain(`:${String(PUBLISHED_PORT)}`);
        const healthy = await httpProbe('/health');
        expect(healthy.observation).toEqual({ kind: 'http', status: 200 });
      });

      it('A3: -prev start, stop and remove act on -prev only; a detached stopped container re-attaches with network_connect', async () => {
        await mustRun(dockerStop({ container, timeoutSeconds: 10 }));
        await mustRun(dockerRenameToPrevious(serviceId));

        await mustRun(dockerStartPrevious(serviceId));
        expect(await answers(200), '-prev answering on the published port').toBe(true);
        const prevIp = await ipOf('previous');
        const prevProbe = await probe(probeHttp({ ip: prevIp, config: asHttp(http('/health')) }));
        expect(prevProbe.observation).toEqual({ kind: 'http', status: 200 });

        await mustRun(dockerStopPrevious({ serviceId, timeoutSeconds: 10 }));
        expect(await onPublishedPort()).toEqual({ kind: 'refused' });

        // ADR 0010 A2: a detached, stopped container is re-attached by network_connect.
        await mustRun(dockerRenameFromPrevious(serviceId));
        const networksOf = async (): Promise<string[]> =>
          Object.keys(
            JSON.parse(
              await mustRun(dockerInspectNetworks({ serviceId, container: 'current' })),
            ) as Record<string, unknown>,
          );
        await s().exec(['docker', 'network', 'disconnect', '--', network, container]);
        expect(await networksOf()).toEqual([]);
        await mustRun(dockerNetworkConnect(serviceId));
        expect(await networksOf()).toEqual([network]);

        await mustRun(dockerRenameToPrevious(serviceId));
        await mustRun(dockerRemovePrevious(serviceId));
        const left = await s().exec(['docker', 'inspect', '--type', 'container', '--', previous]);
        expect(left.exitCode).not.toBe(0);
      });

      it('H2: the response-body canary never reached any probe or template output', () => {
        expect(transcript.join('\n')).not.toContain(bodyCanary);
      });
    });

    describe('18-03: deploy the exact pushed SHA when the branch moved past it', () => {
      let session: SshDeploySession | undefined;
      const redactor = createRedactor();
      const requested: Partial<Record<keyof typeof SHA_REPOS, string>> = {};

      const moveBranch = async (repo: keyof typeof SHA_REPOS, mode: 'moved' | 'forced', allow: boolean) => {
        const result = await s().exec(['sh', '-c', MOVE_BRANCH, SHA_REPOS[repo], mode, allow ? '1' : '0'], {
          user: 'git',
        });
        expect(result.exitCode, result.stderr).toBe(0);
        requested[repo] = result.stdout.trim().split('\n').at(-1) ?? '';
      };
      const shaOf = (repo: keyof typeof SHA_REPOS) => valid(validateCommitSha(requested[repo] ?? ''));
      const deployerGit = async (ws: DeployWorkspace, args: readonly string[]): Promise<string> => {
        const result = await s().exec(['git', '-C', ws.repo, ...args], { user: 'deployer' });
        expect(result.exitCode, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      const cloneAt = async (ws: DeployWorkspace, repo: keyof typeof SHA_REPOS, chunks: string[]) => {
        if (session === undefined) throw new Error('session not connected');
        const source = valid(
          validateServiceSource({ kind: 'git', repositoryUrl: s().gitRepoUrl(SHA_REPOS[repo]), branch: 'main' }),
        );
        if (source.kind !== 'git') throw new Error('expected a git source');
        return cloneRepository({
          session,
          redactor,
          workspace: ws,
          source,
          credential: { kind: 'deploy_key', privateKey: secretValue(s().deployKey.privateKey, 'ssh_private_key') },
          pinnedHostKeys: [await fixtureGitHostKey(s())],
          requestedSha: shaOf(repo),
          limits: CLONE_LIMITS,
          onChunk: (chunk) => {
            transcript.push(chunk.text);
            chunks.push(chunk.text);
          },
        });
      };

      beforeAll(async () => {
        await moveBranch('direct', 'moved', true);
        await moveBranch('fallback', 'moved', false);
        await moveBranch('forced', 'forced', true);
        const outcome = await createSsh2Adapter().connect({
          target: { host: s().ssh.host, port: s().ssh.port, user: s().ssh.user },
          credential: { kind: 'private_key', privateKey: secretValue(s().ssh.privateKey, 'ssh_private_key') },
          timeouts: { connectMs: 20_000, commandMs: 60_000, discoveryMs: 120_000 },
          trustedFingerprint: null,
          redactor,
        });
        if (!outcome.ok) throw new Error(`connect failed: ${outcome.errorCode}`);
        session = outcome.session;
      }, STACK_TIMEOUT_MS);

      afterAll(async () => {
        await session?.close();
      });

      it('A1/A3: fetches the requested SHA shallowly by SHA and records exactly it', async () => {
        await withWorkspace(async (ws) => {
          const chunks: string[] = [];
          const result = await cloneAt(ws, 'direct', chunks);

          expect(result, chunks.join('')).toMatchObject({ ok: true, value: { commitSha: requested.direct } });
          expect(await deployerGit(ws, ['rev-parse', 'HEAD'])).toBe(requested.direct);
          // Fetched by SHA, never deepened: the clone is still shallow.
          expect(await deployerGit(ws, ['rev-parse', '--is-shallow-repository'])).toBe('true');
        });
      }, SSH_COMMAND_TIMEOUT_MS);

      it('H1: a server that refuses unadvertised objects falls back to deepening the branch', async () => {
        await withWorkspace(async (ws) => {
          // The template alone, against the real bare repo: the server refuses the want.
          await mustRun(await cloneCommand(ws, SHA_REPOS.fallback, [await fixtureGitHostKey(s())]));
          const auth = {
            kind: 'deploy_key',
            keyFile: ws.secretFile('deploy_key'),
            knownHostsFile: ws.secretFile('known_hosts'),
          } as const;
          const refused = await run(gitFetch({ repo: ws.repo, auth, mode: { kind: 'commit', sha: shaOf('fallback') } }));
          // git exits 1 ("error: Server does not allow request...") or 128 depending on the protocol
          // version; callers classify stderr, never the code (ADR 0008 G1).
          expect(refused.exitCode, refused.stderr).not.toBe(0);
          expect(refused.stderr).toMatch(/unadvertised object|not our ref/);
          expect(
            classifyGitError(
              {
                kind: 'command',
                operation: 'clone',
                failure: { exitCode: refused.exitCode, stderr: refused.stderr, stdoutTail: refused.stdout },
              },
              { redactor: createRedactor() },
            ).code,
          ).toBe('CLONE_FAILED');
        });

        await withWorkspace(async (ws) => {
          const chunks: string[] = [];
          const result = await cloneAt(ws, 'fallback', chunks);

          expect(result, chunks.join('')).toMatchObject({ ok: true, value: { commitSha: requested.fallback } });
          expect(await deployerGit(ws, ['rev-parse', 'HEAD'])).toBe(requested.fallback);
          expect(await deployerGit(ws, ['rev-parse', '--is-shallow-repository'])).toBe('false');
        });
      }, SSH_COMMAND_TIMEOUT_MS);

      it('A2: a SHA force-pushed away from the remote ends COMMIT_NOT_FOUND with the actionable message', async () => {
        await withWorkspace(async (ws) => {
          const chunks: string[] = [];
          const result = await cloneAt(ws, 'forced', chunks);

          expect(result, chunks.join('')).toEqual({
            ok: false,
            kind: 'failed',
            code: 'COMMIT_NOT_FOUND',
            message: V03_DEPLOYMENT_ERROR_MESSAGES.COMMIT_NOT_FOUND,
          });
          expect(await deployerGit(ws, ['rev-parse', 'HEAD'])).not.toBe(requested.forced);
        });
      }, SSH_COMMAND_TIMEOUT_MS);
    });

    // Runs last: the transcript then holds every command line and output of this suite.
    it('SEC canary: no secret ever appears in a command line or in any streamed output', () => {
      const keyBody = s()
        .deployKey.privateKey.split('\n')
        .filter((line) => line !== '' && !line.startsWith('-----'));
      const secrets = [tokenCanary, fileCanary, s().registry.password, ...keyBody];
      const joined = transcript.join('\n');

      expect(transcript.length).toBeGreaterThan(50);
      expect(keyBody.length).toBeGreaterThan(0);
      for (const secret of secrets) {
        expect(joined.includes(secret), 'a secret leaked into argv or output').toBe(false);
      }
    });
  },
);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
