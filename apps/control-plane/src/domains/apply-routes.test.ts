import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { validateResourceId, type ResourceId } from '@noodara/domain';
import { revealSecret } from '@noodara/domain/security';
import type { RemoteCommand, SshDeploySession, StreamOptions, StreamResult } from '@noodara/ssh';
import {
  ROUTE_LOCK_CLASS,
  ROUTE_LOCK_PERMITS,
  applyRoutes,
  createRouteLock,
  type ApplyRoutesPorts,
  type RouteDesired,
  type RouteLock,
  type RouteLockDb,
} from './apply-routes.js';
import type { DomainApplyLimits } from './domain-apply.js';
import type { DomainRow } from './domain-store.js';

const SERVICE_ID = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';
const SERVICE = (validateResourceId(SERVICE_ID) as { value: ResourceId }).value;
const limits: DomainApplyLimits = { stepMs: 1000, verifyMs: 30, verifyPollMs: 1, maxLineBytes: 4096 };
const ROUTER_ENABLED = 'HTTP/1.1 200 OK\r\n\r\n{"status":"enabled","rule":"Host(`x`)","service":"x"}';

function row(hostname: string, id = '1b1c2d3e-4f50-4617-8899-aabbccddeeff'): DomainRow {
  return { id, hostname, httpsRedirect: true } as DomainRow;
}

function desiredOf(hostname: string): RouteDesired {
  return { serverId: 'srv', serviceId: SERVICE, internalPort: 3000, rows: [row(hostname)] };
}

/** A proxy host with one dynamic file and its `.prev`, as write_dynamic / restore_dynamic keep them. */
function fakeProxyHost(writeDelayMs: (content: string) => number = () => 0) {
  const state = { file: 'initial', prev: '', writes: 0 };
  const session = {
    exec: () => Promise.reject(new Error('unused')),
    close: () => Promise.resolve(),
    stream: async (command: RemoteCommand, options: StreamOptions): Promise<StreamResult> => {
      let stdoutTail = '';
      if (command.name === 'proxy.write_dynamic' && options.stdin !== undefined) {
        const content = revealSecret(options.stdin);
        await new Promise((resolve) => setTimeout(resolve, writeDelayMs(content)));
        state.prev = state.file;
        state.file = content;
        state.writes += 1;
        stdoutTail = 'NOODARA_PROXY_WRITE ok\n';
      } else if (command.name === 'proxy.restore_dynamic') {
        state.file = state.prev;
        stdoutTail = 'NOODARA_PROXY_RESTORE restored\n';
      } else if (command.name === 'proxy.status') {
        stdoutTail = ROUTER_ENABLED;
      }
      await Promise.resolve();
      return {
        commandName: command.name,
        outcome: 'completed',
        exitCode: 0,
        exitSignal: null,
        durationMs: 1,
        totalBytes: 0,
        truncated: false,
        stdoutTail,
        stderrTail: '',
      };
    },
  } as unknown as SshDeploySession;
  return { session, state };
}

