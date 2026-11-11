import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  gate: async (_stage: string): Promise<void> => undefined,
  resources: new Map<string, Record<string, string>>(),
  docker: vi.fn<(...args: readonly unknown[]) => Promise<string>>(),
  stop: vi.fn(),
  failInventory: false,
  failRemoval: false,
}));
vi.mock('../../integration/helpers/test-resources.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../integration/helpers/test-resources.js')>();
  return {
    ...actual,
    dockerCli: (args: readonly string[]) => mock.docker(args),
    reapOwnedSshContainers: (owner: string) => actual.reapOwnedSshContainers(owner, (args) => mock.docker(args)),
  };
});
vi.mock('testcontainers', () => {
  class Container {
    labels: Record<string, string> = {};
    name = '';
    static fromDockerfile() { return { withBuildArgs: () => ({ build: () => mock.gate('build') }) }; }
    withName(name: string) { this.name = name; return this; }
    withLabels(labels: Record<string, string>) { Object.assign(this.labels, labels); return this; }
    withEnvironment() { return this; }
    withExposedPorts() { return this; }
    withWaitStrategy() { return this; }
    async start() {
      const hooks = this as unknown as Record<string, (() => Promise<void>) | undefined>;
      await hooks.beforeContainerCreated?.();
      await mock.gate('create');
      mock.resources.set(this.name, this.labels);
      await hooks.containerCreated?.();
      await mock.gate('start');
      await mock.gate('ports');
      await hooks.containerStarting?.();
      await mock.gate('readiness');
      await hooks.containerStarted?.();
      await mock.gate('return');
      return {
        stop: async () => { await mock.stop(); mock.resources.delete(this.name); },
        getHost: () => '127.0.0.1', getMappedPort: () => 2022,
      };
    }
  }
  return { GenericContainer: Container, Wait: { forLogMessage: vi.fn() } };
});
import { createSshdLifecycle, startSshd, type SshDiagnosticEvent } from '../../integration/helpers/ssh.js';
import { reapOwnedSshContainers } from '../../integration/helpers/test-resources.js';

function holdAt(stage: string) {
  let release!: () => void;
  let reached!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  mock.gate = async (current) => { if (current === stage) { reached(); await held; } };
  return { entered, release };
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.stop.mockReset();
  mock.resources.clear();
  mock.failInventory = false;
  mock.failRemoval = false;
  mock.gate = async () => undefined;
  mock.docker.mockImplementation(async (...parameters) => {
    const args = parameters[0] as string[];
    if (args[0] === 'ps') {
      if (mock.failInventory) throw new Error('synthetic-sensitive-env-cookie-cause');
      const label = args.at(-1)?.replace(/^label=/, '') ?? '';
      const split = label.indexOf('=');
      return [...mock.resources].filter(([, labels]) => labels[label.slice(0, split)] === label.slice(split + 1)).map(([id]) => id).join('\n');
    }
    if (args[0] === 'rm') {
      if (mock.failRemoval) throw new Error('synthetic-sensitive-password-private-key-cause');
      for (const id of args.slice(3)) mock.resources.delete(id);
    }
    return '';
  });
});
afterEach(() => { vi.useRealTimers(); });

