import { createRedactor, type ResourceId } from '@noodara/domain';
import type { SshDeploySession } from '@noodara/ssh';
import { describe, expect, it, vi } from 'vitest';
import { createProxyInstallJobHandler, type ProxyInstallJobDeps } from './proxy-job.js';
import type { ProxyInstallInput, ProxyInstallResult } from './proxy-runtime.js';
import type { ProxyInstallOutcome, ProxyInstallTarget } from './proxy-store.js';

const SERVER = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';
const SERVICE = '1b1c2d3e-4f50-4617-8899-aabbccddeeff' as ResourceId;
const CANARY = 'CANARY-ssh-key-7f3e9a';
const payload = { serverId: SERVER, acmeEmail: 'ops@example.com', jobId: `proxy-install-${SERVER}` };

function harness(overrides: Partial<ProxyInstallJobDeps> = {}, target: ProxyInstallTarget | null = null) {
  const logs: unknown[] = [];
  const log = (fields: Record<string, unknown>, message: string) => {
    logs.push({ fields, message });
  };
  const finished: { outcome: ProxyInstallOutcome; reinstalled: boolean }[] = [];
  const installs: ProxyInstallInput[] = [];
  const published: unknown[] = [];
  const close = vi.fn(() => Promise.resolve());
  const deps: ProxyInstallJobDeps = {
    loadTarget: () =>
      Promise.resolve(target ?? { status: 'INSTALLING', installedAt: null, routedServiceIds: [SERVICE] }),
    finish: (_serverId, outcome, reinstalled) => {
      finished.push({ outcome, reinstalled });
      return Promise.resolve(null);
    },
    events: {
      publish: (event) => {
        published.push(event);
        return Promise.resolve();
      },
    },
    connect: () => Promise.resolve({ ok: true, session: {} as SshDeploySession, close }),
    createRedactor: () => createRedactor(),
    image: 'traefik:v3.7.14@sha256:575fa15b135078fe5e50aa847987d96dbddd7b093c172429618404df73f3fa7c',
    acmeCaUrl: 'https://acme.example.com/dir',
    readCaRoot: () => Promise.resolve(null),
    limits: { stepMs: 1000, pullMs: 1000, verifyMs: 1000, verifyPollMs: 10, maxLineBytes: 4096 },
    budgetMs: 60_000,
    logger: { info: log, warn: log, error: log },
    install: (input) => {
      installs.push(input);
      return Promise.resolve<ProxyInstallResult>({ ok: true, durationMs: 5 });
    },
    ...overrides,
  };
  return { handler: createProxyInstallJobHandler(deps), logs, finished, installs, published, close };
}

describe('proxy install job (22-02)', () => {
  it('installs with the rendered config, the routed networks and the budget signal, then records RUNNING', async () => {
    const h = harness();
    expect(await h.handler(payload)).toBe('installed');
    expect(h.installs).toHaveLength(1);
    const input = h.installs[0];
    expect(input?.config.traefikConfig).toContain('ops@example.com');
    expect(input?.config.traefikConfig).toContain('https://acme.example.com/dir');
    expect(input?.routedServiceIds).toEqual([SERVICE]);
    expect(input?.signal).toBeInstanceOf(AbortSignal);
    expect(h.finished).toEqual([{ outcome: { ok: true, durationMs: expect.any(Number) as number }, reinstalled: false }]);
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('a re-install of an installed proxy is recorded as reinstalled', async () => {
    const h = harness({}, { status: 'INSTALLING', installedAt: new Date(), routedServiceIds: [] });
    await h.handler(payload);
    expect(h.finished[0]?.reinstalled).toBe(true);
  });

  it('A1: a port in use is recorded with the listener', async () => {
    const h = harness({
      install: () =>
        Promise.resolve({ ok: false, code: 'PROXY_PORT_IN_USE', step: 'ports', listener: { port: 80, process: 'nginx' }, durationMs: 1 }),
    });
    expect(await h.handler(payload)).toBe('failed');
    expect(h.finished[0]?.outcome).toMatchObject({ ok: false, code: 'PROXY_PORT_IN_USE', step: 'ports', listener: { port: 80, process: 'nginx' } });
  });

  it('skips a row that is no longer INSTALLING (swept or removed)', async () => {
    const h = harness({}, { status: 'FAILED', installedAt: null, routedServiceIds: [] });
    expect(await h.handler(payload)).toBe('skipped');
    expect(h.installs).toHaveLength(0);
    expect(h.finished).toHaveLength(0);
  });

  it('an unreachable server is PROXY_INSTALL_FAILED at connect', async () => {
    const h = harness({ connect: () => Promise.resolve({ ok: false, code: 'SERVER_UNREACHABLE' }) });
    expect(await h.handler(payload)).toBe('failed');
    expect(h.finished[0]?.outcome).toMatchObject({ ok: false, code: 'PROXY_INSTALL_FAILED', step: 'connect' });
  });

  it('H2: after an injected fault the retry reaches RUNNING', async () => {
    let calls = 0;
    const h = harness({
      install: () => {
        calls += 1;
        return Promise.resolve<ProxyInstallResult>(
          calls === 1
            ? { ok: false, code: 'PROXY_INSTALL_FAILED', step: 'pull', listener: null, durationMs: 1 }
            : { ok: true, durationMs: 1 },
        );
      },
    });
    expect(await h.handler(payload)).toBe('failed');
    expect(await h.handler(payload)).toBe('installed');
    expect(h.finished.map((entry) => entry.outcome.ok)).toEqual([false, true]);
  });

  it('the budget aborts the install signal', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({
        budgetMs: 50,
        install: (input) =>
          new Promise((resolve) => {
            input.signal?.addEventListener('abort', () => {
              resolve({ ok: false, code: 'PROXY_INSTALL_FAILED', step: 'verify', listener: null, durationMs: 50 });
            });
          }),
      });
      const pending = h.handler(payload);
      await vi.advanceTimersByTimeAsync(60);
      expect(await pending).toBe('failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('H3: a throwing connect never leaks its message into logs or the outcome', async () => {
    const h = harness({ connect: () => Promise.reject(new Error(`ssh password=${CANARY}`)) });
    expect(await h.handler(payload)).toBe('failed');
    expect(JSON.stringify(h.logs)).not.toContain(CANARY);
    expect(JSON.stringify(h.finished)).not.toContain(CANARY);
    expect(JSON.stringify(h.logs)).not.toContain('ops@example.com');
  });

  it('H3: a payload with anything else is ignored without echoing it', async () => {
    const h = harness();
    expect(await h.handler({ ...payload, privateKey: CANARY })).toBe('invalid_payload');
    expect(JSON.stringify(h.logs)).not.toContain(CANARY);
    expect(h.installs).toHaveLength(0);
  });

  it('an invalid ACME CA URL fails before connecting', async () => {
    const connect = vi.fn();
    const h = harness({ acmeCaUrl: 'ftp://nope', connect });
    expect(await h.handler(payload)).toBe('failed');
    expect(connect).not.toHaveBeenCalled();
  });
});
