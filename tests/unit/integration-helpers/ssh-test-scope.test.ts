// 36-02 (QA-26): one primary timeout in tests/integration/ssh/contracts.test.ts must not make later
// tests fail for a different reason. On a 4 CPU / 6 GB VM a test timed out while its fixture was
// still building/starting; `fixture = await startSshd()` was never assigned, afterEach's
// `fixture?.stop()` was a no-op, and the abandoned start later created an owned container that
// every following afterEach reported as a stray (docs/testing/slow-machines/2026-11-12-wsl-run.md).
// Docker and testcontainers are faked with held stage gates: no real sleep-until-timeout.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  gate: async (_stage: string): Promise<void> => undefined,
  /** name -> labels. A container's name doubles as its id. */
  containers: new Map<string, Record<string, string>>(),
  images: new Set<string>(),
  docker: vi.fn<(args: readonly string[]) => Promise<string>>(),
  failRemoval: false,
  failInventory: false,
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
vi.mock('testcontainers', () => {
  class Container {
    labels: Record<string, string> = {};
    name = '';
    static fromDockerfile() {
      return { withBuildArgs: () => ({ build: async (tag: string) => { await mock.gate('build'); mock.images.add(tag); } }) };
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
      mock.containers.set(this.name, { ...this.labels });
      await hooks.containerCreated?.();
      await mock.gate('readiness');
      await hooks.containerStarting?.();
      await hooks.containerStarted?.();
      return {
        stop: async () => {
          if (mock.failRemoval) throw new Error('synthetic-docker-error-with-env-secret');
          mock.containers.delete(this.name);
        },
        getHost: () => '127.0.0.1', getMappedPort: () => 2022,
      };
    }
  }
  return { GenericContainer: Container, Wait: { forLogMessage: vi.fn() } };
});
import {
  LIFECYCLE_STOP_SETTLE_CAP_MS, SSH_FIXTURE_REAP_BUDGET_MS, createSshdLifecycle, createSshdTestScope, startSshd,
} from '../../integration/helpers/ssh.js';
import {
  SSH_OWNER_LABEL, listOwnedSshResources, reapOwnedSshContainers, sshFixtureImageTag,
} from '../../integration/helpers/test-resources.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

/** What the per-test leak check (assertNoStrayTestContainers) would see. */
function strayTestContainers(): string[] {
  return [...mock.containers].filter(([, labels]) => labels['noodara.test'] === 'true').map(([name]) => name);
}

beforeEach(() => {
  mock.containers.clear();
  mock.images.clear();
  mock.failRemoval = false;
  mock.failInventory = false;
  mock.gate = async () => undefined;
  mock.docker.mockReset();
  mock.docker.mockImplementation(async (args) => {
    if (args[0] === 'ps') {
      if (mock.failInventory) throw new Error('synthetic-docker-error-with-env-secret');
      return [...mock.containers].filter(([, labels]) => matches(labels, args)).map(([name]) => name).join('\n');
    }
    if (args[0] === 'image' && args[1] === 'ls') return mock.images.has(args.at(-1)!) ? `${args.at(-1)!}\n` : '';
    if (args[0] === 'image' && args[1] === 'rm') { mock.images.delete(args.at(-1)!); return ''; }
    if (args[0] === 'rm') {
      if (mock.failRemoval) throw new Error('synthetic-docker-error-with-env-secret');
      for (const id of args.slice(3)) mock.containers.delete(id);
    }
    return '';
  });
});
afterEach(() => { vi.useRealTimers(); });

