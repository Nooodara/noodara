import { createRedactor } from '@noodara/domain/security';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/client.js';
import { findLogService, openServiceRedactor } from '../observability/logs/log-sources.js';
import { openLegacyLogRedactor } from './legacy-log-redactor.js';

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
  it('builds and closes lazily, then fails closed through the scoped opener on a logs request', async () => {
    const { buildApp } = await import('../app.js');
    const client = await import('../db/client.js');
    const credentials = await import('./service-credentials.js');
    const { noopServerEventPublisher } = await import('../events/server-event-publisher.js');
    const { createLogger } = await import('../logger.js');
    const getDb = vi.spyOn(client, 'getDb').mockResolvedValue(db);
    const keyRead = vi.fn(() => Promise.reject(new Error('key read must remain lazy')));
    const keysFactory = vi.spyOn(credentials, 'masterKeysFromEnvironment').mockReturnValue(keyRead);
    const { createSsh2Adapter } = await import('@noodara/ssh');
    const adapter = createSsh2Adapter();
    const sshConnect = vi.spyOn(adapter, 'connect');
    const ssh = await import('@noodara/ssh');
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
