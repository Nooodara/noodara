import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  build: vi.fn(),
  start: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFileSync: mock.remove }));
vi.mock('testcontainers', () => {
  class Container {
    static fromDockerfile() { return { withBuildArgs: () => ({ build: mock.build }) }; }
    withName() { return this; }
    withLabels() { return this; }
    withEnvironment() { return this; }
    withExposedPorts() { return this; }
    withWaitStrategy() { return this; }
    async start() {
      const hooks = this as unknown as Record<string, (() => Promise<void>) | undefined>;
      await hooks.beforeContainerCreated?.();
      await hooks.containerCreated?.();
      await hooks.containerStarting?.();
      await hooks.containerStarted?.();
      return mock.start();
    }
  }
  return { GenericContainer: Container, Wait: { forLogMessage: vi.fn() } };
});
vi.mock('../../integration/helpers/container-start.js', () => ({
  startLabelledContainer: async (_image: string, start: (labels: Record<string, string>) => Promise<unknown>) => start({}),
}));

import { startSshd, type SshDiagnosticEvent } from '../../integration/helpers/ssh.js';

describe('SSH fixture startup stage evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.build.mockResolvedValue({});
    mock.start.mockResolvedValue({ stop: vi.fn(), getHost: () => '127.0.0.1', getMappedPort: () => 2022 });
  });

  it('identifies the build before any container or browser readiness work', async () => {
    const events: SshDiagnosticEvent[] = [];
    const failure = new Error('sensitive-synthetic-build-detail');
    mock.build.mockRejectedValue(failure);
    await expect(startSshd({ ubuntu: '24.04', diagnostics: (event) => { events.push(event); } })).rejects.toBe(failure);
    expect(events.map(({ stage, outcome }) => [stage, outcome])).toEqual([
      ['image_build', 'begin'], ['image_build', 'failure'],
    ]);
    expect(JSON.stringify(events)).not.toContain(failure.message);
    expect(mock.start).not.toHaveBeenCalled();
  });

  it('records separate build, creation, port publication and SSH readiness outcomes with one owner', async () => {
    const events: SshDiagnosticEvent[] = [];
    const fixture = await startSshd({ ubuntu: '22.04', diagnostics: (event) => { events.push(event); } });
    await fixture.stop();
    await fixture.stop();
    expect(events.map(({ stage, outcome }) => [stage, outcome])).toEqual([
      ['image_build', 'begin'], ['image_build', 'success'],
      ['container_create', 'begin'], ['container_create', 'success'],
      ['container_start', 'begin'], ['published_port', 'begin'],
      ['container_start', 'success'], ['published_port', 'success'],
      ['ssh_readiness', 'begin'], ['ssh_readiness', 'success'],
      ['cleanup', 'begin'], ['cleanup', 'success'],
    ]);
    expect(new Set(events.map((event) => event.owner)).size).toBe(1);
    expect(JSON.stringify(events)).not.toContain(fixture.password);
    expect(JSON.stringify(events)).not.toContain(fixture.keyPassphrase);
    expect((await mock.start.mock.results[0]?.value).stop).toHaveBeenCalledTimes(1);
  });

  it('records bounded cleanup failure and preserves the original startup rejection', async () => {
    const events: SshDiagnosticEvent[] = [];
    const primary = new Error('synthetic-sensitive-start-failure');
    mock.start.mockRejectedValue(primary);
    mock.remove.mockImplementation(() => { throw new Error('synthetic-sensitive-cleanup-failure'); });

    await expect(startSshd({ ubuntu: '24.04', diagnostics: (event) => { events.push(event); } })).rejects.toBe(primary);

    expect(events.slice(-3).map(({ stage, outcome }) => [stage, outcome])).toEqual([
      ['ssh_readiness', 'failure'], ['cleanup', 'begin'], ['cleanup', 'failure'],
    ]);
    expect(mock.remove).toHaveBeenCalledTimes(1);
    expect(mock.remove.mock.calls[0]?.[2]).toMatchObject({ stdio: 'ignore', timeout: 30_000 });
    expect(JSON.stringify(events)).not.toContain('synthetic-sensitive');
  });

  it.each(['throwing', 'backpressured', 'unsettled'] as const)(
    'continues startup and idempotent cleanup with a %s diagnostic sink', async (kind) => {
      const sink = vi.fn(() => {
        if (kind === 'throwing') throw new Error('synthetic-sensitive-sink');
        if (kind === 'backpressured') return false;
        return new Promise<void>(() => undefined);
      });
      const fixture = await startSshd({ ubuntu: '24.04', diagnostics: sink });
      await fixture.stop();
      await fixture.stop();
      expect((await mock.start.mock.results[0]?.value).stop).toHaveBeenCalledTimes(1);
      expect(sink).toHaveBeenCalledTimes(1);
    },
  );

});
