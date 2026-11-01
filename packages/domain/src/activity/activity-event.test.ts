import { describe, expect, it } from 'vitest';
import { secretValue } from '../security/secret-value.js';
import {
  ACCOUNT_ACTIONS,
  ALL_ACTIVITY_ACTIONS,
  AUTH_ACTIONS,
  DOMAIN_ACTIONS,
  ENV_ACTIONS,
  InvalidActivityActionError,
  SECRET_ACTIONS,
  SERVER_ACTIONS,
  SensitiveMetadataError,
  buildActivityEvent,
  type ActivityAction,
  type AuthAction,
} from './activity-event.js';

const NOW = new Date('2026-09-10T12:00:00.000Z');

describe('server.proxy_* metadata (22-02 A1, H3)', () => {
  const build = (action: 'server.proxy_installed' | 'server.proxy_failed' | 'server.proxy_removed', metadata: Record<string, unknown>) =>
    buildActivityEvent(
      { actorType: 'system', entityType: 'server', entityId: 'srv-1', action, outcome: 'success', metadata },
      NOW,
    );

  it('accepts the closed keys with closed values', () => {
    expect(build('server.proxy_installed', { durationMs: 1200, reinstalled: false, trigger: 'request' }).metadata).toEqual({
      durationMs: 1200,
      reinstalled: false,
      trigger: 'request',
    });
    expect(build('server.proxy_failed', { durationMs: 5, step: 'ports', trigger: 'domain' }).metadata.step).toBe('ports');
    expect(build('server.proxy_failed', { step: 'ports', listener: 'nginx', port: 80 }).metadata.listener).toBe('nginx');
    expect(build('server.proxy_removed', { durationMs: 0, trigger: 'server_deleted' }).metadata.trigger).toBe(
      'server_deleted',
    );
  });

  it.each([
    ['server.proxy_installed', { acmeEmail: 'ops@example.com' }],
    ['server.proxy_installed', { stdout: 'nginx pid=1' }],
    ['server.proxy_failed', { step: 'pull image traefik' }],
    ['server.proxy_failed', { process: 'nginx' }],
    ['server.proxy_failed', { listener: '/usr/sbin/nginx -g daemon' }],
    ['server.proxy_failed', { durationMs: -1 }],
    ['server.proxy_removed', { trigger: 'x'.repeat(65) }],
    ['server.proxy_removed', { reinstalled: 'yes' }],
  ] as const)('%s rejects %o', (action, metadata) => {
    expect(() => build(action, metadata)).toThrow(SensitiveMetadataError);
  });
});

describe('AUTH_ACTIONS', () => {
  it('contains exactly the 8 documented auth actions', () => {
    expect([...AUTH_ACTIONS].sort()).toEqual(
      [
        'auth.setup_completed',
        'auth.admin_preseeded',
        'auth.login_succeeded',
        'auth.login_failed',
        'auth.login_blocked',
        'auth.logout',
        'auth.session_revoked',
        'auth.password_reset',
      ].sort(),
    );
    expect(AUTH_ACTIONS.length).toBe(8);
  });
});