function hostOf(file: string): string {
  return /Host\(`([^`]+)`\)/.exec(file)?.[1] ?? file;
}

interface Store {
  current: RouteDesired;
  loaded: string[];
  recorded: string[];
}

function ports(store: Store, session: SshDeploySession, overrides: Partial<ApplyRoutesPorts> = {}): ApplyRoutesPorts {
  return {
    loadDesired: () => {
      store.loaded.push(store.current.rows[0]?.hostname ?? '');
      return Promise.resolve(store.current);
    },
    open: () => Promise.resolve({ ok: true, session }),
    record: (_ids, status) => {
      store.recorded.push(status);
      return Promise.resolve();
    },
    ...overrides,
  };
}

const options = (lock: RouteLock) => ({ lock, limits, sleep: () => Promise.resolve() });

/** Fires apply 1 (desired A), waits until it read A, then changes the rows to B and fires apply 2. */
async function twoConcurrentApplies(lock: RouteLock) {
  // A's write is slow: without the lock B's write lands first and A overwrites it.
  const host = fakeProxyHost((content) => (content.includes('a.example.com') ? 20 : 1));
  const store: Store = { current: desiredOf('a.example.com'), loaded: [], recorded: [] };
  const p = ports(store, host.session);
  const first = applyRoutes(SERVICE_ID, p, options(lock));
  while (store.loaded.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  store.current = desiredOf('b.example.com');
  const second = applyRoutes(SERVICE_ID, p, options(lock));
  const outcomes = await Promise.all([first, second]);
  return { outcomes, state: host.state, store };
}

describe('applyRoutes under the per-service route lock (22-05 H3)', () => {
  it('two concurrent applies never interleave: the file is the last desired state, .prev the one before', async () => {
    const { outcomes, state, store } = await twoConcurrentApplies(createRouteLock(null));
    expect(outcomes).toEqual([{ ok: true }, { ok: true }]);
    expect(store.loaded).toEqual(['a.example.com', 'b.example.com']);
    expect(hostOf(state.file)).toBe('b.example.com');
    expect(hostOf(state.prev)).toBe('a.example.com');
    expect(state.writes).toBe(2);
    expect(store.recorded).toEqual(['APPLIED', 'APPLIED']);
  });

  it('control: without a lock the same two applies interleave and the older state wins', async () => {
    const none: RouteLock = (_id, task) => task();
    const { state } = await twoConcurrentApplies(none);
    expect(hostOf(state.file)).toBe('a.example.com');
  });

  it('applies the deploy port instead of the row port when one is given (H2)', async () => {
    const host = fakeProxyHost();
    const store: Store = { current: desiredOf('a.example.com'), loaded: [], recorded: [] };
    await applyRoutes(SERVICE_ID, ports(store, host.session), { ...options(createRouteLock(null)), internalPort: 8080 });
    expect(host.state.file).toContain(':8080');
  });

  it('records PENDING when the session cannot be opened, and nothing when the service is gone', async () => {
    const host = fakeProxyHost();
    const store: Store = { current: desiredOf('a.example.com'), loaded: [], recorded: [] };
    const lock = createRouteLock(null);
    const unreachable = await applyRoutes(SERVICE_ID, ports(store, host.session, { open: () => Promise.resolve({ ok: false }) }), options(lock));
    expect(unreachable).toEqual({ ok: false, code: 'SERVER_UNREACHABLE' });
    expect(store.recorded).toEqual(['PENDING']);
    const gone = await applyRoutes(SERVICE_ID, ports(store, host.session, { loadDesired: () => Promise.resolve(null) }), options(lock));
    expect(gone).toEqual({ ok: true });
    expect(store.recorded).toEqual(['PENDING']);
  });

  it('closes the session it opened, and a failing close never changes the outcome', async () => {
    const host = fakeProxyHost();
    const store: Store = { current: desiredOf('a.example.com'), loaded: [], recorded: [] };
    let closed = 0;
    const p = ports(store, host.session, {
      open: () =>
        Promise.resolve({
          ok: true,
          session: host.session,
          close: () => {
            closed += 1;
            return Promise.reject(new Error('close failed'));
          },
        }),
    });
    await expect(applyRoutes(SERVICE_ID, p, options(createRouteLock(null)))).resolves.toEqual({ ok: true });
    expect(closed).toBe(1);
  });

  const failures: [string, (store: Store, session: SshDeploySession) => Partial<ApplyRoutesPorts>, 'reject' | 'resolve'][] = [
    ['loadDesired throws', () => ({ loadDesired: () => Promise.reject(new Error('db down')) }), 'reject'],
    ['open throws', () => ({ open: () => Promise.reject(new Error('connect threw')) }), 'resolve'],
    [
      'the stream throws',
      () => ({
        open: () =>
          Promise.resolve({
            ok: true,
            session: { stream: () => Promise.reject(new Error('channel closed')) } as unknown as SshDeploySession,
          }),
      }),
      'resolve',
    ],
    ['record throws', () => ({ record: () => Promise.reject(new Error('db down')) }), 'reject'],
  ];

  it.each(failures)('releases the lock when %s', async (_label, override, settles) => {
    const transactions = { open: 0, closed: 0 };
    const db: RouteLockDb = {
      transaction: async (task) => {
        transactions.open += 1;
        try {
          return await task({ execute: () => Promise.resolve() });
        } finally {
          transactions.closed += 1;
        }
      },
    };
    const lock = createRouteLock(db);
    const host = fakeProxyHost();
    const store: Store = { current: desiredOf('a.example.com'), loaded: [], recorded: [] };
    const failing = applyRoutes(SERVICE_ID, ports(store, host.session, override(store, host.session)), options(lock));
    if (settles === 'reject') await expect(failing).rejects.toThrow();
    else await expect(failing).resolves.toMatchObject({ ok: false });
    expect(transactions).toEqual({ open: 1, closed: 1 });
    // The next apply for the same service is not stuck behind the failed one.
    await expect(applyRoutes(SERVICE_ID, ports(store, host.session), options(lock))).resolves.toEqual({ ok: true });
    expect(transactions).toEqual({ open: 2, closed: 2 });
  });
});

describe('createRouteLock over the database (22-05 H3)', () => {
  it('takes a two-int advisory transaction lock keyed by the service id', async () => {
    const queries: { sql: string; params: unknown[] }[] = [];
    const dialect = new PgDialect();
    const db: RouteLockDb = {
      transaction: (task) =>
        task({
          execute: (query) => {
            queries.push(dialect.sqlToQuery(query));
            return Promise.resolve();
          },
        }),
    };
    await expect(createRouteLock(db)(SERVICE_ID, () => Promise.resolve('done'))).resolves.toBe('done');
    expect(queries).toEqual([
      expect.objectContaining({ sql: 'select pg_advisory_xact_lock($1::int4, hashtext($2))', params: [ROUTE_LOCK_CLASS, SERVICE_ID] }),
    ]);
  });

  it('serializes one service and bounds how many transactions a process holds at once', async () => {
    let open = 0;
    let peak = 0;
    const db: RouteLockDb = {
      transaction: async (task) => {
        open += 1;
        peak = Math.max(peak, open);
        try {
          await new Promise((resolve) => setTimeout(resolve, 2));
          return await task({ execute: () => Promise.resolve() });
        } finally {
          open -= 1;
        }
      },
    };
    const lock = createRouteLock(db);
    let sameService = 0;
    let samePeak = 0;
    const onSvc0 = async (): Promise<void> => {
      sameService += 1;
      samePeak = Math.max(samePeak, sameService);
      await new Promise((resolve) => setTimeout(resolve, 1));
      sameService -= 1;
    };
    const ids = Array.from({ length: ROUTE_LOCK_PERMITS + 3 }, (_, index) => `svc-${String(index)}`);
    await Promise.all([...ids.map((id) => lock(id, () => Promise.resolve(id))), lock('svc-0', onSvc0), lock('svc-0', onSvc0)]);
    expect(peak).toBe(ROUTE_LOCK_PERMITS);
    expect(samePeak).toBe(1);
    expect(open).toBe(0);
  });
});
