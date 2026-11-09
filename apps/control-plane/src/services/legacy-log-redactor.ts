// Phase 33: revalidate the authorized service snapshot before loading any secret.
import type { Database } from '../db/client.js';
import { findLogService, openServiceRedactor, type ServiceRedactor } from '../observability/logs/log-sources.js';
import type { TailRequest } from './container-logs.js';
import type { MasterKeys } from './server-service-deps.js';

export async function openLegacyLogRedactor(
  db: Database,
  request: TailRequest,
  masterKeys: () => Promise<MasterKeys>,
): Promise<ServiceRedactor> {
  const service = await findLogService(db, request.projectId, request.serviceId);
  if (service?.id !== request.serviceId || service.projectId !== request.projectId ||
      service.environmentId !== request.environmentId || service.serverId !== request.serverId) {
    throw new Error('Runtime log service scope changed');
  }
  return openServiceRedactor(db, service, masterKeys);
}
