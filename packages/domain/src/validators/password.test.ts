import { describe, expect, it } from 'vitest';
import { COMMON_PASSWORDS } from './common-passwords.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, validatePassword } from './password.js';

describe('PASSWORD_MIN_LENGTH / PASSWORD_MAX_LENGTH', () => {
  it('is 12 and 128 respectively', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
  });
});

describe('COMMON_PASSWORDS', () => {
  it('has at least 200 entries', () => {
    expect(COMMON_PASSWORDS.size).toBeGreaterThanOrEqual(200);
  });

  it('every entry equals its own lowercase form', () => {
    for (const entry of COMMON_PASSWORDS) {
      expect(entry).toBe(entry.toLowerCase());
    }
  });
});

describe('validatePassword', () => {
  it('fails for an 11-character password', () => {
    const result = validatePassword('a'.repeat(11));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('PASSWORD_TOO_SHORT');
  });

  it('succeeds for a 12-character password', () => {
    const result = validatePassword('correcthorse');
    expect(result.ok).toBe(true);
  });

  it("fails 'short' with PASSWORD_TOO_SHORT", () => {
    const result = validatePassword('short');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('PASSWORD_TOO_SHORT');
  });

  it('fails a password over 128 characters with PASSWORD_TOO_LONG', () => {
    const result = validatePassword('a'.repeat(129));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('PASSWORD_TOO_LONG');
  });

  it('succeeds for exactly 128 characters', () => {
    const result = validatePassword('a1'.repeat(64));
    expect(result.ok).toBe(true);
  });

  it('enforces no composition rule: all-lowercase-plus-digit passes composition dimension', () => {
    const result = validatePassword('aaaaaaaaaaaa1');
    expect(result.ok).toBe(true);
  });

  it('enforces no composition rule: a passphrase with spaces passes composition dimension', () => {
    const result = validatePassword('correct horse battery staple');
    expect(result.ok).toBe(true);
  });

  it("fails 'password1234' with PASSWORD_TOO_COMMON", () => {
    const result = validatePassword('password1234');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('PASSWORD_TOO_COMMON');
  });

  it('common-password check is case-insensitive (Password1234)', () => {
    const result = validatePassword('Password1234');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('PASSWORD_TOO_COMMON');
  });

  it('fails when the password equals the email, case-insensitively', () => {
    const result = validatePassword('Admin@Example.com', { email: 'admin@example.com' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('PASSWORD_EQUALS_IDENTIFIER');
  });

  it('fails when the password equals the email local part, case-insensitively', () => {
    const result = validatePassword('AdminUser123', { email: 'AdminUser123@example.com' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('PASSWORD_EQUALS_IDENTIFIER');
  });

  it('does not echo the submitted password in the failure message', () => {
    const result = validatePassword('short');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message.includes('short')).toBe(false);
  });

  it('does not echo the submitted password in the common-password failure message', () => {
    const result = validatePassword('password1234');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message.includes('password1234')).toBe(false);
  });
});
