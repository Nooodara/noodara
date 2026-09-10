import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

function base64Key(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64');
}

function validSource(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NOODARA_MASTER_KEY: base64Key(32),
    BETTER_AUTH_SECRET: 'a'.repeat(32),
    DATABASE_URL: 'postgres://noodara_admin:s3cure-pass@localhost:5432/noodara',
    REDIS_URL: 'redis://localhost:6379',
    NOODARA_PUBLIC_URL: 'https://noodara.example.com',
    ...overrides,
  };
}

describe('parseEnv', () => {
  it('lists every required variable as missing when source is empty', () => {
    const result = parseEnv({});

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    const variables = result.issues.map((issue) => issue.variable);
    expect(variables).toEqual(
      expect.arrayContaining([
        'NOODARA_MASTER_KEY',
        'BETTER_AUTH_SECRET',
        'DATABASE_URL',
        'REDIS_URL',
        'NOODARA_PUBLIC_URL',
      ]),
    );
  });

  it('accepts a fully valid source', () => {
    const result = parseEnv(validSource());

    expect(result.ok).toBe(true);
  });

  describe('NOODARA_MASTER_KEY', () => {
    it('rejects a value that is not valid base64', () => {
      const result = parseEnv(validSource({ NOODARA_MASTER_KEY: 'not-valid-base64!!!' }));

      expect(result.ok).toBe(false);
    });

    it('rejects a key that decodes to 31 bytes', () => {
      const result = parseEnv(validSource({ NOODARA_MASTER_KEY: base64Key(31) }));

      expect(result.ok).toBe(false);
    });

    it('rejects a key that decodes to 33 bytes', () => {
      const result = parseEnv(validSource({ NOODARA_MASTER_KEY: base64Key(33) }));

      expect(result.ok).toBe(false);
    });

    it('accepts a key that decodes to exactly 32 bytes', () => {
      const result = parseEnv(validSource({ NOODARA_MASTER_KEY: base64Key(32) }));

      expect(result.ok).toBe(true);
    });
  });

  describe('BETTER_AUTH_SECRET', () => {
    it('rejects a secret shorter than 32 characters', () => {
      const result = parseEnv(validSource({ BETTER_AUTH_SECRET: 'a'.repeat(31) }));

      expect(result.ok).toBe(false);
    });

    it.each(['changeme', 'secret', 'password', 'noodara', 'ChangeMe', 'SECRET'])(
      'rejects the placeholder value %s regardless of case',
      (placeholder) => {
        const result = parseEnv(validSource({ BETTER_AUTH_SECRET: placeholder }));

        expect(result.ok).toBe(false);
      },
    );
  });

  describe('DATABASE_URL', () => {
    it('rejects a URL with an empty password component', () => {
      const result = parseEnv(
        validSource({ DATABASE_URL: 'postgres://noodara_admin@localhost:5432/noodara' }),
      );

      expect(result.ok).toBe(false);
    });

    it.each(['postgres', 'password', 'changeme'])('rejects the placeholder password %s', (weakPassword) => {
      const result = parseEnv(
        validSource({ DATABASE_URL: `postgres://noodara_admin:${weakPassword}@localhost:5432/noodara` }),
      );

      expect(result.ok).toBe(false);
    });
  });

  describe('NOODARA_ADMIN_EMAIL / NOODARA_ADMIN_PASSWORD pairing (D-04)', () => {
    it('accepts both present together', () => {
      const result = parseEnv(
        validSource({ NOODARA_ADMIN_EMAIL: 'admin@example.com', NOODARA_ADMIN_PASSWORD: 'a-strong-password' }),
      );

      expect(result.ok).toBe(true);
    });

    it('accepts both absent', () => {
      const result = parseEnv(validSource());

      expect(result.ok).toBe(true);
    });

    it('rejects only NOODARA_ADMIN_EMAIL present', () => {
      const result = parseEnv(validSource({ NOODARA_ADMIN_EMAIL: 'admin@example.com' }));

      expect(result.ok).toBe(false);
    });

    it('rejects only NOODARA_ADMIN_PASSWORD present', () => {
      const result = parseEnv(validSource({ NOODARA_ADMIN_PASSWORD: 'a-strong-password' }));

      expect(result.ok).toBe(false);
    });
  });

  describe('NOODARA_MASTER_KEY_PREVIOUS (D-11)', () => {
    it('accepts a valid 32-byte base64 previous key', () => {
      const result = parseEnv(validSource({ NOODARA_MASTER_KEY_PREVIOUS: base64Key(32) }));

      expect(result.ok).toBe(true);
    });

    it('rejects a previous key that decodes to 31 bytes', () => {
      const result = parseEnv(validSource({ NOODARA_MASTER_KEY_PREVIOUS: base64Key(31) }));

      expect(result.ok).toBe(false);
    });

    it('is optional', () => {
      const result = parseEnv(validSource());

      expect(result.ok).toBe(true);
    });
  });

  describe('tuning knobs default values', () => {
    it('applies every documented default when unset', () => {
      const result = parseEnv(validSource());

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected success');
      expect(result.value.NOODARA_SESSION_SLIDING_SECONDS).toBe(604800);
      expect(result.value.NOODARA_SESSION_UPDATE_AGE_SECONDS).toBe(86400);
      expect(result.value.NOODARA_SESSION_ABSOLUTE_SECONDS).toBe(2592000);
      expect(result.value.NOODARA_LOGIN_MAX_ATTEMPTS).toBe(5);
      expect(result.value.NOODARA_LOGIN_WINDOW_SECONDS).toBe(900);
      expect(result.value.NOODARA_LOGIN_BACKOFF_MAX_SECONDS).toBe(86400);
      expect(result.value.NOODARA_COOKIE_INSECURE).toBe(false);
      expect(result.value.PORT).toBe(3000);
      expect(result.value.LOG_LEVEL).toBe('info');
    });

    it('honors an explicit override', () => {
      const result = parseEnv(
        validSource({ PORT: '8080', LOG_LEVEL: 'debug', NOODARA_COOKIE_INSECURE: 'true' }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected success');
      expect(result.value.PORT).toBe(8080);
      expect(result.value.LOG_LEVEL).toBe('debug');
      expect(result.value.NOODARA_COOKIE_INSECURE).toBe(true);
    });
  });

  describe('failure report safety', () => {
    it('never contains the offending value', () => {
      const badKey = 'totally-not-base64-and-should-never-appear';
      const result = parseEnv(validSource({ NOODARA_MASTER_KEY: badKey }));

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      const serialized = JSON.stringify(result.issues);
      expect(serialized).not.toContain(badKey);
    });

    it('never exposes a "received" field', () => {
      const result = parseEnv({});

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      for (const issue of result.issues) {
        expect(issue).not.toHaveProperty('received');
      }
    });
  });
});
