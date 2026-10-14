// 14-30 (Human UAT finding 3, A1/A2): a deploy over SSH as a non-root user that is in the `docker`
// group but has no sudo works without host setup, because the workspace lives under that user's
// home (`.noodara/deploy/<deploymentId>`). A workspace that cannot be created fails
// WORKSPACE_UNAVAILABLE (not CLONE_FAILED) on the real mkdir stderr. The user is created at runtime
// as root, so the shared fixture image keeps its deployer/restricted contract untouched.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transitionDeployment, type DeploymentStatus } from '@noodara/domain/deployment';
import { createRedactor, secretValue } from '@noodara/domain/security';
import {
  deployWorkspaceFor,
  validateContainerPort,
  validateResourceId,
  validateServiceSource,
  type DeployWorkspace,
  type GitHostKey,
  type ResourceId,
  type ServiceSource,
  type ValidationResult,
} from '@noodara/domain/validators';
import { createSsh2Adapter, type SshDeploySession } from '@noodara/ssh';
import { cloneRepository } from '@noodara/git';
import {
  buildImage,
  createContainer,
  ensureNetwork,
  inspectContainerState,
  removeContainer,
  removeImage,
  removeNetwork,
  removeWorkspace,
  startContainer,
  stopContainer,
  type DockerStepContext,
  type StepLimits,
  type StepResult,
} from '@noodara/docker';
import {
  DEPLOY_ENGINE_UBUNTU_VERSIONS,
  startDeployEngineStack,
  type DeployEngineStack,
} from '../helpers/deploy-engine.js';
import { fixtureGitHostKey } from '../helpers/git-host-key.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, '../../../fixtures');
const STACK_TIMEOUT_MS = 900_000;
const STEP_TEST_TIMEOUT_MS = 300_000;
const REPO = 'node-api';
const USER = 'builder';
const USER_HOME = `/home/${USER}`;
const WORKSPACE_BASE = `${USER_HOME}/.noodara/deploy`;
const PUBLISHED_PORT = 13_140;
const INTERNAL_PORT = 3_000;
const INSPECT_ATTEMPTS = 5;
const INSPECT_BACKOFF_MS = 1_000;

const LIMITS: StepLimits = {
  maxDurationMs: 240_000,
  idleTimeoutMs: 120_000,
  maxTotalBytes: 1_048_576,
  maxLineBytes: 16_384,
};

/** A docker-group user with no sudoers entry, reachable with deployer's login key. */
const CREATE_USER = `set -eu
useradd -m -s /bin/bash -G docker "$0"
usermod -p '*' "$0"
mkdir -p "/home/$0/.ssh"
cp /home/deployer/.ssh/authorized_keys "/home/$0/.ssh/authorized_keys"
chmod 0700 "/home/$0/.ssh"
chmod 0600 "/home/$0/.ssh/authorized_keys"
chown -R "$0:$0" "/home/$0/.ssh"`;

