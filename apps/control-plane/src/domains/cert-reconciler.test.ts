import type { RemoteCommand, StreamResult } from '@noodara/ssh';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectResult, DeployJobLogger } from '../deploy/deploy-worker.js';
import type { ServerEvent } from '../events/server-event-publisher.js';
import type { ServiceView } from '../services/service-view.js';
import {
  createCertReconciler,
  startCertReconcileLoop,
  type CertReconciler,
  type CertReconcilerDeps,
  type CertReconcilerStore,
} from './cert-reconciler.js';
import type { CertCandidate, CertStatusWrite } from './domain-store.js';

const SERVER = '0192f1a4-7b3c-7d2e-8f00-00000000aaa3';
const SERVICE = '0192f1a4-7b3c-7d2e-8f00-00000000bbbb';
const DOMAIN = '0192f1a4-7b3c-7d2e-8f00-00000000d001';
const T0 = new Date('2026-10-31T10:00:00.000Z');
const INTERVAL = 600_000;
const TIMEOUT = 600_000;
const NOT_AFTER = new Date('2027-01-29T10:00:00.000Z');

function candidate(overrides: Partial<CertCandidate> = {}): CertCandidate {
  return {
    id: DOMAIN,
    serviceId: SERVICE,
    serverId: SERVER,
    hostname: 'app.example.com',
    certStatus: 'PENDING',
    certNotAfter: null,
    certErrorCode: null,
    dnsStatus: 'RESOLVES',
    applyStatus: 'APPLIED',
    updatedAt: T0,
    proxyStatus: 'RUNNING',
    ...overrides,
  };
}

const API_UP = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"status":"enabled","rule":"Host(`x`)","service":"api@internal"}\n';
const ROUTER_MISSING = 'HTTP/1.1 404 Not Found\r\n\r\n404 page not found\n';
const certLine = (notAfter: Date, issuer = 'CN=Pebble Intermediate CA') =>
  `NOODARA_CERT tls notAfter=${String(Math.floor(notAfter.getTime() / 1000))} issuer=${issuer}\n`;
const DEFAULT_CERT = `NOODARA_CERT tls notAfter=${String(Math.floor(NOT_AFTER.getTime() / 1000))} issuer=CN=TRAEFIK DEFAULT CERT\n`;

interface Remote {
  api?: string;
  cert?: string | ((hostname: string) => string);
  router?: string;
  truncated?: boolean;
  throwOn?: RemoteCommand['name'];
}

function streamResult(command: RemoteCommand, stdout: string, truncated = false): StreamResult {
  return {
    commandName: command.name,
    outcome: 'completed',
    exitCode: 0,
    exitSignal: null,
    durationMs: 3,
    totalBytes: Buffer.byteLength(stdout),
    truncated,
    stdoutTail: stdout,
    stderrTail: '',
  };
}