describe('A3: a timed-out test leaves nothing behind for the next test', () => {
  it('mechanism: the legacy `fixture = await startSshd()` + `fixture?.stop()` pattern leaks a late container', async () => {
    const held = holdAt('create');
    const suite: { fixture?: { stop: () => Promise<void> } } = {};
    // The test "times out" here: its body is abandoned while startSshd is still in flight.
    const abandoned = (async () => { suite.fixture = await startSshd({ ubuntu: '24.04' }); })();
    await held.entered;
    await suite.fixture?.stop(); // afterEach: fixture was never assigned, so this is a no-op.
    expect(suite.fixture).toBeUndefined();
    held.release();
    await abandoned;
    // The next test's empty-inventory assertion now fails for a reason that is not its own.
    expect(strayTestContainers()).toHaveLength(1);
    await suite.fixture?.stop();
  });

  it.each(['build', 'create', 'readiness'])(
    'reap() removes the resources of a test that timed out during %s, before the next test asserts', async (stage) => {
      const scope = createSshdTestScope();
      const held = holdAt(stage);
      const abandoned = scope.start({ ubuntu: '22.04' });
      void abandoned.catch(() => undefined);
      await held.entered;
      const reaping = scope.reap();
      held.release();
      await reaping;
      expect(strayTestContainers()).toEqual([]);
      expect(mock.images.size).toBe(0);
      await expect(abandoned).rejects.toThrow();
    },
  );

  it('reap() also stops fixtures the test did receive, and is a no-op with nothing tracked', async () => {
    const scope = createSshdTestScope();
    await scope.start({ ubuntu: '24.04' });
    await scope.start({ ubuntu: '22.04' });
    expect(strayTestContainers()).toHaveLength(2);
    await scope.reap();
    expect(strayTestContainers()).toEqual([]);
    expect(mock.images.size).toBe(0);
    await expect(scope.reap()).resolves.toBeUndefined();
  });
});

describe('H1: reaping is bounded and scoped to the ownership id', () => {
  it('never removes another owner\'s container or one lacking the noodara.test label', async () => {
    const owner = crypto.randomUUID();
    const foreign = crypto.randomUUID();
    mock.containers.set('own', { 'noodara.test': 'true', [SSH_OWNER_LABEL]: owner });
    mock.containers.set('own-owner-label-but-unlabelled', { [SSH_OWNER_LABEL]: owner });
    mock.containers.set('foreign-owner', { 'noodara.test': 'true', [SSH_OWNER_LABEL]: foreign });
    mock.containers.set('unlabelled', {});
    expect(await listOwnedSshResources(owner)).toEqual(['container own']);
    await reapOwnedSshContainers(owner);
    expect([...mock.containers.keys()].sort()).toEqual(['foreign-owner', 'own-owner-label-but-unlabelled', 'unlabelled']);
    for (const call of mock.docker.mock.calls.filter(([args]) => args[0] === 'ps' || args[0] === 'rm')) {
      const args = call[0];
      if (args[0] === 'ps') {
        expect(args).toContain('label=noodara.test=true');
        expect(args.at(-1)).toBe(`label=${SSH_OWNER_LABEL}=${owner}`);
      } else {
        expect(args.slice(3)).toEqual(['own']);
      }
    }
  });

  it('a scope reap leaves a concurrent owner\'s fixture running', async () => {
    const other = createSshdTestScope();
    await other.start({ ubuntu: '24.04' });
    const scope = createSshdTestScope();
    await scope.start({ ubuntu: '24.04' });
    await scope.reap();
    expect(strayTestContainers()).toHaveLength(1);
    await other.reap();
    expect(strayTestContainers()).toEqual([]);
  });

  it('bounds the reap by a scaled() deadline whose unscaled value sits above the settle cap', () => {
    expect(SSH_FIXTURE_REAP_BUDGET_MS).toBe(90_000);
    expect(LIFECYCLE_STOP_SETTLE_CAP_MS).toBe(30_000);
    expect(SSH_FIXTURE_REAP_BUDGET_MS).toBeGreaterThan(LIFECYCLE_STOP_SETTLE_CAP_MS);
    expect(SSH_FIXTURE_REAP_BUDGET_MS).toBeLessThan(120_000);
    const source = readFileSync('tests/integration/helpers/ssh.ts', 'utf8');
    expect(source).toMatch(/resolveRunnerTimeoutScale\("vitest"\)\.scaled\(SSH_FIXTURE_REAP_BUDGET_MS\)/);
  });
});

