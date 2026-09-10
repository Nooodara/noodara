import { describe, expect, it } from 'vitest';
import { validateEmail, validateServerName, validateSshUser } from './identity.js';

describe('validateServerName', () => {
  it.each(['my-server', 'srv01', 'a', 'a1b2c3'])('accepts slug %s', (name) => {
    const result = validateServerName(name);
    expect(result).toEqual({ ok: true, value: name });
  });

  it('fails for uppercase (My-Server)', () => {
    const result = validateServerName('My-Server');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('SERVER_NAME_INVALID');
  });

  it('succeeds for lowercase (my-server)', () => {
    const result = validateServerName('my-server');
    expect(result).toEqual({ ok: true, value: 'my-server' });
  });

  it('rejects a leading hyphen', () => {
    const result = validateServerName('-server');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('SERVER_NAME_INVALID');
  });

  it('rejects a trailing hyphen', () => {
    const result = validateServerName('server-');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('SERVER_NAME_INVALID');
  });

  it('rejects a 64-character name', () => {
    const result = validateServerName('a'.repeat(64));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('SERVER_NAME_INVALID');
  });

  it('rejects an empty string', () => {
    const result = validateServerName('');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('SERVER_NAME_INVALID');
  });
});

describe('validateSshUser', () => {
  it.each(['root', 'ubuntu', 'deploy-user', 'user_1'])('accepts %s', (user) => {
    const result = validateSshUser(user);
    expect(result).toEqual({ ok: true, value: user });
  });

  it('rejects an empty string', () => {
    const result = validateSshUser('');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('SSH_USER_INVALID');
  });

  it('rejects a name over 32 characters', () => {
    const result = validateSshUser('a'.repeat(33));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('SSH_USER_INVALID');
  });

  it('rejects a leading digit', () => {
    const result = validateSshUser('1deploy');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('SSH_USER_INVALID');
  });

  it('rejects whitespace', () => {
    const result = validateSshUser('dep loy');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('SSH_USER_INVALID');
  });

  it('rejects a slash', () => {
    const result = validateSshUser('dep/loy');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('SSH_USER_INVALID');
  });

  it('rejects a colon', () => {
    const result = validateSshUser('dep:loy');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('SSH_USER_INVALID');
  });

  it('rejects a shell metacharacter', () => {
    const result = validateSshUser('dep;loy');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('SSH_USER_INVALID');
  });
});

describe('validateEmail', () => {
  it('accepts a normal address', () => {
    const result = validateEmail('admin@example.com');
    expect(result).toEqual({ ok: true, value: 'admin@example.com' });
  });

  it('lowercases the success value', () => {
    const result = validateEmail('Admin@Example.COM');
    expect(result).toEqual({ ok: true, value: 'admin@example.com' });
  });

  it('rejects a value with no @', () => {
    const result = validateEmail('adminexample.com');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('EMAIL_INVALID');
  });

  it('rejects a value with no domain dot', () => {
    const result = validateEmail('admin@examplecom');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('EMAIL_INVALID');
  });

  it('rejects leading whitespace', () => {
    const result = validateEmail(' admin@example.com');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('EMAIL_INVALID');
  });

  it('rejects trailing whitespace', () => {
    const result = validateEmail('admin@example.com ');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('EMAIL_INVALID');
  });

  it('rejects an address over 254 characters', () => {
    const longLocalPart = 'a'.repeat(250);
    const result = validateEmail(`${longLocalPart}@example.com`);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('EMAIL_INVALID');
  });
});