describe('buildActivityEvent', () => {
  it('builds an event from the given input and now', () => {
    const event = buildActivityEvent(
      {
        actorType: 'user',
        entityType: 'server',
        entityId: 'srv-1',
        action: 'auth.login_succeeded',
        outcome: 'success',
        metadata: { ip: '203.0.113.5' },
      },
      NOW,
    );

    expect(event.actorType).toBe('user');
    expect(event.entityType).toBe('server');
    expect(event.entityId).toBe('srv-1');
    expect(event.action).toBe('auth.login_succeeded');
    expect(event.outcome).toBe('success');
    expect(event.metadata).toEqual({ ip: '203.0.113.5' });
    expect(event.occurredAt).toBe(NOW);
  });

  it('accepts an optional errorCode', () => {
    const event = buildActivityEvent(
      {
        actorType: 'system',
        entityType: 'admin',
        entityId: 'admin-1',
        action: 'auth.login_failed',
        outcome: 'failure',
        errorCode: 'BAD_CREDENTIALS',
      },
      NOW,
    );

    expect(event.errorCode).toBe('BAD_CREDENTIALS');
  });

  it('defaults metadata to an empty object when omitted', () => {
    const event = buildActivityEvent(
      {
        actorType: 'system',
        entityType: 'admin',
        entityId: 'admin-1',
        action: 'auth.logout',
        outcome: 'success',
      },
      NOW,
    );

    expect(event.metadata).toEqual({});
  });

  it('rejects an action outside the AUTH_ACTIONS union', () => {
    expect(() =>
      buildActivityEvent(
        {
          actorType: 'user',
          entityType: 'admin',
          entityId: 'admin-1',
          action: 'auth.bogus_action' as AuthAction,
          outcome: 'success',
        },
        NOW,
      ),
    ).toThrow();
  });

  it('throws SensitiveMetadataError for a top-level forbidden key', () => {
    expect(() =>
      buildActivityEvent(
        {
          actorType: 'user',
          entityType: 'admin',
          entityId: 'admin-1',
          action: 'auth.login_failed',
          outcome: 'failure',
          metadata: { password: 'x' },
        },
        NOW,
      ),
    ).toThrow(SensitiveMetadataError);
  });

  it('throws SensitiveMetadataError for a nested forbidden key (metadata.detail.password)', () => {
    expect(() =>
      buildActivityEvent(
        {
          actorType: 'user',
          entityType: 'admin',
          entityId: 'admin-1',
          action: 'auth.login_failed',
          outcome: 'failure',
          metadata: { detail: { password: 'x' } },
        },
        NOW,
      ),
    ).toThrow(SensitiveMetadataError);
  });

  it('throws SensitiveMetadataError for a forbidden key nested inside an array', () => {
    expect(() =>
      buildActivityEvent(
        {
          actorType: 'user',
          entityType: 'admin',
          entityId: 'admin-1',
          action: 'auth.login_failed',
          outcome: 'failure',
          metadata: { attempts: [{ token: 'x' }] },
        },
        NOW,
      ),
    ).toThrow(SensitiveMetadataError);
  });

  it('is case-insensitive when matching forbidden keys (sshPassword)', () => {
    expect(() =>
      buildActivityEvent(
        {
          actorType: 'user',
          entityType: 'admin',
          entityId: 'admin-1',
          action: 'auth.login_failed',
          outcome: 'failure',
          metadata: { SSHPassword: 'x' },
        },
        NOW,
      ),
    ).toThrow(SensitiveMetadataError);
  });

  it('allows an array of non-sensitive values inside metadata', () => {
    const event = buildActivityEvent(
      {
        actorType: 'user',
        entityType: 'admin',
        entityId: 'admin-1',
        action: 'auth.login_succeeded',
        outcome: 'success',
        metadata: { tags: ['first-login', 'trusted-device'] },
      },
      NOW,
    );

    expect(event.metadata).toEqual({ tags: ['first-login', 'trusted-device'] });
  });

  it('rejects a metadata value that is a SecretValue instance regardless of key name', () => {
    expect(() =>
      buildActivityEvent(
        {
          actorType: 'user',
          entityType: 'admin',
          entityId: 'admin-1',
          action: 'auth.login_failed',
          outcome: 'failure',
          metadata: { note: secretValue('super-secret', 'ssh_password') },
        },
        NOW,
      ),
    ).toThrow(SensitiveMetadataError);
  });

  it('rejects an unknown action with the updated "Unknown activity action" wording', () => {
    expect(() =>
      buildActivityEvent(
        {
          actorType: 'user',
          entityType: 'admin',
          entityId: 'admin-1',
          action: 'auth.bogus_action' as AuthAction,
          outcome: 'success',
        },
        NOW,
      ),
    ).toThrow('Unknown activity action: "auth.bogus_action"');
  });
});

