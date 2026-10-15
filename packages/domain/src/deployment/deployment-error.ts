// Closed deployment error vocabulary (DEP-03). The `deployment_error_code` pg enum (11-05) is
// derived from this tuple so the DB and the TS union cannot drift. DEP-03's examples
// AUTH_FAILED/TIMEOUT are refined into REPOSITORY_AUTH_FAILED/REGISTRY_AUTH_FAILED and
// BUILD_TIMEOUT/BUILD_STALLED (ROADMAP D15). LFS and submodules share one code; the detail
// lives in the message (D-09). GIT_HOST_KEY_* (14-06): the Git host's SSH key did not match the
// pinned key, or no key could be pinned (ssh-keyscan failed); the clone never runs unpinned.
// ENQUEUE_FAILED (14-08): the deploy job never reached the queue; the worker's stale-QUEUED sweep
// fails the row so the service is not locked forever. WORKSPACE_UNAVAILABLE (14-30): the deploy
// workspace under the SSH user's home could not be created or written (not a repository problem).
// v0.3 (16-02, ADR 0010): healthcheck, rollback and webhook-commit codes, appended so the pg enum
// grows with plain `ADD VALUE` (migration 0011).

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
  'WORKSPACE_UNAVAILABLE',
  'HEALTHCHECK_FAILED',
  'HEALTHCHECK_TIMEOUT',
  'ROLLBACK_FAILED',
  'ROLLBACK_TARGET_UNAVAILABLE',
  'COMMIT_NOT_FOUND',
] as const);

export type DeploymentErrorCode = (typeof DEPLOYMENT_ERROR_CODES)[number];

export function isDeploymentErrorCode(value: string): value is DeploymentErrorCode {
  return (DEPLOYMENT_ERROR_CODES as readonly string[]).includes(value);
}

/** The codes v0.3 adds; each has a fixed, actionable message below. */
export const V03_DEPLOYMENT_ERROR_CODES = Object.freeze([
  'HEALTHCHECK_FAILED',
  'HEALTHCHECK_TIMEOUT',
  'ROLLBACK_FAILED',
  'ROLLBACK_TARGET_UNAVAILABLE',
  'COMMIT_NOT_FOUND',
] as const satisfies readonly DeploymentErrorCode[]);

export type V03DeploymentErrorCode = (typeof V03_DEPLOYMENT_ERROR_CODES)[number];

/** Fixed text: never carries probe output, container names, IPs or other remote detail. */
export const V03_DEPLOYMENT_ERROR_MESSAGES: Readonly<Record<V03DeploymentErrorCode, string>> =
  Object.freeze({
    HEALTHCHECK_FAILED:
      'The new version did not pass its healthcheck. Check the healthcheck path, port and expected status, then deploy again.',
    HEALTHCHECK_TIMEOUT:
      'The new version did not become healthy in time. Check that the service starts within the healthcheck timeout, or raise it, then deploy again.',
    ROLLBACK_FAILED:
      'The previous version could not be restored. Check the server and Docker, then redeploy a known good version.',
    ROLLBACK_TARGET_UNAVAILABLE:
      'There is no previous version to roll back to. Its image may have been removed; deploy a known good version instead.',
    COMMIT_NOT_FOUND:
      'The pushed commit was not found in the repository. Check that the branch was not force-pushed, then deploy again.',
  } satisfies Record<V03DeploymentErrorCode, string>);
