// 11-16: end-to-end composition proof of the Phase 11 primitives on the real sshd + dockerd fixture
// (ROADMAP Phase 11 goal, criteria 2-5; DEP-01, DEP-08, SVC-08, QA-07, QA-10; ADR 0008 wins over the
// plan). Every remote step goes through the public surface Phase 12's worker will use:
// createSsh2Adapter -> @noodara/git cloneRepository and @noodara/docker wrappers, with the status
// derived by @noodara/domain from the real `docker ps` output. Raw `stack.exec` is used only for
// root-side truth (rev-parse, inspect, history, ps sampling, curl). Measurements are numbers only.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_ERROR_CODES,
  deriveServiceStatus,
  toContainerObservation,
  transitionDeployment,
  type DeploymentStatus,
} from '@noodara/domain/deployment';
import { createRedactor, secretValue, type Redactor } from '@noodara/domain/security';
import {
  containerNameFor,
  deployWorkspaceFor,
  deploymentImageRefFor,
  networkNameFor,
  validateContainerPort,
  validateRegistryHost,
  validateRegistryUsername,
  validateResourceId,
  validateServiceSource,
  type DeployWorkspace,
  type ImageRef,
  type ResourceId,
  type ServiceSource,
  type ValidationResult,
} from '@noodara/domain/validators';
import { createSsh2Adapter, type SshDeploySession, type StreamChunk } from '@noodara/ssh';
// Relative source imports: the root package.json (outside this task's scope) does not declare
// @noodara/git / @noodara/docker, so a bare specifier would not typecheck under
// tests/integration/deploy-engine/tsconfig.json. Vitest resolves the same source files either way.
import { cloneRepository, type GitCredential } from '../../../packages/git/src/index.js';
import {
  buildImage,
  createContainer,
  ensureNetwork,
  inspectContainerState,
  listManagedContainers,
  pullImage,
  removeContainer,
  removeImage,
  removeNetwork,
  removeWorkspace,
  startContainer,
  stopContainer,
  type DockerStepContext,
  type StepLimits,
  type StepResult,
} from '../../../packages/docker/src/index.js';
import {
  DEPLOY_ENGINE_UBUNTU_VERSIONS,
  preloadedRefFor,
  startDeployEngineStack,
  type DeployEngineStack,
} from '../helpers/deploy-engine.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, '../../../fixtures');
const STACK_TIMEOUT_MS = 900_000;
const STEP_TEST_TIMEOUT_MS = 300_000;
const WORKSPACE_ROOT = '/opt/noodara-deploy';
const PUBLISHED_PORT = 13_100;
const INTERNAL_PORT = 3_000;
const INSPECT_ATTEMPTS = 5;
const INSPECT_BACKOFF_MS = 1_000;
const HEALTH_ATTEMPTS = 40;
const HEALTH_INTERVAL_MS = 250;
const SAMPLER_TIMEOUT_MS = 300_000;
/** Raw output lines shorter than this are too generic to prove a message echoed stderr. */
const MIN_RAW_LINE_LENGTH = 16;

const LIMITS: StepLimits = {
  maxDurationMs: 240_000,
  idleTimeoutMs: 120_000,
  maxTotalBytes: 1_048_576,
  maxLineBytes: 16_384,
};

const REPOS = {
  nodeApi: 'node-api',
  failingBuild: 'failing-build',
  lfs: 'node-api-lfs',
  submodule: 'node-api-submodule',
} as const;

/** RFC 9562 UUIDv7 from crypto.randomBytes (the resource-id format the control plane issues). */
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

function freshId(): ResourceId {
  return valid(validateResourceId(uuidv7()));
}

/** Messages are the closed, redacted vocabulary, so they are safe in an assertion message. */
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

/** Numbers only. NOODARA_MEASUREMENTS_FILE collects the SUMMARY numbers (11-08/11-14 convention). */
function measure(ubuntu: string, data: Record<string, number | string>): void {
  const line = `[11-16] ${JSON.stringify({ ubuntu, ...data })}`;
  console.log(line);
  const file = process.env['NOODARA_MEASUREMENTS_FILE'];
  if (file !== undefined && file !== '') appendFileSync(file, `${line}\n`);
}

async function timed<T>(timings: Record<string, number>, key: string, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await run();
  } finally {
    timings[key] = Date.now() - startedAt;
  }
}

/** A deployment walking the DEP-01 state machine as each primitive completes. */
class DeploymentRun {
  status: DeploymentStatus = 'QUEUED';
  readonly id: ResourceId = freshId();
  readonly workspace: DeployWorkspace = valid(deployWorkspaceFor(this.id));

