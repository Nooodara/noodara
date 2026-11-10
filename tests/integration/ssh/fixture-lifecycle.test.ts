import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenericContainer } from 'testcontainers';
import { dockerCli } from '../helpers/test-resources.js';
import { startSshd, type SshDiagnosticEvent, type SshdFixture } from '../helpers/ssh.js';

let fixture: SshdFixture | undefined;
let sentinel: net.Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture?.stop();
  fixture = undefined;
  if (sentinel?.listening) await new Promise<void>((resolve, reject) => sentinel?.close((error) => error ? reject(error) : resolve()));
  sentinel = undefined;
});

describe('actual SSH fixture lifecycle observations', () => {
  it('cleans its owned container twice safely while a throwing observer and foreign listener remain isolated', async () => {
    sentinel = net.createServer((socket) => socket.end('sentinel'));
    await new Promise<void>((resolve) => sentinel?.listen(0, '127.0.0.1', resolve));
    const address = sentinel.address();
    if (address === null || typeof address === 'string') throw new Error('Sentinel did not bind');
    const sink = vi.fn(() => { throw new Error('synthetic-sensitive-observer'); });

    fixture = await startSshd({ ubuntu: '24.04', diagnostics: sink });
    const id = fixture.container.getId();
    await fixture.stop();
    await fixture.stop();

    expect((await dockerCli(['ps', '-aq', '--no-trunc', '--filter', `id=${id}`])).trim()).toBe('');
    expect(sink).toHaveBeenCalledTimes(1);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(address.port, '127.0.0.1');
      socket.on('data', (data: Buffer) => resolve(data.toString()));
      socket.on('error', reject);
      socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Sentinel did not respond')); });
    });
    expect(reply).toBe('sentinel');
  });

  it('reproduces a late container after an outer deadline without attributing that mechanism to historical CI', async () => {
    // Controlled diagnostic reproducer, intentionally exposing the current cancellation gap.
    // Its explicit final cleanup is the observer's responsibility; this is NOT an A5 pass.
    const events: SshDiagnosticEvent[] = [];
    let releaseBuild!: () => void;
    let markBuilt!: () => void;
    const held = new Promise<void>((resolve) => { releaseBuild = resolve; });
    const built = new Promise<void>((resolve) => { markBuilt = resolve; });
    const original = GenericContainer.fromDockerfile.bind(GenericContainer);
    vi.spyOn(GenericContainer, 'fromDockerfile').mockImplementation((...args) => {
      const builder = original(...args);
      const build = builder.build.bind(builder);
      vi.spyOn(builder, 'build').mockImplementation(async (...buildArgs) => {
        const image = await build(...buildArgs);
        markBuilt();
        await held;
        return image;
      });
      return builder;
    });
    const startup = startSshd({ ubuntu: '24.04', diagnostics: (event) => { events.push(event); } });
    // Attach immediately so a real build failure never becomes an unhandled rejection.
    void startup.catch(() => markBuilt());
    try {
      await built;
      const deadline = new Error('controlled outer test deadline');
      await expect(Promise.race([startup, Promise.reject(deadline)])).rejects.toBe(deadline);
      expect(events.some((event) => event.stage === 'container_create')).toBe(false);
      releaseBuild();
      fixture = await startup;
      const id = fixture.container.getId();
      expect((await dockerCli(['ps', '-aq', '--no-trunc', '--filter', `id=${id}`])).trim()).toBe(id);
      expect(events.some((event) => event.stage === 'ssh_readiness' && event.outcome === 'success')).toBe(true);
      await fixture.stop();
      expect((await dockerCli(['ps', '-aq', '--no-trunc', '--filter', `id=${id}`])).trim()).toBe('');
    } finally {
      releaseBuild();
      // Always join the operation, including assertion failure. Never abandon the race loser.
      const late = await startup.catch(() => undefined);
      await late?.stop();
    }
  });
});
