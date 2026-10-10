import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertNoLeakedTestResources,
  assertNoTestResources,
  diffSnapshots,
  reapTestResourcesSince,
  snapshotTestResources,
  type DockerRunner,
  type TestResourceSnapshot,
} from './test-resources.js';

const EMPTY: TestResourceSnapshot = { containers: [], networks: [], volumes: [] };

/** In-memory Docker CLI: just enough of ps/ls/inspect/rm for the leak guard. */
function fakeDocker(initial: { containers?: string[]; networks?: string[]; volumes?: string[] } = {}) {
  const state = {
    containers: new Set(initial.containers ?? []),
    networks: new Set(initial.networks ?? []),
    volumes: new Set(initial.volumes ?? []),
  };
  const stuck = new Set<string>();
  const onRemove: (() => void)[] = [];
  const calls: string[][] = [];
  const run: DockerRunner = (args) => {
    calls.push([...args]);
    const [a, b] = args;
    const list = (set: Set<string>) => Promise.resolve([...set].join('\n'));
    if (a === 'ps') return list(state.containers);
    if (a === 'network' && b === 'ls') return list(state.networks);
    if (a === 'volume' && b === 'ls') return list(state.volumes);
    if (a === 'inspect') {
      const id = args.at(-1) ?? '';
      return state.containers.has(id) ? Promise.resolve(`/${id}-name|img:${id}|running\n`) : Promise.reject(new Error('gone'));
    }
    if (a === 'network' && b === 'inspect') return Promise.resolve(`${args.at(-1) ?? ''}-net\n`);
    if (a === 'rm') {
      for (const id of args.slice(3)) if (!stuck.has(id)) state.containers.delete(id);
      onRemove.splice(0).forEach((f) => f());
      return Promise.resolve('');
    }
    if (a === 'network' && b === 'rm') {
      state.networks.delete(args[2] ?? '');
      return Promise.resolve('');
    }
    if (a === 'volume' && b === 'rm') {
      for (const id of args.slice(3)) state.volumes.delete(id);
      return Promise.resolve('');
    }
    return Promise.reject(new Error(`unexpected docker ${args.join(' ')}`));
  };
  return { run, state, stuck, onRemove, calls };
}

describe('test-resources leak guard (unit)', () => {
  it('diffSnapshots returns only resources added since the baseline', () => {
    const added = diffSnapshots(
      { containers: ['a'], networks: ['n1'], volumes: [] },
      { containers: ['a', 'b'], networks: ['n1'], volumes: ['v1'] },
    );
    expect(added).toEqual({ containers: ['b'], networks: [], volumes: ['v1'] });
  });

  it('removes only what was added since the baseline and never touches older resources', async () => {
    const docker = fakeDocker({ containers: ['old'], networks: ['oldnet'] });
    const baseline = await snapshotTestResources(docker.run);
    docker.state.containers.add('new');
    docker.state.networks.add('newnet');
    docker.state.volumes.add('newvol');

    const report = await reapTestResourcesSince(baseline, { docker: docker.run });

    expect(report.leaked).toEqual(['container new-name (img:new, running)', 'network newnet-net', 'volume newvol']);
    expect(report.survivors).toEqual([]);
    expect([...docker.state.containers]).toEqual(['old']);
    expect([...docker.state.networks]).toEqual(['oldnet']);
    expect([...docker.state.volumes]).toEqual([]);
    // Containers go before networks, so a network is never removed while still attached.
    const order = docker.calls.filter(([a, b]) => a === 'rm' || b === 'rm').map(([a, b]) => (a === 'rm' ? 'rm' : b));
    expect(order[0]).toBe('rm');
  });

  it('sweeps again after settling to catch a container created while it was removing', async () => {
    const docker = fakeDocker();
    docker.state.containers.add('first');
    docker.onRemove.push(() => docker.state.containers.add('late'));

    const report = await reapTestResourcesSince(EMPTY, { docker: docker.run, settleMs: 1 });

    expect(report.leaked).toEqual(['container first-name (img:first, running)', 'container late-name (img:late, running)']);
    expect(docker.state.containers.size).toBe(0);
  });

  it('assertNoLeakedTestResources is silent when nothing was added', async () => {
    const docker = fakeDocker({ containers: ['old'] });
    await expect(assertNoLeakedTestResources('suite', await snapshotTestResources(docker.run), { docker: docker.run })).resolves.toBeUndefined();
  });

  it('assertNoLeakedTestResources fails loudly naming the leak, after removing it', async () => {
    const docker = fakeDocker();
    docker.state.containers.add('pg');
    const error = await assertNoLeakedTestResources('tests/x.test.ts', EMPTY, { docker: docker.run }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('tests/x.test.ts left 1 noodara.test resource(s) behind');
    expect((error as Error).message).toContain('container pg-name (img:pg, running)');
    expect(docker.state.containers.size).toBe(0);
  });

  it('reports a resource that survives removal', async () => {
    const docker = fakeDocker();
    docker.state.containers.add('wedged');
    docker.stuck.add('wedged');
    const error = await assertNoLeakedTestResources('suite', EMPTY, { docker: docker.run }).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/could not remove:\n {2}- container wedged-name/);
  });

  it('assertNoTestResources fails before a run when an earlier run left resources, and removes nothing', async () => {
    const docker = fakeDocker({ containers: ['stale'], volumes: ['stalevol'] });
    const error = await assertNoTestResources('pnpm test:integration', docker.run).catch((e: unknown) => e);
    expect((error as Error).message).toContain('pnpm test:integration: 2 noodara.test resource(s) already exist before the run');
    expect((error as Error).message).toContain('docker rm -f -v $(docker ps -aq --filter label=noodara.test=true)');
    expect(docker.state.containers.has('stale')).toBe(true);
    await expect(assertNoTestResources('x', fakeDocker().run)).resolves.toBeUndefined();
  });
});

describe('test-resources leak guard (real Docker)', () => {
  it('reaps a labelled container, network and volume added after the snapshot', async () => {
    const baseline = await snapshotTestResources();
    const suffix = randomUUID().slice(0, 8);
    const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000 }).trim();
    const net = `noodara-leakguard-${suffix}`;
    docker(['network', 'create', '--label', 'noodara.test=true', net]);
    docker(['volume', 'create', '--label', 'noodara.test=true', `noodara-leakguard-${suffix}`]);
    docker([
      'create', '--name', `noodara-leakguard-${suffix}`, '--label', 'noodara.test=true', '--network', net,
      'redis:7-alpine', 'sleep', '60',
    ]);

    const error = await assertNoLeakedTestResources('leak-guard probe', baseline).catch((e: unknown) => e);

    expect((error as Error).message).toContain(`container noodara-leakguard-${suffix} (redis:7-alpine, created)`);
    expect((error as Error).message).toContain(`network ${net}`);
    expect((error as Error).message).toContain(`volume noodara-leakguard-${suffix}`);
    expect(diffSnapshots(baseline, await snapshotTestResources())).toEqual(EMPTY);
  });
});