/** RFC 9562 UUIDv7 (the resource-id format the control plane issues). */
function uuidv7(): string {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function valid<T>(result: ValidationResult<T>): T {
  if (!result.ok) throw new Error(`fixture failed validation: ${result.code}`);
  return result.value;
}

function expectOk<T>(label: string, step: StepResult<T>): T {
  if (!step.ok) {
    const detail = step.kind === 'failed' ? `${step.code}: ${step.message}` : step.outcome;
    throw new Error(`${label} did not succeed (${detail})`);
  }
  return step.value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class DeploymentRun {
  status: DeploymentStatus = 'QUEUED';
  readonly id: ResourceId = valid(validateResourceId(uuidv7()));
  readonly workspace: DeployWorkspace = valid(deployWorkspaceFor(this.id));

  to(next: DeploymentStatus): void {
    this.status = transitionDeployment(this.status, next);
  }
}

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)(
  '14-30 A1/A2: deploy as a non-root docker-group SSH user without sudo, Ubuntu %s',
  (ubuntu) => {
    let stack: DeployEngineStack | undefined;
    let session: SshDeploySession | undefined;
    let hostKey: GitHostKey | undefined;
    const redactor = createRedactor();
    const serviceId = valid(validateResourceId(uuidv7()));

    const s = (): DeployEngineStack => {
      if (stack === undefined) throw new Error('stack not started');
      return stack;
    };
    const sess = (): SshDeploySession => {
      if (session === undefined) throw new Error('session not connected');
      return session;
    };
    const ctx = (): DockerStepContext => ({ session: sess(), redactor, limits: LIMITS });
    const root = (argv: readonly string[]) => s().exec(argv, { user: 'root' });
    const exists = async (target: string): Promise<boolean> =>
      (await root(['test', '-e', target])).exitCode === 0;
    const gitSource = (): Extract<ServiceSource, { kind: 'git' }> => {
      const source = valid(
        validateServiceSource({ kind: 'git', repositoryUrl: s().gitRepoUrl(REPO), branch: 'main' }),
      );
      if (source.kind !== 'git') throw new Error('expected a git source');
      return source;
    };
    const clone = (run: DeploymentRun) => {
      if (hostKey === undefined) throw new Error('fixture host key not read');
      return cloneRepository({
        session: sess(),
        redactor,
        workspace: run.workspace,
        source: gitSource(),
        credential: {
          kind: 'deploy_key',
          privateKey: secretValue(s().deployKey.privateKey, 'ssh_private_key'),
        },
        pinnedHostKeys: [hostKey],
        limits: LIMITS,
      });
    };

    beforeAll(async () => {
      stack = await startDeployEngineStack({
        ubuntu,
        seedRepositories: [{ name: REPO, sourceDir: path.join(FIXTURES_DIR, 'node-api') }],
      });
      hostKey = await fixtureGitHostKey(stack);
      const created = await stack.exec(['sh', '-c', CREATE_USER, USER], { user: 'root' });
      if (created.exitCode !== 0) throw new Error(`creating ${USER} failed: ${created.stderr}`);
      const outcome = await createSsh2Adapter().connect({
        target: { host: stack.ssh.host, port: stack.ssh.port, user: USER },
        credential: {
          kind: 'private_key',
          privateKey: secretValue(stack.ssh.privateKey, 'ssh_private_key'),
        },
        timeouts: { connectMs: 20_000, commandMs: 60_000, discoveryMs: 120_000 },
        trustedFingerprint: null,
        redactor,
      });
      if (!outcome.ok) throw new Error(`connect as ${USER} failed: ${outcome.errorCode}`);
      session = outcome.session;
    }, STACK_TIMEOUT_MS);

    afterAll(async () => {
      await session?.close();
      await stack?.stop();
      await assertNoStrayTestContainers();
    }, STACK_TIMEOUT_MS);

    it(`${USER} is non-root, in the docker group, has no sudo, and no workspace root was pre-created`, async () => {
      const as = (argv: readonly string[]) => s().exec(argv, { user: USER });
      expect((await as(['id', '-u'])).stdout.trim()).not.toBe('0');
      expect((await as(['id', '-nG'])).stdout.trim().split(/\s+/)).toContain('docker');
      expect((await as(['sudo', '-n', 'true'])).exitCode).not.toBe(0);
      expect(await exists('/opt/noodara-deploy')).toBe(false);
      expect(await exists(`${USER_HOME}/.noodara`)).toBe(false);
    });

    it('a git deploy clones into ~/.noodara/deploy/<id>, builds, runs RUNNING and tears down', async () => {
      const run = new DeploymentRun();
      const absolute = `${USER_HOME}/${run.workspace.root}`;
      run.to('PREPARING');
      expectOk('clone', await clone(run));
      expect(run.workspace.root.startsWith('.noodara/deploy/')).toBe(true);
      expect((await root(['stat', '-c', '%U', `${absolute}/repo`])).stdout.trim()).toBe(USER);

      run.to('BUILDING');
      const image = expectOk(
        'build',
        await buildImage(ctx(), {
          workspace: run.workspace,
          source: gitSource(),
          serviceId,
          deploymentId: run.id,
        }),
      );

      run.to('DEPLOYING');
      expectOk('network', await ensureNetwork(ctx(), { serviceId }));
      expectOk(
        'create',
        await createContainer(ctx(), {
          serviceId,
          deploymentId: run.id,
          image,
          internalPort: valid(validateContainerPort(INTERNAL_PORT)),
          publishedPort: valid(validateContainerPort(PUBLISHED_PORT)),
        }),
      );
      expectOk('start', await startContainer(ctx(), { serviceId }));
      let running = false;
      for (let attempt = 0; attempt < INSPECT_ATTEMPTS && !running; attempt += 1) {
        if (attempt > 0) await delay(INSPECT_BACKOFF_MS);
        const state = expectOk('inspect', await inspectContainerState(ctx(), { serviceId }));
        running = state.kind === 'ok' && state.running;
      }
      expect(running).toBe(true);
      run.to('SUCCESS');

      expectOk('stop', await stopContainer(ctx(), { serviceId, timeoutSeconds: 10 }));
      expectOk('remove container', await removeContainer(ctx(), { serviceId }));
      expectOk('remove image', await removeImage(ctx(), { image }));
      expectOk('remove network', await removeNetwork(ctx(), { serviceId }));
      expectOk('remove workspace', await removeWorkspace(ctx(), { workspace: run.workspace }));
      expect(await exists(WORKSPACE_BASE)).toBe(true);
      expect(await exists(absolute)).toBe(false);
    }, STEP_TEST_TIMEOUT_MS);

    it.each([
      {
        label: '~/.noodara is a regular file',
        setup: `rm -rf "$0/.noodara" && touch "$0/.noodara" && chown ${USER}:${USER} "$0/.noodara"`,
      },
      {
        label: '~/.noodara is owned by root and not writable',
        setup: `rm -rf "$0/.noodara" && mkdir -m 0755 "$0/.noodara"`,
      },
    ])(
      'a workspace that cannot be created ($label) fails FAILED/WORKSPACE_UNAVAILABLE, not CLONE_FAILED',
      async ({ setup }) => {
        const broken = await root(['sh', '-c', setup, USER_HOME]);
        expect(broken.exitCode, broken.stderr).toBe(0);
        try {
          const run = new DeploymentRun();
          run.to('PREPARING');
          const step = await clone(run);
          expect(step.ok).toBe(false);
          if (step.ok || step.kind !== 'failed') throw new Error('expected a classified failure');
          expect(step.code).toBe('WORKSPACE_UNAVAILABLE');
          expect(step.message).toContain('~/.noodara/deploy');
          expect(step.message).not.toMatch(/repository URL|deploy key/i);
          run.to('FAILED');
          expect(run.status).toBe('FAILED');
        } finally {
          await root(['rm', '-rf', `${USER_HOME}/.noodara`]);
        }
      },
      STEP_TEST_TIMEOUT_MS,
    );
  },
);
