// Derived Service status (ROADMAP D5). Pure, never throws and is not a second state machine: it
// combines the latest Deployment status with what `docker ps` observed. UNKNOWN (container state
// could not be observed) is deliberately distinct from STOPPED. A failed build never replaces
// the running container (DEP-03), so a running container wins over a terminal FAILED attempt.

import { isTerminalDeploymentStatus, type DeploymentStatus } from './deployment-state.js';

export const SERVICE_STATUSES = Object.freeze([
  'NEVER_DEPLOYED',
  'DEPLOYING',
  'RUNNING',
  'STOPPED',
  'FAILED',
  'UNKNOWN',
] as const);

export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export type ContainerObservation =
  | { readonly kind: 'running' }
  | { readonly kind: 'stopped'; readonly exitCode: number | null }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown' };

export interface ServiceStatusInput {
  readonly latestDeployment: { readonly status: DeploymentStatus } | null;
  readonly container: ContainerObservation;
}

export function deriveServiceStatus(input: ServiceStatusInput): ServiceStatus {
  const { latestDeployment, container } = input;

  if (latestDeployment === null) {
    return 'NEVER_DEPLOYED';
  }
  if (!isTerminalDeploymentStatus(latestDeployment.status)) {
    return 'DEPLOYING';
  }
  if (container.kind === 'unknown') {
    return 'UNKNOWN';
  }
  if (container.kind === 'running') {
    return 'RUNNING';
  }
  if (latestDeployment.status === 'FAILED') {
    return 'FAILED';
  }
  return 'STOPPED';
}
