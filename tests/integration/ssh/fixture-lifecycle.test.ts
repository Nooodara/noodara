import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenericContainer } from 'testcontainers';
import { dockerCli, SSH_OWNER_LABEL } from '../helpers/test-resources.js';
import { createSshdLifecycle, startSshd, type SshDiagnosticEvent, type SshdFixture, type SshdLifecycle } from '../helpers/ssh.js';

const selected = process.env['NOODARA_TEST_UBUNTU'];
const versions = selected === '22.04' || selected === '24.04' ? [selected] as const : ['22.04', '24.04'] as const;
let fixtures: SshdFixture[] = [];
let owners: SshdLifecycle[] = [];
let sentinel: net.Server | undefined;
function recordEvents(events: SshDiagnosticEvent[]): (event: SshDiagnosticEvent) => void {
  return (event) => {
    events.push(event);
    if (process.env['NOODARA_SSH_DIAGNOSTICS'] === '1') {
      // The helper constructs these bounded, allowlisted events without exception details.
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
  };
}
async function trackedStart(options: Parameters<typeof startSshd>[0]): Promise<SshdFixture> {
  const owner = createSshdLifecycle(options);
  owners.push(owner);
  return owner.result;
}
afterEach(async () => {
  vi.restoreAllMocks();
  const results = await Promise.allSettled([...owners.map((owner) => owner.stop()), ...fixtures.map((fixture) => fixture.stop())]);
  fixtures = [];
  owners = [];
  if (sentinel?.listening) await new Promise<void>((resolve, reject) => sentinel?.close((error) => error ? reject(error) : resolve()));
  sentinel = undefined;
  if (results.some((result) => result.status === 'rejected')) throw new Error('Lifecycle cleanup unverified');
});

async function absent(owner: string): Promise<void> {
  expect((await dockerCli(['ps', '-aq', '--no-trunc', '--filter', `label=${SSH_OWNER_LABEL}=${owner}`])).trim()).toBe('');
}

for (const ubuntu of versions) {
  describe(`real SSH fixture lifecycle Ubuntu ${ubuntu}`, () => {
    for (const cache of ['cold', 'warm'] as const) {
      it(`builds and reaches SSH readiness (${cache}), stops twice, and preserves a foreign listener`, async () => {
        if (cache === 'cold') {
          // Bypass fixture layers for this owned build without deleting shared images/cache.
          // The existing base image may remain local; no registry-cold claim is implied.
          const fromDockerfile = GenericContainer.fromDockerfile.bind(GenericContainer);
          vi.spyOn(GenericContainer, 'fromDockerfile').mockImplementation((...args) =>
            fromDockerfile(...args).withCache(false));
        }
        sentinel = net.createServer((socket) => socket.end('sentinel'));
        await new Promise<void>((resolve) => sentinel?.listen(0, '127.0.0.1', resolve));
        const address = sentinel.address();
        if (address === null || typeof address === 'string') throw new Error('Sentinel did not bind');
        const events: SshDiagnosticEvent[] = [];
        const fixture = await trackedStart({ ubuntu, diagnostics: recordEvents(events) });
        fixtures.push(fixture);
        expect(events.some((event) => event.stage === 'ssh_readiness' && event.outcome === 'success')).toBe(true);
        await fixture.stop();
        await fixture.stop();
        const owner = events[0]?.owner;
        if (owner === undefined) throw new Error('Missing fixture owner');
        await absent(owner);
        const reply = await new Promise<string>((resolve, reject) => {
          const socket = net.connect(address.port, '127.0.0.1');
          socket.on('data', (data: Buffer) => { socket.destroy(); resolve(data.toString()); });
          socket.on('error', reject);
          socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Sentinel did not respond')); });
        });
        expect(reply).toBe('sentinel');
      });
    }

    it('joins a held real build after cancellation without creating a container, preserving a later concurrent owner', async () => {
      const events: SshDiagnosticEvent[] = [];
      let release!: () => void;
      let built!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const reached = new Promise<void>((resolve) => { built = resolve; });
      const original = GenericContainer.fromDockerfile.bind(GenericContainer);
      let first = true;
      vi.spyOn(GenericContainer, 'fromDockerfile').mockImplementation((...args) => {
        const builder = original(...args);
        if (!first) return builder;
        first = false;
        const build = builder.build.bind(builder);
        vi.spyOn(builder, 'build').mockImplementation(async (...buildArgs) => {
          const image = await build(...buildArgs);
          built();
          await held;
          return image;
        });
        return builder;
      });
      const owner = createSshdLifecycle({ ubuntu, diagnostics: recordEvents(events) });
      owners.push(owner);
      try {
        // Startup failure/cancellation must reject this wait; it must never authorize
        // creating the other owner after Vitest has already entered teardown.
        await Promise.race([reached, owner.result]);
        const other = await trackedStart({ ubuntu });
        fixtures.push(other);
        const otherId = other.container.getId();
        const primary = new Error('controlled outer test deadline');
        owner.cancel(primary);
        await expect(owner.result).rejects.toBe(primary);
        release();
        await owner.stop();
        await owner.settled;
        expect(events.some((event) => event.stage === 'container_create')).toBe(false);
        const ownerId = events[0]?.owner;
        if (ownerId === undefined) throw new Error('Missing fixture owner');
        await absent(ownerId);
        expect((await dockerCli(['ps', '-aq', '--no-trunc', '--filter', `id=${otherId}`])).trim()).toBe(otherId);
        await other.stop();
      } finally { release(); await owner.settled; }
    });

    it('reaps an actual late start handle after cancellation and preserves a foreign container created later', async () => {
      const events: SshDiagnosticEvent[] = [];
      let release!: () => void;
      let started!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const reached = new Promise<void>((resolve) => { started = resolve; });
      const original = GenericContainer.prototype.start;
      let first = true;
      vi.spyOn(GenericContainer.prototype, 'start').mockImplementation(async function (this: GenericContainer) {
        if (!first) return original.call(this);
        first = false;
        const handle = await original.call(this);
        started();
        await held;
        return handle;
      });
      const owner = createSshdLifecycle({ ubuntu, diagnostics: recordEvents(events) });
      owners.push(owner);
      try {
        await Promise.race([reached, owner.result]);
        const other = await trackedStart({ ubuntu });
        fixtures.push(other);
        const id = other.container.getId();
        owner.cancel(new Error('controlled outer deadline'));
        await expect(owner.result).rejects.toThrow('controlled outer deadline');
        release();
        await owner.stop();
        const ownerId = events[0]?.owner;
        if (ownerId === undefined) throw new Error('Missing fixture owner');
        await absent(ownerId);
        expect((await dockerCli(['ps', '-aq', '--no-trunc', '--filter', `id=${id}`])).trim()).toBe(id);
        await other.stop();
      } finally { release(); await owner.settled; }
    });
  });
}
