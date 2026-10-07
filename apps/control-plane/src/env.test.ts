import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEPLOY_ENV_KNOBS, DEPLOY_LOG_LINE_MAX_BYTES, loadEnv, parseEnv } from './env.js';

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
      expect(result.value.NOODARA_TRUST_PROXY).toBe(false);
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

  describe('NOODARA_TRUST_PROXY (T-1-40)', () => {
    it('defaults to false', () => {
      const result = parseEnv(validSource());

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected success');
      expect(result.value.NOODARA_TRUST_PROXY).toBe(false);
    });

    it('accepts an explicit "true"', () => {
      const result = parseEnv(validSource({ NOODARA_TRUST_PROXY: 'true' }));

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected success');
      expect(result.value.NOODARA_TRUST_PROXY).toBe(true);
    });

    it('rejects a non-boolean value', () => {
      const result = parseEnv(validSource({ NOODARA_TRUST_PROXY: 'yes' }));

      expect(result.ok).toBe(false);
    });
  });

  describe('SSH timeout knobs (D-08, D-09)', () => {
    it('applies every documented default when unset', () => {
      const result = parseEnv(validSource());

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected success');
      expect(result.value.NOODARA_SSH_CONNECT_TIMEOUT_MS).toBe(10000);
      expect(result.value.NOODARA_SSH_COMMAND_TIMEOUT_MS).toBe(30000);
      expect(result.value.NOODARA_SSH_DISCOVERY_TIMEOUT_MS).toBe(60000);
    });

    it('honors a valid explicit override for each knob', () => {
      const result = parseEnv(
        validSource({
          NOODARA_SSH_CONNECT_TIMEOUT_MS: '5000',
          NOODARA_SSH_COMMAND_TIMEOUT_MS: '45000',
          NOODARA_SSH_DISCOVERY_TIMEOUT_MS: '90000',
        }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected success');
      expect(result.value.NOODARA_SSH_CONNECT_TIMEOUT_MS).toBe(5000);
      expect(result.value.NOODARA_SSH_COMMAND_TIMEOUT_MS).toBe(45000);
      expect(result.value.NOODARA_SSH_DISCOVERY_TIMEOUT_MS).toBe(90000);
    });

    it.each([
      ['NOODARA_SSH_CONNECT_TIMEOUT_MS', 1000],
      ['NOODARA_SSH_CONNECT_TIMEOUT_MS', 120000],
      ['NOODARA_SSH_COMMAND_TIMEOUT_MS', 1000],
      ['NOODARA_SSH_COMMAND_TIMEOUT_MS', 300000],
      ['NOODARA_SSH_DISCOVERY_TIMEOUT_MS', 5000],
      ['NOODARA_SSH_DISCOVERY_TIMEOUT_MS', 600000],
    ])('accepts the %s boundary value %d', (variable, value) => {
      // The discovery/command coherence rule (discovery >= command) means the discovery lower
      // boundary (5000) must be tested with a command timeout no larger than it, and the command
      // upper boundary (300000) must be tested with a discovery timeout at least that large.
      const overrides: Record<string, string> = { [variable]: String(value) };
      if (variable === 'NOODARA_SSH_DISCOVERY_TIMEOUT_MS' && value === 5000) {
        overrides.NOODARA_SSH_COMMAND_TIMEOUT_MS = '1000';
      }
      if (variable === 'NOODARA_SSH_COMMAND_TIMEOUT_MS' && value === 300000) {
        overrides.NOODARA_SSH_DISCOVERY_TIMEOUT_MS = '600000';
      }

      const result = parseEnv(validSource(overrides));

      expect(result.ok).toBe(true);
    });

    it('rejects a connect timeout below the minimum', () => {
      const result = parseEnv(validSource({ NOODARA_SSH_CONNECT_TIMEOUT_MS: '999' }));

      expect(result.ok).toBe(false);
    });

    it('rejects a connect timeout above the maximum', () => {
      const result = parseEnv(validSource({ NOODARA_SSH_CONNECT_TIMEOUT_MS: '120001' }));

      expect(result.ok).toBe(false);
    });

    it('rejects a non-integer value', () => {
      const result = parseEnv(validSource({ NOODARA_SSH_COMMAND_TIMEOUT_MS: '1000.5' }));

      expect(result.ok).toBe(false);
    });

    it('rejects a non-numeric value', () => {
      const result = parseEnv(validSource({ NOODARA_SSH_DISCOVERY_TIMEOUT_MS: 'not-a-number' }));

      expect(result.ok).toBe(false);
    });

    it('rejects a command timeout below the minimum with exactly one issue whose requirement omits the value', () => {
      const result = parseEnv(validSource({ NOODARA_SSH_COMMAND_TIMEOUT_MS: '999' }));

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      const issues = result.issues.filter((issue) => issue.variable === 'NOODARA_SSH_COMMAND_TIMEOUT_MS');
      expect(issues).toHaveLength(1);
      expect(issues[0]?.requirement).not.toContain('999');
    });

    it('rejects a discovery timeout smaller than the command timeout', () => {
      const result = parseEnv(
        validSource({
          NOODARA_SSH_COMMAND_TIMEOUT_MS: '50000',
          NOODARA_SSH_DISCOVERY_TIMEOUT_MS: '40000',
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      const variables = result.issues.map((issue) => issue.variable);
      expect(variables).toContain('NOODARA_SSH_DISCOVERY_TIMEOUT_MS');
    });

    it('accepts a discovery timeout exactly equal to the command timeout', () => {
      const result = parseEnv(
        validSource({
          NOODARA_SSH_COMMAND_TIMEOUT_MS: '30000',
          NOODARA_SSH_DISCOVERY_TIMEOUT_MS: '30000',
        }),
      );

      expect(result.ok).toBe(true);
    });

    it('never exposes the received value for any of the three timeout knobs', () => {
      const result = parseEnv(
        validSource({
          NOODARA_SSH_CONNECT_TIMEOUT_MS: 'nope',
          NOODARA_SSH_COMMAND_TIMEOUT_MS: 'nope',
          NOODARA_SSH_DISCOVERY_TIMEOUT_MS: 'nope',
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      const serialized = JSON.stringify(result.issues);
      expect(serialized).not.toContain('nope');
    });
  });

  describe('NOODARA_WORKER_CONCURRENCY (D-24)', () => {
    it('applies the documented default when unset', () => {
      const result = parseEnv(validSource());

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected success');
      expect(result.value.NOODARA_WORKER_CONCURRENCY).toBe(5);
    });

    it('honors a valid explicit override', () => {
      const result = parseEnv(validSource({ NOODARA_WORKER_CONCURRENCY: '10' }));

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected success');
      expect(result.value.NOODARA_WORKER_CONCURRENCY).toBe(10);
    });

    it('rejects a value of 0 with exactly one issue naming the variable', () => {
      const result = parseEnv(validSource({ NOODARA_WORKER_CONCURRENCY: '0' }));

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      const issues = result.issues.filter((issue) => issue.variable === 'NOODARA_WORKER_CONCURRENCY');
      expect(issues).toHaveLength(1);
      expect(issues[0]).not.toHaveProperty('received');
    });

    it('rejects a value of 21 with exactly one issue naming the variable', () => {
      const result = parseEnv(validSource({ NOODARA_WORKER_CONCURRENCY: '21' }));

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      const issues = result.issues.filter((issue) => issue.variable === 'NOODARA_WORKER_CONCURRENCY');
      expect(issues).toHaveLength(1);
    });

    it('accepts the boundary values 1 and 20', () => {
      expect(parseEnv(validSource({ NOODARA_WORKER_CONCURRENCY: '1' })).ok).toBe(true);
      expect(parseEnv(validSource({ NOODARA_WORKER_CONCURRENCY: '20' })).ok).toBe(true);
    });

    it('rejects a non-integer value instead of producing NaN', () => {
      const result = parseEnv(validSource({ NOODARA_WORKER_CONCURRENCY: '2.5' }));

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      const issues = result.issues.filter((issue) => issue.variable === 'NOODARA_WORKER_CONCURRENCY');
      expect(issues).toHaveLength(1);
    });
  });

  describe('NOODARA_SSE_MAX_CONNECTIONS (D-07)', () => {
    it('applies the documented default when unset', () => {
      const result = parseEnv(validSource());

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected success');
      expect(result.value.NOODARA_SSE_MAX_CONNECTIONS).toBe(32);
    });

    it('honors a valid explicit override', () => {
      const result = parseEnv(validSource({ NOODARA_SSE_MAX_CONNECTIONS: '100' }));

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected success');
      expect(result.value.NOODARA_SSE_MAX_CONNECTIONS).toBe(100);
    });

    it('rejects a value of 0 with exactly one issue naming the variable', () => {
      const result = parseEnv(validSource({ NOODARA_SSE_MAX_CONNECTIONS: '0' }));

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      const issues = result.issues.filter((issue) => issue.variable === 'NOODARA_SSE_MAX_CONNECTIONS');
      expect(issues).toHaveLength(1);
      expect(issues[0]).not.toHaveProperty('received');
    });

    it('rejects a value of 1001 with exactly one issue naming the variable', () => {
      const result = parseEnv(validSource({ NOODARA_SSE_MAX_CONNECTIONS: '1001' }));

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      const issues = result.issues.filter((issue) => issue.variable === 'NOODARA_SSE_MAX_CONNECTIONS');
      expect(issues).toHaveLength(1);
    });

    it('accepts the boundary values 1 and 1000', () => {
      expect(parseEnv(validSource({ NOODARA_SSE_MAX_CONNECTIONS: '1' })).ok).toBe(true);
      expect(parseEnv(validSource({ NOODARA_SSE_MAX_CONNECTIONS: '1000' })).ok).toBe(true);
    });

    it('rejects a non-integer value instead of producing NaN', () => {
      const result = parseEnv(validSource({ NOODARA_SSE_MAX_CONNECTIONS: '2.5' }));

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      const issues = result.issues.filter((issue) => issue.variable === 'NOODARA_SSE_MAX_CONNECTIONS');
      expect(issues).toHaveLength(1);
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

describe('deploy engine knobs (Phase 12, D15/D16/D8)', () => {
  const DEFAULTS: Record<string, number> = {
    NOODARA_DEPLOY_MAX_MS: 3_600_000,
    NOODARA_DEPLOY_IDLE_MS: 300_000,
    NOODARA_DEPLOY_CONCURRENCY: 1,
    NOODARA_DEPLOY_LOG_MAX_BYTES: 10_485_760,
    NOODARA_DEPLOY_LOG_FLUSH_MS: 250,
    NOODARA_DEPLOY_LOG_FLUSH_BYTES: 16_384,
    NOODARA_DEPLOY_LOG_RETENTION_DAYS: 30,
    NOODARA_RECONCILE_INTERVAL_MS: 30_000,
    NOODARA_RUNTIME_LOG_TAIL: 1000,
    NOODARA_RUNTIME_LOG_FOLLOW_MAX_MS: 600_000,
    NOODARA_DEPLOY_QUEUED_STALE_MS: 120_000,
  };

  // [variable, min, max] — each boundary is valid on its own with every other knob at its default.
  const RANGES: readonly (readonly [string, number, number])[] = [
    ['NOODARA_DEPLOY_MAX_MS', 300_000, 14_400_000],
    ['NOODARA_DEPLOY_IDLE_MS', 10_000, 3_600_000],
    ['NOODARA_DEPLOY_CONCURRENCY', 1, 10],
    ['NOODARA_DEPLOY_LOG_MAX_BYTES', 16_384, 104_857_600],
    ['NOODARA_DEPLOY_LOG_FLUSH_MS', 50, 5000],
    ['NOODARA_DEPLOY_LOG_FLUSH_BYTES', 1024, 16_384],
    ['NOODARA_DEPLOY_LOG_RETENTION_DAYS', 1, 365],
    ['NOODARA_RECONCILE_INTERVAL_MS', 5000, 600_000],
    ['NOODARA_RUNTIME_LOG_TAIL', 1, 10_000],
    ['NOODARA_RUNTIME_LOG_FOLLOW_MAX_MS', 10_000, 3_600_000],
    ['NOODARA_DEPLOY_QUEUED_STALE_MS', 30_000, 3_600_000],
  ];

  function issuesFor(overrides: Record<string, string>): { variable: string; requirement: string }[] {
    const result = parseEnv(validSource(overrides));
    if (result.ok) throw new Error('expected failure');
    return result.issues;
  }

  it('declares exactly the eleven deploy knobs', () => {
    expect([...DEPLOY_ENV_KNOBS].sort()).toEqual(Object.keys(DEFAULTS).sort());
  });

  it('applies every research default when unset', () => {
    const result = parseEnv(validSource());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    for (const [variable, expected] of Object.entries(DEFAULTS)) {
      expect(result.value[variable as keyof typeof result.value], variable).toBe(expected);
    }
  });

  it('keeps the flush-bytes default equal to the 16 KiB per-line cap', () => {
    expect(DEPLOY_LOG_LINE_MAX_BYTES).toBe(16_384);
  });

  it.each(RANGES)('accepts the boundary values of %s', (variable, min, max) => {
    for (const value of [min, max]) {
      const result = parseEnv(validSource({ [variable]: String(value) }));

      expect(result.ok, `${variable}=${String(value)}`).toBe(true);
      if (!result.ok) throw new Error('expected success');
      expect(result.value[variable as keyof typeof result.value]).toBe(value);
    }
  });

  it.each(RANGES)('rejects %s just outside its range with one value-free issue', (variable, min, max) => {
    for (const value of [min - 1, max + 1]) {
      const issues = issuesFor({ [variable]: String(value) });

      expect(issues).toHaveLength(1);
      expect(issues[0]?.variable).toBe(variable);
      expect(issues[0]?.requirement).not.toMatch(new RegExp(`\\b${String(value)}\\b`));
    }
  });

  it.each(RANGES)('rejects a non-integer %s instead of producing NaN', (variable) => {
    const issues = issuesFor({ [variable]: '12.5' });

    expect(issues.map((issue) => issue.variable)).toEqual([variable]);
  });

  // 14-08 (H1): below the minimum a deployment whose job is still being enqueued (bounded
  // enqueue timeout, no BullMQ retry backoff: attempts 1) could be failed ENQUEUE_FAILED.
  it('rejects a stale-QUEUED threshold below its minimum with a named requirement', () => {
    const issues = issuesFor({ NOODARA_DEPLOY_QUEUED_STALE_MS: '29999' });

    expect(issues).toEqual([
      {
        variable: 'NOODARA_DEPLOY_QUEUED_STALE_MS',
        requirement:
          'NOODARA_DEPLOY_QUEUED_STALE_MS must be at least 30000 ms, above the longest legitimate enqueue-to-pickup delay',
      },
    ]);
  });

  describe('cross-knob validation (H1)', () => {
    it('rejects an idle timeout larger than the deploy max, against the idle variable', () => {
      const issues = issuesFor({ NOODARA_DEPLOY_MAX_MS: '600000', NOODARA_DEPLOY_IDLE_MS: '600001' });

      expect(issues).toEqual([
        {
          variable: 'NOODARA_DEPLOY_IDLE_MS',
          requirement: 'NOODARA_DEPLOY_IDLE_MS must be less than or equal to NOODARA_DEPLOY_MAX_MS (D15)',
        },
      ]);
    });

    it('accepts an idle timeout exactly equal to the deploy max', () => {
      const result = parseEnv(validSource({ NOODARA_DEPLOY_MAX_MS: '600000', NOODARA_DEPLOY_IDLE_MS: '600000' }));

      expect(result.ok).toBe(true);
    });

    it('rejects a flush size larger than the per-line cap with a named requirement', () => {
      const issues = issuesFor({ NOODARA_DEPLOY_LOG_FLUSH_BYTES: '16385' });

      expect(issues).toHaveLength(1);
      expect(issues[0]?.variable).toBe('NOODARA_DEPLOY_LOG_FLUSH_BYTES');
      expect(issues[0]?.requirement).toContain('per-line cap');
    });

    it('rejects a per-phase log cap smaller than the per-line cap with a named requirement', () => {
      const issues = issuesFor({ NOODARA_DEPLOY_LOG_MAX_BYTES: '16383' });

      expect(issues).toHaveLength(1);
      expect(issues[0]?.variable).toBe('NOODARA_DEPLOY_LOG_MAX_BYTES');
      expect(issues[0]?.requirement).toContain('per-line cap');
    });

    it('does not report a cross-knob issue on top of a range issue for the same variable', () => {
      const issues = issuesFor({ NOODARA_DEPLOY_MAX_MS: '1', NOODARA_DEPLOY_IDLE_MS: '10000' });

      expect(issues.map((issue) => issue.variable)).toEqual(['NOODARA_DEPLOY_MAX_MS']);
    });
  });

  describe('boot failure (loadEnv)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('fails boot naming the variable without echoing any other env value', () => {
      const source = validSource({
        NOODARA_ADMIN_EMAIL: 'admin-canary@example.com',
        NOODARA_ADMIN_PASSWORD: 'admin-password-canary-91827',
        NOODARA_DEPLOY_MAX_MS: '777777',
        NOODARA_DEPLOY_IDLE_MS: '888888',
      });
      const written: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
      vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
        throw new Error(`exit ${String(code)}`);
      });

      expect(() => loadEnv(source)).toThrow('exit 1');

      const output = written.join('');
      expect(output).toContain('NOODARA_CONFIG_ERROR NOODARA_DEPLOY_IDLE_MS:');
      for (const [variable, value] of Object.entries(source)) {
        if (value === undefined) continue;
        expect(output, `${variable} value leaked`).not.toContain(value);
      }
    });
  });
});

describe('env wiring (ADR 0003)', () => {
  const turbo = JSON.parse(readFileSync(new URL('../../../turbo.json', import.meta.url), 'utf8')) as {
    tasks: Record<string, { passThroughEnv?: string[] }>;
  };
  const envExample = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');

  function allEnvKeys(): string[] {
    const result = parseEnv(
      validSource({
        NOODARA_MASTER_KEY_PREVIOUS: base64Key(32),
        NOODARA_ADMIN_EMAIL: 'admin@example.com',
        NOODARA_ADMIN_PASSWORD: 'a-long-admin-password',
      }),
    );
    if (!result.ok) throw new Error('expected success');
    return Object.keys(result.value);
  }

  it.each(['dev', 'dev:worker'])('lists every validated variable in the %s passThroughEnv', (task) => {
    const passThrough = turbo.tasks[task]?.passThroughEnv ?? [];

    for (const variable of allEnvKeys()) {
      expect(passThrough, `${variable} missing from ${task}`).toContain(variable);
    }
  });

  it('documents every deploy knob in .env.example', () => {
    for (const variable of DEPLOY_ENV_KNOBS) {
      expect(envExample, `${variable} missing from .env.example`).toMatch(new RegExp(`^${variable}=$`, 'm'));
    }
  });
});
