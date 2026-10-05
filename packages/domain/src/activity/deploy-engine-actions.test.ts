// Phase 12 (12-05, A1): project / environment / service / deployment lifecycle actions. Every one
// of them carries a closed per-action metadata allowlist with a fixed value kind per key, so an
// activity row for the deploy engine structurally cannot carry a repository URL, a token, a key
// or any other free-form value that could hold a secret.
import { describe, expect, it } from 'vitest';
import { secretValue } from '../security/secret-value.js';
import {
  ACCOUNT_ACTIONS,
  ALL_ACTIVITY_ACTIONS,
  AUTH_ACTIONS,
  DEPLOY_ENGINE_ACTION_METADATA_KEYS,
  DEPLOY_ENGINE_ACTIONS,
  DEPLOY_ENGINE_METADATA_KEY_KINDS,
  DEPLOYMENT_ACTIONS,
  ENVIRONMENT_ACTIONS,
  InvalidActivityActionError,
  PROJECT_ACTIONS,
  SERVER_ACTIONS,
  SERVICE_ACTIONS,
  SensitiveMetadataError,
  buildActivityEvent,
  type AnyActivityAction,
  type BuildActivityEventInput,
  type DeployEngineAction,
} from './activity-event.js';

const NOW = new Date('2026-10-04T12:00:00.000Z');

function entityTypeOf(action: DeployEngineAction): string {
  return action.slice(0, action.indexOf('.'));
}

function build(
  action: DeployEngineAction,
  metadata: Record<string, unknown>,
  overrides: Partial<BuildActivityEventInput> = {},
) {
  return buildActivityEvent(
    {
      actorType: 'user',
      actorId: 'user-1',
      entityType: entityTypeOf(action),
      entityId: 'entity-1',
      action,
      outcome: 'success',
      metadata,
      ...overrides,
    },
    NOW,
  );
}

describe('deploy engine action tuples', () => {
  it('PROJECT_ACTIONS covers create, edit, archive, unarchive and delete', () => {
    expect([...PROJECT_ACTIONS]).toEqual([
      'project.created',
      'project.updated',
      'project.archived',
      'project.unarchived',
      'project.deleted',
    ]);
  });

  it('ENVIRONMENT_ACTIONS covers create, edit and delete (PROJ-03)', () => {
    expect([...ENVIRONMENT_ACTIONS]).toEqual(['environment.created', 'environment.updated', 'environment.deleted']);
  });

  it('SERVICE_ACTIONS covers the lifecycle, operations and the out-of-band container change', () => {
    expect([...SERVICE_ACTIONS]).toEqual([
      'service.created',
      'service.updated',
      'service.deleted',
      'service.started',
      'service.stopped',
      'service.restarted',
      'service.container_changed',
    ]);
  });

  it('DEPLOYMENT_ACTIONS covers queued, cancel requested and finished', () => {
    expect([...DEPLOYMENT_ACTIONS]).toEqual(['deployment.queued', 'deployment.cancel_requested', 'deployment.finished']);
  });

  it('DEPLOY_ENGINE_ACTIONS is the concatenation of the four groups with no duplicates', () => {
    expect([...DEPLOY_ENGINE_ACTIONS]).toEqual([
      ...PROJECT_ACTIONS,
      ...ENVIRONMENT_ACTIONS,
      ...SERVICE_ACTIONS,
      ...DEPLOYMENT_ACTIONS,
    ]);
    expect(new Set(DEPLOY_ENGINE_ACTIONS).size).toBe(DEPLOY_ENGINE_ACTIONS.length);
  });

  it('ALL_ACTIVITY_ACTIONS is every v0.1 action plus every deploy engine action', () => {
    expect([...ALL_ACTIVITY_ACTIONS]).toEqual([
      ...AUTH_ACTIONS,
      ...SERVER_ACTIONS,
      ...ACCOUNT_ACTIONS,
      ...DEPLOY_ENGINE_ACTIONS,
    ]);
  });

  it('every deploy engine action has a metadata allowlist and no allowlist exists for anything else', () => {
    expect(Object.keys(DEPLOY_ENGINE_ACTION_METADATA_KEYS).sort()).toEqual([...DEPLOY_ENGINE_ACTIONS].sort());
  });

  it('every allowlisted key has a fixed value kind', () => {
    for (const keys of Object.values(DEPLOY_ENGINE_ACTION_METADATA_KEYS)) {
      for (const key of keys) {
        expect(DEPLOY_ENGINE_METADATA_KEY_KINDS[key]).toBeDefined();
      }
    }
  });

  it('no string-valued key names a repository URL, image reference, credential or free-form output', () => {
    const forbidden = /url|image|repo|token|secret|password|credential|key|message|output|stderr|stdout|command/i;
    for (const [key, kind] of Object.entries(DEPLOY_ENGINE_METADATA_KEY_KINDS)) {
      if (kind === 'boolean' || kind === 'count') continue;
      expect(key).not.toMatch(forbidden);
    }
  });
});

