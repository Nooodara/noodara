import { describe, expect, it } from 'vitest';
import {
  AccountProfileResponseSchema,
  ChangePasswordBodySchema,
  ChangePasswordResponseSchema,
  PreferencesResponseSchema,
  UpdatePreferencesBodySchema,
  UpdateProfileBodySchema,
} from './account-schemas.js';

// 09-06 Task 1: strict request/response contracts for the phase's three `/api/account/*` routes.
// `.strict()` schemas reject mass-assignment (an extra `userId` key), and every string carries an
// explicit max length protecting argon2/the DB — the domain validators (`validateName`/
// `validateAccountEmail`) still own the product-level rules.

describe('UpdateProfileBodySchema', () => {
  const currentPassword = 'correct horse battery staple';

  it('accepts a name-only edit', () => {
    expect(UpdateProfileBodySchema.safeParse({ name: 'Ada', currentPassword }).success).toBe(true);
  });

  it('accepts an email-only edit', () => {
    expect(UpdateProfileBodySchema.safeParse({ email: 'ada@example.com', currentPassword }).success).toBe(true);
  });

  it('accepts a name+email edit', () => {
    expect(
      UpdateProfileBodySchema.safeParse({ name: 'Ada', email: 'ada@example.com', currentPassword }).success,
    ).toBe(true);
  });

  it('rejects a body missing currentPassword', () => {
    expect(UpdateProfileBodySchema.safeParse({ name: 'Ada' }).success).toBe(false);
  });

  it('rejects an empty currentPassword', () => {
    expect(UpdateProfileBodySchema.safeParse({ name: 'Ada', currentPassword: '' }).success).toBe(false);
  });

  it('rejects a body with neither name nor email', () => {
    expect(UpdateProfileBodySchema.safeParse({ currentPassword }).success).toBe(false);
  });

  it('rejects an extra key (userId) — mass-assignment/IDOR guard (T-09-08)', () => {
    expect(
      UpdateProfileBodySchema.safeParse({ name: 'Ada', currentPassword, userId: 'someone-else' }).success,
    ).toBe(false);
  });

  it('rejects a currentPassword longer than 256 characters', () => {
    expect(UpdateProfileBodySchema.safeParse({ name: 'Ada', currentPassword: 'x'.repeat(257) }).success).toBe(
      false,
    );
  });

  it('rejects a name longer than 200 characters', () => {
    expect(UpdateProfileBodySchema.safeParse({ name: 'x'.repeat(201), currentPassword }).success).toBe(false);
  });

  it('rejects an email longer than 320 characters', () => {
    const longEmail = `${'a'.repeat(311)}@example.com`;
    expect(longEmail.length).toBeGreaterThan(320);
    expect(UpdateProfileBodySchema.safeParse({ email: longEmail, currentPassword }).success).toBe(false);
  });
});

describe('ChangePasswordBodySchema', () => {
  it('accepts a currentPassword/newPassword pair', () => {
    expect(
      ChangePasswordBodySchema.safeParse({ currentPassword: 'old-password', newPassword: 'new-password' })
        .success,
    ).toBe(true);
  });

  it('rejects an extra revokeOtherSessions key — the server always sets revocation itself', () => {
    expect(
      ChangePasswordBodySchema.safeParse({
        currentPassword: 'old-password',
        newPassword: 'new-password',
        revokeOtherSessions: false,
      }).success,
    ).toBe(false);
  });

  it('rejects an extra userId key', () => {
    expect(
      ChangePasswordBodySchema.safeParse({
        currentPassword: 'old-password',
        newPassword: 'new-password',
        userId: 'someone-else',
      }).success,
    ).toBe(false);
  });

  it('rejects a newPassword longer than 256 characters', () => {
    expect(
      ChangePasswordBodySchema.safeParse({ currentPassword: 'old-password', newPassword: 'x'.repeat(257) })
        .success,
    ).toBe(false);
  });
});

describe('UpdatePreferencesBodySchema (PreferencesPatchSchema)', () => {
  it('accepts a single-key patch', () => {
    expect(UpdatePreferencesBodySchema.safeParse({ theme: 'dark' }).success).toBe(true);
  });

  it('rejects an empty patch (strict, >=1 key)', () => {
    expect(UpdatePreferencesBodySchema.safeParse({}).success).toBe(false);
  });

  it('rejects an unknown key', () => {
    expect(UpdatePreferencesBodySchema.safeParse({ theme: 'dark', extra: true }).success).toBe(false);
  });
});

describe('Response schemas', () => {
  it('AccountProfileResponseSchema is exactly { name, email }', () => {
    const parsed = AccountProfileResponseSchema.parse({ name: 'Ada', email: 'ada@example.com' });
    expect(Object.keys(parsed).sort()).toStrictEqual(['email', 'name']);
  });

  it('ChangePasswordResponseSchema is { sessionsRevoked: int >= 0 } with no token field', () => {
    expect(ChangePasswordResponseSchema.safeParse({ sessionsRevoked: 0 }).success).toBe(true);
    expect(ChangePasswordResponseSchema.safeParse({ sessionsRevoked: -1 }).success).toBe(false);
    expect(ChangePasswordResponseSchema.safeParse({ sessionsRevoked: 1.5 }).success).toBe(false);
  });

  it('PreferencesResponseSchema accepts a full Preferences object', () => {
    expect(
      PreferencesResponseSchema.safeParse({ theme: 'auto', reduceMotion: 'system', density: 'comfortable' })
        .success,
    ).toBe(true);
  });
});