describe('H2: a failed or overdue reap is reported with its origin and survivors', () => {
  it('names the originating test and the surviving container when removal fails', async () => {
    const scope = createSshdTestScope();
    await scope.start({ ubuntu: '24.04' });
    mock.failRemoval = true;
    const survivor = strayTestContainers()[0]!;
    const failure = await scope.reap().then(() => undefined, (error: unknown) => error as Error);
    expect(failure?.message).toContain(`test "${expect.getState().currentTestName!}"`);
    expect(failure?.message).toContain(`container ${survivor}`);
    expect(failure?.message).not.toContain('synthetic-docker-error');
  });

  it('reports a build that outlives the reap deadline instead of waiting forever or passing', async () => {
    vi.useFakeTimers();
    const scope = createSshdTestScope({ reapBudgetMs: () => LIFECYCLE_STOP_SETTLE_CAP_MS + 5_000, currentTestName: () => 'slow cold build' });
    const held = holdAt('build');
    void scope.start({ ubuntu: '22.04' }).catch(() => undefined);
    await held.entered;
    const outcome = scope.reap().then(() => undefined, (error: unknown) => error as Error);
    await vi.advanceTimersByTimeAsync(LIFECYCLE_STOP_SETTLE_CAP_MS + 5_000);
    const failure = await outcome;
    expect(failure?.message).toMatch(/test "slow cold build" \(fixture owner [0-9a-f-]{36}\): build\/start did not settle within the 35000 ms reap deadline/);
    vi.useRealTimers();
    held.release();
    await vi.waitFor(() => { expect(mock.images.size).toBe(0); });
    expect(strayTestContainers()).toEqual([]);
  });

  it('reports an unavailable inventory as a bounded category, never the Docker error text', async () => {
    const scope = createSshdTestScope({ currentTestName: () => 'inventory test' });
    await scope.start({ ubuntu: '24.04' });
    mock.failInventory = true;
    const failure = await scope.reap().then(() => undefined, (error: unknown) => error as Error);
    expect(failure?.message).toMatch(/test "inventory test" .*owned resource inventory unavailable/);
    expect(failure?.message).not.toContain('synthetic-docker-error');
  });
});

describe('H3: ownership ids come from crypto.randomUUID', () => {
  it('each lifecycle owns a distinct v4 UUID that labels its container and image', async () => {
    const first = createSshdLifecycle({ ubuntu: '24.04' });
    const second = createSshdLifecycle({ ubuntu: '24.04' });
    expect(first.owner).toMatch(UUID_V4);
    expect(second.owner).toMatch(UUID_V4);
    expect(first.owner).not.toBe(second.owner);
    await Promise.all([first.result, second.result]);
    expect([...mock.containers.values()].map((labels) => labels[SSH_OWNER_LABEL]).sort())
      .toEqual([first.owner, second.owner].sort());
    expect(mock.images.has(`noodara-test/sshd-diagnostics:${first.owner}`)).toBe(true);
    expect(sshFixtureImageTag(first.owner)).toBe(`noodara-test/sshd-diagnostics:${first.owner}`);
    await Promise.all([first.stop(), second.stop()]);
    expect(mock.containers.size).toBe(0);
  });

  it('the helper generates owners only with randomUUID (no Math.random, clock or counter)', () => {
    const source = readFileSync('tests/integration/helpers/ssh.ts', 'utf8');
    const assignments = [...source.matchAll(/\bowner\s*(?::\s*string\s*)?=\s*([^;,\n]+)/g)].map((match) => match[1]!.trim());
    expect(assignments).toEqual(['randomUUID()', 'randomUUID()']);
    expect(source).not.toMatch(/Math\.random/);
  });
});
