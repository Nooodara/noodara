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
  dockerImageRemove,
  dockerInspectState,
  dockerLogin,
  dockerLogout,
  dockerLogs,
  dockerNetworkCreate,
  dockerNetworkRemove,
  dockerPs,
  dockerPull,
  dockerRemove,
  dockerRestart,
  dockerStart,
  dockerStop,
  gitCheckout,
  gitClone,
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
  writeSecretFile,
  ASKPASS_SCRIPT_CONTENT,
  type RemoteCommand,
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
  type DeployWorkspace,
  type GitHostKey,
  type ValidationResult,
} from '@noodara/domain/validators';
import { createRedactor } from '@noodara/domain/security';
import { classifyGitError } from '@noodara/ssh';
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
