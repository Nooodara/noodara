import { describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_ERROR_CODES,
  V03_DEPLOYMENT_ERROR_CODES,
  V03_DEPLOYMENT_ERROR_MESSAGES,
  V04_DEPLOYMENT_ERROR_CODES,
  V04_DEPLOYMENT_ERROR_MESSAGES,
  isDeploymentErrorCode,
} from './deployment-error.js';

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
      'WORKSPACE_UNAVAILABLE',
      'HEALTHCHECK_FAILED',
      'HEALTHCHECK_TIMEOUT',
      'ROLLBACK_FAILED',
      'ROLLBACK_TARGET_UNAVAILABLE',
      'COMMIT_NOT_FOUND',
      'SECRET_UNRESOLVED',
      'ENV_INJECTION_FAILED',
      'PROXY_ROUTE_FAILED',
    ]);
  });

  it('has 32 codes and no duplicates', () => {
    expect(DEPLOYMENT_ERROR_CODES.length).toBe(32);
    expect(new Set(DEPLOYMENT_ERROR_CODES).size).toBe(32);
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

describe('v0.3 error codes (16-02)', () => {
  it('adds the healthcheck, rollback and commit codes at the end (plain ADD VALUE)', () => {
    expect([...V03_DEPLOYMENT_ERROR_CODES]).toEqual([
      'HEALTHCHECK_FAILED',
      'HEALTHCHECK_TIMEOUT',
      'ROLLBACK_FAILED',
      'ROLLBACK_TARGET_UNAVAILABLE',
      'COMMIT_NOT_FOUND',
    ]);
    expect(DEPLOYMENT_ERROR_CODES.slice(-8, -3)).toEqual([...V03_DEPLOYMENT_ERROR_CODES]);
    expect(Object.isFrozen(V03_DEPLOYMENT_ERROR_CODES)).toBe(true);
    expect(Object.isFrozen(V03_DEPLOYMENT_ERROR_MESSAGES)).toBe(true);
  });

  it('every v0.3 code has exactly one message', () => {
    expect(Object.keys(V03_DEPLOYMENT_ERROR_MESSAGES).sort()).toEqual(
      [...V03_DEPLOYMENT_ERROR_CODES].sort(),
    );
  });

  it.each(V03_DEPLOYMENT_ERROR_CODES)('%s has an actionable message without remote detail', (code) => {
    const message = V03_DEPLOYMENT_ERROR_MESSAGES[code];
    expect(isDeploymentErrorCode(code)).toBe(true);
    // Actionable: states what happened, then what to do next.
    expect(message).toMatch(/^[A-Z].+\. .+\.$/);
    expect(message).toMatch(/\b(Check|deploy|Deploy|redeploy|raise)\b/);
    // No infrastructure detail: no IPs, container names, paths, exit codes or code names.
    expect(message).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect(message).not.toMatch(/noodara-|-prev|\/|exit \d+|[A-Z]{2,}_[A-Z]+/);
    expect(message.length).toBeLessThanOrEqual(160);
  });

  it('messages are distinct', () => {
    const messages = Object.values(V03_DEPLOYMENT_ERROR_MESSAGES);
    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe('v0.4 error codes (21-04, 21-06)', () => {
  it('appends the secret, env injection and route codes at the end (migration 0014 ADD VALUE)', () => {
    expect([...V04_DEPLOYMENT_ERROR_CODES]).toEqual([
      'SECRET_UNRESOLVED',
      'ENV_INJECTION_FAILED',
      'PROXY_ROUTE_FAILED',
    ]);
    expect(DEPLOYMENT_ERROR_CODES.slice(-3)).toEqual([...V04_DEPLOYMENT_ERROR_CODES]);
    expect(V04_DEPLOYMENT_ERROR_CODES.every((code) => isDeploymentErrorCode(code))).toBe(true);
    expect(Object.isFrozen(V04_DEPLOYMENT_ERROR_CODES)).toBe(true);
    expect(Object.isFrozen(V04_DEPLOYMENT_ERROR_MESSAGES)).toBe(true);
    expect(Object.keys(V04_DEPLOYMENT_ERROR_MESSAGES).sort()).toEqual(
      [...V04_DEPLOYMENT_ERROR_CODES].sort(),
    );
  });

  it.each(V04_DEPLOYMENT_ERROR_CODES)('%s has a fixed actionable message without values or remote detail', (code) => {
    const message = V04_DEPLOYMENT_ERROR_MESSAGES[code];
    expect(message).toMatch(/^[A-Z].+\. .+\.$/);
    expect(message).toMatch(/\b(Check|Add|deploy|Deploy)\b/);
    expect(message).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect(message).not.toMatch(/noodara-|\/|<secret:|exit \d+|[A-Z]{2,}_[A-Z]+/);
    expect(message.length).toBeLessThanOrEqual(160);
  });

  it('messages are distinct from each other and from the v0.3 ones', () => {
    const messages = [
      ...Object.values(V04_DEPLOYMENT_ERROR_MESSAGES),
      ...Object.values(V03_DEPLOYMENT_ERROR_MESSAGES),
    ];
    expect(new Set(messages).size).toBe(messages.length);
  });
});
