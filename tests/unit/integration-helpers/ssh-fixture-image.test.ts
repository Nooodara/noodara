// 36-04: wiring of the content-addressed fixture image module into the SSH helper (ssh.ts).
// Docker, testcontainers and the module's real `docker pull` runner are faked: a stateful image
// store (tag -> identity label + platform), labelled containers/networks/volumes and held gates.
// Covers the default image modes, the opt-in registry pull (A2/H3), cancellation and late-image
// reaping (A3), and the separation of cached images from per-test resources (H7).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeImage { readonly label: string | null; readonly os: string; readonly architecture: string }

const mock = vi.hoisted(() => ({
  gate: async (_stage: string): Promise<void> => undefined,
  /** name -> labels. A container's name doubles as its id. */
  containers: new Map<string, Record<string, string>>(),
  networks: new Map<string, Record<string, string>>(),
  volumes: new Map<string, Record<string, string>>(),
  images: new Map<string, { readonly label: string | null; readonly os: string; readonly architecture: string }>(),
  builds: [] as { readonly dockerfile: string; readonly args: Record<string, string>; readonly tag: string }[],
  started: [] as string[],
  calls: [] as string[][],
  /** What `docker build` stamps as the identity label (null = a Dockerfile without the LABEL). */
  buildLabel: (args: Record<string, string>): string | null => args['NOODARA_FIXTURE_IDENTITY'] ?? null,
  pull: vi.fn<(args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal | undefined }) => Promise<string>>(),
  docker: async (_args: readonly string[]): Promise<string> => '',
}));

vi.mock('../../integration/helpers/test-resources.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../integration/helpers/test-resources.js')>();
  const docker = (args: readonly string[]) => mock.docker(args);
  return {
    ...actual,
    dockerCli: docker,
    reapOwnedSshContainers: (owner: string) => actual.reapOwnedSshContainers(owner, docker),
    listOwnedSshResources: (owner: string) => actual.listOwnedSshResources(owner, docker),
  };
});
vi.mock('../../integration/helpers/fixture-image.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../integration/helpers/fixture-image.js')>();
  return { ...actual, runDockerCli: (args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal }) => mock.pull(args, options) };
});
vi.mock('testcontainers', () => {
  class Container {
    labels: Record<string, string> = {};
    name = '';
    constructor(readonly image: string) {}
    static fromDockerfile(_context: string, dockerfile: string) {
      return {
        withBuildArgs: (args: Record<string, string>) => ({
          build: async (tag: string) => {
            mock.builds.push({ dockerfile, args: { ...args }, tag });
            await mock.gate('build');
            mock.images.set(tag, { label: mock.buildLabel(args), os: 'linux', architecture: 'amd64' });
          },
        }),
      };
    }
    withName(name: string) { this.name = name; return this; }
    withLabels(labels: Record<string, string>) { Object.assign(this.labels, labels); return this; }
    withEnvironment() { return this; }
    withExposedPorts() { return this; }
    withWaitStrategy() { return this; }
    async start() {
      const hooks = this as unknown as Record<string, (() => Promise<void>) | undefined>;
      await hooks.beforeContainerCreated?.();
      await mock.gate('create');
      if (!mock.images.has(this.image)) throw new Error(`No such image: ${this.image}`);
      mock.started.push(this.image);
      mock.containers.set(this.name, { ...this.labels });
      await hooks.containerCreated?.();
      await hooks.containerStarting?.();
      await hooks.containerStarted?.();
      return {
        stop: async () => { mock.containers.delete(this.name); },
        getHost: () => '127.0.0.1', getMappedPort: () => 2022,
      };
    }
  }
  return { GenericContainer: Container, Wait: { forLogMessage: vi.fn() } };
});

import {
  FIXTURE_IDENTITY_LABEL, FIXTURE_IMAGE_PULL_BUDGET_MS, FIXTURE_REGISTRY_ENV, computeFixtureIdentity,
  computeFixtureIdentitySync, localFixtureRef, remoteFixtureRef, resetFixtureImageState,
} from '../../integration/helpers/fixture-image.js';
import { createSshdLifecycle, createSshdTestScope, startSshd, type UbuntuVersion } from '../../integration/helpers/ssh.js';
import {
  assertNoLeakedTestResources, listOwnedSshResources, reapOwnedSshContainers, snapshotTestResources,
  sshFixtureImageTag,
} from '../../integration/helpers/test-resources.js';
import { resolveRunnerTimeoutScale } from '../../support/timeout-scale.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OWNER_TAG = /^noodara-test\/sshd-diagnostics:([0-9a-f-]{36})$/;
const CONTEXT = 'tests/integration/images';
const DEFAULT_ARGS = { WITH_DOCKER_CLI: 'false', WITH_SLOW_DF: 'false' } as const;
const REGISTRY = 'registry.example.test/noodara-fixtures';

