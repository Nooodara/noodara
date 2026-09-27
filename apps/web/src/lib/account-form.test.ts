// 09-11-PLAN.md Task 1: account-form.ts's pure form logic for the Name/Email/Password account
// Sheets (09-CONTEXT.md D-01, D-02, D-05, D-06). Every rule the Sheets apply lives here, tested
// without React, apiSend or fetch -- server-form.test.ts's precedent for a pure form-helper
// module.
import { describe, expect, it } from 'vitest';
import {
  buildProfileRequest,
  canSubmitPassword,
  canSubmitProfile,
  confirmError,
  passwordNoticeMessage,
  passwordsMatch,
  retryMessage,
} from './account-form';

describe('canSubmitProfile', () => {
  it('is false when currentPassword is blank', () => {
    expect(canSubmitProfile({ value: 'Ada', currentPassword: '' })).toBe(false);
  });

  it('is false when value is blank', () => {
    expect(canSubmitProfile({ value: '', currentPassword: 'x' })).toBe(false);
  });

  it('is true when both are non-blank', () => {
    expect(canSubmitProfile({ value: 'Ada', currentPassword: 'x' })).toBe(true);
  });

  it('is false when value is only whitespace', () => {
    expect(canSubmitProfile({ value: '   ', currentPassword: 'x' })).toBe(false);
  });
});

describe('buildProfileRequest', () => {
  it('trims the name and keeps its case', () => {
    expect(buildProfileRequest('name', '  Ada ', 'pw')).toStrictEqual({ name: 'Ada', currentPassword: 'pw' });
  });

  it('trims and lowercases the email', () => {
    expect(buildProfileRequest('email', ' A@B.co ', 'pw')).toStrictEqual({ email: 'a@b.co', currentPassword: 'pw' });
  });

  it('never includes a key from the other field', () => {
    const nameBody = buildProfileRequest('name', 'Ada', 'pw');
    const emailBody = buildProfileRequest('email', 'ada@example.test', 'pw');

    expect(nameBody).not.toHaveProperty('email');
    expect(emailBody).not.toHaveProperty('name');
  });
});

describe('passwordsMatch', () => {
  it('is true for identical strings', () => {
    expect(passwordsMatch('abc', 'abc')).toBe(true);
  });

  it('is false for different strings', () => {
    expect(passwordsMatch('abc', 'abd')).toBe(false);
  });
});

describe('confirmError', () => {
  it('returns undefined while confirm is empty', () => {
    expect(confirmError('newpass', '')).toBeUndefined();
  });

  it('returns undefined when confirm matches', () => {
    expect(confirmError('newpass', 'newpass')).toBeUndefined();
  });

  it("returns \"Passwords don't match.\" when confirm is non-empty and differs", () => {
    expect(confirmError('newpass', 'other')).toBe("Passwords don't match.");
  });
});

describe('canSubmitPassword', () => {
  it('is false when any of the three fields is blank', () => {
    expect(canSubmitPassword({ currentPassword: '', newPassword: 'a', confirmPassword: 'a' })).toBe(false);
    expect(canSubmitPassword({ currentPassword: 'a', newPassword: '', confirmPassword: 'a' })).toBe(false);
    expect(canSubmitPassword({ currentPassword: 'a', newPassword: 'a', confirmPassword: '' })).toBe(false);
  });

  it('is false when new and confirm do not match', () => {
    expect(canSubmitPassword({ currentPassword: 'a', newPassword: 'new-pass', confirmPassword: 'other' })).toBe(false);
  });

  it('is true when all three are non-blank and new matches confirm', () => {
    expect(canSubmitPassword({ currentPassword: 'a', newPassword: 'new-pass', confirmPassword: 'new-pass' })).toBe(
      true,
    );
  });
});

describe('passwordNoticeMessage', () => {
  it('renders the bare confirmation when no other session was revoked', () => {
    expect(passwordNoticeMessage(0)).toBe('Password updated.');
  });

  it('uses singular "session was" for exactly one revoked session', () => {
    expect(passwordNoticeMessage(1)).toBe('Password updated. 1 other session was signed out.');
  });

  it('uses plural "sessions were" for more than one revoked session', () => {
    expect(passwordNoticeMessage(3)).toBe('Password updated. 3 other sessions were signed out.');
  });

  it('falls back to the count-unknown copy when sessionsRevoked is undefined', () => {
    expect(passwordNoticeMessage(undefined)).toBe('Password updated. Other sessions were signed out.');
  });
});

describe('retryMessage', () => {
  it('embeds the shared formatRetryAfterDuration output', () => {
    expect(retryMessage(90)).toBe('Too many attempts. Try again in 2 minutes.');
  });
});
