// 22-07 (A4-A6): the proxy request side against an in-memory store. The fake mirrors the Drizzle
// store's contract: a try-lock per server (busy while another change holds it), conditional
// status writes (CAS on `from`) and `rowLock` recorded so the removal path can be asserted.
import type { ProxyStatus } from '@noodara/domain';
import { describe, expect, it, vi } from 'vitest';
import type { ProxyInstallJobPayload } from '../queue/proxy-job-payload.js';
import type { ProxyEnqueueResult } from '../queue/proxy-queue.js';
import type { ServerView } from '../services/server-view.js';
import type { ProxyRemoveResult } from './proxy-runtime.js';
import {
  removeServerProxy,
  requestProxyInstall,
  setProxyAcmeEmail,
  type ProxyServiceDeps,
  type ProxyServiceResult,
} from './proxy-service.js';
import type { ProxyLockedStore, ProxyServiceStore, ProxyTrigger } from './proxy-store.js';

const SERVER = '01900000-0000-7000-8000-0000000000aa';
const ACTOR = { type: 'system' } as const;
const CA_URL = 'https://acme.example.test/directory';
const ADMIN = 'admin@noodara.dev';

interface FakeRow {
  status: ProxyStatus;
  acmeEmail: string | null;
  domains: number;
}

interface Removal {
  readonly ok: boolean;
  readonly trigger: ProxyTrigger;
}

function buildFake(initial: Partial<FakeRow> | null, adminEmail: string | null = ADMIN) {
  const row: FakeRow | null = initial === null ? null : { status: 'NOT_INSTALLED', acmeEmail: null, domains: 0, ...initial };
  const state = { held: false, lockModes: [] as boolean[], removals: [] as Removal[] };
  const transition = (from: ProxyStatus, to: ProxyStatus, fields: { acmeEmail?: string }): Promise<boolean> => {
    if (row?.status !== from) return Promise.resolve(false);
    row.status = to;
    if (fields.acmeEmail !== undefined) row.acmeEmail = fields.acmeEmail;
    return Promise.resolve(true);
  };
  const store: ProxyServiceStore = {
    async withServerLock(_serverId, options, fn) {
      state.lockModes.push(options.rowLock);
      if (row === null) return { kind: 'missing' };
      if (state.held) return { kind: 'busy' };
      state.held = true;
      try {
        const locked: ProxyLockedStore = {
          adminEmail: () => Promise.resolve(adminEmail),
          countDomains: () => Promise.resolve(row.domains),
          transition,
          setAcmeEmail: (email) => {
            row.acmeEmail = email;
            return Promise.resolve();
          },
          recordRemoved: (_at, input) => {
            state.removals.push({ ok: input.ok, trigger: input.trigger });
            return Promise.resolve();
          },
        };
        return { kind: 'ok', value: await fn(locked, { status: row.status, acmeEmail: row.acmeEmail }) };
      } finally {
        state.held = false;
      }
    },
    transition: (_serverId, from, to, fields) => transition(from, to, fields),
    loadView: (serverId) =>
      Promise.resolve(
        row === null ? null : ({ id: serverId, proxyStatus: row.status, proxyAcmeEmail: row.acmeEmail } as unknown as ServerView),
      ),
  };
  return { row, state, store };
}

function buildDeps(
  store: ProxyServiceStore,
  overrides: {
    enqueue?: (payload: ProxyInstallJobPayload) => Promise<ProxyEnqueueResult>;
    remove?: (serverId: string) => Promise<ProxyRemoveResult>;
  } = {},
) {
  const enqueued: ProxyInstallJobPayload[] = [];
  const published: unknown[] = [];
  const remove = vi.fn(overrides.remove ?? (() => Promise.resolve<ProxyRemoveResult>({ ok: true, durationMs: 5 })));
  const deps: ProxyServiceDeps = {
    store,
    now: () => new Date('2026-11-01T10:00:00Z'),
    events: {
      publish: (event) => {
        published.push(event);
        return Promise.resolve();
      },
    },
    enqueue:
      overrides.enqueue ??
      ((payload) => {
        enqueued.push(payload);
        return Promise.resolve({ ok: true, jobId: payload.jobId, collapsed: false });
      }),
    acmeCaUrl: CA_URL,
    remove,
    removeTimeoutMs: 1_000,
  };
  return { deps, enqueued, published, remove };
}

