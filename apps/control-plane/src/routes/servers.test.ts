// 22-07 (A4-A6): the proxy-facing `/api/servers` routes over HTTP (Fastify inject) with the real
// proxy service on an in-memory store; no database, Redis or SSH. Proves the status mapping and
// that a proxy 409 on PATCH never half-applies connection fields.
import type { ProxyStatus } from '@noodara/domain';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { servers } from '../db/schema/servers.js';
import type { ProxyServiceDeps } from '../proxy/proxy-service.js';
import type { ProxyServiceStore } from '../proxy/proxy-store.js';
import type { ConnectServerQueue } from '../queue/connect-server-queue.js';
import type { ServerServices } from '../services/server-services.js';
import { toServerView } from '../services/server-view.js';
import serversRoutes from './servers.js';

const SERVER = '01900000-0000-7000-8000-0000000000bb';

type ServerRow = typeof servers.$inferSelect;

function serverRow(status: ProxyStatus, acmeEmail: string | null): ServerRow {
  return {
    id: SERVER,
    name: 'prod-1',
    host: '10.0.0.5',
    sshPort: 22,
    sshUser: 'deployer',
    credentialId: '01900000-0000-7000-8000-0000000000cc',
    status: 'CONNECTED',
    proxyStatus: status,
    proxyErrorCode: null,
    proxyAcmeEmail: acmeEmail,
    proxyInstalledAt: null,
    proxyInstallStartedAt: null,
    hostFingerprint: null,
    pendingFingerprint: null,
    hostFingerprintCapturedAt: null,
    pendingFingerprintSeenAt: null,
    hostname: null,
    osDistribution: null,
    osVersion: null,
    arch: null,
    cpuCores: null,
    ramMb: null,
    diskTotalMb: null,
    diskUsedMb: null,
    uptimeSeconds: null,
    dockerInstalled: true,
    dockerVersion: null,
    dockerComposeVersion: null,
    dockerBuildkitAvailable: null,
    lastSeenAt: null,
    lastErrorCode: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  };
}

function buildStore(initial: { status: ProxyStatus; acmeEmail: string | null; domains?: number }) {
  const row = { domains: 0, ...initial };
  const store: ProxyServiceStore = {
    async withServerLock(_serverId, _options, fn) {
      return {
        kind: 'ok',
        value: await fn(
          {
            adminEmail: () => Promise.resolve('admin@noodara.dev'),
            countDomains: () => Promise.resolve(row.domains),
            transition: (from, to, fields) => {
              if (row.status !== from) return Promise.resolve(false);
              row.status = to;
              if (fields.acmeEmail !== undefined) row.acmeEmail = fields.acmeEmail;
              return Promise.resolve(true);
            },
            setAcmeEmail: (email) => {
              row.acmeEmail = email;
              return Promise.resolve();
            },
            recordRemoved: () => Promise.resolve(),
          },
          { status: row.status, acmeEmail: row.acmeEmail },
        ),
      };
    },
    transition: () => Promise.resolve(true),
    loadView: () => Promise.resolve(toServerView(serverRow(row.status, row.acmeEmail), 'ssh_password')),
  };
  return { row, store };
}

let apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
});

async function buildApp(store: ProxyServiceStore, services: Partial<ServerServices> = {}) {
  const app = Fastify({ logger: false as unknown as FastifyBaseLogger });
  apps.push(app);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('actor', null);
  app.addHook('onRequest', (request, _reply, done) => {
    request.actor = { type: 'system' };
    done();
  });
  const enqueue = vi.fn<ProxyServiceDeps['enqueue']>((payload) =>
    Promise.resolve({ ok: true, jobId: payload.jobId, collapsed: false }),
  );
  const remove = vi.fn(() => Promise.resolve({ ok: true as const, durationMs: 1 }));
  const deps: ProxyServiceDeps = {
    store,
    now: () => new Date('2026-11-01T10:00:00Z'),
    events: { publish: () => Promise.resolve() },
    enqueue,
    acmeCaUrl: 'https://acme.example.test/directory',
    remove,
    removeTimeoutMs: 1_000,
  };
  app.decorate('getProxyService', () => Promise.resolve(deps));
  app.decorate('getServerServices', () => Promise.resolve(services as ServerServices));
  app.decorate('getQueue', () => Promise.resolve({} as ConnectServerQueue));
  await app.register(serversRoutes);
  await app.ready();
  return { app, enqueue, remove };
}

