import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const mock = vi.hoisted(() => ({
  build: vi.fn(),
  start: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFileSync: mock.remove }));
vi.mock('../../integration/helpers/test-resources.js', () => ({
  SSH_OWNER_LABEL: 'noodara.test.ssh-owner',
  reapOwnedSshContainers: async () => { mock.remove(); },
  dockerCli: async () => '',
}));
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

import {
  createSshDiagnostics, createSshdLifecycle, startSshd, type SshDiagnosticEvent,
} from '../../integration/helpers/ssh.js';

describe('SSH fixture startup stage evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.remove.mockReset();
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

  it('rejects an already cancelled fixture before any build starts', async () => {
    const controller = new AbortController();
    const reason = new Error('controlled cancellation');
    controller.abort(reason);

    await expect(startSshd({ ubuntu: '24.04', signal: controller.signal })).rejects.toBe(reason);
    expect(mock.build).not.toHaveBeenCalled();
    expect(mock.start).not.toHaveBeenCalled();
  });

  it('never creates a container when the held build completes after cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('controlled cancellation');
    let release!: () => void;
    mock.build.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const startup = startSshd({ ubuntu: '24.04', signal: controller.signal });
    const rejection = expect(startup).rejects.toBe(reason);
    controller.abort(reason);
    release();

    await rejection;
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

// H1 (35-03, after 35-04): diagnostic emission stays observational on every failure path. A
// sink that throws, writes to a closed stream, reports backpressure, never settles or rejects
// can neither replace the original startup outcome nor skip deadline/cancellation cleanup, and
// no raw error ever falls back to stdout/stderr.
type SinkKind = 'throwing' | 'closed' | 'backpressured' | 'unsettled' | 'rejected';
const SINK_KINDS: readonly SinkKind[] = ['throwing', 'closed', 'backpressured', 'unsettled', 'rejected'];

function hostileSink(kind: SinkKind) {
  const closed = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  closed.on('error', () => undefined);
  closed.destroy();
  return vi.fn((event: SshDiagnosticEvent): void | boolean | Promise<unknown> => {
    if (kind === 'throwing') throw new Error('synthetic-sensitive-sink-failure');
    if (kind === 'closed') return closed.write(`${JSON.stringify(event)}\n`);
    if (kind === 'backpressured') return false;
    if (kind === 'unsettled') return new Promise<void>(() => undefined);
    return Promise.reject(new Error('synthetic-sensitive-sink-rejection'));
  });
}

describe('H1: hostile diagnostic sinks never change startup outcome or skip cleanup', () => {
  let stdout: MockInstance<typeof process.stdout.write>;
  let stderr: MockInstance<typeof process.stderr.write>;
  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock.remove.mockReset();
    mock.build.mockReset();
    mock.start.mockReset();
    mock.build.mockResolvedValue({});
    mock.start.mockResolvedValue({ stop: vi.fn(), getHost: () => '127.0.0.1', getMappedPort: () => 2022 });
    stdout = vi.spyOn(process.stdout, 'write');
    stderr = vi.spyOn(process.stderr, 'write');
    consoleError = vi.spyOn(console, 'error');
  });

  afterEach(() => {
    const written = [...stdout.mock.calls, ...stderr.mock.calls, ...consoleError.mock.calls]
      .map((call) => String(call[0])).join('\n');
    stdout.mockRestore();
    stderr.mockRestore();
    consoleError.mockRestore();
    expect(written).not.toContain('synthetic-sensitive');
  });

  it.each(SINK_KINDS)('%s sink: startup failure keeps the primary rejection and still reaps the owner', async (kind) => {
    const sink = hostileSink(kind);
    const primary = new Error('synthetic-sensitive-start-failure');
    mock.start.mockRejectedValue(primary);

    await expect(startSshd({ ubuntu: '24.04', diagnostics: sink })).rejects.toBe(primary);

    expect(mock.remove).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const [event] of sink.mock.calls) expect(JSON.stringify(event)).not.toContain('synthetic-sensitive');
  });

  it.each(SINK_KINDS)('%s sink: a held build completing after cancellation never starts a container', async (kind) => {
    const sink = hostileSink(kind);
    const controller = new AbortController();
    const reason = new Error('controlled cancellation');
    let release!: () => void;
    mock.build.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const startup = startSshd({ ubuntu: '22.04', signal: controller.signal, diagnostics: sink });
    const rejection = expect(startup).rejects.toBe(reason);
    controller.abort(reason);
    release();

    await rejection;
    expect(mock.start).not.toHaveBeenCalled();
  });

  it.each(SINK_KINDS)('%s sink: a start that succeeds after the deadline is reaped and rejects with the reason', async (kind) => {
    const sink = hostileSink(kind);
    const controller = new AbortController();
    const reason = new Error('controlled deadline');
    const late = { stop: vi.fn(), getHost: () => '127.0.0.1', getMappedPort: () => 2022 };
    let release!: () => void;
    mock.start.mockImplementation(() => new Promise((resolve) => { release = () => { resolve(late); }; }));
    const startup = startSshd({ ubuntu: '24.04', signal: controller.signal, diagnostics: sink });
    const rejection = expect(startup).rejects.toBe(reason);
    await vi.waitFor(() => { expect(mock.start).toHaveBeenCalledTimes(1); });
    controller.abort(reason);
    release();

    await rejection;
    // The abort sweep and the post-settle owner sweep both ran; the stale handle got no stop.
    expect(mock.remove.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(late.stop).not.toHaveBeenCalled();
  });

  it.each(SINK_KINDS)('%s sink: lifecycle cancel rejects promptly, joins the late start and reaps its owner', async (kind) => {
    const sink = hostileSink(kind);
    const late = { stop: vi.fn(), getHost: () => '127.0.0.1', getMappedPort: () => 2022 };
    let release!: () => void;
    mock.start.mockImplementation(() => new Promise((resolve) => { release = () => { resolve(late); }; }));
    const lifecycle = createSshdLifecycle({ ubuntu: '22.04', diagnostics: sink });
    await vi.waitFor(() => { expect(mock.start).toHaveBeenCalledTimes(1); });
    const reason = new Error('controlled cancellation');
    lifecycle.cancel(reason);
    await expect(lifecycle.result).rejects.toBe(reason);

    const stopping = lifecycle.stop();
    release();
    await expect(stopping).resolves.toBeUndefined();
    await expect(lifecycle.settled).resolves.toBeUndefined();
    expect(mock.remove.mock.calls.length).toBeGreaterThanOrEqual(2);
    await expect(lifecycle.stop()).resolves.toBeUndefined();
  });

  it('excessive event production stays bounded while startup and cleanup complete', async () => {
    const accepted: SshDiagnosticEvent[] = [];
    const fixture = await startSshd({ ubuntu: '24.04', diagnostics: (event) => { accepted.push(event); } });
    await fixture.stop();
    const diagnostic = createSshDiagnostics(crypto.randomUUID(), (event) => { accepted.push(event); });
    for (let n = 0; n < 100_000; n += 1) diagnostic.record('published_port', 'timeout', new Error('synthetic-sensitive-flood'));
    expect(accepted.length).toBe(12 + 64);
    const elapsed = accepted.slice(12).map((event) => event.elapsedMs);
    expect(elapsed).toEqual([...elapsed].sort((a, b) => a - b));
    expect(Object.keys(accepted[accepted.length - 1] ?? {}).sort()).toEqual(['category', 'elapsedMs', 'outcome', 'owner', 'stage']);
    expect(JSON.stringify(accepted)).not.toContain('synthetic-sensitive');
  });
});
