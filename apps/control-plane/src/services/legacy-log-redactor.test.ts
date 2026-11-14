import { createRedactor } from '@noodara/domain/security';
import { beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import type { Database } from '../db/client.js';
import { findLogService, openServiceRedactor } from '../observability/logs/log-sources.js';
import { openLegacyLogRedactor } from './legacy-log-redactor.js';

// 36-02: the root vitest.config.ts provides the NOODARA_TEST_TIMEOUT_SCALE factor it resolved
// (tests/support/timeout-scale.ts, exactly 1 when unset). This package may not import tests/support
// (pnpm boundaries), so the key is declared here; tests/unit/scripts/timeout-scale-runners.test.ts
// pins that this declaration matches the shared one in tests/support/vitest-provided.ts.
declare module 'vitest' {
  interface ProvidedContext {
    noodaraTestTimeoutScale: number;
  }
}

/** Unscaled budget for cold-importing the whole app (see 'production default wiring'). */
const PRODUCTION_WIRING_COLD_IMPORT_BUDGET_MS = 30_000;
// Mirrors TIMEOUT_SCALE_MIN / TIMEOUT_SCALE_MAX and NODE_TIMER_MAX_MS of tests/support/timeout-scale.ts.
const TIMEOUT_SCALE_MIN = 1;
const TIMEOUT_SCALE_MAX = 10;
const NODE_TIMER_MAX_MS = 2_147_483_647;
/** The injected factor, rejected unless it is a finite number in [1, 10] (as the shared parser). */
function checkedScaleFactor(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('noodaraTestTimeoutScale was not provided: run this test through the root vitest.config.ts');
  }
  if (value < TIMEOUT_SCALE_MIN || value > TIMEOUT_SCALE_MAX) {
    throw new Error(`noodaraTestTimeoutScale must be in [${String(TIMEOUT_SCALE_MIN)}, ${String(TIMEOUT_SCALE_MAX)}]`);
  }
  return value;
}
const providedFactor: number = checkedScaleFactor(inject('noodaraTestTimeoutScale'));
/** Same rounding and Node timer ceiling as tests/support/timeout-scale.ts scaleTimeout. */
const scaleBy = (ms: number, factor: number): number => {
  const result = Math.ceil(ms * checkedScaleFactor(factor));
  if (result > NODE_TIMER_MAX_MS) throw new Error('scaled timeout exceeds the Node.js timer limit');
  return result;
};
const scaled = (ms: number): number => scaleBy(ms, providedFactor);

vi.mock('../observability/logs/log-sources.js', () => ({
  findLogService: vi.fn(), openServiceRedactor: vi.fn(),
}));
const db = {} as Database;
const request = { projectId: 'project', environmentId: 'environment', serviceId: 'service', serverId: 'server', tail: 5 };
const ref = { id: request.serviceId, projectId: request.projectId, environmentId: request.environmentId, serverId: request.serverId };

beforeEach(() => vi.resetAllMocks());
describe('authoritative legacy scope', () => {
  it('uses the authoritative ref and existing scoped redactor boundary', async () => {
    const masterKeys = vi.fn();
    const lease = { redactor: createRedactor(), release: vi.fn() };
    vi.mocked(findLogService).mockResolvedValue(ref);
    vi.mocked(openServiceRedactor).mockResolvedValue(lease);
    expect(await openLegacyLogRedactor(db, request, masterKeys)).toBe(lease);
    expect(findLogService).toHaveBeenCalledWith(db, 'project', 'service');
    expect(openServiceRedactor).toHaveBeenCalledWith(db, ref, masterKeys);
  });

  it.each([null, { ...ref, id: 'other' }, { ...ref, projectId: 'other' },
    { ...ref, environmentId: 'other' }, { ...ref, serverId: 'other' }])(
    'rejects a missing or changed service before secret/key access: %j', async (changed) => {
      const masterKeys = vi.fn();
      vi.mocked(findLogService).mockResolvedValue(changed);
      await expect(openLegacyLogRedactor(db, request, masterKeys)).rejects.toThrow('Runtime log service scope changed');
      expect(openServiceRedactor).not.toHaveBeenCalled();
      expect(masterKeys).not.toHaveBeenCalled();
    },
  );
});