function identityOf(ubuntu: UbuntuVersion): Promise<string> {
  return computeFixtureIdentity({ contextDir: CONTEXT, dockerfile: `sshd-ubuntu-${ubuntu}/Dockerfile`, buildArgs: DEFAULT_ARGS });
}

function hashRefOf(ubuntu: UbuntuVersion, identity: string): string {
  return localFixtureRef(`sshd-ubuntu-${ubuntu}`, identity);
}

function seedCache(ref: string, label: string): void {
  mock.images.set(ref, { label, os: 'linux', architecture: 'amd64' });
}

function holdAt(stage: string) {
  let release!: () => void;
  let reached!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  mock.gate = async (current) => { if (current === stage) { reached(); await held; } };
  return { entered, release };
}

/** Docker semantics the reaper relies on: repeated --filter label=k=v are ANDed. */
function matches(labels: Record<string, string>, args: readonly string[]): boolean {
  return args.every((arg, index) => {
    if (args[index - 1] !== '--filter' || !arg.startsWith('label=')) return true;
    const [key, value] = arg.slice('label='.length).split(/=(.*)/s);
    return labels[key!] === value;
  });
}

function listed(store: Map<string, Record<string, string>>, args: readonly string[]): string {
  return [...store].filter(([, labels]) => matches(labels, args)).map(([id]) => id).join('\n');
}

async function fakeDocker(args: readonly string[]): Promise<string> {
  mock.calls.push([...args]);
  const [command, sub] = args;
  const last = args.at(-1)!;
  if (command === 'ps') return listed(mock.containers, args);
  if (command === 'rm') { for (const id of args.slice(3)) mock.containers.delete(id); return ''; }
  if (command === 'inspect') return `/${last}|some-image|running`;
  if (command === 'version') return 'linux/amd64\n';
  if (command === 'network' && sub === 'ls') return listed(mock.networks, args);
  if (command === 'network' && sub === 'rm') { mock.networks.delete(last); return ''; }
  if (command === 'network' && sub === 'inspect') return last;
  if (command === 'volume' && sub === 'ls') return listed(mock.volumes, args);
  if (command === 'volume' && sub === 'rm') { for (const id of args.slice(3)) mock.volumes.delete(id); return ''; }
  if (command === 'image' && sub === 'inspect') {
    const image = mock.images.get(last);
    if (image === undefined) throw new Error(`Error: No such image: ${last}`);
    return JSON.stringify({
      os: image.os, architecture: image.architecture,
      labels: image.label === null ? null : { [FIXTURE_IDENTITY_LABEL]: image.label },
    });
  }
  if (command === 'image' && sub === 'tag') {
    const [source, target] = args.slice(-2) as [string, string];
    const image = mock.images.get(source);
    if (image === undefined) throw new Error(`Error: No such image: ${source}`);
    mock.images.set(target, { ...image });
    return '';
  }
  if (command === 'image' && sub === 'rm') { mock.images.delete(last); return ''; }
  if (command === 'image' && sub === 'ls') return mock.images.has(last) ? `${last}\n` : '';
  return '';
}

const imageRemovals = (): string[] => mock.calls.filter((call) => call[0] === 'image' && call[1] === 'rm').map((call) => call.at(-1)!);
const pullCalls = (): string[][] => [...mock.calls.filter((call) => call[0] === 'pull'), ...mock.pull.mock.calls.map(([args]) => [...args])];