describe('server actions (ACT-01, D-16)', () => {
  it('SERVER_ACTIONS has length 9 and equals the exact ordered tuple', () => {
    expect(SERVER_ACTIONS.length).toBe(9);
    expect([...SERVER_ACTIONS]).toEqual([
      'server.created',
      'server.updated',
      'server.deleted',
      'server.connection_attempted',
      'server.discovery_completed',
      'server.fingerprint_trusted',
      'server.proxy_installed',
      'server.proxy_failed',
      'server.proxy_removed',
    ]);
  });

  it('AUTH_ACTIONS still has exactly 8 entries', () => {
    expect(AUTH_ACTIONS.length).toBe(8);
  });

  it.each(SERVER_ACTIONS)('builds a %s event and round-trips the action', (action) => {
    const event = buildActivityEvent(
      {
        actorType: 'user',
        entityType: 'server',
        entityId: 'srv-1',
        action,
        outcome: 'success',
      },
      NOW,
    );

    expect(event.action).toBe(action);
  });

  it('throws InvalidActivityActionError for an unknown server.* action', () => {
    expect(() =>
      buildActivityEvent(
        {
          actorType: 'user',
          entityType: 'server',
          entityId: 'srv-1',
          action: 'server.exploded' as ActivityAction,
          outcome: 'failure',
        },
        NOW,
      ),
    ).toThrow(InvalidActivityActionError);
  });

  it('throws InvalidActivityActionError for an unknown namespace (cluster.created)', () => {
    expect(() =>
      buildActivityEvent(
        {
          actorType: 'user',
          entityType: 'cluster',
          entityId: 'cluster-1',
          action: 'cluster.created' as ActivityAction,
          outcome: 'success',
        },
        NOW,
      ),
    ).toThrow(InvalidActivityActionError);
  });

  it('throws SensitiveMetadataError for a server.created event with a credential key', () => {
    expect(() =>
      buildActivityEvent(
        {
          actorType: 'user',
          entityType: 'server',
          entityId: 'srv-1',
          action: 'server.created',
          outcome: 'success',
          metadata: { credential: 'x' },
        },
        NOW,
      ),
    ).toThrow(SensitiveMetadataError);
  });

  it('builds a server.updated event with changedFields and credentialReplaced metadata', () => {
    const event = buildActivityEvent(
      {
        actorType: 'user',
        entityType: 'server',
        entityId: 'srv-1',
        action: 'server.updated',
        outcome: 'success',
        metadata: { changedFields: ['host', 'sshPort'], credentialReplaced: true },
      },
      NOW,
    );

    expect(event.metadata).toEqual({ changedFields: ['host', 'sshPort'], credentialReplaced: true });
  });

  it('builds a server.fingerprint_trusted event with public fingerprint metadata', () => {
    const event = buildActivityEvent(
      {
        actorType: 'user',
        entityType: 'server',
        entityId: 'srv-1',
        action: 'server.fingerprint_trusted',
        outcome: 'success',
        metadata: { previousFingerprint: 'SHA256:old', newFingerprint: 'SHA256:new' },
      },
      NOW,
    );

    expect(event.metadata).toEqual({
      previousFingerprint: 'SHA256:old',
      newFingerprint: 'SHA256:new',
    });
  });
});

describe('account actions (SET-02/SET-03, D-08)', () => {
  it('ACCOUNT_ACTIONS has length 3 and equals the exact ordered tuple', () => {
    expect(ACCOUNT_ACTIONS.length).toBe(3);
    expect([...ACCOUNT_ACTIONS]).toEqual([
      'account.name_changed',
      'account.email_changed',
      'account.password_changed',
    ]);
  });

  it('builds an account.name_changed event with a name metadata key', () => {
    const event = buildActivityEvent(
      {
        actorType: 'user',
        entityType: 'user',
        entityId: 'admin-1',
        action: 'account.name_changed',
        outcome: 'success',
        metadata: { name: 'Ada' },
      },
      NOW,
    );

    expect(event.metadata).toEqual({ name: 'Ada' });
  });

  it('builds an account.email_changed event with an email metadata key', () => {
    const event = buildActivityEvent(
      {
        actorType: 'user',
        entityType: 'user',
        entityId: 'admin-1',
        action: 'account.email_changed',
        outcome: 'success',
        metadata: { email: 'a@b.co' },
      },
      NOW,
    );

    expect(event.metadata).toEqual({ email: 'a@b.co' });
  });

  it('builds an account.password_changed event with a sessions_revoked metadata key', () => {
    const event = buildActivityEvent(
      {
        actorType: 'user',
        entityType: 'user',
        entityId: 'admin-1',
        action: 'account.password_changed',
        outcome: 'success',
        metadata: { sessions_revoked: 2 },
      },
      NOW,
    );

    expect(event.metadata).toEqual({ sessions_revoked: 2 });
  });

  it('throws SensitiveMetadataError for account.email_changed carrying previousEmail', () => {
    expect(() =>
      buildActivityEvent(
        {
          actorType: 'user',
          entityType: 'user',
          entityId: 'admin-1',
          action: 'account.email_changed',
          outcome: 'success',
          metadata: { email: 'a@b.co', previousEmail: 'x@y.co' },
        },
        NOW,
      ),
    ).toThrow(SensitiveMetadataError);
  });

  it('throws SensitiveMetadataError for account.password_changed carrying an ip key', () => {
    expect(() =>
      buildActivityEvent(
        {
          actorType: 'user',
          entityType: 'user',
          entityId: 'admin-1',
          action: 'account.password_changed',
          outcome: 'success',
          metadata: { sessions_revoked: 1, ip: '1.2.3.4' },
        },
        NOW,
      ),
    ).toThrow(SensitiveMetadataError);
  });

  it('throws SensitiveMetadataError for an account.* event carrying a password key', () => {
    expect(() =>
      buildActivityEvent(
        {
          actorType: 'user',
          entityType: 'user',
          entityId: 'admin-1',
          action: 'account.password_changed',
          outcome: 'success',
          metadata: { sessions_revoked: 1, password: 'x' },
        },
        NOW,
      ),
    ).toThrow(SensitiveMetadataError);
  });

  it('throws SensitiveMetadataError for account.name_changed carrying a token key', () => {
    expect(() =>
      buildActivityEvent(
        {
          actorType: 'user',
          entityType: 'user',
          entityId: 'admin-1',
          action: 'account.name_changed',
          outcome: 'success',
          metadata: { name: 'Ada', token: 'x' },
        },
        NOW,
      ),
    ).toThrow(SensitiveMetadataError);
  });
});

