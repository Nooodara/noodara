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

function fakeSession(overrides: Record<string, Reply | Reply[]> = {}) {
  const calls: { name: string; stdin: boolean; maxMs: number }[] = [];
  const queues = new Map<string, Reply[]>();
  for (const [name, reply] of Object.entries(overrides)) queues.set(name, Array.isArray(reply) ? [...reply] : [reply]);
  const session = {
    exec: () => Promise.reject(new Error('unused')),
    close: () => Promise.resolve(),
    stream: (command: RemoteCommand, options: StreamOptions): Promise<StreamResult> => {
      calls.push({ name: command.name, stdin: options.stdin !== undefined, maxMs: options.maxDurationMs });
      const queued = queues.get(command.name);
      const reply = (queued !== undefined && queued.length > 0 ? (queued.length > 1 ? queued.shift() : queued[0]) : undefined) ??
        OK_REPLIES[command.name] ?? {};
      if (reply === 'throw') return Promise.reject(new Error('ssh: password=hunter2 channel closed'));
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
  return { session, calls, names: () => calls.map((call) => call.name) };
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
    ['pull', { 'docker.pull': { exitCode: 1, stderrTail: 'manifest unknown' } }],
    ['create', { 'proxy.create': { exitCode: 125, stderrTail: 'Conflict' } }],
    ['verify', { 'proxy.status': { stdoutTail: 'NOODARA_PROXY_API down\n' } }],
    ['write_config', { 'proxy.write_static': { exitCode: 4, stdoutTail: 'NOODARA_PROXY_WRITE incomplete' } }],
  ] as const)('H2: a %s failure removes the container so the retry starts clean', async (step, overrides) => {
    const fake = fakeSession(overrides);
    const result = await installProxy({ ...base, session: fake.session });
    expect(result).toMatchObject({ ok: false, code: 'PROXY_INSTALL_FAILED', step, listener: null });
    expect(fake.names().at(-1)).toBe('docker.remove');
    // The retry after the fault reaches RUNNING.
    expect((await installProxy({ ...base, session: fakeSession().session })).ok).toBe(true);
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