describe.each(['22.04', '24.04'] as const)('SSH cancellation ownership Ubuntu %s', (ubuntu) => {
  it.each(['build', 'create', 'start', 'ports', 'readiness', 'return'])(
    'joins late %s completion without returning a handle or touching a concurrent owner', async (stage) => {
      const foreign = await startSshd({ ubuntu });
      const foreignIds = [...mock.resources.keys()];
      const held = holdAt(stage);
      const events: SshDiagnosticEvent[] = [];
      const owner = createSshdLifecycle({ ubuntu, diagnostics: (event) => { events.push(event); } });
      await held.entered;
      // A newly created shared-label sentinel was absent from the first owner's baseline.
      mock.resources.set('foreign-after-baseline', { 'noodara.test': 'true', 'noodara.test.ssh-owner': 'foreign' });
      const primary = new Error('controlled cancellation');
      owner.cancel(primary);
      await expect(owner.result).rejects.toBe(primary);
      const stopping = owner.stop();
      held.release();
      await stopping;
      await owner.settled;
      expect([...mock.resources.keys()].sort()).toEqual([...foreignIds, 'foreign-after-baseline'].sort());
      expect(events.some((event) => event.outcome === 'cancelled')).toBe(true);
      await owner.stop();
      await foreign.stop();
      expect([...mock.resources.keys()]).toEqual(['foreign-after-baseline']);
    },
  );

  it('fails bounded teardown closed while retaining late build ownership', async () => {
    vi.useFakeTimers();
    const held = holdAt('build');
    const owner = createSshdLifecycle({ ubuntu });
    await held.entered;
    owner.cancel();
    await expect(owner.result).rejects.toThrow('SSH fixture cancelled');
    const stopping = owner.stop();
    const assertion = expect(stopping).rejects.toThrow('cleanup unverified: creation did not settle');
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    held.release();
    await owner.settled;
    expect(mock.resources.size).toBe(0);
  });

  it.each(['build', 'start', 'readiness'])('preserves %s rejection and verifies cleanup', async (stage) => {
    const primary = new Error('controlled startup failure');
    const events: SshDiagnosticEvent[] = [];
    mock.gate = async (current) => { if (current === stage) throw primary; };
    const owner = createSshdLifecycle({ ubuntu, diagnostics: (event) => { events.push(event); } });
    await expect(owner.result).rejects.toBe(primary);
    await owner.stop();
    expect(mock.resources.size).toBe(0);
    expect(JSON.stringify(events)).not.toContain(primary.message);
  });
});

describe('fail-closed exact owner cleanup', () => {
  it('removes only the owner image while preserving its untagged shared parent cache', async () => {
    const events: SshDiagnosticEvent[] = [];
    const sharedParents = new Set(['shared-parent-cache']);
    const images = new Set(['foreign-tagged-image']);
    const docker = mock.docker.getMockImplementation()!;
    mock.docker.mockImplementation(async (...parameters) => {
      const args = parameters[0] as string[];
      if (args[0] === 'image' && args[1] === 'rm') {
        // Docker's default image-rm behavior deletes untagged parents too. A fixture
        // owns its tag, while an untagged parent may be another build's cache.
        images.delete(args.at(-1)!);
        if (!args.includes('--no-prune')) sharedParents.clear();
        return '';
      }
      return docker(...parameters);
    });
    const owner = createSshdLifecycle({ ubuntu: '24.04', diagnostics: (event) => { events.push(event); } });
    await owner.result;
    const ownImage = `noodara-test/sshd-diagnostics:${events[0]!.owner}`;
    images.add(ownImage);
    await owner.stop();
    expect(images).toEqual(new Set(['foreign-tagged-image']));
    expect(sharedParents).toEqual(new Set(['shared-parent-cache']));
    expect(mock.resources.size).toBe(0);
  });

  it.each(['inventory', 'removal'])('reports %s failure without exception details or successful teardown', async (failure) => {
    const held = holdAt('readiness');
    const primary = new Error('controlled primary cancellation');
    const events: SshDiagnosticEvent[] = [];
    const owner = createSshdLifecycle({ ubuntu: '24.04', diagnostics: (event) => { events.push(event); } });
    await held.entered;
    mock.failInventory = failure === 'inventory';
    mock.failRemoval = failure === 'removal';
    owner.cancel(primary);
    await expect(owner.result).rejects.toBe(primary);
    held.release();
    await expect(owner.stop()).rejects.toThrow('cleanup unverified');
    await owner.settled;
    expect(mock.resources.size).toBe(1);
    expect(events.some((event) => event.stage === 'cleanup' && event.outcome === 'failure')).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/synthetic-sensitive|password|cookie|private-key/);
  });

  it('keeps repeated failed stop rejected while still reaping owned resources', async () => {
    mock.stop.mockImplementation(() => { throw new Error('synthetic-sensitive-stop'); });
    const owner = createSshdLifecycle({ ubuntu: '24.04' });
    await owner.result;
    await expect(owner.stop()).rejects.toThrow('cleanup unverified');
    await expect(owner.stop()).rejects.toThrow('cleanup unverified');
    expect(mock.stop).toHaveBeenCalledTimes(1);
    expect(mock.resources.size).toBe(0);
  });

  it('rejects invalid ownership without issuing a Docker command', async () => {
    await expect(reapOwnedSshContainers('noodara.test=true')).rejects.toThrow('Invalid SSH fixture owner');
    expect(mock.docker).not.toHaveBeenCalled();
  });
});