describe('deployment.rollback_started (17-03 P1)', () => {
  it('is a closed-vocabulary action buildActivityEvent accepts', () => {
    expect(ALL_ACTIVITY_ACTIONS).toContain('deployment.rollback_started');
    const event = buildActivityEvent(
      {
        actorType: 'system',
        entityType: 'deployment',
        entityId: 'dep-2',
        action: 'deployment.rollback_started',
        outcome: 'success',
        metadata: { deploymentId: 'dep-2', serviceId: 'svc-1', targetDeploymentId: 'dep-1' },
      },
      NOW,
    );
    expect(event).toMatchObject({ action: 'deployment.rollback_started', actorId: null, occurredAt: NOW });
  });

  it('rejects a secret-shaped key even next to the allowlisted ids', () => {
    expect(() =>
      buildActivityEvent(
        {
          actorType: 'system',
          entityType: 'deployment',
          entityId: 'dep-2',
          action: 'deployment.rollback_started',
          outcome: 'success',
          metadata: { serviceId: 'svc-1', token: 'ghp_canary' },
        },
        NOW,
      ),
    ).toThrow(SensitiveMetadataError);
  });
});

describe('domain.* certificate actions (22-04 A3, H4)', () => {
  const build = (action: (typeof DOMAIN_ACTIONS)[number], entityType: string, metadata: Record<string, unknown>) =>
    buildActivityEvent({ actorType: 'system', entityType, entityId: 'dom-1', action, outcome: 'success', metadata }, NOW);

  it('accepts the closed allowlist for each action', () => {
    expect(build('domain.certificate_issued', 'domain', { serviceId: 'svc-1', previousStatus: 'PENDING' }).action).toBe(
      'domain.certificate_issued',
    );
    expect(build('domain.certificate_failed', 'domain', { serviceId: 'svc-1', previousStatus: 'PENDING' }).metadata).toEqual({
      serviceId: 'svc-1',
      previousStatus: 'PENDING',
    });
    expect(build('domain.certificate_expired', 'domain', { serviceId: 'svc-1' }).action).toBe('domain.certificate_expired');
    expect(build('domain.route_restored', 'service', { serviceId: 'svc-1', durationMs: 12 }).action).toBe('domain.route_restored');
  });

  it('is not part of the deploy-engine or legacy action lists', () => {
    for (const action of DOMAIN_ACTIONS) {
      expect(ALL_ACTIVITY_ACTIONS).not.toContain(action);
    }
  });

  it.each<[(typeof DOMAIN_ACTIONS)[number], string, Record<string, unknown>]>([
    ['domain.certificate_issued', 'domain', { hostname: 'app.example.com' }],
    ['domain.certificate_failed', 'domain', { issuer: 'Pebble Intermediate' }],
    ['domain.certificate_failed', 'domain', { previousStatus: 'pending status' }],
    ['domain.certificate_expired', 'domain', { certificate: '-----BEGIN' }],
    ['domain.route_restored', 'service', { path: '/etc/noodara/traefik/dynamic/x.yml' }],
    ['domain.route_restored', 'service', { durationMs: -1 }],
  ])('rejects %s with metadata %j', (action, entityType, metadata) => {
    expect(() => build(action, entityType, metadata)).toThrow(SensitiveMetadataError);
  });

  it('rejects a mismatched entityType', () => {
    expect(() => build('domain.certificate_issued', 'service', { serviceId: 'svc-1' })).toThrow(InvalidActivityActionError);
    expect(() => build('domain.route_restored', 'domain', { serviceId: 'svc-1' })).toThrow(InvalidActivityActionError);
  });
});