describe('buildActivityEvent for deploy engine actions (A1)', () => {
  it('builds a project.created event with name and slug', () => {
    const event = build('project.created', { name: 'Shop', slug: 'shop' });
    expect(event).toEqual({
      actorType: 'user',
      actorId: 'user-1',
      entityType: 'project',
      entityId: 'entity-1',
      action: 'project.created',
      outcome: 'success',
      metadata: { name: 'Shop', slug: 'shop' },
      occurredAt: NOW,
    });
  });

  it('builds a project.deleted event with counts of what the cascade removed', () => {
    const event = build('project.deleted', { name: 'Shop', environments: 2, services: 3 });
    expect(event.metadata).toEqual({ name: 'Shop', environments: 2, services: 3 });
  });

  it('builds an environment.created event scoped to its project', () => {
    const event = build('environment.created', { projectId: 'p-1', name: 'production', kind: 'production' });
    expect(event.entityType).toBe('environment');
  });

  it('builds a service.updated event with changedFields, requiresRedeploy and credentialReplaced', () => {
    const event = build('service.updated', {
      changedFields: ['branch', 'internalPort'],
      requiresRedeploy: true,
      credentialReplaced: false,
    });
    expect(event.metadata).toEqual({
      changedFields: ['branch', 'internalPort'],
      requiresRedeploy: true,
      credentialReplaced: false,
    });
  });

  it('builds a system service.container_changed event for a container stopped outside Noodara', () => {
    const event = build(
      'service.container_changed',
      { serverId: 's-1', previousStatus: 'RUNNING', observedState: 'exited' },
      { actorType: 'system', actorId: null },
    );
    expect(event.actorType).toBe('system');
    expect(event.actorId).toBeNull();
    expect(event.metadata).toEqual({ serverId: 's-1', previousStatus: 'RUNNING', observedState: 'exited' });
  });

  it('builds a failed deployment.finished event with errorCode on the event, never in metadata', () => {
    const event = build(
      'deployment.finished',
      { serviceId: 'svc-1', status: 'FAILED', durationMs: 4200, commitSha: 'a'.repeat(40) },
      { outcome: 'failure', errorCode: 'BUILD_FAILED', actorType: 'system', actorId: null },
    );
    expect(event.errorCode).toBe('BUILD_FAILED');
    expect(event.metadata).toEqual({ serviceId: 'svc-1', status: 'FAILED', durationMs: 4200, commitSha: 'a'.repeat(40) });
  });

  it('accepts an empty metadata object (every allowlisted key is optional)', () => {
    expect(build('service.started', {}).metadata).toEqual({});
  });

  it('accepts null for an allowlisted string key', () => {
    expect(build('deployment.finished', { serviceId: 'svc-1', commitSha: null }).metadata).toEqual({
      serviceId: 'svc-1',
      commitSha: null,
    });
  });
});