function harness(options: { candidates: CertCandidate[]; remote?: Remote; connectOk?: boolean; connectThrows?: boolean }) {
  let clock = T0;
  let candidates = options.candidates;
  const remote: Remote = { api: API_UP, cert: certLine(NOT_AFTER), router: API_UP, ...options.remote };
  const writes: CertStatusWrite[] = [];
  const events: ServerEvent[] = [];
  const order: string[] = [];
  const logs: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const stream = vi.fn((command: RemoteCommand) => {
    if (remote.throwOn === command.name) return Promise.reject(new Error('channel closed: secret remote text'));
    if (command.name === 'tls.cert_status') {
      const host = command.argv.find((arg) => arg.endsWith('.example.com')) ?? '';
      const out = typeof remote.cert === 'function' ? remote.cert(host) : (remote.cert ?? '');
      return Promise.resolve(streamResult(command, out, remote.truncated ?? false));
    }
    const isApi = command.argv.includes('noodara-api');
    return Promise.resolve(streamResult(command, (isApi ? remote.api : remote.router) ?? ''));
  });
  const close = vi.fn(() => {
    order.push('close');
    return Promise.resolve();
  });
  const connect = vi.fn((): Promise<ConnectResult> => {
    order.push('connect');
    if (options.connectThrows === true) return Promise.reject(new Error('ECONNREFUSED'));
    if (options.connectOk === false) return Promise.resolve({ ok: false, code: 'SERVER_UNREACHABLE' });
    return Promise.resolve({ ok: true, session: { stream } as never, close });
  });
  const view = (updatedAt: Date): ServiceView =>
    ({ id: SERVICE, projectId: 'p', environmentId: 'e', serverId: SERVER, status: 'RUNNING', updatedAt: updatedAt.toISOString() }) as never;
  const markProxyUnavailable = vi.fn((_serverId: string, _at: Date) => {
    candidates = candidates.map((c) => ({ ...c, proxyStatus: 'FAILED' as const }));
    return Promise.resolve({ id: SERVER } as never);
  });
  const recordRouteRestored = vi.fn((_input: { serviceId: string; durationMs: number; at: Date }) => Promise.resolve(view(clock)));
  const listCandidates = vi.fn(() => Promise.resolve(candidates));
  const store: CertReconcilerStore = {
    listCandidates,
    writeCertStatus: vi.fn((write: CertStatusWrite) => {
      writes.push(write);
      const updatedAt = new Date(write.at.getTime());
      candidates = candidates.map((c) =>
        c.id === write.domainId ? { ...c, certStatus: write.status, certNotAfter: write.notAfter, certErrorCode: write.errorCode, updatedAt } : c,
      );
      return Promise.resolve({ view: view(updatedAt), updatedAt });
    }),
    markProxyUnavailable,
    recordRouteRestored,
  };
  const apply = vi.fn((serviceId: string) => {
    order.push(`apply:${serviceId}`);
    return Promise.resolve({ ok: true } as const);
  });
  const logger: DeployJobLogger = {
    info: (fields, message) => logs.push({ level: 'info', fields, message }),
    warn: (fields, message) => logs.push({ level: 'warn', fields, message }),
    error: (fields, message) => logs.push({ level: 'error', fields, message }),
  };
  const deps: CertReconcilerDeps = {
    store,
    connect,
    createRedactor: () => ({}) as never,
    apply,
    events: { publish: (event) => Promise.resolve(void events.push(event)) },
    logger,
    intervalMs: INTERVAL,
    issueTimeoutMs: TIMEOUT,
    commandMs: 5_000,
    now: () => clock,
  };
  const reconciler = createCertReconciler(deps);
  return {
    reconciler,
    store,
    mocks: { listCandidates, markProxyUnavailable, recordRouteRestored },
    connect,
    stream,
    close,
    apply,
    writes,
    events,
    logs,
    order,
    remote,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    setCandidates(next: CertCandidate[]) {
      candidates = next;
    },
    get candidates() {
      return candidates;
    },
  };
}

/** A domain first seen long after its last change is due at once. */
const OLD = new Date(T0.getTime() - 3_600_000);