describe('env.variable_* actions (23-02 A1)', () => {
  const build = (action: (typeof ENV_ACTIONS)[number], entityType: string, metadata: Record<string, unknown>) =>
    buildActivityEvent({ actorType: 'user', actorId: 'u-1', entityType, entityId: 'var-1', action, outcome: 'success', metadata }, NOW);

  it('accepts scope and key only, for each action', () => {
    for (const action of ENV_ACTIONS) {
      expect(build(action, 'environment_variable', { scope: 'service', key: 'DATABASE_URL' }).metadata).toEqual({
        scope: 'service',
        key: 'DATABASE_URL',
      });
    }
  });

  it('is not part of the legacy action lists', () => {
    for (const action of ENV_ACTIONS) expect(ALL_ACTIVITY_ACTIONS).not.toContain(action);
  });

  it.each<[Record<string, unknown>]>([
    [{ scope: 'service', key: 'API_KEY', value: 'canary-123' }],
    [{ scope: 'service' }],
    [{ key: 'API_KEY' }],
    [{ scope: 'global', key: 'API_KEY' }],
    [{ scope: 'project', key: 'not a key: canary-123' }],
    [{ scope: 'project', key: 42 }],
  ])('rejects metadata %j', (metadata) => {
    expect(() => build('env.variable_created', 'environment_variable', metadata)).toThrow(SensitiveMetadataError);
  });

  it('rejects a mismatched entityType', () => {
    expect(() => build('env.variable_updated', 'service', { scope: 'project', key: 'A' })).toThrow(InvalidActivityActionError);
  });
});

describe('secret.* actions (23-03 A2, H1)', () => {
  const build = (action: (typeof SECRET_ACTIONS)[number], entityType: string, metadata: Record<string, unknown>) =>
    buildActivityEvent({ actorType: 'user', actorId: 'u-1', entityType, entityId: 'sec-1', action, outcome: 'success', metadata }, NOW);

  it('accepts scope and name only, for each action', () => {
    expect(SECRET_ACTIONS).toEqual(['secret.created', 'secret.replaced', 'secret.deleted']);
    for (const action of SECRET_ACTIONS) {
      expect(build(action, 'secret', { scope: 'environment', name: 'db_password' }).metadata).toEqual({
        scope: 'environment',
        name: 'db_password',
      });
    }
  });

  it('is not part of the legacy action lists', () => {
    for (const action of SECRET_ACTIONS) expect(ALL_ACTIVITY_ACTIONS).not.toContain(action);
  });

  it.each<[Record<string, unknown>]>([
    [{ scope: 'service', name: 'api_key', value: 'canary-123' }],
    [{ scope: 'service', name: 'api_key', hint: '…123' }],
    [{ scope: 'service' }],
    [{ name: 'api_key' }],
    [{ scope: 'global', name: 'api_key' }],
    [{ scope: 'project', name: 'not a name: canary-123' }],
    [{ scope: 'project', name: 'API_KEY' }],
    [{ scope: 'project', name: 42 }],
  ])('rejects metadata %j', (metadata) => {
    expect(() => build('secret.created', 'secret', metadata)).toThrow(SensitiveMetadataError);
  });

  it('rejects a mismatched entityType', () => {
    expect(() => build('secret.deleted', 'environment_variable', { scope: 'project', name: 'a' })).toThrow(
      InvalidActivityActionError,
    );
  });
});
