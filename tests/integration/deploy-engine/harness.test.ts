// Smoke proof of the deploy-engine fixture stack (11-03-PLAN.md Task 2): one helper call yields a
// real deploy host (sshd + install.sh's Docker), a bare Git host served over SSH with a per-run
// deploy key, the D-10 htpasswd registry and the G7 base-image mirror, all torn down afterwards.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@noodara/ssh/testing';
import type { ClientChannel } from '@noodara/ssh/testing';
import {
  DEPLOY_ENGINE_UBUNTU_VERSIONS,
  MIRROR_ALIAS,
  startDeployEngineStack,
  type DeployEngineStack,
} from '../helpers/deploy-engine.js';
import { generateDeployKeyPair } from '../helpers/deploy-keys.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE_API_FIXTURE = path.resolve(HERE, '../../../fixtures/node-api');
const STACK_TIMEOUT_MS = 900_000;
const SSH_COMMAND_TIMEOUT_MS = 180_000;
const DEPLOY_KEY_PATH = '/home/deployer/.ssh/noodara_deploy_key';
const UNAUTHORIZED_KEY_PATH = '/home/deployer/.ssh/noodara_unauthorized_key';

interface SshResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** One command over a fresh ssh2 connection as deployer; `stdin` is written then closed. */
function sshExec(stack: DeployEngineStack, command: string, stdin?: string): Promise<SshResult> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const timer = setTimeout(() => {
      client.end();
      reject(new Error(`sshExec timed out after ${String(SSH_COMMAND_TIMEOUT_MS)}ms`));
    }, SSH_COMMAND_TIMEOUT_MS);
    client.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    client.on('ready', () => {
      client.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err !== undefined) {
          clearTimeout(timer);
          client.end();
          reject(err);
          return;
        }
        let stdout = '';
        let stderr = '';
        stream.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        stream.on('close', (code: number | null) => {
          clearTimeout(timer);
          client.end();
          resolve({ exitCode: code ?? -1, stdout, stderr });
        });
        if (stdin !== undefined) stream.write(stdin);
        stream.end();
      });
    });
    client.connect({
      host: stack.ssh.host,
      port: stack.ssh.port,
      username: stack.ssh.user,
      privateKey: stack.ssh.privateKey,
      readyTimeout: 20_000,
    });
  });
}

async function writeDeployerFile(
  stack: DeployEngineStack,
  target: string,
  content: string,
): Promise<void> {
  const result = await stack.exec(['sh', '-c', 'umask 077 && cat > "$1"', 'sh', target], {
    user: 'deployer',
    stdin: content,
  });
  expect(result.exitCode).toBe(0);
}

function lsRemote(stack: DeployEngineStack, keyPath: string, name: string): Promise<SshResult> {
  return sshExec(
    stack,
    `GIT_SSH_COMMAND='ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes' git ls-remote ${stack.gitRepoUrl(name)}`,
  );
}

