import { describe, expect, it } from 'vitest';
import { DEPLOYMENT_ERROR_CODES, isDeploymentErrorCode } from './deployment-error.js';

describe('DEPLOYMENT_ERROR_CODES', () => {
  it('is the closed vocabulary, in order (the pg enum is derived from it)', () => {
    expect([...DEPLOYMENT_ERROR_CODES]).toEqual([
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
    ]);
  });

  it('has 23 codes and no duplicates', () => {
    expect(DEPLOYMENT_ERROR_CODES.length).toBe(23);
    expect(new Set(DEPLOYMENT_ERROR_CODES).size).toBe(23);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DEPLOYMENT_ERROR_CODES)).toBe(true);
  });
});

describe('isDeploymentErrorCode', () => {
  it.each(['BUILD_FAILED', 'UNSUPPORTED_REPOSITORY_FEATURE', 'WORKER_CRASHED'])(
    'accepts %s',
    (value) => {
      expect(isDeploymentErrorCode(value)).toBe(true);
    },
  );

  it.each(['build_failed', '', 'AUTH_FAILED', 'TIMEOUT', ' BUILD_FAILED'])('rejects %j', (value) => {
    expect(isDeploymentErrorCode(value)).toBe(false);
  });
});
