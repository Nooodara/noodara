// 27-02 (A3): the collector's system event for a new crash loop or OOM. It reuses the domain's
// `service.container_changed` action (system actor, entity service) and carries ids and the
// diagnosis only: no container output, exit text or log line.
import type { Diagnosis } from '@noodara/domain';
import { writeActivityEvent, type ActivityWriteHandle } from './write-activity-event.js';

export type ContainerIncidentDiagnosis = Extract<Diagnosis, 'crash_loop' | 'out_of_memory'>;

export interface ContainerIncidentEventInput {
  readonly serviceId: string;
  readonly serverId: string;
  readonly diagnosis: ContainerIncidentDiagnosis;
}

export function writeContainerIncidentEvent(
  handle: ActivityWriteHandle,
  input: ContainerIncidentEventInput,
  at: Date,
): Promise<string> {
  return writeActivityEvent(
    handle,
    {
      actorType: 'system',
      entityType: 'service',
      entityId: input.serviceId,
      action: 'service.container_changed',
      outcome: 'success',
      metadata: { serverId: input.serverId, observedState: input.diagnosis },
    },
    at,
  );
}