describe('cert reconciler decisions (22-04 A1, A3)', () => {
  it('PENDING with an issued certificate becomes ISSUED with notAfter, records issued and publishes service.updated', async () => {
    const h = harness({ candidates: [candidate({ updatedAt: OLD })] });
    await h.reconciler.runDue();
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.writes).toEqual([
      expect.objectContaining({
        domainId: DOMAIN,
        expectedUpdatedAt: OLD,
        status: 'ISSUED',
        notAfter: NOT_AFTER,
        errorCode: null,
        activity: { action: 'domain.certificate_issued', previousStatus: 'PENDING' },
      }),
    ]);
    expect(h.events).toEqual([{ type: 'service.updated', service: expect.objectContaining({ id: SERVICE }) as unknown }]);
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it('keeps a PENDING domain with the default certificate inside the issue timeout', async () => {
    // Settled (past the post-change checks, so due now) but well inside the 10 min timeout.
    const inside = new Date(T0.getTime() - 5 * 60_000);
    const h = harness({ candidates: [candidate({ updatedAt: inside })], remote: { cert: DEFAULT_CERT } });
    await h.reconciler.runDue();
    expect(h.stream).toHaveBeenCalled();
    expect(h.writes).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it.each<[string, CertCandidate['dnsStatus'], string]>([
    ['not resolving', 'MISMATCH', 'CERT_DNS_MISMATCH'],
    ['never checked', null, 'CERT_DNS_MISMATCH'],
    ['resolving', 'RESOLVES', 'CERT_ISSUANCE_FAILED'],
  ])('fails a PENDING domain past the issue timeout with DNS %s', async (_label, dnsStatus, code) => {
    const h = harness({ candidates: [candidate({ updatedAt: OLD, dnsStatus })], remote: { cert: DEFAULT_CERT } });
    await h.reconciler.runDue();
    expect(h.writes).toEqual([
      expect.objectContaining({
        status: 'FAILED',
        errorCode: code,
        notAfter: null,
        activity: { action: 'domain.certificate_failed', previousStatus: 'PENDING' },
      }),
    ]);
  });

  it('a past notAfter turns an ISSUED domain EXPIRED and records expired', async () => {
    const past = new Date(T0.getTime() - 60_000);
    const h = harness({
      candidates: [candidate({ updatedAt: OLD, certStatus: 'ISSUED', certNotAfter: past })],
      remote: { cert: certLine(past) },
    });
    await h.reconciler.runDue();
    expect(h.writes).toEqual([
      expect.objectContaining({ status: 'EXPIRED', activity: { action: 'domain.certificate_expired', previousStatus: 'ISSUED' } }),
    ]);
  });

  it('a certificate inside the renewal window passes through RENEWING before the new one is ISSUED', async () => {
    const soon = new Date(T0.getTime() + 5 * 86_400_000);
    const h = harness({
      candidates: [candidate({ updatedAt: OLD, certStatus: 'ISSUED', certNotAfter: soon })],
      remote: { cert: certLine(soon) },
    });
    await h.reconciler.runDue();
    expect(h.writes.map((w) => [w.status, w.activity])).toEqual([['RENEWING', undefined]]);
    h.remote.cert = certLine(NOT_AFTER);
    h.advance(INTERVAL);
    await h.reconciler.runDue();
    expect(h.writes.map((w) => w.status)).toEqual(['RENEWING', 'ISSUED']);
    expect(h.writes[1]?.notAfter).toEqual(NOT_AFTER);
  });

  it('proxy down records CERT_PROXY_UNAVAILABLE without changing an ISSUED status', async () => {
    const h = harness({
      candidates: [candidate({ updatedAt: OLD, certStatus: 'ISSUED', certNotAfter: NOT_AFTER })],
      remote: { api: 'NOODARA_PROXY_API down\n' },
    });
    await h.reconciler.runDue();
    expect(h.writes).toEqual([expect.objectContaining({ status: 'ISSUED', notAfter: NOT_AFTER, errorCode: 'CERT_PROXY_UNAVAILABLE' })]);
    expect(h.writes[0]?.activity).toBeUndefined();
    expect(h.stream.mock.calls.some(([command]) => command.name === 'tls.cert_status')).toBe(false);
  });

  it('writes nothing when the decision changes nothing', async () => {
    const h = harness({ candidates: [candidate({ updatedAt: OLD, certStatus: 'ISSUED', certNotAfter: NOT_AFTER })] });
    await h.reconciler.runDue();
    expect(h.writes).toEqual([]);
    expect(h.connect).toHaveBeenCalledTimes(1);
  });

  it('probes every due domain of one server over a single SSH session', async () => {
    const other = { ...candidate({ updatedAt: OLD }), id: '0192f1a4-7b3c-7d2e-8f00-00000000d002', hostname: 'www.example.com' };
    const h = harness({ candidates: [candidate({ updatedAt: OLD }), other] });
    await h.reconciler.runDue();
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.stream.mock.calls.filter(([command]) => command.name === 'tls.cert_status')).toHaveLength(2);
    expect(h.writes).toHaveLength(2);
  });
});

describe('cert reconciler schedule (22-04 A2)', () => {
  it('checks a changed domain at 15 s, 30 s and 60 s, then every interval', async () => {
    const h = harness({ candidates: [candidate({ updatedAt: T0 })], remote: { cert: DEFAULT_CERT } });
    const probes = () => h.stream.mock.calls.filter(([command]) => command.name === 'tls.cert_status').length;
    await h.reconciler.runDue();
    expect(probes()).toBe(0);
    h.advance(15_000);
    await h.reconciler.runDue();
    expect(probes()).toBe(1);
    h.advance(29_000);
    await h.reconciler.runDue();
    expect(probes()).toBe(1);
    h.advance(1_000);
    await h.reconciler.runDue();
    expect(probes()).toBe(2);
    h.advance(60_000);
    await h.reconciler.runDue();
    expect(probes()).toBe(3);
    h.advance(INTERVAL - 1);
    await h.reconciler.runDue();
    expect(probes()).toBe(3);
    h.advance(1);
    await h.reconciler.runDue();
    expect(probes()).toBe(4);
  });

  it('an external change (a PATCH, a dns-check) restarts the post-change checks; its own writes do not', async () => {
    const h = harness({ candidates: [candidate({ updatedAt: OLD })] });
    await h.reconciler.runDue();
    expect(h.writes).toHaveLength(1);
    // Own write: no restart at 15 s (a settled domain goes on with the regular interval).
    h.advance(15_000);
    await h.reconciler.runDue();
    expect(h.connect).toHaveBeenCalledTimes(1);
    const patched = new Date(T0.getTime() + 16_000);
    h.setCandidates(h.candidates.map((c) => ({ ...c, certStatus: 'PENDING', updatedAt: patched })));
    h.advance(1_000);
    await h.reconciler.runDue();
    h.advance(15_000);
    await h.reconciler.runDue();
    expect(h.connect).toHaveBeenCalledTimes(2);
  });

  it('times a PENDING domain out from when it entered PENDING', async () => {
    const h = harness({ candidates: [candidate({ updatedAt: T0 })], remote: { cert: DEFAULT_CERT } });
    await h.reconciler.runDue();
    for (let elapsed = 0; elapsed <= TIMEOUT + INTERVAL; elapsed += 15_000) {
      h.advance(15_000);
      await h.reconciler.runDue();
    }
    expect(h.writes).toEqual([expect.objectContaining({ status: 'FAILED', errorCode: 'CERT_ISSUANCE_FAILED' })]);
  });

  it('re-applies services with PENDING apply rows in the same cycle, after the session closed', async () => {
    const h = harness({ candidates: [candidate({ updatedAt: OLD, applyStatus: 'PENDING' })] });
    await h.reconciler.runDue();
    expect(h.order).toEqual(['connect', 'close', `apply:${SERVICE}`]);
  });
});

describe('cert reconciler hardening (22-04 H1, H2, H3, H4)', () => {
  it('H1: two cycles never run concurrently for one server', async () => {
    const h = harness({ candidates: [candidate({ updatedAt: OLD })] });
    const first = h.reconciler.runDue();
    const second = h.reconciler.runDue();
    const [a, b] = await Promise.all([first, second]);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(a.skippedInFlight + b.skippedInFlight).toBe(1);
  });

  it.each([
    ['connect fails', { connectOk: false }],
    ['connect throws', { connectThrows: true }],
    ['a probe stream rejects', { remote: { throwOn: 'tls.cert_status' as const } }],
  ])('H1: %s -> every status unchanged, outcome logged, no FAILED flip', async (_label, options) => {
    const past = new Date(T0.getTime() - 60_000);
    const h = harness({
      candidates: [candidate({ updatedAt: OLD }), { ...candidate({ updatedAt: OLD, certStatus: 'ISSUED', certNotAfter: past }), id: 'd2' }],
      ...options,
    });
    const summary = await h.reconciler.runDue();
    expect(h.writes).toEqual([]);
    expect(h.mocks.markProxyUnavailable).not.toHaveBeenCalled();
    expect(summary.sshFailed).toBe(1);
    expect(h.logs).toContainEqual(expect.objectContaining({ fields: expect.objectContaining({ serverId: SERVER, outcome: 'ssh_failed' }) as unknown }));
    expect(JSON.stringify(h.logs)).not.toContain('secret remote text');
  });

  it('H1: probe output beyond the cap is discarded (nothing stored)', async () => {
    const h = harness({ candidates: [candidate({ updatedAt: OLD })], remote: { truncated: true } });
    const summary = await h.reconciler.runDue();
    expect(h.writes).toEqual([]);
    expect(summary.probeInvalid).toBe(1);
  });

  it.each([
    ['an unknown status token', 'NOODARA_CERT weird\n'],
    ['an unparseable notAfter', 'NOODARA_CERT tls notAfter=tomorrow issuer=CN=x\n'],
    ['an oversized issuer', certLine(NOT_AFTER, `CN=${'x'.repeat(300)}`)],
    ['an out-of-order field', `NOODARA_CERT tls issuer=CN=x notAfter=${String(Math.floor(NOT_AFTER.getTime() / 1000))}\n`],
    ['a certificate body', '-----BEGIN CERTIFICATE-----\n'],
    ['two lines', `${certLine(NOT_AFTER)}${certLine(NOT_AFTER)}`],
    ['an unavailable probe', 'NOODARA_CERT no_openssl\n'],
  ])('H3: %s leaves the status unchanged with a logged probe-invalid outcome', async (_label, out) => {
    const h = harness({ candidates: [candidate({ updatedAt: OLD })], remote: { cert: out } });
    const summary = await h.reconciler.runDue();
    expect(h.writes).toEqual([]);
    expect(summary.probeInvalid).toBe(1);
    expect(h.logs).toContainEqual(expect.objectContaining({ fields: expect.objectContaining({ domainId: DOMAIN, outcome: 'probe_invalid' }) as unknown }));
    expect(JSON.stringify(h.logs)).not.toContain('CN=');
  });

  it('H3: an invalid proxy.status answer leaves every status unchanged', async () => {
    const h = harness({ candidates: [candidate({ updatedAt: OLD })], remote: { api: 'HTTP/1.1 500 Internal\r\n\r\n' } });
    const summary = await h.reconciler.runDue();
    expect(h.writes).toEqual([]);
    expect(h.mocks.markProxyUnavailable).not.toHaveBeenCalled();
    expect(summary.probeInvalid).toBe(1);
  });

  it('H2: no running proxy on a RUNNING server fails the proxy once, not on every cycle', async () => {
    const h = harness({ candidates: [candidate({ updatedAt: OLD })], remote: { api: 'NOODARA_PROXY_API down\n' } });
    await h.reconciler.runDue();
    expect(h.mocks.markProxyUnavailable).toHaveBeenCalledTimes(1);
    expect(h.mocks.markProxyUnavailable).toHaveBeenCalledWith(SERVER, T0);
    expect(h.events).toContainEqual({ type: 'server.updated', server: { id: SERVER } });
    h.advance(INTERVAL * 2);
    await h.reconciler.runDue();
    h.advance(INTERVAL * 2);
    await h.reconciler.runDue();
    expect(h.mocks.markProxyUnavailable).toHaveBeenCalledTimes(1);
  });

  it('H4: a routed service whose dynamic file is gone is re-applied once and records route_restored', async () => {
    const h = harness({
      candidates: [candidate({ updatedAt: OLD, certStatus: 'ISSUED', certNotAfter: NOT_AFTER })],
      remote: { router: ROUTER_MISSING },
    });
    await h.reconciler.runDue();
    expect(h.order).toEqual(['connect', 'close', `apply:${SERVICE}`]);
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.mocks.recordRouteRestored).toHaveBeenCalledWith(expect.objectContaining({ serviceId: SERVICE }));
    expect(h.events).toContainEqual({ type: 'service.updated', service: expect.objectContaining({ id: SERVICE }) as unknown });
  });

  it('H4: a present router is left alone', async () => {
    const h = harness({ candidates: [candidate({ updatedAt: OLD, certStatus: 'ISSUED', certNotAfter: NOT_AFTER })] });
    await h.reconciler.runDue();
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.mocks.recordRouteRestored).not.toHaveBeenCalled();
  });

  it('a listing failure is logged and never rejects', async () => {
    const h = harness({ candidates: [] });
    vi.mocked(h.mocks.listCandidates).mockRejectedValueOnce(new Error('db down'));
    await expect(h.reconciler.runDue()).resolves.toMatchObject({ checked: 0 });
    expect(h.logs).toContainEqual(expect.objectContaining({ level: 'warn' }));
  });
});

describe('startCertReconcileLoop (22-04 A1, H1)', () => {
  const quiet: DeployJobLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const summary = { checked: 0, written: 0, skippedInFlight: 0, sshFailed: 0, probeInvalid: 0, restored: 0 };

  it('polls runDue, never stacks a poll on a slow one, and close waits for the running poll', async () => {
    vi.useFakeTimers();
    try {
      let release: () => void = () => undefined;
      const runDue = vi.fn(
        () =>
          new Promise<typeof summary>((resolve) => {
            release = () => {
              resolve(summary);
            };
          }),
      );
      const loop = startCertReconcileLoop({ reconciler: { runDue } satisfies CertReconciler, pollMs: 1_000, logger: quiet });
      await vi.advanceTimersByTimeAsync(3_500);
      expect(runDue).toHaveBeenCalledTimes(1);
      release();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runDue).toHaveBeenCalledTimes(2);
      let closed = false;
      const closing = loop.close().then(() => {
        closed = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(closed).toBe(false);
      release();
      await closing;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runDue).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