function failureCode(result: ProxyServiceResult): string {
  if (result.ok) throw new Error('expected a failure');
  return result.code;
}

describe('requestProxyInstall (22-02 A1, 22-07 A4/A6)', () => {
  it('rejects a malformed body email before touching the store', async () => {
    const { store, state } = buildFake({});
    const { deps } = buildDeps(store);
    expect(failureCode(await requestProxyInstall(deps, { actor: ACTOR, serverId: SERVER, acmeEmail: 'not an email' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(state.lockModes).toEqual([]);
  });

  it('answers NOT_FOUND for an unknown server', async () => {
    const { store } = buildFake(null);
    const { deps, enqueued } = buildDeps(store);
    expect(failureCode(await requestProxyInstall(deps, { actor: ACTOR, serverId: SERVER }))).toBe('NOT_FOUND');
    expect(enqueued).toEqual([]);
  });

  it('moves NOT_INSTALLED to INSTALLING under a row lock and queues one job with the admin email', async () => {
    const { store, row, state } = buildFake({});
    const { deps, enqueued, published } = buildDeps(store);
    const result = await requestProxyInstall(deps, { actor: ACTOR, serverId: SERVER });
    expect(result).toMatchObject({ ok: true, server: { proxyStatus: 'INSTALLING' } });
    expect(row?.status).toBe('INSTALLING');
    expect(state.lockModes).toEqual([true]);
    expect(enqueued).toEqual([{ serverId: SERVER, acmeEmail: ADMIN, jobId: `proxy-install-${SERVER}` }]);
    expect(published).toHaveLength(1);
  });

  it('stores the body email and queues the job with it', async () => {
    const { store, row } = buildFake({ status: 'FAILED', acmeEmail: 'old@noodara.dev' });
    const { deps, enqueued } = buildDeps(store);
    await requestProxyInstall(deps, { actor: ACTOR, serverId: SERVER, acmeEmail: 'ops@noodara.dev' });
    expect(row).toMatchObject({ status: 'INSTALLING', acmeEmail: 'ops@noodara.dev' });
    expect(enqueued[0]?.acmeEmail).toBe('ops@noodara.dev');
  });

  it('asks for an email when neither the body, the server nor an admin has one', async () => {
    const { store, row } = buildFake({}, null);
    const { deps, enqueued } = buildDeps(store);
    expect(failureCode(await requestProxyInstall(deps, { actor: ACTOR, serverId: SERVER }))).toBe('VALIDATION_FAILED');
    expect(row?.status).toBe('NOT_INSTALLED');
    expect(enqueued).toEqual([]);
  });

  it('joins a pending install with the same (or no) email without a second transition', async () => {
    const { store, row } = buildFake({ status: 'INSTALLING', acmeEmail: 'ops@noodara.dev' });
    const { deps, enqueued } = buildDeps(store);
    expect((await requestProxyInstall(deps, { actor: ACTOR, serverId: SERVER })).ok).toBe(true);
    expect((await requestProxyInstall(deps, { actor: ACTOR, serverId: SERVER, acmeEmail: 'ops@noodara.dev' })).ok).toBe(true);
    expect(row?.status).toBe('INSTALLING');
    expect(enqueued.map((payload) => payload.acmeEmail)).toEqual(['ops@noodara.dev', 'ops@noodara.dev']);
  });

  it('A6: refuses a different email while INSTALLING (409) and leaves the stored email alone', async () => {
    const { store, row } = buildFake({ status: 'INSTALLING', acmeEmail: 'ops@noodara.dev' });
    const { deps, enqueued } = buildDeps(store);
    const result = await requestProxyInstall(deps, { actor: ACTOR, serverId: SERVER, acmeEmail: 'new@noodara.dev' });
    expect(failureCode(result)).toBe('SERVER_BUSY');
    expect(row?.acmeEmail).toBe('ops@noodara.dev');
    expect(enqueued).toEqual([]);
  });

  it('answers SERVER_BUSY while another proxy change holds the lock', async () => {
    const { store, state, row } = buildFake({});
    const { deps } = buildDeps(store);
    state.held = true;
    expect(failureCode(await requestProxyInstall(deps, { actor: ACTOR, serverId: SERVER }))).toBe('SERVER_BUSY');
    expect(row?.status).toBe('NOT_INSTALLED');
  });

  it('ends FAILED when the queue is down, but leaves a joined INSTALLING row alone', async () => {
    const down = () => Promise.resolve<ProxyEnqueueResult>({ ok: false, code: 'QUEUE_UNAVAILABLE', message: 'Queue unavailable' });
    const fresh = buildFake({});
    const result = await requestProxyInstall(buildDeps(fresh.store, { enqueue: down }).deps, { actor: ACTOR, serverId: SERVER });
    expect(failureCode(result)).toBe('QUEUE_UNAVAILABLE');
    expect(fresh.row?.status).toBe('FAILED');

    const joined = buildFake({ status: 'INSTALLING', acmeEmail: 'ops@noodara.dev' });
    await requestProxyInstall(buildDeps(joined.store, { enqueue: down }).deps, { actor: ACTOR, serverId: SERVER });
    expect(joined.row?.status).toBe('INSTALLING');
  });
});

describe('setProxyAcmeEmail (22-02 A2, 22-07 A6)', () => {
  it('rejects a malformed address', async () => {
    const { store } = buildFake({});
    const { deps } = buildDeps(store);
    expect(failureCode(await setProxyAcmeEmail(deps, { actor: ACTOR, serverId: SERVER, acmeEmail: 'x' }))).toBe('VALIDATION_FAILED');
  });

  it('A6: refuses a change while INSTALLING (409): the pending job keeps the email it was queued with', async () => {
    const { store, row } = buildFake({ status: 'INSTALLING', acmeEmail: 'ops@noodara.dev' });
    const { deps, enqueued } = buildDeps(store);
    const result = await setProxyAcmeEmail(deps, { actor: ACTOR, serverId: SERVER, acmeEmail: 'new@noodara.dev' });
    expect(failureCode(result)).toBe('SERVER_BUSY');
    expect(row?.acmeEmail).toBe('ops@noodara.dev');
    expect(enqueued).toEqual([]);
  });

  it('re-installs a RUNNING proxy with the new email carried by the job', async () => {
    const { store, row } = buildFake({ status: 'RUNNING', acmeEmail: 'ops@noodara.dev' });
    const { deps, enqueued } = buildDeps(store);
    const result = await setProxyAcmeEmail(deps, { actor: ACTOR, serverId: SERVER, acmeEmail: 'new@noodara.dev' });
    expect(result).toMatchObject({ ok: true, server: { proxyStatus: 'INSTALLING', proxyAcmeEmail: 'new@noodara.dev' } });
    expect(row).toMatchObject({ status: 'INSTALLING', acmeEmail: 'new@noodara.dev' });
    expect(enqueued).toEqual([{ serverId: SERVER, acmeEmail: 'new@noodara.dev', jobId: `proxy-install-${SERVER}` }]);
  });

  it('only stores the email when the proxy is not running or the email is unchanged', async () => {
    for (const initial of [
      { status: 'NOT_INSTALLED' as const, acmeEmail: null },
      { status: 'FAILED' as const, acmeEmail: 'old@noodara.dev' },
      { status: 'RUNNING' as const, acmeEmail: 'new@noodara.dev' },
    ]) {
      const { store, row } = buildFake(initial);
      const { deps, enqueued } = buildDeps(store);
      expect((await setProxyAcmeEmail(deps, { actor: ACTOR, serverId: SERVER, acmeEmail: 'new@noodara.dev' })).ok).toBe(true);
      expect(row).toMatchObject({ status: initial.status, acmeEmail: 'new@noodara.dev' });
      expect(enqueued).toEqual([]);
    }
  });

  it('answers NOT_FOUND and SERVER_BUSY from the lock', async () => {
    const missing = buildFake(null);
    expect(
      failureCode(await setProxyAcmeEmail(buildDeps(missing.store).deps, { actor: ACTOR, serverId: SERVER, acmeEmail: 'a@b.dev' })),
    ).toBe('NOT_FOUND');
    const busy = buildFake({});
    busy.state.held = true;
    expect(
      failureCode(await setProxyAcmeEmail(buildDeps(busy.store).deps, { actor: ACTOR, serverId: SERVER, acmeEmail: 'a@b.dev' })),
    ).toBe('SERVER_BUSY');
  });
});

describe('removeServerProxy (22-02 A3, 22-07 A5)', () => {
  it('answers PROXY_IN_USE while a domain exists, without reaching the server', async () => {
    const { store, row } = buildFake({ status: 'RUNNING', domains: 1 });
    const { deps, remove } = buildDeps(store);
    expect(failureCode(await removeServerProxy(deps, { actor: ACTOR, serverId: SERVER }))).toBe('PROXY_IN_USE');
    expect(remove).not.toHaveBeenCalled();
    expect(row?.status).toBe('RUNNING');
  });

  it('answers SERVER_BUSY while INSTALLING, without reaching the server', async () => {
    const { store } = buildFake({ status: 'INSTALLING' });
    const { deps, remove } = buildDeps(store);
    expect(failureCode(await removeServerProxy(deps, { actor: ACTOR, serverId: SERVER }))).toBe('SERVER_BUSY');
    expect(remove).not.toHaveBeenCalled();
  });

  it('is a no-op on NOT_INSTALLED', async () => {
    const { store, state } = buildFake({});
    const { deps, remove } = buildDeps(store);
    expect(await removeServerProxy(deps, { actor: ACTOR, serverId: SERVER })).toMatchObject({
      ok: true,
      server: { proxyStatus: 'NOT_INSTALLED' },
    });
    expect(remove).not.toHaveBeenCalled();
    expect(state.removals).toEqual([]);
  });

  it('removes a RUNNING proxy under the proxy lock without a row lock, then NOT_INSTALLED', async () => {
    const { store, row, state } = buildFake({ status: 'RUNNING' });
    const { deps, remove } = buildDeps(store);
    expect((await removeServerProxy(deps, { actor: ACTOR, serverId: SERVER })).ok).toBe(true);
    expect(remove).toHaveBeenCalledWith(SERVER);
    expect(state.lockModes).toEqual([false]);
    expect(row?.status).toBe('NOT_INSTALLED');
    expect(state.removals).toEqual([{ ok: true, trigger: 'request' }]);
  });

  it('records a failed removal and keeps the status (PROXY_UNAVAILABLE)', async () => {
    const { store, row, state } = buildFake({ status: 'FAILED' });
    const { deps } = buildDeps(store, { remove: () => Promise.reject(new Error('ssh: ECONNREFUSED')) });
    const result = await removeServerProxy(deps, { actor: ACTOR, serverId: SERVER });
    expect(failureCode(result)).toBe('PROXY_UNAVAILABLE');
    expect(JSON.stringify(result)).not.toContain('ECONNREFUSED');
    expect(row?.status).toBe('FAILED');
    expect(state.removals).toEqual([{ ok: false, trigger: 'request' }]);
  });

  it('returns SERVER_BUSY when the ->NOT_INSTALLED transition does not apply', async () => {
    const fake = buildFake({ status: 'RUNNING' });
    const { deps } = buildDeps(fake.store, {
      remove: () => {
        // Another writer moved the row while the server was being reached.
        if (fake.row !== null) fake.row.status = 'FAILED';
        return Promise.resolve({ ok: true, durationMs: 3 });
      },
    });
    expect(failureCode(await removeServerProxy(deps, { actor: ACTOR, serverId: SERVER }))).toBe('SERVER_BUSY');
    expect(fake.row?.status).toBe('FAILED');
  });

  it('serialises with install: a request during the removal gets SERVER_BUSY and queues nothing', async () => {
    const fake = buildFake({ status: 'RUNNING' });
    let during: ProxyServiceResult | undefined;
    const { deps, enqueued } = buildDeps(fake.store, {
      remove: async () => {
        during = await requestProxyInstall(deps, { actor: ACTOR, serverId: SERVER });
        return { ok: true, durationMs: 3 };
      },
    });
    expect((await removeServerProxy(deps, { actor: ACTOR, serverId: SERVER })).ok).toBe(true);
    expect(during === undefined ? null : failureCode(during)).toBe('SERVER_BUSY');
    expect(enqueued).toEqual([]);
    expect(fake.row?.status).toBe('NOT_INSTALLED');
  });

  it('answers SERVER_BUSY while another change holds the lock', async () => {
    const { store, state } = buildFake({ status: 'RUNNING' });
    const { deps, remove } = buildDeps(store);
    state.held = true;
    expect(failureCode(await removeServerProxy(deps, { actor: ACTOR, serverId: SERVER }))).toBe('SERVER_BUSY');
    expect(remove).not.toHaveBeenCalled();
  });
});
