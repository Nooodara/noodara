// 17-07 (A4): `deployment.rollback_started`, written once when an attempt enters ROLLING_BACK. The
// worker is the system actor; the metadata names only ids (never an image ref, a runtime config or
// an error text). The rollback's result is the attempt's `deployment.finished` event.
import { writeActivityEvent, type ActivityWriteHandle } from './write-activity-event.js';

export interface DeploymentRollbackStartedEventInput {
  readonly deploymentId: string;
  readonly serviceId: string;
  /** The deployment whose version is restored; null when the service has no earlier SUCCESS. */
  readonly targetDeploymentId: string | null;
}

export function writeDeploymentRollbackStartedEvent(
  handle: ActivityWriteHandle,
  input: DeploymentRollbackStartedEventInput,
  now: Date = new Date(),
): Promise<string> {
  return writeActivityEvent(
    handle,
    {
      actorType: 'system',
      entityType: 'deployment',
      entityId: input.deploymentId,
      action: 'deployment.rollback_started',
      outcome: 'success',
      metadata: {
        deploymentId: input.deploymentId,
        serviceId: input.serviceId,
        ...(input.targetDeploymentId === null ? {} : { targetDeploymentId: input.targetDeploymentId }),
      },
    },
    now,
  );
}