describe('deploy engine metadata cannot carry secrets (A1)', () => {
  it.each([
    ['service.created', 'repositoryUrl', 'https://x-access-token:ghp_canary@github.com/acme/app.git'],
    ['service.created', 'image', 'ghcr.io/acme/app:1.0'],
    ['service.updated', 'previousBranch', 'main'],
    ['deployment.finished', 'stderr', 'fatal: Authentication failed'],
    ['project.updated', 'description', 'anything'],
  ] as const)('rejects %s carrying the non-allowlisted key %s', (action, key, value) => {
    expect(() => build(action, { [key]: value })).toThrow(SensitiveMetadataError);
  });

  it('rejects a key allowlisted for a different action (name on service.started)', () => {
    expect(() => build('service.started', { name: 'api' })).toThrow(SensitiveMetadataError);
  });

  it('reports the offending key on the error', () => {
    try {
      build('service.created', { name: 'api', token: 'canary' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SensitiveMetadataError);
      expect((err as SensitiveMetadataError).key).toBe('token');
    }
  });

  it('rejects a nested object under an allowlisted key', () => {
    expect(() => build('project.created', { name: { password: 'canary' } })).toThrow(SensitiveMetadataError);
    expect(() => build('project.created', { name: { value: 'x' } })).toThrow(SensitiveMetadataError);
  });

  it('rejects a SecretValue under an allowlisted key', () => {
    expect(() => build('project.created', { name: secretValue('canary', 'ssh_password') })).toThrow(SensitiveMetadataError);
  });

  it('rejects a string value that embeds URL credentials', () => {
    expect(() => build('service.created', { name: 'https://user:ghp_canary@github.com/a/b.git' })).toThrow(
      SensitiveMetadataError,
    );
    expect(() => build('service.created', { name: 'ssh://git@github.com/a/b.git' })).toThrow(SensitiveMetadataError);
  });

  it('rejects a string value longer than the bound', () => {
    expect(() => build('project.created', { name: 'x'.repeat(257) })).toThrow(SensitiveMetadataError);
    expect(build('project.created', { name: 'x'.repeat(256) }).metadata).toEqual({ name: 'x'.repeat(256) });
  });

  it('rejects a wrong value kind for a typed key', () => {
    expect(() => build('service.updated', { requiresRedeploy: 'yes' })).toThrow(SensitiveMetadataError);
    expect(() => build('deployment.finished', { durationMs: '42' })).toThrow(SensitiveMetadataError);
    expect(() => build('deployment.finished', { durationMs: -1 })).toThrow(SensitiveMetadataError);
    expect(() => build('deployment.finished', { durationMs: Number.NaN })).toThrow(SensitiveMetadataError);
    expect(() => build('project.deleted', { services: 1.5 })).toThrow(SensitiveMetadataError);
    expect(() => build('project.created', { name: 42 })).toThrow(SensitiveMetadataError);
    expect(() => build('project.updated', { changedFields: 'name' })).toThrow(SensitiveMetadataError);
  });

  it('rejects an id or code value outside its closed charset', () => {
    expect(() => build('service.started', { serverId: 'a b;rm' })).toThrow(SensitiveMetadataError);
    expect(() => build('service.started', { serverId: 'x'.repeat(129) })).toThrow(SensitiveMetadataError);
    expect(() => build('service.container_changed', { observedState: 'exited; rm -rf /' })).toThrow(
      SensitiveMetadataError,
    );
    expect(() => build('deployment.finished', { commitSha: 'deadbeef\n' })).toThrow(SensitiveMetadataError);
    expect(build('service.started', { serverId: '3f0e1c2a-8d1b-4b5e-9a7c-1d2e3f4a5b6c' }).metadata).toEqual({
      serverId: '3f0e1c2a-8d1b-4b5e-9a7c-1d2e3f4a5b6c',
    });
  });

  it('rejects changedFields entries that are not field identifiers', () => {
    expect(() => build('service.updated', { changedFields: ['branch', 'ghp_canary token'] })).toThrow(
      SensitiveMetadataError,
    );
    expect(() => build('service.updated', { changedFields: [42] })).toThrow(SensitiveMetadataError);
    expect(() => build('service.updated', { changedFields: [{ password: 'x' }] })).toThrow(SensitiveMetadataError);
  });

  it('rejects null for a boolean or number key', () => {
    expect(() => build('service.updated', { requiresRedeploy: null })).toThrow(SensitiveMetadataError);
    expect(() => build('deployment.finished', { durationMs: null })).toThrow(SensitiveMetadataError);
  });

  it('rejects an entityType that does not match the action namespace', () => {
    expect(() => build('service.created', {}, { entityType: 'server' })).toThrow(InvalidActivityActionError);
    expect(() => build('deployment.queued', {}, { entityType: 'service' })).toThrow(InvalidActivityActionError);
  });

  it('still rejects an unknown action in a deploy engine namespace', () => {
    expect(() => build('service.exploded' as DeployEngineAction, {})).toThrow(InvalidActivityActionError);
  });

  it('every action accepts every key of its own allowlist with a valid value', () => {
    const sample: Record<string, unknown> = {
      name: 'n',
      slug: 's',
      kind: 'production',
      projectId: 'p',
      environmentId: 'e',
      serverId: 's',
      serviceId: 'svc',
      deploymentId: 'd',
      sourceType: 'git',
      trigger: 'manual',
      status: 'SUCCESS',
      previousStatus: 'RUNNING',
      observedState: 'absent',
      commitSha: 'abc',
      changedFields: ['name'],
      requiresRedeploy: false,
      credentialReplaced: true,
      durationMs: 0,
      environments: 0,
      services: 0,
    };
    for (const action of DEPLOY_ENGINE_ACTIONS) {
      const metadata = Object.fromEntries(DEPLOY_ENGINE_ACTION_METADATA_KEYS[action].map((k) => [k, sample[k]]));
      expect(() => build(action, metadata)).not.toThrow();
    }
  });
});

describe('v0.1 actions are unaffected', () => {
  it('server.created still accepts its documented free-shape metadata', () => {
    const action: AnyActivityAction = 'server.created';
    const event = buildActivityEvent(
      {
        actorType: 'user',
        entityType: 'server',
        entityId: 'srv-1',
        action,
        outcome: 'success',
        metadata: { name: 'a', host: 'h', sshPort: 22, sshUser: 'root', credentialType: 'ssh_key' },
      },
      NOW,
    );
    expect(event.metadata).toEqual({ name: 'a', host: 'h', sshPort: 22, sshUser: 'root', credentialType: 'ssh_key' });
  });
});
