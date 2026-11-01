import { describe, expect, it } from 'vitest';
import { renderStaticConfig, validateResourceId, type ResourceId } from '@noodara/domain';
import type { RemoteCommand, SshDeploySession, StreamOptions, StreamResult } from '@noodara/ssh';
import { installProxy, removeProxy, sanitizeListenerName, type ProxyRuntimeLimits } from './proxy-runtime.js';

const IMAGE = 'traefik:v3.7.14@sha256:575fa15b135078fe5e50aa847987d96dbddd7b093c172429618404df73f3fa7c';
const rendered = renderStaticConfig({ email: 'ops@example.com', caUrl: 'https://acme.example.com/dir' });
if (!rendered.ok) throw new Error('fixture');
const config = rendered.value;
const SERVICE = (validateResourceId('0b1c2d3e-4f50-4617-8899-aabbccddeeff') as { value: ResourceId }).value;
const limits: ProxyRuntimeLimits = { stepMs: 1000, pullMs: 5000, verifyMs: 50, verifyPollMs: 10, maxLineBytes: 4096 };

type Reply = Partial<Pick<StreamResult, 'exitCode' | 'stdoutTail' | 'stderrTail' | 'outcome'>> | 'throw';

const OK_REPLIES: Record<string, Reply> = {
  'proxy.ports_in_use': { stdoutTail: 'NOODARA_PORTS done\n' },
  'proxy.prepare_dirs': { stdoutTail: 'NOODARA_PROXY_DIRS ready\n' },
  'proxy.write_static': { stdoutTail: 'NOODARA_PROXY_WRITE ok\n' },
  'proxy.write_dynamic': { stdoutTail: 'NOODARA_PROXY_WRITE ok\n' },
  'docker.pull': {},
  'docker.remove': { exitCode: 1, stderrTail: 'Error response from daemon: No such container: noodara-traefik' },
  'proxy.create': { stdoutTail: 'abc123\n' },
  'docker.network_connect': {},
  'docker.start': {},
  'proxy.status': { stdoutTail: 'HTTP/1.1 404 Not Found\r\n\r\n' },
  'proxy.remove_files': { stdoutTail: 'NOODARA_PROXY_PURGE ok\n' },
};

/**
 * A fake server with state: `container` is what `docker ps -a` would show for noodara-traefik
 * (`running` once started). `clearFaults()` drops the overrides so a retry runs against the same
 * state the faulted attempt left behind (22-07 A3).
 */
function fakeSession(overrides: Record<string, Reply | Reply[]> = {}, initial: { container: 'none' | 'created' | 'running' } = { container: 'none' }) {
  const calls: { name: string; stdin: boolean; maxMs: number }[] = [];
  const queues = new Map<string, Reply[]>();
  const state = { container: initial.container };
  for (const [name, reply] of Object.entries(overrides)) queues.set(name, Array.isArray(reply) ? [...reply] : [reply]);
  const stateful = (name: string): Reply | undefined => {
    if (name === 'docker.remove') {
      return state.container === 'none'
        ? OK_REPLIES['docker.remove']
        : {};
    }
    if (name === 'docker.start' && state.container === 'none') return { exitCode: 1, stderrTail: 'No such container: noodara-traefik' };
    if (name === 'proxy.create' && state.container !== 'none') return { exitCode: 125, stderrTail: 'Conflict. The container name is already in use' };
    if (name === 'proxy.status' && state.container !== 'running') return { stdoutTail: 'NOODARA_PROXY_API down\n' };
    return undefined;
  };
  const apply = (name: string, ok: boolean) => {
    if (!ok) return;
    if (name === 'docker.remove') state.container = 'none';
    if (name === 'proxy.create') state.container = 'created';
    if (name === 'docker.start') state.container = 'running';
  };
  const session = {
    exec: () => Promise.reject(new Error('unused')),
    close: () => Promise.resolve(),
    stream: (command: RemoteCommand, options: StreamOptions): Promise<StreamResult> => {
      calls.push({ name: command.name, stdin: options.stdin !== undefined, maxMs: options.maxDurationMs });
      const queued = queues.get(command.name);
      const reply = (queued !== undefined && queued.length > 0 ? (queued.length > 1 ? queued.shift() : queued[0]) : undefined) ??
        stateful(command.name) ?? OK_REPLIES[command.name] ?? {};
      if (reply === 'throw') return Promise.reject(new Error('ssh: password=hunter2 channel closed'));
      apply(command.name, (reply.exitCode ?? 0) === 0 && (reply.outcome ?? 'completed') === 'completed');
      return Promise.resolve({
        commandName: command.name,
        outcome: reply.outcome ?? 'completed',
        exitCode: reply.exitCode ?? 0,
        exitSignal: null,
        durationMs: 1,
        totalBytes: 0,
        truncated: false,
        stdoutTail: reply.stdoutTail ?? '',
        stderrTail: reply.stderrTail ?? '',
      });
    },
  } as unknown as SshDeploySession;
  return {
    session,
    calls,
    state,
    names: () => calls.map((call) => call.name),
    clearFaults: () => {
      queues.clear();
      calls.length = 0;
    },
  };
}

