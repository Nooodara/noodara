import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password-hasher.js';

// AUTH-02: passwords are hashed with argon2id, never Better Auth's default (scrypt-based) hasher.

describe('password-hasher', () => {
  it('hashes with argon2id (stored hash starts with $argon2id$)', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('verifies the correct password and rejects any other password', async () => {
    const hash = await hashPassword('correct horse battery staple');

    await expect(verifyPassword({ hash, password: 'correct horse battery staple' })).resolves.toBe(true);
    await expect(verifyPassword({ hash, password: 'wrong password entirely' })).resolves.toBe(false);
  });

  it('returns false, rather than throwing, for a malformed stored hash', async () => {
    await expect(
      verifyPassword({ hash: 'not-a-real-argon2-hash', password: 'whatever' }),
    ).resolves.toBe(false);
  });

  it('hashes the same password to different digests each time (random salt)', async () => {
    const first = await hashPassword('correct horse battery staple');
    const second = await hashPassword('correct horse battery staple');

    expect(first).not.toBe(second);
  });
});