describe('production default wiring', () => {
  // 36-02 (QA-26): cold-importing the whole app is not what this test measures, so the import
  // gets its own named budget instead of sharing the 5 s per-test default with the assertions.
  // It exceeded 5 s on a 4 CPU / 6 GB WSL VM (docs/testing/slow-machines/2026-11-12-wsl-run.md).
  let modules: {
    buildApp: (typeof import('../app.js'))['buildApp'];
    client: typeof import('../db/client.js');
    credentials: typeof import('./service-credentials.js');
    noopServerEventPublisher: (typeof import('../events/server-event-publisher.js'))['noopServerEventPublisher'];
    createLogger: (typeof import('../logger.js'))['createLogger'];
    ssh: typeof import('@noodara/ssh');
  };
  beforeAll(async () => {
    const app = await import('../app.js');
    const client = await import('../db/client.js');
    const credentials = await import('./service-credentials.js');
    const events = await import('../events/server-event-publisher.js');
    const logger = await import('../logger.js');
    const ssh = await import('@noodara/ssh');
    modules = {
      buildApp: app.buildApp, client, credentials,
      noopServerEventPublisher: events.noopServerEventPublisher, createLogger: logger.createLogger, ssh,
    };
  }, scaled(PRODUCTION_WIRING_COLD_IMPORT_BUDGET_MS));

  it('gives the cold app import an explicit 30 s budget when the timeout scale is unset', () => {
    expect(PRODUCTION_WIRING_COLD_IMPORT_BUDGET_MS).toBe(30_000);
    expect(scaleBy(PRODUCTION_WIRING_COLD_IMPORT_BUDGET_MS, 1)).toBe(30_000);
    expect(scaled(PRODUCTION_WIRING_COLD_IMPORT_BUDGET_MS)).toBeGreaterThanOrEqual(30_000);
  });

  it.each([0, 0.5, 10.5, 11, -1, Number.NaN, Number.POSITIVE_INFINITY, '2', undefined, null])(
    'rejects an injected timeout scale factor outside [1, 10] or non-finite (%s)',
    (value) => {
      expect(() => checkedScaleFactor(value)).toThrow(/noodaraTestTimeoutScale/);
    },
  );

  it.each([1, 1.5, 3, 10])('accepts an injected timeout scale factor of %s', (value) => {
    expect(checkedScaleFactor(value)).toBe(value);
    expect(scaleBy(PRODUCTION_WIRING_COLD_IMPORT_BUDGET_MS, value)).toBe(Math.ceil(30_000 * value));
  });

  it('builds and closes lazily, then fails closed through the scoped opener on a logs request', async () => {
    const { buildApp, client, credentials, noopServerEventPublisher, createLogger } = modules;
    const getDb = vi.spyOn(client, 'getDb').mockResolvedValue(db);
    const keyRead = vi.fn(() => Promise.reject(new Error('key read must remain lazy')));
    const keysFactory = vi.spyOn(credentials, 'masterKeysFromEnvironment').mockReturnValue(keyRead);
    const { ssh } = modules;
    const adapter = ssh.createSsh2Adapter();
    const sshConnect = vi.spyOn(adapter, 'connect');
    const adapterFactory = vi.spyOn(ssh, 'createSsh2Adapter').mockReturnValue(adapter);
    const app = buildApp({
      logger: createLogger({ level: 'silent', destination: { write: () => true } }),
      broadcaster: { start: () => Promise.resolve(), stop: () => Promise.resolve(), closeAll: () => Promise.resolve() } as never,
      eventPublisher: noopServerEventPublisher,
    });
    try {
      await app.ready();
      expect(getDb).not.toHaveBeenCalled();
      expect(keyRead).not.toHaveBeenCalled();
      expect(sshConnect).not.toHaveBeenCalled();
      expect(findLogService).not.toHaveBeenCalled();
      const logsRequest = { ...request, serviceId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' };
      vi.mocked(findLogService).mockResolvedValue({ ...ref, id: logsRequest.serviceId });
      vi.mocked(openServiceRedactor).mockRejectedValue(new Error('sensitive opener failure'));
      const result = await app.getContainerLogs().tail(logsRequest);
      expect(result).toMatchObject({ ok: false, code: 'RUNTIME_LOGS_FAILED' });
      expect(JSON.stringify(result)).not.toContain('sensitive opener failure');
      expect(openServiceRedactor).toHaveBeenCalledWith(db, { ...ref, id: logsRequest.serviceId }, keyRead);
      expect(sshConnect).not.toHaveBeenCalled();
    } finally {
      await app.close();
      getDb.mockRestore(); keysFactory.mockRestore(); sshConnect.mockRestore(); adapterFactory.mockRestore();
    }
  });
});
