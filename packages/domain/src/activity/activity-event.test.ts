import { describe, expect, it } from 'vitest';
import { secretValue } from '../security/secret-value.js';
import {
  AUTH_ACTIONS,
  SensitiveMetadataError,
  buildActivityEvent,
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
});
