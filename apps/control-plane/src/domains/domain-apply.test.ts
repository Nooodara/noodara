import { describe, expect, it } from 'vitest';
import { validateHostname, validateResourceId, type Hostname, type ResourceId } from '@noodara/domain';
import type { RemoteCommand, SshDeploySession, StreamOptions, StreamResult } from '@noodara/ssh';
import {
  applyServiceDomains,
  createServiceLock,
  renderServiceRoutes,
  withNoStoreRedirects,
  type DomainApplyLimits,
} from './domain-apply.js';

const SERVICE = (validateResourceId('0b1c2d3e-4f50-4617-8899-aabbccddeeff') as { value: ResourceId }).value;
const DOMAIN_ID = '1b1c2d3e-4f50-4617-8899-aabbccddeeff';
const HOST = (validateHostname('app.example.com') as { value: Hostname }).value;
const limits: DomainApplyLimits = { stepMs: 1000, verifyMs: 30, verifyPollMs: 10, maxLineBytes: 4096 };

type Reply = Partial<Pick<StreamResult, 'exitCode' | 'stdoutTail' | 'stderrTail' | 'outcome'>> | 'throw';

const API_UP = 'HTTP/1.1 200 OK\r\n\r\n{"status":"enabled","rule":"PathPrefix(`/api`)","service":"api@internal"}';
const ROUTER_ENABLED = 'HTTP/1.1 200 OK\r\n\r\n{"status":"enabled","rule":"Host(`app.example.com`)","service":"x"}';
const ROUTER_MISSING = 'HTTP/1.1 404 Not Found\r\n\r\n';

const OK_REPLIES: Record<string, Reply> = {
  'proxy.write_dynamic': { stdoutTail: 'NOODARA_PROXY_WRITE ok\n' },
  'proxy.restore_dynamic': { stdoutTail: 'NOODARA_PROXY_RESTORE restored\n' },
  'proxy.remove_dynamic': { stdoutTail: 'NOODARA_PROXY_REMOVE ok\n' },
  'docker.network_connect': {},
  'docker.network_disconnect': {},
  'proxy.status': { stdoutTail: ROUTER_ENABLED },
};

