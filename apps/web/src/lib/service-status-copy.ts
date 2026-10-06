// 13-12: words, tones and recovery copy for the service view. The service status shown is always
// the one the API derived (deriveServiceStatus on the server, ROADMAP D5); nothing here computes a
// status from local data. UNKNOWN says plainly what it means: the container could not be observed.
import { isTerminalDeploymentStatus, type DeploymentStatus, type DeploymentTrigger, type ServiceStatus } from '@noodara/domain';
import { PLACEHOLDER, type Tone } from '@noodara/ui';
import type { DeployApiErrorCode } from './api-client';

export interface StatusPresentation {
  readonly word: string;
  readonly tone: Tone;
  /** In-progress states pulse (skill §4.2). */
  readonly pulsing: boolean;
}

export interface ServiceStatusPresentation extends StatusPresentation {
  /** One sentence for the operator: what the status means right now. */
  readonly meaning: string;
}

const SERVICE_STATUS_PRESENTATION = {
  NEVER_DEPLOYED: {
    word: 'Never deployed',
    tone: 'idle',
    pulsing: false,
    meaning: 'This service has no deployments yet. Deploy it to start a container.',
  },
  DEPLOYING: {
    word: 'Deploying',
    tone: 'warn',
    pulsing: true,
    meaning: 'A deployment is in progress.',
  },
  RUNNING: {
    word: 'Running',
    tone: 'ok',
    pulsing: false,
    meaning: 'The container is running on its server.',
  },
  STOPPED: {
    word: 'Stopped',
    tone: 'idle',
    pulsing: false,
    meaning: 'The container is not running. Deploy or restart to bring it back.',
  },
  FAILED: {
    word: 'Failed',
    tone: 'error',
    pulsing: false,
    meaning: 'The last deployment failed and no container is running.',
  },
  UNKNOWN: {
    word: 'Unknown',
    tone: 'idle',
    pulsing: false,
    meaning:
      "Noodara couldn't check the container on its server, so its state is unknown. It may still be running. Check that the server is reachable.",
  },
} as const satisfies Record<ServiceStatus, ServiceStatusPresentation>;

const UNRECOGNIZED_STATUS: ServiceStatusPresentation = SERVICE_STATUS_PRESENTATION.UNKNOWN;

/** An unrecognized value falls back to UNKNOWN: never a guess that the service is fine. */
export function serviceStatusPresentation(status: string): ServiceStatusPresentation {
  return Object.hasOwn(SERVICE_STATUS_PRESENTATION, status)
    ? SERVICE_STATUS_PRESENTATION[status as ServiceStatus]
    : UNRECOGNIZED_STATUS;
}

const DEPLOYMENT_STATUS_PRESENTATION = {
  QUEUED: { word: 'Queued', tone: 'warn', pulsing: true },
  PREPARING: { word: 'Preparing', tone: 'warn', pulsing: true },
  BUILDING: { word: 'Building', tone: 'warn', pulsing: true },
  DEPLOYING: { word: 'Deploying', tone: 'warn', pulsing: true },
  SUCCESS: { word: 'Success', tone: 'ok', pulsing: false },
  FAILED: { word: 'Failed', tone: 'error', pulsing: false },
  CANCELLED: { word: 'Cancelled', tone: 'idle', pulsing: false },
} as const satisfies Record<DeploymentStatus, StatusPresentation>;

export function deploymentStatusPresentation(status: string): StatusPresentation {
  return Object.hasOwn(DEPLOYMENT_STATUS_PRESENTATION, status)
    ? DEPLOYMENT_STATUS_PRESENTATION[status as DeploymentStatus]
    : { word: status, tone: 'idle', pulsing: false };
}

const TRIGGER_WORDS = {
  manual: 'Manual',
  redeploy: 'Redeploy',
} as const satisfies Record<DeploymentTrigger, string>;

/** The trigger's word; an unrecognized value is shown as-is (React renders it as inert text). */
export function triggerWord(trigger: string): string {
  return Object.hasOwn(TRIGGER_WORDS, trigger) ? TRIGGER_WORDS[trigger as DeploymentTrigger] : trigger;
}

export const SHORT_SHA_LENGTH = 7;

export function shortSha(sha: string | null): string {
  if (sha === null || sha === '') return PLACEHOLDER;
  return sha.slice(0, SHORT_SHA_LENGTH);
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return PLACEHOLDER;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(seconds)}s`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(rest)}m`;
}

/** Same rule as the cancel route: only a queued or running deployment can be cancelled. */
export function isCancellable(status: string): boolean {
  return Object.hasOwn(DEPLOYMENT_STATUS_PRESENTATION, status) && !isTerminalDeploymentStatus(status as DeploymentStatus);
}

export const PROJECT_ARCHIVED_DEPLOY_COPY = 'This project is archived. Unarchive it to deploy this service.';
export const DEPLOYMENT_IN_PROGRESS_COPY =
  'A deployment is already running for this service. Wait for it to finish or cancel it, then deploy again.';
export const DEPLOYMENT_NOT_CANCELLABLE_COPY = 'This deployment already finished, so there is nothing to cancel.';
export const SERVICE_NOT_DEPLOYED_COPY = 'This service has no container yet. Deploy it first.';
export const SERVICE_OPERATION_IN_PROGRESS_COPY = 'Another operation is running on this service. Try again once it finishes.';
export const SERVER_UNREACHABLE_COPY = "Noodara couldn't reach the server. Check that it is online and try again.";
export const SERVICE_ACTION_FAILED_COPY = "Couldn't complete the action. Check your connection and try again.";
export const SERVICE_SESSION_COPY = 'Your session has expired. Sign in again to continue.';

const RECOVERY_COPY: Partial<Record<DeployApiErrorCode, string>> = {
  PROJECT_ARCHIVED: PROJECT_ARCHIVED_DEPLOY_COPY,
  DEPLOYMENT_IN_PROGRESS: DEPLOYMENT_IN_PROGRESS_COPY,
  DEPLOYMENT_NOT_CANCELLABLE: DEPLOYMENT_NOT_CANCELLABLE_COPY,
  SERVICE_NOT_DEPLOYED: SERVICE_NOT_DEPLOYED_COPY,
  SERVICE_OPERATION_IN_PROGRESS: SERVICE_OPERATION_IN_PROGRESS_COPY,
  SERVER_UNREACHABLE: SERVER_UNREACHABLE_COPY,
};

/** Fixed copy for a failed service action; never the server's own text. */
export function serviceActionCopy(code: DeployApiErrorCode): string {
  return RECOVERY_COPY[code] ?? SERVICE_ACTION_FAILED_COPY;
}

/** Codes that mean "the state moved under you": the view refetches instead of reporting a fault. */
export function isStateRaceCode(code: DeployApiErrorCode): boolean {
  return code === 'DEPLOYMENT_IN_PROGRESS' || code === 'DEPLOYMENT_NOT_CANCELLABLE' || code === 'SERVICE_OPERATION_IN_PROGRESS';
}