  to(next: DeploymentStatus): void {
    this.status = transitionDeployment(this.status, next);
  }
}

/**
 * Samples argv (`ps -eww -o args`) and every /proc/<pid>/cmdline and environ as root, every ~20 ms,
 * while `body` runs. Returns the de-duplicated sample text for the canary scan.
 */
const SAMPLER_SCRIPT = `stop=$1; out=$2
umask 077
: > "$out"
while [ ! -e "$stop" ]; do
  ps -eww -o args= >> "$out" 2>/dev/null
  for p in /proc/[0-9]*; do
    cat "$p/cmdline" >> "$out" 2>/dev/null; printf '\\n' >> "$out"
    cat "$p/environ" >> "$out" 2>/dev/null; printf '\\n' >> "$out"
  done
  sleep 0.02
done
`;

async function sampleProcessesDuring<T>(
  stack: DeployEngineStack,
  body: () => Promise<T>,
): Promise<{ value: T; samples: string }> {
  const tag = randomUUID();
  const stop = `/tmp/noodara-sampler-stop-${tag}`;
  const out = `/tmp/noodara-sampler-out-${tag}`;
  const sampling = stack.exec(['sh', '-c', SAMPLER_SCRIPT, 'sh', stop, out], {
    user: 'root',
    timeoutMs: SAMPLER_TIMEOUT_MS,
  });
  try {
    for (let i = 0; i < 100; i += 1) {
      const started = await stack.exec(['test', '-s', out], { user: 'root' });
      if (started.exitCode === 0) break;
      await delay(50);
    }
    const value = await body();
    await stack.exec(['touch', stop], { user: 'root' });
    await sampling;
    const read = await stack.exec(['sh', '-c', 'tr "\\000" " " < "$0" | sort -u', out], {
      user: 'root',
    });
    return { value, samples: read.stdout };
  } finally {
    await stack.exec(['touch', stop], { user: 'root' });
    await sampling.catch(() => undefined);
    await stack.exec(['rm', '-f', stop, out], { user: 'root' });
  }
}

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)(
  '11-16 / Phase 11 goal, criteria 2-5: deploy primitives compose on real infrastructure, Ubuntu %s',
  (ubuntu) => {
    let stack: DeployEngineStack | undefined;
    let session: SshDeploySession | undefined;
    const redactor: Redactor = createRedactor();
    /** Every chunk, tail and failure message any wrapper produced in this suite. */
    const transcript: string[] = [];
    /** Every root-side observation that must not contain a secret, by origin. */
    const observed: { readonly origin: string; readonly text: string }[] = [];
    const timings: Record<string, number> = {};

    const serviceId = freshId();
    const first = new DeploymentRun();
    let firstImage: ImageRef | undefined;
    let firstContainerId: string | undefined;
    let firstStartedAt: string | undefined;

    const s = (): DeployEngineStack => {
      if (stack === undefined) throw new Error('stack not started');
      return stack;
    };
    const sess = (): SshDeploySession => {
      if (session === undefined) throw new Error('session not connected');
      return session;
    };

    /** A wrapper context whose chunks land in the transcript and in `sink`. */
    const context = (sink?: StreamChunk[]): DockerStepContext => ({
      session: sess(),
      redactor,
      limits: LIMITS,
      onChunk: (chunk) => {
        transcript.push(chunk.text);
        sink?.push(chunk);
      },
    });
    const record = <T>(step: StepResult<T>): StepResult<T> => {
      if (step.ok) transcript.push(step.result.stdoutTail, step.result.stderrTail);
      else if (step.kind === 'failed') transcript.push(step.message);
      return step;
    };
    const rootOut = async (argv: readonly string[]): Promise<string> =>
      (await s().exec(argv, { user: 'root' })).stdout.trim();
    const rootOk = async (argv: readonly string[]): Promise<string> => {
      const result = await s().exec(argv, { user: 'root' });
      expect(result.exitCode, `${argv.slice(0, 3).join(' ')} exited non-zero`).toBe(0);
      return result.stdout;
    };
    const gitSource = (repo: string): Extract<ServiceSource, { kind: 'git' }> => {
      const source = valid(
        validateServiceSource({ kind: 'git', repositoryUrl: s().gitRepoUrl(repo), branch: 'main' }),
      );
      if (source.kind !== 'git') throw new Error('expected a git source');
      return source;
    };
    const deployKey = (): GitCredential => ({
      kind: 'deploy_key',
      privateKey: secretValue(s().deployKey.privateKey, 'ssh_private_key'),
    });
    const clone = (run: DeploymentRun, repo: string, sink?: StreamChunk[]) =>
      cloneRepository({
        session: sess(),
        redactor,
        workspace: run.workspace,
        source: gitSource(repo),
        credential: deployKey(),
        limits: LIMITS,
        onChunk: (chunk) => {
          transcript.push(chunk.text);
          sink?.push(chunk);
        },
      }).then(record);
    const pathGone = async (target: string): Promise<boolean> =>
      (await rootOut(['sh', '-c', 'test -e "$0" && echo present || echo gone', target])) === 'gone';

    /** Closed vocabulary, expected code, and no raw output line echoed into the message. */
    const expectCuratedFailure = (
      step: StepResult<unknown>,
      code: (typeof DEPLOYMENT_ERROR_CODES)[number],
      chunks: readonly StreamChunk[],
    ): string => {
      expect(step.ok).toBe(false);
      if (step.ok || step.kind !== 'failed') throw new Error('expected a classified failure');
      expect(step.code).toBe(code);
      expect(DEPLOYMENT_ERROR_CODES).toContain(step.code);
      const rawLines = chunks
        .flatMap((chunk) => chunk.text.split('\n'))
        .map((line) => line.trim())
        .filter((line) => line.length >= MIN_RAW_LINE_LENGTH);
      for (const line of rawLines) expect(step.message).not.toContain(line);
      return step.message;
    };

    beforeAll(async () => {
      stack = await startDeployEngineStack({
        ubuntu,
        seedRepositories: [
          { name: REPOS.nodeApi, sourceDir: path.join(FIXTURES_DIR, 'node-api') },
          { name: REPOS.failingBuild, sourceDir: path.join(FIXTURES_DIR, 'failing-build') },
          { name: REPOS.lfs, sourceDir: path.join(FIXTURES_DIR, 'node-api'), withLfsPointer: true },
          {
            name: REPOS.submodule,
            sourceDir: path.join(FIXTURES_DIR, 'node-api'),
            withGitmodules: true,
          },
        ],
      });
      const outcome = await createSsh2Adapter().connect({
        target: { host: stack.ssh.host, port: stack.ssh.port, user: stack.ssh.user },
        credential: {
          kind: 'private_key',
          privateKey: secretValue(stack.ssh.privateKey, 'ssh_private_key'),
        },
        timeouts: { connectMs: 20_000, commandMs: 60_000, discoveryMs: 120_000 },
        trustedFingerprint: null,
        redactor,
      });
      if (!outcome.ok) throw new Error(`connect failed: ${outcome.errorCode}`);
      session = outcome.session;
    }, STACK_TIMEOUT_MS);

    afterAll(async () => {
      measure(ubuntu, timings);
      await session?.close();
      await stack?.stop();
      await assertNoStrayTestContainers();
      const networks = execFileSync(
        'docker',
        ['network', 'ls', '-q', '--filter', 'label=noodara.test=true'],
        { encoding: 'utf8', timeout: 60_000 },
      );
      expect(networks.trim()).toBe('');
    }, STACK_TIMEOUT_MS);

    it('happy path (Phase 11 goal, criteria 2-3, DEP-01): node-api clones with a per-run deploy key, builds noodara/<serviceId>:<deploymentId>, runs on its network and derives RUNNING', async () => {
      const sink: StreamChunk[] = [];
      const ctx = context(sink);
      const ws = first.workspace;
      const expectedSha = (
        await s().exec(['git', '-C', `/srv/git/${REPOS.nodeApi}.git`, 'rev-parse', 'main'], {
          user: 'git',
        })
      ).stdout.trim();

      first.to('PREPARING');
      const { value: cloned, samples } = await sampleProcessesDuring(s(), () =>
        timed(timings, 'cloneMs', () => clone(first, REPOS.nodeApi, sink)),
      );
      observed.push({ origin: 'ps/proc during clone', text: samples });
      // The sampler overlapped the clone: its argv (with the workspace path) was captured.
      expect(samples).toContain(ws.repo);
      expect(expectOk('clone', cloned).commitSha).toBe(expectedSha);
      observed.push({
        origin: '.git/config',
        text: await rootOk(['cat', `${ws.repo}/.git/config`]),
      });

      first.to('BUILDING');
      const image = expectOk(
        'build',
        record(
          await timed(timings, 'buildMs', () =>
            buildImage(ctx, { workspace: ws, source: gitSource(REPOS.nodeApi), serviceId, deploymentId: first.id }),
          ),
        ),
      );
      expect(image).toBe(valid(deploymentImageRefFor(serviceId, first.id)));
      expect(image).toBe(`noodara/${serviceId}:${first.id}`);
      firstImage = image;

      first.to('DEPLOYING');
      const network = expectOk(
        'network',
        record(await timed(timings, 'networkMs', () => ensureNetwork(ctx, { serviceId }))),
      );
      expect(network).toBe(valid(networkNameFor(serviceId)));
      expect(network).toBe(`noodara-net-${serviceId}`);
      const container = expectOk(
        'create',
        record(
          await timed(timings, 'createMs', () =>
            createContainer(ctx, {
              serviceId,
              deploymentId: first.id,
              image,
              internalPort: valid(validateContainerPort(INTERNAL_PORT)),
              publishedPort: valid(validateContainerPort(PUBLISHED_PORT)),
            }),
          ),
        ),
      );
      expect(container).toBe(`noodara-${serviceId}`);
      expectOk('start', record(await timed(timings, 'startMs', () => startContainer(ctx, { serviceId }))));

      const runningAt = Date.now();
      let running = false;
      for (let attempt = 0; attempt < INSPECT_ATTEMPTS && !running; attempt += 1) {
        if (attempt > 0) await delay(INSPECT_BACKOFF_MS);
        const state = expectOk('inspect', record(await inspectContainerState(ctx, { serviceId })));
        running = state.kind === 'ok' && state.running;
      }
      timings['inspectRunningMs'] = Date.now() - runningAt;
      expect(running).toBe(true);
      first.to('SUCCESS');

      const listed = expectOk('ps', record(await timed(timings, 'psMs', () => listManagedContainers(ctx))));
      if (listed.kind !== 'ok') throw new Error(`docker ps not ok: ${listed.kind}`);
      expect(listed.unparseableLines).toEqual([]);
      const observation = toContainerObservation(listed.containers, valid(containerNameFor(serviceId)));
      expect(observation).toEqual({ kind: 'running' });
      expect(deriveServiceStatus({ latestDeployment: { status: first.status }, container: observation })).toBe(
        'RUNNING',
      );
      const ours = listed.containers.find((c) => c.name === container);
      expect(ours?.labels['noodara.managed']).toBe('true');
      expect(ours?.labels['noodara.service_id']).toBe(serviceId);
      expect(ours?.labels['noodara.deployment_id']).toBe(first.id);
      firstContainerId = ours?.id;

      const healthAt = Date.now();
      let body = '';
      for (let attempt = 0; attempt < HEALTH_ATTEMPTS && body !== 'ok'; attempt += 1) {
        if (attempt > 0) await delay(HEALTH_INTERVAL_MS);
        body = await rootOut(['curl', '-fsS', `http://127.0.0.1:${String(PUBLISHED_PORT)}/health`]);
      }
      timings['healthyMs'] = Date.now() - healthAt;
      expect(body).toBe('ok');

      firstStartedAt = await rootOut(['docker', 'inspect', '--format', '{{.State.StartedAt}}', container]);
      observed.push({ origin: 'docker inspect', text: await rootOk(['docker', 'inspect', container]) });
      observed.push({
        origin: 'docker history',
        text: await rootOk(['docker', 'history', '--no-trunc', image]),
      });
      expect(first.status).toBe('SUCCESS');
    }, STEP_TEST_TIMEOUT_MS);

    it('DEP-08: a repository with a Git LFS pointer is rejected with UNSUPPORTED_REPOSITORY_FEATURE after the clone and its workspace is removable', async () => {
      const run = new DeploymentRun();
      const sink: StreamChunk[] = [];
      run.to('PREPARING');
      const step = await timed(timings, 'lfsRejectMs', () => clone(run, REPOS.lfs, sink));
      const message = expectCuratedFailure(step, 'UNSUPPORTED_REPOSITORY_FEATURE', sink);
      expect(message).toContain('Git LFS');
      run.to('FAILED');
      expectOk('remove workspace', record(await removeWorkspace(context(), { workspace: run.workspace })));
      expect(await pathGone(run.workspace.root)).toBe(true);
    }, STEP_TEST_TIMEOUT_MS);

    it('DEP-08: a repository with .gitmodules is rejected with UNSUPPORTED_REPOSITORY_FEATURE after the clone and its workspace is removable', async () => {
      const run = new DeploymentRun();
      const sink: StreamChunk[] = [];
      run.to('PREPARING');
      const step = await timed(timings, 'submoduleRejectMs', () => clone(run, REPOS.submodule, sink));
      const message = expectCuratedFailure(step, 'UNSUPPORTED_REPOSITORY_FEATURE', sink);
      expect(message).toContain('Git submodules');
      run.to('FAILED');
      expectOk('remove workspace', record(await removeWorkspace(context(), { workspace: run.workspace })));
      expect(await pathGone(run.workspace.root)).toBe(true);
    }, STEP_TEST_TIMEOUT_MS);

    it('D-09 / DEP-03 groundwork: failing-build gives BUILD_FAILED and leaves the running container and its image untouched', async () => {
      if (firstImage === undefined || firstContainerId === undefined) {
        throw new Error('happy path did not leave a running service');
      }
      const run = new DeploymentRun();
      const sink: StreamChunk[] = [];
      const ctx = context(sink);
      run.to('PREPARING');
      expectOk('clone failing-build', await clone(run, REPOS.failingBuild, sink));
      run.to('BUILDING');
      const step = record(
        await timed(timings, 'failingBuildMs', () =>
          buildImage(ctx, {
            workspace: run.workspace,
            source: gitSource(REPOS.failingBuild),
            serviceId,
            deploymentId: run.id,
          }),
        ),
      );
      const message = expectCuratedFailure(step, 'BUILD_FAILED', sink);
      expect(message).toContain('exit code 42');
      expect(message).not.toContain('NOODARA_FIXTURE_BUILD_FAILURE');
      run.to('FAILED');

      const container = valid(containerNameFor(serviceId));
      const state = expectOk('inspect', record(await inspectContainerState(ctx, { serviceId })));
      expect(state.kind === 'ok' && state.running).toBe(true);
      expect(await rootOut(['docker', 'inspect', '--format', '{{.Id}}', container])).toBe(firstContainerId);
      expect(await rootOut(['docker', 'inspect', '--format', '{{.State.StartedAt}}', container])).toBe(
        firstStartedAt,
      );
      expect((await s().exec(['docker', 'image', 'inspect', firstImage], { user: 'root' })).exitCode).toBe(0);
      const failedImage = valid(deploymentImageRefFor(serviceId, run.id));
      expect((await s().exec(['docker', 'image', 'inspect', failedImage], { user: 'root' })).exitCode).not.toBe(0);

      const listed = expectOk('ps', record(await listManagedContainers(ctx)));
      if (listed.kind !== 'ok') throw new Error(`docker ps not ok: ${listed.kind}`);
      const observation = toContainerObservation(listed.containers, container);
      // A failed attempt never replaces a running container: the service stays RUNNING.
      expect(deriveServiceStatus({ latestDeployment: { status: run.status }, container: observation })).toBe(
        'RUNNING',
      );

      expectOk('remove workspace', record(await removeWorkspace(ctx, { workspace: run.workspace })));
      expect(await pathGone(run.workspace.root)).toBe(true);
    }, STEP_TEST_TIMEOUT_MS);

    it('D-10 / G1: an image from the htpasswd registry pulls with its credential; a wrong password gives REGISTRY_AUTH_FAILED', async () => {
      const base = s().baseImages.find((ref) => ref.startsWith('node:')) ?? s().baseImages[0];
      if (base === undefined) throw new Error('harness preloaded no base image');
      const source = valid(
        validateServiceSource({ kind: 'image', imageRef: preloadedRefFor(s().registry.host, base) }),
      );
      if (source.kind !== 'image') throw new Error('expected an image source');
      const host = valid(validateRegistryHost(s().registry.host));
      const username = valid(validateRegistryUsername(s().registry.username));

      const good = new DeploymentRun();
      const goodSink: StreamChunk[] = [];
      good.to('PREPARING');
      const { value: pulled, samples } = await sampleProcessesDuring(s(), () =>
        timed(timings, 'registryPullMs', () =>
          pullImage(context(goodSink), {
            workspace: good.workspace,
            image: source.imageRef,
            registry: { host, username, password: secretValue(s().registry.password, 'api_key') },
          }).then(record),
        ),
      );
      observed.push({ origin: 'ps/proc during registry login', text: samples });
      expect(samples).toContain(good.workspace.dockerConfigDir);
      expect(expectOk('pull', pulled)).toBe(source.imageRef);
      expect((await s().exec(['docker', 'image', 'inspect', source.imageRef], { user: 'root' })).exitCode).toBe(0);
      expectOk('remove pulled image', record(await removeImage(context(), { image: source.imageRef })));
      expectOk('remove workspace', record(await removeWorkspace(context(), { workspace: good.workspace })));
      expect(await pathGone(good.workspace.root)).toBe(true);

      const bad = new DeploymentRun();
      const badSink: StreamChunk[] = [];
      const wrongPassword = randomBytes(24).toString('base64url');
      bad.to('PREPARING');
      const rejected = await timed(timings, 'registryRejectMs', () =>
        pullImage(context(badSink), {
          workspace: bad.workspace,
          image: source.imageRef,
          registry: { host, username, password: secretValue(wrongPassword, 'api_key') },
        }).then(record),
      );
      const message = expectCuratedFailure(rejected, 'REGISTRY_AUTH_FAILED', badSink);
      expect(message).not.toMatch(/401|unauthorized/i);
      expect(transcript.join('\n')).not.toContain(wrongPassword);
      bad.to('FAILED');
      expectOk('remove workspace', record(await removeWorkspace(context(), { workspace: bad.workspace })));
      expect(await pathGone(bad.workspace.root)).toBe(true);
    }, STEP_TEST_TIMEOUT_MS);

    it('SEC / T-11-46: deploy key, registry password and login key are absent from ps/proc samples, .git/config, docker inspect, docker history and every StreamChunk', () => {
      const { deployKey: key, registry, ssh } = s();
      const pemLines = (pem: string): string[] =>
        pem
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length >= MIN_RAW_LINE_LENGTH && !line.startsWith('-----'));
      const canaries = [
        ...pemLines(key.privateKey),
        ...pemLines(ssh.privateKey),
        registry.password,
        Buffer.from(`${registry.username}:${registry.password}`).toString('base64'),
      ];
      expect(canaries.length).toBeGreaterThan(4);
      const origins = observed.map((entry) => entry.origin);
      expect(origins).toEqual(
        expect.arrayContaining([
          'ps/proc during clone',
          'ps/proc during registry login',
          '.git/config',
          'docker inspect',
          'docker history',
        ]),
      );
      const all = [...observed, { origin: 'stream chunks, tails and messages', text: transcript.join('\n') }];
      for (const { origin, text } of all) {
        expect(text.length, `${origin} was empty`).toBeGreaterThan(0);
        for (const canary of canaries) {
          expect(text.includes(canary), `a secret leaked into ${origin}`).toBe(false);
        }
      }
    });

    it('happy path teardown (D-14, T-11-48): the wrappers leave no noodara.managed container, network or image and no /opt/noodara-deploy/<id>', async () => {
      if (firstImage === undefined) throw new Error('happy path did not build an image');
      const ctx = context();
      const teardownAt = Date.now();
      expectOk('stop', record(await stopContainer(ctx, { serviceId, timeoutSeconds: 10 })));
      expectOk('remove container', record(await removeContainer(ctx, { serviceId })));
      expectOk('remove image', record(await removeImage(ctx, { image: firstImage })));
      expectOk('remove network', record(await removeNetwork(ctx, { serviceId })));
      expectOk('remove workspace', record(await removeWorkspace(ctx, { workspace: first.workspace })));
      timings['teardownMs'] = Date.now() - teardownAt;

      const listed = expectOk('ps', record(await listManagedContainers(ctx)));
      if (listed.kind !== 'ok') throw new Error(`docker ps not ok: ${listed.kind}`);
      expect(listed.containers).toEqual([]);
      expect(
        deriveServiceStatus({
          latestDeployment: { status: first.status },
          container: toContainerObservation(listed.containers, valid(containerNameFor(serviceId))),
        }),
      ).toBe('STOPPED');

      for (const label of ['noodara.managed=true', 'noodara.test=true']) {
        expect(await rootOut(['docker', 'ps', '-aq', '--filter', `label=${label}`])).toBe('');
        expect(await rootOut(['docker', 'network', 'ls', '-q', '--filter', `label=${label}`])).toBe('');
        expect(await rootOut(['docker', 'images', '-q', '--filter', `label=${label}`])).toBe('');
      }
      expect(await rootOut(['find', WORKSPACE_ROOT, '-mindepth', '1', '-maxdepth', '1'])).toBe('');
      expect(await pathGone(first.workspace.root)).toBe(true);
    }, STEP_TEST_TIMEOUT_MS);
  },
);