function strayNetworks(): string {
  return execFileSync('docker', ['network', 'ls', '-q', '--filter', 'label=noodara.test=true'], {
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();
}

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('deploy-engine harness on Ubuntu %s', (ubuntu) => {
  let stack: DeployEngineStack | undefined;
  let inlineSourceDir: string | undefined;

  const current = (): DeployEngineStack => {
    if (stack === undefined) throw new Error('stack not started');
    return stack;
  };

  beforeAll(async () => {
    let sourceDir = NODE_API_FIXTURE;
    if (!existsSync(NODE_API_FIXTURE)) {
      inlineSourceDir = mkdtempSync(path.join(tmpdir(), 'noodara-harness-src-'));
      writeFileSync(path.join(inlineSourceDir, 'README.md'), '# harness seed\n');
      sourceDir = inlineSourceDir;
    }
    stack = await startDeployEngineStack({
      ubuntu,
      seedRepositories: [
        { name: 'node-api', sourceDir },
        { name: 'edge-cases', sourceDir, withGitmodules: true, withLfsPointer: true },
      ],
    });
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    await stack?.stop();
    if (inlineSourceDir !== undefined) rmSync(inlineSourceDir, { recursive: true, force: true });
    await assertNoStrayTestContainers();
    expect(strayNetworks()).toBe('');
  }, STACK_TIMEOUT_MS);

  it('reaches the real dockerd over SSH as deployer', async () => {
    const result = await sshExec(current(), "docker info --format '{{json .ServerVersion}}'");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^"\d+\.\d+/);
  });

  it('serves the seeded bare repository over SSH to the per-run deploy key', async () => {
    const s = current();
    await writeDeployerFile(s, DEPLOY_KEY_PATH, s.deployKey.privateKey);

    try {
      const result = await lsRemote(s, DEPLOY_KEY_PATH, 'node-api');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^[0-9a-f]{40}\trefs\/heads\/main$/m);
    } finally {
      await s.exec(['rm', '-f', DEPLOY_KEY_PATH]);
    }
  });

  it('refuses a key that is not the deploy key', async () => {
    const s = current();
    const unauthorized = await generateDeployKeyPair('noodara-test-unauthorized');
    await writeDeployerFile(s, UNAUTHORIZED_KEY_PATH, unauthorized.privateKey);

    try {
      const result = await lsRemote(s, UNAUTHORIZED_KEY_PATH, 'node-api');

      expect(result.exitCode).toBe(128);
    } finally {
      await s.exec(['rm', '-f', UNAUTHORIZED_KEY_PATH]);
    }
  });

  it('seeds a gitlink and an LFS pointer when asked', async () => {
    const result = await current().exec(
      ['git', '-C', '/srv/git/edge-cases.git', 'ls-tree', '-r', 'main'],
      {
        user: 'git',
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^160000 commit [0-9a-f]{40}\tvendor\/sub$/m);
    expect(result.stdout).toMatch(/\t\.gitmodules$/m);
    expect(result.stdout).toMatch(/\tblob\.bin$/m);
  });

  it('logs in to the htpasswd registry with --password-stdin and pulls a preloaded base', async () => {
    const s = current();
    const [preloaded] = s.baseImages
      .map((ref) => ref.split('@')[0] ?? ref)
      .map((ref) => `${s.registry.host}/fixtures/${ref}`);
    expect(preloaded).toBeDefined();
    const image = preloaded ?? '';

    const login = await sshExec(
      s,
      `docker login ${s.registry.host} --username ${s.registry.username} --password-stdin`,
      `${s.registry.password}\n`,
    );
    expect(login.exitCode).toBe(0);
    expect(login.stdout + login.stderr).not.toContain(s.registry.password);

    const pull = await sshExec(
      s,
      `docker image rm -f ${image} >/dev/null 2>&1; docker pull ${image}`,
    );
    expect(pull.exitCode).toBe(0);

    const logout = await sshExec(s, `docker logout ${s.registry.host}`);
    expect(logout.exitCode).toBe(0);
    const denied = await sshExec(
      s,
      `docker image rm -f ${image} >/dev/null 2>&1; docker pull ${image}`,
    );
    expect(denied.exitCode).not.toBe(0);
  });

  it('resolves every digest-pinned base image through the mirror', async () => {
    const s = current();
    expect(s.baseImages.length).toBeGreaterThan(0);

    for (const ref of s.baseImages) {
      expect(ref).toMatch(/@sha256:[0-9a-f]{64}$/);
      const inspect = await sshExec(s, `docker image inspect --format '{{.Id}}' ${ref}`);
      expect(inspect.exitCode).toBe(0);
    }
    const catalog = await sshExec(s, `curl -fsS http://${MIRROR_ALIAS}:5000/v2/_catalog`);
    expect(catalog.exitCode).toBe(0);
    for (const ref of s.baseImages) {
      const repository = (ref.split('@')[0] ?? ref).split(':')[0] ?? ref;
      expect(catalog.stdout).toContain(`library/${repository}`);
    }
  });
});
