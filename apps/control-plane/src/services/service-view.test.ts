import { describe, expect, it } from 'vitest';
import type { DeploymentStatus, ServiceStatus } from '@noodara/domain/deployment';
import { containerObservationFromCache, SERVICE_VIEW_FIELDS, toServiceView, type ServiceRow } from './service-view.js';

const CREATED_AT = new Date('2026-10-01T10:00:00.000Z');
const UPDATED_AT = new Date('2026-10-02T11:30:00.000Z');

function gitRow(overrides: Partial<ServiceRow> = {}): ServiceRow {
  return {
    id: '0192f1a4-7b3c-7d2e-8f00-000000000001',
    projectId: '0192f1a4-7b3c-7d2e-8f00-000000000002',
    environmentId: '0192f1a4-7b3c-7d2e-8f00-000000000003',
    serverId: '0192f1a4-7b3c-7d2e-8f00-000000000004',
    name: 'web',
    sourceType: 'git',
    repositoryUrl: 'https://git.example.test/app.git',
    branch: 'main',
    buildContext: '.',
    dockerfilePath: 'Dockerfile',
    buildTarget: null,
    imageRef: null,
    internalPort: 3000,
    publishedPort: null,
    status: 'NEVER_DEPLOYED',
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe('toServiceView (SVC-05, SVC-07)', () => {
  it('returns exactly the SVC-05 allowlist, with ISO timestamps', () => {
    const view = toServiceView(gitRow(), null);
    expect(Object.keys(view)).toStrictEqual([...SERVICE_VIEW_FIELDS]);
    expect(view).toStrictEqual({
      id: '0192f1a4-7b3c-7d2e-8f00-000000000001',
      projectId: '0192f1a4-7b3c-7d2e-8f00-000000000002',
      environmentId: '0192f1a4-7b3c-7d2e-8f00-000000000003',
      serverId: '0192f1a4-7b3c-7d2e-8f00-000000000004',
      name: 'web',
      sourceType: 'git',
      repositoryUrl: 'https://git.example.test/app.git',
      branch: 'main',
      buildContext: '.',
      dockerfilePath: 'Dockerfile',
      buildTarget: null,
      imageRef: null,
      internalPort: 3000,
      publishedPort: null,
      status: 'NEVER_DEPLOYED',
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-02T11:30:00.000Z',
    });
  });

  it('never copies a column outside the allowlist (credential ids stay server-side)', () => {
    const row = {
      ...gitRow(),
      repositoryCredentialId: '0192f1a4-7b3c-7d2e-8f00-0000000000ff',
      registryCredentialId: '0192f1a4-7b3c-7d2e-8f00-0000000000ee',
    };
    const view = toServiceView(row, null);
    expect(JSON.stringify(view)).not.toContain('0000000000ff');
    expect(JSON.stringify(view)).not.toContain('0000000000ee');
  });

  it('ignores a hand-written cached status when no deployment exists: NEVER_DEPLOYED', () => {
    expect(toServiceView(gitRow({ status: 'RUNNING' }), null).status).toBe('NEVER_DEPLOYED');
  });

  it('is DEPLOYING while the latest deployment is not terminal, whatever the cache says', () => {
    for (const status of ['QUEUED', 'PREPARING', 'BUILDING', 'DEPLOYING'] as const) {
      expect(toServiceView(gitRow({ status: 'STOPPED' }), { status }).status).toBe('DEPLOYING');
    }
  });

  it.each<[ServiceStatus, DeploymentStatus, ServiceStatus]>([
    ['RUNNING', 'SUCCESS', 'RUNNING'],
    ['RUNNING', 'FAILED', 'RUNNING'],
    ['STOPPED', 'SUCCESS', 'STOPPED'],
    ['STOPPED', 'FAILED', 'FAILED'],
    ['FAILED', 'FAILED', 'FAILED'],
    ['UNKNOWN', 'SUCCESS', 'UNKNOWN'],
    ['NEVER_DEPLOYED', 'SUCCESS', 'STOPPED'],
    ['DEPLOYING', 'CANCELLED', 'STOPPED'],
  ])('cache %s + latest deployment %s derives %s', (cached, deployment, expected) => {
    expect(toServiceView(gitRow({ status: cached }), { status: deployment }).status).toBe(expected);
  });

  it('carries an image source with null git fields', () => {
    const view = toServiceView(
      gitRow({
        sourceType: 'image',
        repositoryUrl: null,
        branch: null,
        buildContext: null,
        dockerfilePath: null,
        imageRef: 'ghcr.io/acme/api:1.2.3',
        publishedPort: 8080,
      }),
      null,
    );
    expect(view).toMatchObject({ sourceType: 'image', imageRef: 'ghcr.io/acme/api:1.2.3', repositoryUrl: null, publishedPort: 8080 });
  });
});

describe('containerObservationFromCache', () => {
  it.each<[ServiceStatus, string]>([
    ['RUNNING', 'running'],
    ['STOPPED', 'stopped'],
    ['FAILED', 'stopped'],
    ['UNKNOWN', 'unknown'],
    ['NEVER_DEPLOYED', 'absent'],
    ['DEPLOYING', 'absent'],
  ])('maps the cached %s to a %s observation', (cached, kind) => {
    expect(containerObservationFromCache(cached).kind).toBe(kind);
  });
});
