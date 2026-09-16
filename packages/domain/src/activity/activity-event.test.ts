import { describe, expect, it } from 'vitest';
import { secretValue } from '../security/secret-value.js';
import {
  AUTH_ACTIONS,
  InvalidActivityActionError,
  SERVER_ACTIONS,
  SensitiveMetadataError,
  buildActivityEvent,
  type ActivityAction,
  type AuthAction,
} from './activity-event.js';

const NOW = new Date('2026-09-10T12:00:00.000Z');

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
  it('SERVER_ACTIONS has length 6 and equals the exact ordered tuple', () => {
    expect(SERVER_ACTIONS.length).toBe(6);
    expect([...SERVER_ACTIONS]).toEqual([
      'server.created',
      'server.updated',
      'server.deleted',
      'server.connection_attempted',
      'server.discovery_completed',
      'server.fingerprint_trusted',
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

  it('throws InvalidActivityActionError for an unknown namespace (project.created)', () => {
    expect(() =>
      buildActivityEvent(
        {
          actorType: 'user',
          entityType: 'project',
          entityId: 'proj-1',
          action: 'project.created' as ActivityAction,
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
