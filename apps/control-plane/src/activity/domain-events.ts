// 22-03 (A1): the `service.updated` event a domain add/patch/remove writes in the same transaction
// as the row. The metadata names only the changed field (never a hostname, an IP or ACME data).
// 22-04 (A3, H4): the certificate and route-restore events of the cert reconciler; their metadata is
// the closed allowlist of activity-event.ts (ids, status, duration), never a certificate body.
import { writeActivityEvent, type ActivityWriteHandle, type WriteActivityEventInput } from './write-activity-event.js';

export type DomainEventActor = { readonly type: 'user'; readonly id: string } | { readonly type: 'system' };

export interface ServiceDomainsChangedEventInput {
  readonly actor: DomainEventActor;
  readonly serviceId: string;
}

export function writeServiceDomainsChangedEvent(
  handle: ActivityWriteHandle,
  input: ServiceDomainsChangedEventInput,
  at: Date = new Date(),
): Promise<string> {
  return writeActivityEvent(
    handle,
    {
      actorType: input.actor.type,
      actorId: input.actor.type === 'user' ? input.actor.id : null,
      entityType: 'service',
      entityId: input.serviceId,
      action: 'service.updated',
      outcome: 'success',
      metadata: { changedFields: ['domains'], requiresRedeploy: false, credentialReplaced: false },
    },
    at,
  );
}

export type DomainCertActivityAction =
  | 'domain.certificate_issued'
  | 'domain.certificate_failed'
  | 'domain.certificate_expired'
  | 'domain.route_restored';

export type DomainActivityEventInput = WriteActivityEventInput & { readonly action: DomainCertActivityAction };

export function writeDomainActivityEvent(
  handle: ActivityWriteHandle,
  input: DomainActivityEventInput,
  at: Date,
): Promise<string> {
  return writeActivityEvent(handle, input, at);
}