beforeEach(() => {
  resetFixtureImageState();
  mock.containers.clear();
  mock.networks.clear();
  mock.volumes.clear();
  mock.images.clear();
  mock.builds.length = 0;
  mock.started.length = 0;
  mock.calls.length = 0;
  mock.gate = async () => undefined;
  mock.buildLabel = (args) => args['NOODARA_FIXTURE_IDENTITY'] ?? null;
  mock.docker = fakeDocker;
  mock.pull.mockReset();
  mock.pull.mockRejectedValue(Object.assign(new Error('pull failed'), { stderr: 'manifest unknown' }));
  vi.stubEnv(FIXTURE_REGISTRY_ENV, '');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function scope() {
  return createSshdTestScope({ currentTestName: () => 'wiring test', reapBudgetMs: () => 5_000 });
}

describe.each(['22.04', '24.04'] as const)('36-04 SSH fixture image wiring Ubuntu %s', (ubuntu) => {
  it('the SSH helper computes the same identity as the shared async implementation (H8 parity)', async () => {
    const identity = await identityOf(ubuntu);
    expect(computeFixtureIdentitySync({ contextDir: CONTEXT, dockerfile: `sshd-ubuntu-${ubuntu}/Dockerfile`, buildArgs: DEFAULT_ARGS }))
      .toBe(identity);
    const withCli = { ...DEFAULT_ARGS, WITH_DOCKER_CLI: 'true' };
    expect(computeFixtureIdentitySync({ contextDir: CONTEXT, dockerfile: `sshd-ubuntu-${ubuntu}/Dockerfile`, buildArgs: withCli }))
      .not.toBe(identity);
  });

  it('startSshd defaults to build: it starts the build synchronously, into the owner tag, with the identity build arg, even when a verified cache exists', async () => {
    const identity = await identityOf(ubuntu);
    seedCache(hashRefOf(ubuntu, identity), identity);
    const starting = startSshd({ ubuntu });
    expect(mock.builds).toHaveLength(1);
    const fixture = await starting;
    const build = mock.builds[0]!;
    expect(build.dockerfile).toBe(`sshd-ubuntu-${ubuntu}/Dockerfile`);
    expect(build.args).toEqual({ ...DEFAULT_ARGS, NOODARA_FIXTURE_IDENTITY: identity });
    const owner = OWNER_TAG.exec(build.tag)?.[1];
    expect(owner).toMatch(UUID_V4);
    expect(build.tag).toBe(sshFixtureImageTag(owner!));
    expect(build.tag).not.toBe(hashRefOf(ubuntu, identity));
    expect(mock.started).toEqual([build.tag]);
    await fixture.stop();
    expect(mock.images.has(build.tag)).toBe(false);
    expect(mock.images.has(hashRefOf(ubuntu, identity))).toBe(true);
  });

  it('createSshdLifecycle defaults to build; image: reuse opts into the verified local cache without a build', async () => {
    const identity = await identityOf(ubuntu);
    seedCache(hashRefOf(ubuntu, identity), identity);
    const built = createSshdLifecycle({ ubuntu });
    await built.result;
    expect(mock.builds.map((build) => build.tag)).toEqual([sshFixtureImageTag(built.owner)]);
    await built.stop();

    const reused = createSshdLifecycle({ ubuntu, image: 'reuse' });
    await reused.result;
    expect(mock.builds).toHaveLength(1);
    expect(mock.started.at(-1)).toBe(sshFixtureImageTag(reused.owner));
    await reused.stop();
    expect(mock.images.has(sshFixtureImageTag(reused.owner))).toBe(false);
    expect(mock.images.has(hashRefOf(ubuntu, identity))).toBe(true);
  });

  it('createSshdTestScope().start defaults to reuse; an explicit image: build still builds', async () => {
    const identity = await identityOf(ubuntu);
    seedCache(hashRefOf(ubuntu, identity), identity);
    const tests = scope();
    await tests.start({ ubuntu });
    expect(mock.builds).toHaveLength(0);
    await tests.start({ ubuntu, image: 'build' });
    expect(mock.builds).toHaveLength(1);
    await tests.reap();
    expect([...mock.images.keys()]).toEqual([hashRefOf(ubuntu, identity)]);
    expect(mock.containers.size).toBe(0);
  });

  it('a labelled build is cached under its content hash only after it completes, so the next reuse skips the build', async () => {
    const identity = await identityOf(ubuntu);
    const fixture = await startSshd({ ubuntu });
    await fixture.stop();
    expect(mock.images.get(hashRefOf(ubuntu, identity))?.label).toBe(identity);
    const tests = scope();
    await tests.start({ ubuntu });
    expect(mock.builds).toHaveLength(1);
    await tests.reap();
  });

  it('never reuses or caches an image whose label does not match the computed identity (A1)', async () => {
    const identity = await identityOf(ubuntu);
    seedCache(hashRefOf(ubuntu, identity), 'f'.repeat(64));
    mock.buildLabel = () => 'unset';
    const tests = scope();
    await tests.start({ ubuntu });
    expect(mock.builds).toHaveLength(1);
    await tests.reap();
    expect(mock.images.get(hashRefOf(ubuntu, identity))?.label).toBe('f'.repeat(64));
  });

  it('with NOODARA_TEST_FIXTURE_REGISTRY unset no pull is attempted and the image is built', async () => {
    const tests = scope();
    await tests.start({ ubuntu });
    expect(pullCalls()).toEqual([]);
    expect(mock.builds).toHaveLength(1);
    await tests.reap();
  });

  it.each(['https://registry.example.test', 'user:secret@registry.example.test', '-registry.example.test', 'Registry.Example.Test'])(
    'with an invalid registry value (%s) no pull is attempted and the value is never echoed', async (value) => {
      vi.stubEnv(FIXTURE_REGISTRY_ENV, value);
      const tests = scope();
      await tests.start({ ubuntu });
      expect(pullCalls()).toEqual([]);
      expect(mock.builds).toHaveLength(1);
      const written = vi.mocked(process.stderr.write).mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(written).not.toContain(value);
      await tests.reap();
    },
  );

  it('with a valid registry, reuse pulls <registry>/<name>:<hash> as an argv under the scaled deadline, verifies it and skips the build', async () => {
    const identity = await identityOf(ubuntu);
    const remote = remoteFixtureRef(REGISTRY, `sshd-ubuntu-${ubuntu}`, identity);
    vi.stubEnv(FIXTURE_REGISTRY_ENV, REGISTRY);
    mock.pull.mockImplementation(async (args) => { seedCache(args.at(-1)!, identity); return ''; });
    const tests = scope();
    await tests.start({ ubuntu });
    expect(mock.pull).toHaveBeenCalledTimes(1);
    const [args, options] = mock.pull.mock.calls[0]!;
    expect(args).toEqual(['pull', '--quiet', '--', remote]);
    expect(options.timeoutMs).toBe(resolveRunnerTimeoutScale('vitest').scaled(FIXTURE_IMAGE_PULL_BUDGET_MS));
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(mock.builds).toHaveLength(0);
    expect(mock.images.has(remote)).toBe(false);
    expect(mock.images.get(hashRefOf(ubuntu, identity))?.label).toBe(identity);
    await tests.reap();
    expect([...mock.images.keys()]).toEqual([hashRefOf(ubuntu, identity)]);
  });

  it('a failed pull falls back to the build path and leaves no remote or hash tag from the pull', async () => {
    const identity = await identityOf(ubuntu);
    vi.stubEnv(FIXTURE_REGISTRY_ENV, REGISTRY);
    mock.pull.mockImplementation(async (args) => {
      seedCache(args.at(-1)!, 'e'.repeat(64)); // a mislabelled image arrives
      return '';
    });
    const tests = scope();
    await tests.start({ ubuntu });
    expect(mock.pull).toHaveBeenCalledTimes(1);
    expect(mock.builds).toHaveLength(1);
    expect(mock.images.has(remoteFixtureRef(REGISTRY, `sshd-ubuntu-${ubuntu}`, identity))).toBe(false);
    await tests.reap();
    expect([...mock.images.keys()]).toEqual([hashRefOf(ubuntu, identity)]);
  });

  it('build mode never pulls, even with a valid registry', async () => {
    vi.stubEnv(FIXTURE_REGISTRY_ENV, REGISTRY);
    const fixture = await startSshd({ ubuntu });
    await fixture.stop();
    expect(pullCalls()).toEqual([]);
  });

  it.each(['build', 'reuse'] as const)(
    'A3: a %s-mode build that completes after cancellation returns no handle; its owner tag is reaped and never cached', async (image) => {
      const identity = await identityOf(ubuntu);
      const held = holdAt('build');
      const lifecycle = createSshdLifecycle({ ubuntu, image });
      await held.entered;
      const primary = new Error('controlled cancellation');
      lifecycle.cancel(primary);
      await expect(lifecycle.result).rejects.toBe(primary);
      const stopping = lifecycle.stop();
      held.release();
      await stopping;
      await lifecycle.settled;
      expect(mock.images.has(sshFixtureImageTag(lifecycle.owner))).toBe(false);
      expect(mock.images.has(hashRefOf(ubuntu, identity))).toBe(false);
      expect(mock.containers.size).toBe(0);
      expect(await listOwnedSshResources(lifecycle.owner)).toEqual([]);
    },
  );

  it('A3: aborting during a pull returns no handle and leaves no owned container or tagged image', async () => {
    const identity = await identityOf(ubuntu);
    vi.stubEnv(FIXTURE_REGISTRY_ENV, REGISTRY);
    let pulling!: () => void;
    const entered = new Promise<void>((resolve) => { pulling = resolve; });
    mock.pull.mockImplementation((args, options) => new Promise<string>((_resolve, reject) => {
      pulling();
      options.signal?.addEventListener('abort', () => {
        seedCache(args.at(-1)!, identity); // the daemon finished writing the image anyway
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true });
    }));
    const lifecycle = createSshdLifecycle({ ubuntu, image: 'reuse' });
    await entered;
    const primary = new Error('controlled cancellation');
    lifecycle.cancel(primary);
    await expect(lifecycle.result).rejects.toBe(primary);
    await lifecycle.stop();
    await lifecycle.settled;
    expect(mock.builds).toHaveLength(0);
    expect(mock.containers.size).toBe(0);
    await vi.waitFor(() => { expect([...mock.images.keys()]).toEqual([]); });
    expect(await listOwnedSshResources(lifecycle.owner)).toEqual([]);
  });

  it('H7: every tag the helper creates besides the content hash is the randomUUID owner tag', async () => {
    const identity = await identityOf(ubuntu);
    seedCache(hashRefOf(ubuntu, identity), identity);
    const lifecycles = [createSshdLifecycle({ ubuntu, image: 'reuse' }), createSshdLifecycle({ ubuntu })];
    await Promise.all(lifecycles.map((lifecycle) => lifecycle.result));
    const created = [
      ...mock.builds.map((build) => build.tag),
      ...mock.calls.filter((call) => call[0] === 'image' && call[1] === 'tag').map((call) => call.at(-1)!),
    ];
    expect(new Set(created)).toEqual(new Set([...lifecycles.map((lifecycle) => sshFixtureImageTag(lifecycle.owner))]));
    for (const lifecycle of lifecycles) expect(lifecycle.owner).toMatch(UUID_V4);
    await Promise.all(lifecycles.map((lifecycle) => lifecycle.stop()));
  });
});

describe('H7: cached content-addressed images are not per-test resources', () => {
  it('the leak guard neither reports nor removes a cached image, yet still fails on leaked containers, networks and volumes', async () => {
    const identity = await identityOf('24.04');
    const baseline = await snapshotTestResources(fakeDocker);
    seedCache(hashRefOf('24.04', identity), identity);
    await expect(assertNoLeakedTestResources('cache-only suite', baseline, { docker: fakeDocker })).resolves.toBeUndefined();

    mock.containers.set('leaked-container', { 'noodara.test': 'true' });
    mock.networks.set('leaked-network', { 'noodara.test': 'true' });
    mock.volumes.set('leaked-volume', { 'noodara.test': 'true' });
    const failure = await assertNoLeakedTestResources('leaky suite', baseline, { docker: fakeDocker })
      .then(() => undefined, (error: unknown) => error as Error);
    expect(failure?.message).toMatch(/container leaked-container[\s\S]*network leaked-network[\s\S]*volume leaked-volume/);
    expect(failure?.message).not.toContain('noodara-test/sshd-ubuntu');
    expect(mock.images.has(hashRefOf('24.04', identity))).toBe(true);
    expect(imageRemovals()).toEqual([]);
  });

  it('the 35-04 owner reaper and inventory ignore cached images and still report an owned container', async () => {
    const identity = await identityOf('24.04');
    seedCache(hashRefOf('24.04', identity), identity);
    const tests = scope();
    await tests.start({ ubuntu: '24.04' });
    await tests.reap();
    expect(imageRemovals().filter((ref) => !OWNER_TAG.test(ref))).toEqual([]);
    expect(mock.images.has(hashRefOf('24.04', identity))).toBe(true);

    const lifecycle = createSshdLifecycle({ ubuntu: '24.04', image: 'reuse' });
    await lifecycle.result;
    expect(await listOwnedSshResources(lifecycle.owner)).toEqual([
      expect.stringMatching(/^container noodara-sshd-24\.04-/), `image ${sshFixtureImageTag(lifecycle.owner)}`,
    ]);
    await reapOwnedSshContainers(lifecycle.owner);
    expect(mock.containers.size).toBe(0);
    expect(mock.images.has(hashRefOf('24.04', identity))).toBe(true);
    await lifecycle.stop();
    expect(await listOwnedSshResources(lifecycle.owner)).toEqual([]);
    expect(mock.images.has(hashRefOf('24.04', identity))).toBe(true);
  });
});
