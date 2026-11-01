// 22-03 (A1): the `service.updated` event a domain add/patch/remove writes in the same transaction
// as the row. The metadata names only the changed field (never a hostname, an IP or ACME data).
import { writeActivityEvent, type ActivityWriteHandle } from './write-activity-event.js';

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