describe('POST /api/servers/:id/proxy (22-07 A4/A6)', () => {
  it('answers 202 INSTALLING and queues the job', async () => {
    const { store } = buildStore({ status: 'NOT_INSTALLED', acmeEmail: null });
    const { app, enqueue } = await buildApp(store);
    const response = await app.inject({ method: 'POST', url: `/api/servers/${SERVER}/proxy`, payload: {} });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ id: SERVER, proxyStatus: 'INSTALLING' });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('answers 409 SERVER_BUSY for a different email while INSTALLING', async () => {
    const { store, row } = buildStore({ status: 'INSTALLING', acmeEmail: 'ops@noodara.dev' });
    const { app, enqueue } = await buildApp(store);
    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${SERVER}/proxy`,
      payload: { acmeEmail: 'new@noodara.dev' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'SERVER_BUSY' });
    expect(row.acmeEmail).toBe('ops@noodara.dev');
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('POST /api/servers/:id/proxy/remove (22-07 A4/A5)', () => {
  it('answers 409 PROXY_IN_USE while a domain exists', async () => {
    const { store } = buildStore({ status: 'RUNNING', acmeEmail: null, domains: 1 });
    const { app, remove } = await buildApp(store);
    const response = await app.inject({ method: 'POST', url: `/api/servers/${SERVER}/proxy/remove` });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'PROXY_IN_USE' });
    expect(remove).not.toHaveBeenCalled();
  });

  it('answers 409 SERVER_BUSY while INSTALLING', async () => {
    const { store } = buildStore({ status: 'INSTALLING', acmeEmail: null });
    const { app } = await buildApp(store);
    const response = await app.inject({ method: 'POST', url: `/api/servers/${SERVER}/proxy/remove` });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'SERVER_BUSY' });
  });

  it('answers 200 NOT_INSTALLED after removing a RUNNING proxy', async () => {
    const { store } = buildStore({ status: 'RUNNING', acmeEmail: null });
    const { app, remove } = await buildApp(store);
    const response = await app.inject({ method: 'POST', url: `/api/servers/${SERVER}/proxy/remove` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ proxyStatus: 'NOT_INSTALLED' });
    expect(remove).toHaveBeenCalledWith(SERVER);
  });
});

describe('PATCH /api/servers/:id (22-07 A6)', () => {
  it('a proxyAcmeEmail-only body goes to the proxy service: 409 while INSTALLING, nothing edited', async () => {
    const { store, row } = buildStore({ status: 'INSTALLING', acmeEmail: 'ops@noodara.dev' });
    const editServer = vi.fn();
    const { app } = await buildApp(store, { editServer });
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/servers/${SERVER}`,
      payload: { proxyAcmeEmail: 'new@noodara.dev' },
    });
    expect(response.statusCode).toBe(409);
    expect(row.acmeEmail).toBe('ops@noodara.dev');
    expect(editServer).not.toHaveBeenCalled();
  });

  it('re-installs a RUNNING proxy with the new email (200 INSTALLING)', async () => {
    const { store } = buildStore({ status: 'RUNNING', acmeEmail: 'ops@noodara.dev' });
    const { app, enqueue } = await buildApp(store);
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/servers/${SERVER}`,
      payload: { proxyAcmeEmail: 'new@noodara.dev' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ proxyStatus: 'INSTALLING', proxyAcmeEmail: 'new@noodara.dev' });
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ acmeEmail: 'new@noodara.dev' });
  });

  it('rejects proxyAcmeEmail mixed with connection fields (400) without editing anything', async () => {
    const { store, row } = buildStore({ status: 'RUNNING', acmeEmail: 'ops@noodara.dev' });
    const editServer = vi.fn();
    const { app, enqueue } = await buildApp(store, { editServer });
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/servers/${SERVER}`,
      payload: { name: 'renamed', proxyAcmeEmail: 'new@noodara.dev' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'VALIDATION_FAILED' });
    expect(editServer).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(row).toMatchObject({ status: 'RUNNING', acmeEmail: 'ops@noodara.dev' });
  });

  it('a connection-only body goes to editServer and never to the proxy service', async () => {
    const { store, row } = buildStore({ status: 'RUNNING', acmeEmail: 'ops@noodara.dev' });
    const view = toServerView({ ...serverRow('RUNNING', 'ops@noodara.dev'), name: 'renamed' }, 'ssh_password');
    const editServer = vi.fn(() => Promise.resolve({ ok: true as const, server: view }));
    const { app, enqueue } = await buildApp(store, { editServer });
    const response = await app.inject({ method: 'PATCH', url: `/api/servers/${SERVER}`, payload: { name: 'renamed' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: 'renamed' });
    expect(editServer).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(row.status).toBe('RUNNING');
  });
});

describe('DELETE /api/servers/:id (22-07 A5)', () => {
  it('maps a SERVER_BUSY refusal (proxy INSTALLING) to 409', async () => {
    const { store } = buildStore({ status: 'INSTALLING', acmeEmail: null });
    const deleteServer = vi.fn(() =>
      Promise.resolve({ ok: false as const, code: 'SERVER_BUSY' as const, message: 'A proxy install is in progress on this server' }),
    );
    const { app } = await buildApp(store, { deleteServer });
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/servers/${SERVER}`,
      payload: { confirmName: 'prod-1' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'SERVER_BUSY' });
  });
});
