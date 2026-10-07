// Closed deployment error vocabulary (DEP-03). The `deployment_error_code` pg enum (11-05) is
// derived from this tuple so the DB and the TS union cannot drift. DEP-03's examples
// AUTH_FAILED/TIMEOUT are refined into REPOSITORY_AUTH_FAILED/REGISTRY_AUTH_FAILED and
// BUILD_TIMEOUT/BUILD_STALLED (ROADMAP D15). LFS and submodules share one code; the detail
// lives in the message (D-09). GIT_HOST_KEY_* (14-06): the Git host's SSH key did not match the
// pinned key, or no key could be pinned (ssh-keyscan failed); the clone never runs unpinned.
// ENQUEUE_FAILED (14-08): the deploy job never reached the queue; the worker's stale-QUEUED sweep
// fails the row so the service is not locked forever.

export const DEPLOYMENT_ERROR_CODES = Object.freeze([
  'REPOSITORY_AUTH_FAILED',
  'REPOSITORY_NOT_FOUND',
  'BRANCH_NOT_FOUND',
  'REPOSITORY_HOST_UNREACHABLE',
  'GIT_HOST_KEY_MISMATCH',
  'GIT_HOST_KEY_UNAVAILABLE',
  'UNSUPPORTED_REPOSITORY_FEATURE',
  'CLONE_FAILED',
  'DOCKERFILE_NOT_FOUND',
  'BUILDKIT_UNAVAILABLE',
  'BUILD_FAILED',
  'REGISTRY_AUTH_FAILED',
  'IMAGE_NOT_FOUND',
  'IMAGE_PULL_FAILED',
  'DISK_FULL',
  'PORT_IN_USE',
  'START_FAILED',
  'DOCKER_UNAVAILABLE',
  'SERVER_UNREACHABLE',
  'BUILD_TIMEOUT',
  'BUILD_STALLED',
  'WORKER_CRASHED',
  'ENQUEUE_FAILED',
] as const);

export type DeploymentErrorCode = (typeof DEPLOYMENT_ERROR_CODES)[number];

export function isDeploymentErrorCode(value: string): value is DeploymentErrorCode {
  return (DEPLOYMENT_ERROR_CODES as readonly string[]).includes(value);
}