function fakeSession(overrides: Record<string, Reply | Reply[]> = {}) {
  const calls: { name: string; args: readonly string[]; stdin: boolean }[] = [];
  const queues = new Map<string, Reply[]>();
  for (const [name, reply] of Object.entries(overrides)) queues.set(name, Array.isArray(reply) ? [...reply] : [reply]);
  const session = {
    exec: () => Promise.reject(new Error('unused')),
    close: () => Promise.resolve(),
    stream: (command: RemoteCommand, options: StreamOptions): Promise<StreamResult> => {
      const args = (command as unknown as { args?: readonly string[] }).args ?? [];
      calls.push({ name: command.name, args, stdin: options.stdin !== undefined });
      const queued = queues.get(command.name);
      const reply =
        (queued !== undefined && queued.length > 0 ? (queued.length > 1 ? queued.shift() : queued[0]) : undefined) ??
        OK_REPLIES[command.name] ??
        {};
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

const domain = { id: DOMAIN_ID, hostname: HOST, httpsRedirect: true };
const base = { service: { id: SERVICE, internalPort: 3000 }, limits, sleep: () => Promise.resolve() };

describe('applyServiceDomains (22-03 A1)', () => {
  it('preflights the API, joins the network, writes and verifies every router', async () => {
    const fake = fakeSession({ 'proxy.status': [{ stdoutTail: API_UP }, { stdoutTail: ROUTER_ENABLED }] });
    const result = await applyServiceDomains({ ...base, session: fake.session, domains: [domain] });
    expect(result).toEqual({ ok: true, outcome: 'applied' });
    expect(fake.names()).toEqual([
      'proxy.status',
      'docker.network_connect',
      'proxy.write_dynamic',
      'proxy.status',
      'proxy.status',
    ]);
    expect(fake.calls.find((call) => call.name === 'proxy.write_dynamic')?.stdin).toBe(true);
  });

  it('answers PROXY_UNAVAILABLE without touching anything when the proxy API is down', async () => {
    const fake = fakeSession({ 'proxy.status': { stdoutTail: 'NOODARA_PROXY_API down\n', exitCode: 3 } });
    const result = await applyServiceDomains({ ...base, session: fake.session, domains: [domain] });
    expect(result).toEqual({ ok: false, code: 'PROXY_UNAVAILABLE', restored: false });
    expect(fake.names()).toEqual(['proxy.status']);
  });

  it('accepts an already joined network and a network the deploy has not created yet', async () => {
    for (const stderr of [
      'Error response from daemon: endpoint with name noodara-traefik already exists in network noodara-net-x',
      'Error response from daemon: network noodara-net-x not found',
    ]) {
      const fake = fakeSession({ 'docker.network_connect': { exitCode: 1, stderrTail: stderr } });
      const result = await applyServiceDomains({ ...base, session: fake.session, domains: [domain] });
      expect(result.ok).toBe(true);
    }
  });

  it('restores .prev and answers PROXY_ROUTE_FAILED when a router never becomes enabled', async () => {
    const fake = fakeSession({ 'proxy.status': [{ stdoutTail: API_UP }, { stdoutTail: ROUTER_MISSING }] });
    let clock = 0;
    const result = await applyServiceDomains({
      ...base,
      session: fake.session,
      domains: [domain],
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });
    expect(result).toEqual({ ok: false, code: 'PROXY_ROUTE_FAILED', restored: true });
    expect(fake.names().at(-1)).toBe('proxy.restore_dynamic');
  });

  it('a failed write never restores: the live file was not replaced', async () => {
    const fake = fakeSession({
      'proxy.status': { stdoutTail: API_UP },
      'proxy.write_dynamic': { exitCode: 4, stdoutTail: 'NOODARA_PROXY_WRITE incomplete\n' },
    });
    const result = await applyServiceDomains({ ...base, session: fake.session, domains: [domain] });
    expect(result).toEqual({ ok: false, code: 'PROXY_ROUTE_FAILED', restored: false });
    expect(fake.names()).not.toContain('proxy.restore_dynamic');
  });

  it('a render failure writes nothing', async () => {
    const fake = fakeSession({ 'proxy.status': { stdoutTail: API_UP } });
    const result = await applyServiceDomains({
      ...base,
      session: fake.session,
      domains: [domain],
      render: () => ({ ok: false, code: 'PROXY_CONFIG_PORT_INVALID', message: 'x' }),
    });
    expect(result.ok).toBe(false);
    expect(fake.names()).toEqual(['proxy.status']);
  });

  it('H3: a lost connection maps to SERVER_UNREACHABLE and drops the remote message', async () => {
    const fake = fakeSession({ 'proxy.status': { stdoutTail: API_UP }, 'proxy.write_dynamic': 'throw' });
    const result = await applyServiceDomains({ ...base, session: fake.session, domains: [domain] });
    expect(result).toEqual({ ok: false, code: 'SERVER_UNREACHABLE', restored: false });
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('A2: no domains left removes the file and disconnects the network', async () => {
    const fake = fakeSession({ 'proxy.status': { stdoutTail: API_UP } });
    const result = await applyServiceDomains({ ...base, session: fake.session, domains: [] });
    expect(result).toEqual({ ok: true, outcome: 'removed' });
    expect(fake.names()).toEqual(['proxy.status', 'proxy.remove_dynamic', 'docker.network_disconnect']);
  });

  it('A2: a network the proxy already left is not an error', async () => {
    const fake = fakeSession({
      'proxy.status': { stdoutTail: API_UP },
      'docker.network_disconnect': {
        exitCode: 1,
        stderrTail: 'Error response from daemon: container abc is not connected to network noodara-net-x',
      },
    });
    const result = await applyServiceDomains({ ...base, session: fake.session, domains: [] });
    expect(result.ok).toBe(true);
  });
});

describe('renderServiceRoutes (R1)', () => {
  it('puts a no-store headers middleware before every redirect', () => {
    const rendered = renderServiceRoutes({ id: SERVICE, internalPort: 3000 }, [domain]);
    if (!rendered.ok) throw new Error('render failed');
    const parsed = JSON.parse(rendered.value) as {
      http: { routers: Record<string, { middlewares?: string[] }>; middlewares: Record<string, unknown> };
    };
    const base = `noodara-${SERVICE}-${DOMAIN_ID}`;
    expect(parsed.http.routers[`${base}-web`]?.middlewares).toEqual([`${base}-nostore`, `${base}-redirect`]);
    expect(parsed.http.middlewares[`${base}-nostore`]).toEqual({
      headers: { customResponseHeaders: { 'Cache-Control': 'no-store' } },
    });
    expect(parsed.http.routers[`${base}-websecure`]?.middlewares).toBeUndefined();
  });

  it('leaves routers without a redirect and non-JSON input alone', () => {
    const rendered = renderServiceRoutes({ id: SERVICE, internalPort: 3000 }, [{ ...domain, httpsRedirect: false }]);
    if (!rendered.ok) throw new Error('render failed');
    expect(rendered.value).not.toContain('nostore');
    expect(withNoStoreRedirects('not json')).toBe('not json');
    expect(withNoStoreRedirects('1')).toBe('1');
  });
});

describe('createServiceLock', () => {
  it('runs one task at a time per service and survives a rejected task', async () => {
    const lock = createServiceLock();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = lock('a', async () => {
      order.push('first:start');
      await gate;
      order.push('first:end');
      throw new Error('boom');
    });
    const second = lock('a', () => {
      order.push('second');
      return Promise.resolve(2);
    });
    const other = lock('b', () => {
      order.push('other');
      return Promise.resolve(3);
    });
    await expect(other).resolves.toBe(3);
    release();
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(['first:start', 'other', 'first:end', 'second']);
  });
});