const base = { image: IMAGE, config, caRoot: null, routedServiceIds: [], limits, sleep: () => Promise.resolve() };

describe('installProxy (22-02 A1)', () => {
  it('runs preflight, dirs, config, pull, recreate, start and the API check in order', async () => {
    const fake = fakeSession();
    const result = await installProxy({ ...base, session: fake.session, routedServiceIds: [SERVICE] });
    expect(result.ok).toBe(true);
    expect(fake.names()).toEqual([
      'proxy.ports_in_use',
      'proxy.prepare_dirs',
      'proxy.write_static',
      'proxy.write_dynamic',
      'docker.pull',
      'docker.remove',
      'proxy.create',
      'docker.network_connect',
      'docker.start',
      'proxy.status',
    ]);
    expect(fake.calls.filter((call) => call.stdin).map((call) => call.name)).toEqual([
      'proxy.write_static',
      'proxy.write_dynamic',
    ]);
    expect(fake.calls.find((call) => call.name === 'docker.pull')?.maxMs).toBe(limits.pullMs);
    expect(fake.calls.every((call) => call.maxMs > 0)).toBe(true);
  });

  it('writes the CA root when one is set', async () => {
    const fake = fakeSession();
    await installProxy({ ...base, session: fake.session, caRoot: '-----BEGIN CERTIFICATE-----\nx\n' });
    expect(fake.names().filter((name) => name === 'proxy.write_static')).toHaveLength(2);
  });

  it('a foreign listener on 80 fails PROXY_PORT_IN_USE naming the process, before touching anything', async () => {
    const fake = fakeSession({
      'proxy.ports_in_use': {
        stdoutTail: 'S LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812,fd=6))\nNOODARA_PORTS done\n',
      },
    });
    const result = await installProxy({ ...base, session: fake.session });
    expect(result).toMatchObject({ ok: false, code: 'PROXY_PORT_IN_USE', step: 'ports', listener: { port: 80, process: 'nginx' } });
    expect(fake.names()).toEqual(['proxy.ports_in_use']);
  });

  it('a start that cannot bind is PROXY_PORT_IN_USE too', async () => {
    const fake = fakeSession({ 'docker.start': { exitCode: 1, stderrTail: 'Bind for 0.0.0.0:80 failed: port is already allocated' } });
    expect(await installProxy({ ...base, session: fake.session })).toMatchObject({ ok: false, code: 'PROXY_PORT_IN_USE', step: 'start' });
  });

  it.each([
    ['create', { 'proxy.create': { exitCode: 125, stderrTail: 'Conflict' } }],
    ['network', { 'docker.network_connect': { exitCode: 1, stderrTail: 'network not found' } }],
    ['start', { 'docker.start': { exitCode: 1, stderrTail: 'OCI runtime create failed' } }],
    ['verify', { 'proxy.status': { stdoutTail: 'NOODARA_PROXY_API down\n' } }],
  ] as const)('H2: a %s failure removes the container it created; the retry on the same server reaches RUNNING', async (step, overrides) => {
    const fake = fakeSession(overrides);
    const result = await installProxy({ ...base, session: fake.session, routedServiceIds: [SERVICE] });
    expect(result).toMatchObject({ ok: false, code: 'PROXY_INSTALL_FAILED', step, listener: null });
    expect(fake.names().at(-1)).toBe('docker.remove');
    expect(fake.state.container).toBe('none');
    // A3: the retry runs against the state the faulted attempt left behind, not a fresh fake.
    fake.clearFaults();
    expect((await installProxy({ ...base, session: fake.session, routedServiceIds: [SERVICE] })).ok).toBe(true);
    expect(fake.state.container).toBe('running');
  });

  it.each([
    ['prepare_dirs', { 'proxy.prepare_dirs': { exitCode: 3, stdoutTail: 'NOODARA_PROXY_DIRS failed' } }],
    ['write_config', { 'proxy.write_static': { exitCode: 4, stdoutTail: 'NOODARA_PROXY_WRITE incomplete' } }],
    ['write_config', { 'proxy.write_dynamic': 'throw' }],
    ['pull', { 'docker.pull': { exitCode: 1, stderrTail: 'manifest unknown' } }],
  ] as const)('22-07 A1: a %s failure on a RUNNING proxy leaves its container untouched', async (step, overrides) => {
    const fake = fakeSession(overrides, { container: 'running' });
    const result = await installProxy({ ...base, session: fake.session });
    expect(result).toMatchObject({ ok: false, code: 'PROXY_INSTALL_FAILED', step });
    expect(fake.names()).not.toContain('docker.remove');
    expect(fake.names()).not.toContain('proxy.create');
    expect(fake.state.container).toBe('running');
    // A3: the retry from that same state replaces the container and reaches RUNNING.
    fake.clearFaults();
    expect((await installProxy({ ...base, session: fake.session })).ok).toBe(true);
    expect(fake.names()).toContain('docker.remove');
    expect(fake.state.container).toBe('running');
  });

  it('22-07 A7: verify keeps polling while the API is starting', async () => {
    const fake = fakeSession({
      'proxy.status': [
        { stdoutTail: 'NOODARA_PROXY_API starting\n' },
        { stdoutTail: 'NOODARA_PROXY_API starting\n' },
        { stdoutTail: 'HTTP/1.1 404 Not Found\r\n\r\n' },
      ],
    });
    expect((await installProxy({ ...base, session: fake.session, limits: { ...limits, verifyMs: 10_000 } })).ok).toBe(true);
    expect(fake.names().filter((name) => name === 'proxy.status')).toHaveLength(3);
  });

  it('22-07 A7: an API stuck starting past the deadline fails verify', async () => {
    const fake = fakeSession({ 'proxy.status': { stdoutTail: 'NOODARA_PROXY_API starting\n' } });
    expect(await installProxy({ ...base, session: fake.session })).toMatchObject({ ok: false, step: 'verify' });
  });

  it('verify polls until the API answers', async () => {
    const fake = fakeSession({
      'proxy.status': [{ stdoutTail: 'NOODARA_PROXY_API down\n' }, { stdoutTail: 'HTTP/1.1 404 Not Found\r\n\r\n' }],
    });
    expect((await installProxy({ ...base, session: fake.session, limits: { ...limits, verifyMs: 10_000 } })).ok).toBe(true);
    expect(fake.names().filter((name) => name === 'proxy.status')).toHaveLength(2);
  });

  it('a dropped session is PROXY_INSTALL_FAILED and never surfaces the error text', async () => {
    const fake = fakeSession({ 'docker.pull': 'throw' });
    const result = await installProxy({ ...base, session: fake.session });
    expect(result).toMatchObject({ ok: false, code: 'PROXY_INSTALL_FAILED', step: 'pull' });
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('an invalid image never reaches the server', async () => {
    const fake = fakeSession();
    expect((await installProxy({ ...base, image: 'Traefik latest', session: fake.session })).ok).toBe(false);
    expect(fake.names()).not.toContain('proxy.create');
  });
});

describe('removeProxy (22-02 A3)', () => {
  it('removes the container then the files; an absent container is settled', async () => {
    const fake = fakeSession();
    expect((await removeProxy({ session: fake.session, limits })).ok).toBe(true);
    expect(fake.names()).toEqual(['docker.remove', 'proxy.remove_files']);
  });

  it.each([
    ['docker.remove', { exitCode: 1, stderrTail: 'permission denied' }],
    ['proxy.remove_files', { exitCode: 3, stdoutTail: 'NOODARA_PROXY_PURGE failed' }],
    ['docker.remove', 'throw'],
  ] as const)('%s failing is PROXY_UNAVAILABLE', async (name, reply) => {
    const fake = fakeSession({ [name]: reply });
    expect(await removeProxy({ session: fake.session, limits })).toMatchObject({ ok: false, code: 'PROXY_UNAVAILABLE' });
  });
});

describe('sanitizeListenerName', () => {
  it.each([
    ['nginx', 'nginx'],
    ['docker-proxy', 'docker_proxy'],
    ['/usr/sbin/apache2', null],
    [null, null],
    ['9x', null],
  ] as const)('%s -> %s', (raw, expected) => {
    expect(sanitizeListenerName(raw)).toBe(expected);
  });
});
