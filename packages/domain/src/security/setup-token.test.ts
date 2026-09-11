import { describe, expect, it } from 'vitest';
import { revealSecret } from './secret-value.js';
import {
  SETUP_TOKEN_PURPOSES,
  SETUP_TOKEN_TTL_SECONDS,
  generateSetupToken,
  hashSetupToken,
  isTokenUsable,
  verifyTokenHash,
} from './setup-token.js';

// D-01/D-02/D-03: pure setup/recovery token rules (generation, hashing, usability), shared by
// the setup route (Plan 01-12) and the `noodara admin reset` CLI (Plan 01-14). No database, no
// environment, no clock — every "now" is a parameter (noodara-tdd skill §4).

describe('SETUP_TOKEN_TTL_SECONDS', () => {
  it('is 24 hours', () => {
    expect(SETUP_TOKEN_TTL_SECONDS).toBe(86400);
  });
});

describe('SETUP_TOKEN_PURPOSES', () => {
  it('is exactly ["setup", "recovery"] (D-03)', () => {
    expect(SETUP_TOKEN_PURPOSES).toEqual(['setup', 'recovery']);
  });
});

describe('generateSetupToken', () => {
  it('returns a SecretValue of kind "setup_token"', () => {
    const token = generateSetupToken();
    expect(token.kind).toBe('setup_token');
  });

  it('reveals a value that decodes to at least 32 bytes of entropy (base64url)', () => {
    const token = generateSetupToken();
    const raw = revealSecret(token);
    const decoded = Buffer.from(raw, 'base64url');
    expect(decoded.length).toBeGreaterThanOrEqual(32);
  });

  it('never collides across two consecutive calls', () => {
    const first = revealSecret(generateSetupToken());
    const second = revealSecret(generateSetupToken());
    expect(first).not.toBe(second);
  });

  it('never renders the raw value through toString/toJSON (SecretValue redaction)', () => {
    const token = generateSetupToken();
    expect(token.toString()).toBe('[REDACTED:setup_token]');
    expect(JSON.stringify({ token })).toContain('[REDACTED:setup_token]');
  });
});

describe('hashSetupToken', () => {
  it('returns a lowercase hex SHA-256 digest', () => {
    const digest = hashSetupToken('a-fixed-token-value');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic: the same input always yields the same digest', () => {
    const value = revealSecret(generateSetupToken());
    expect(hashSetupToken(value)).toBe(hashSetupToken(value));
  });

  it('never contains the raw input as a substring of the digest', () => {
    const value = 'super-secret-setup-token-value-1234567890';
    const digest = hashSetupToken(value);
    expect(digest).not.toContain(value);
  });

  it('produces different digests for different inputs', () => {
    expect(hashSetupToken('token-a')).not.toBe(hashSetupToken('token-b'));
  });
});

describe('verifyTokenHash', () => {
  it('returns true for the candidate that hashes to the stored hash', () => {
    const value = 'the-correct-token';
    const storedHash = hashSetupToken(value);
    expect(verifyTokenHash(value, storedHash)).toBe(true);
  });

  it('returns false for a wrong candidate of the same hash length', () => {
    const storedHash = hashSetupToken('the-correct-token');
    expect(verifyTokenHash('a-completely-different-token', storedHash)).toBe(false);
  });

  it('returns false (does not throw) for a stored hash of the wrong length', () => {
    expect(() => verifyTokenHash('any-candidate', 'ab')).not.toThrow();
    expect(verifyTokenHash('any-candidate', 'ab')).toBe(false);
  });

  it('returns false (does not throw) for a stored hash containing non-hex characters', () => {
    const malformed = 'z'.repeat(64);
    expect(() => verifyTokenHash('any-candidate', malformed)).not.toThrow();
    expect(verifyTokenHash('any-candidate', malformed)).toBe(false);
  });
});

describe('isTokenUsable', () => {
  const NOW = new Date('2026-09-11T12:00:00.000Z');

  it('is usable when unused and not yet expired', () => {
    const result = isTokenUsable(
      { usedAt: null, expiresAt: new Date('2026-09-11T12:00:01.000Z') },
      NOW,
    );
    expect(result).toEqual({ usable: true });
  });

  it('is EXPIRED exactly at the boundary (now === expiresAt)', () => {
    const result = isTokenUsable({ usedAt: null, expiresAt: NOW }, NOW);
    expect(result).toEqual({ usable: false, reason: 'EXPIRED' });
  });

  it('is EXPIRED when now is after expiresAt', () => {
    const result = isTokenUsable(
      { usedAt: null, expiresAt: new Date('2026-09-11T11:59:59.000Z') },
      NOW,
    );
    expect(result).toEqual({ usable: false, reason: 'EXPIRED' });
  });

  it('is ALREADY_USED when usedAt is set and not yet expired', () => {
    const result = isTokenUsable(
      { usedAt: new Date('2026-09-11T11:00:00.000Z'), expiresAt: new Date('2026-09-11T13:00:00.000Z') },
      NOW,
    );
    expect(result).toEqual({ usable: false, reason: 'ALREADY_USED' });
  });

  it('prefers ALREADY_USED over EXPIRED when both apply', () => {
    const result = isTokenUsable(
      { usedAt: new Date('2026-09-11T11:00:00.000Z'), expiresAt: new Date('2026-09-11T11:30:00.000Z') },
      NOW,
    );
    expect(result).toEqual({ usable: false, reason: 'ALREADY_USED' });
  });
});
