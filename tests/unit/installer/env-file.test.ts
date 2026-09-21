// 06-04-PLAN.md: install.sh's `.env` generation half of INST-01/INST-02 -- secret generation,
// fresh .env writing (mode 600, HTTP cookie opt-out), and the additive merge/backup mechanism for
// a re-run (D-11). Exercised under every available real POSIX interpreter (`/bin/sh`, plus `dash`
// when present), never `bash` (06-RESEARCH.md Pitfall 1), mirroring preflight.test.ts's own
// conventions.
//
// hard_rule #8: no generated secret value here is ever asserted by literal equality against a
// hardcoded string, echoed in an expect() failure message beyond structural comparison, or
// compared across test runs -- only shape/length/charset and round-trip equality within the same
// generation are asserted.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { posixInterpreters, runInstallerShell, type RunInstallerShellResult } from './sh-harness.js';

/** POSIX single-quote escaping for embedding an arbitrary value into a shell snippet. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Parses a generated `.env`'s `KEY=VALUE` lines, skipping blank lines and `#` comments. Never
 *  re-quotes or re-interprets a value -- this mirrors install.sh's own additive-merge mechanism
 *  (D-11), which only ever checks presence via an anchored `KEY=` prefix. */
function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    values[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return values;
}

function generateEnv(
  interpreter: string,
  envPath: string,
  publicUrl: string,
  port: string,
  version: string,
  imagePrefix: string,
  extraEnv: Record<string, string> = {},
): RunInstallerShellResult {
  const snippet = `noodara_generate_env ${shQuote(envPath)} ${shQuote(publicUrl)} ${shQuote(port)} ${shQuote(version)} ${shQuote(imagePrefix)}`;
  return runInstallerShell(interpreter, snippet, { env: extraEnv });
}

describe.each(posixInterpreters())('install.sh secret generation (%s)', (interpreter) => {
  describe('noodara_generate_secret', () => {
    it('hex prints 64 lowercase hex characters', () => {
      const result = runInstallerShell(interpreter, 'noodara_generate_secret hex');

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
    });

    it('base64 prints a value that decodes to exactly 32 bytes', () => {
      const result = runInstallerShell(interpreter, 'noodara_generate_secret base64');

      expect(result.status).toBe(0);
      const decoded = Buffer.from(result.stdout.trim(), 'base64');
      expect(decoded.length).toBe(32);
    });

    it('two consecutive hex calls never produce the same value', () => {
      const result = runInstallerShell(
        interpreter,
        'a=$(noodara_generate_secret hex); b=$(noodara_generate_secret hex); [ "$a" != "$b" ]',
      );

      expect(result.status).toBe(0);
    });

    it('two consecutive base64 calls never produce the same value', () => {
      const result = runInstallerShell(
        interpreter,
        'a=$(noodara_generate_secret base64); b=$(noodara_generate_secret base64); [ "$a" != "$b" ]',
      );

      expect(result.status).toBe(0);
    });
  });

  describe('noodara_build_database_url', () => {
    it('prints postgresql://noodara:<password>@postgres:5432/noodara', () => {
      const result = runInstallerShell(interpreter, 'noodara_build_database_url examplepw123');

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('postgresql://noodara:examplepw123@postgres:5432/noodara');
    });

    it('round-trips a hex password through URL parsing byte-for-byte', () => {
      const result = runInstallerShell(
        interpreter,
        [
          'password=$(noodara_generate_secret hex)',
          'noodara_build_database_url "$password"',
          'printf "PW=%s\\n" "$password"',
        ].join('\n'),
      );

      expect(result.status).toBe(0);
      const lines = result.stdout.trim().split('\n');
      const url = lines[0] ?? '';
      const pwLine = lines.find((line) => line.startsWith('PW='));
      const originalPassword = pwLine === undefined ? '' : pwLine.slice('PW='.length);

      const parsed = new URL(url);
      expect(decodeURIComponent(parsed.password)).toBe(originalPassword);
    });
  });

  describe('noodara_build_redis_url', () => {
    it('prints redis://:<password>@redis:6379', () => {
      const result = runInstallerShell(interpreter, 'noodara_build_redis_url examplepw123');

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('redis://:examplepw123@redis:6379');
    });

    it('round-trips a hex password through URL parsing byte-for-byte', () => {
      const result = runInstallerShell(
        interpreter,
        [
          'password=$(noodara_generate_secret hex)',
          'noodara_build_redis_url "$password"',
          'printf "PW=%s\\n" "$password"',
        ].join('\n'),
      );

      expect(result.status).toBe(0);
      const lines = result.stdout.trim().split('\n');
      const url = lines[0] ?? '';
      const pwLine = lines.find((line) => line.startsWith('PW='));
      const originalPassword = pwLine === undefined ? '' : pwLine.slice('PW='.length);

      const parsed = new URL(url);
      expect(decodeURIComponent(parsed.password)).toBe(originalPassword);
    });
  });
});

const EXPECTED_FRESH_ENV_KEYS = [
  'NOODARA_VERSION',
  'NOODARA_IMAGE_PREFIX',
  'NOODARA_PORT',
  'NOODARA_PUBLIC_URL',
  'NOODARA_MASTER_KEY',
  'BETTER_AUTH_SECRET',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'REDIS_PASSWORD',
  'DATABASE_URL',
  'REDIS_URL',
  'PORT',
].sort();

const FRESH_ENV_SECRET_KEYS = [
  'NOODARA_MASTER_KEY',
  'BETTER_AUTH_SECRET',
  'POSTGRES_PASSWORD',
  'REDIS_PASSWORD',
  'DATABASE_URL',
  'REDIS_URL',
];

describe.each(posixInterpreters())('install.sh noodara_generate_env (%s)', (interpreter) => {
  it('creates a missing parent directory mode 700, writes the file, and chmods it 600', () => {
    const base = mkdtempSync(join(tmpdir(), 'noodara-env-'));
    const envDir = join(base, 'opt-noodara');
    const envPath = join(envDir, '.env');

    const result = generateEnv(
      interpreter,
      envPath,
      'https://noodara.example.com',
      '3000',
      '0.1.0',
      'ghcr.io/example/noodara',
    );

    expect(result.status).toBe(0);
    expect(statSync(envDir).mode & 0o777).toBe(0o700);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it('contains exactly the required keys for an https:// public URL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
    const envPath = join(dir, '.env');

    generateEnv(interpreter, envPath, 'https://noodara.example.com', '3000', '0.1.0', 'ghcr.io/example/noodara');
    const parsed = parseEnvFile(readFileSync(envPath, 'utf8'));

    expect(Object.keys(parsed).sort()).toEqual(EXPECTED_FRESH_ENV_KEYS);
  });

  it('writes NOODARA_COOKIE_INSECURE=true only when NOODARA_PUBLIC_URL starts with http://', () => {
    const httpDir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
    const httpPath = join(httpDir, '.env');
    generateEnv(interpreter, httpPath, 'http://203.0.113.5:3000', '3000', '0.1.0', 'ghcr.io/example/noodara');
    const httpParsed = parseEnvFile(readFileSync(httpPath, 'utf8'));
    expect(httpParsed.NOODARA_COOKIE_INSECURE).toBe('true');

    const httpsDir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
    const httpsPath = join(httpsDir, '.env');
    generateEnv(interpreter, httpsPath, 'https://noodara.example.com', '3000', '0.1.0', 'ghcr.io/example/noodara');
    const httpsParsed = parseEnvFile(readFileSync(httpsPath, 'utf8'));
    expect(Object.prototype.hasOwnProperty.call(httpsParsed, 'NOODARA_COOKIE_INSECURE')).toBe(false);
  });

  it('writes both admin vars when both are supplied', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
    const envPath = join(dir, '.env');

    const result = generateEnv(
      interpreter,
      envPath,
      'https://noodara.example.com',
      '3000',
      '0.1.0',
      'ghcr.io/example/noodara',
      { NOODARA_ADMIN_EMAIL: 'admin@example.com', NOODARA_ADMIN_PASSWORD: 'a-fresh-test-password' },
    );

    expect(result.status).toBe(0);
    const parsed = parseEnvFile(readFileSync(envPath, 'utf8'));
    expect(parsed.NOODARA_ADMIN_EMAIL).toBe('admin@example.com');
    expect(parsed.NOODARA_ADMIN_PASSWORD).toBe('a-fresh-test-password');
  });

  it('writes neither admin var and warns naming both variable names when only one is supplied', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
    const envPath = join(dir, '.env');

    const result = generateEnv(
      interpreter,
      envPath,
      'https://noodara.example.com',
      '3000',
      '0.1.0',
      'ghcr.io/example/noodara',
      { NOODARA_ADMIN_EMAIL: 'admin@example.com' },
    );

    expect(result.status).toBe(0);
    const parsed = parseEnvFile(readFileSync(envPath, 'utf8'));
    expect(Object.prototype.hasOwnProperty.call(parsed, 'NOODARA_ADMIN_EMAIL')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'NOODARA_ADMIN_PASSWORD')).toBe(false);
    expect(result.stderr).toContain('NOODARA_ADMIN_EMAIL');
    expect(result.stderr).toContain('NOODARA_ADMIN_PASSWORD');
  });

  it('POSTGRES_PASSWORD matches the password embedded in DATABASE_URL; REDIS_PASSWORD matches REDIS_URL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
    const envPath = join(dir, '.env');

    generateEnv(interpreter, envPath, 'https://noodara.example.com', '3000', '0.1.0', 'ghcr.io/example/noodara');
    const parsed = parseEnvFile(readFileSync(envPath, 'utf8'));

    const dbUrl = new URL(parsed.DATABASE_URL ?? '');
    expect(decodeURIComponent(dbUrl.password)).toBe(parsed.POSTGRES_PASSWORD);

    const redisUrl = new URL(parsed.REDIS_URL ?? '');
    expect(decodeURIComponent(redisUrl.password)).toBe(parsed.REDIS_PASSWORD);
  });

  it('two separate fresh generations produce different values for every secret key', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'noodara-env-'));
    const pathA = join(dirA, '.env');
    const dirB = mkdtempSync(join(tmpdir(), 'noodara-env-'));
    const pathB = join(dirB, '.env');

    generateEnv(interpreter, pathA, 'https://noodara.example.com', '3000', '0.1.0', 'ghcr.io/example/noodara');
    generateEnv(interpreter, pathB, 'https://noodara.example.com', '3000', '0.1.0', 'ghcr.io/example/noodara');
    const a = parseEnvFile(readFileSync(pathA, 'utf8'));
    const b = parseEnvFile(readFileSync(pathB, 'utf8'));

    for (const key of FRESH_ENV_SECRET_KEYS) {
      expect(a[key]).not.toBe(b[key]);
    }
  });

  it('the whole generation writes no generated secret value to stdout or stderr', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
    const envPath = join(dir, '.env');

    const result = generateEnv(
      interpreter,
      envPath,
      'https://noodara.example.com',
      '3000',
      '0.1.0',
      'ghcr.io/example/noodara',
    );
    const parsed = parseEnvFile(readFileSync(envPath, 'utf8'));

    for (const key of FRESH_ENV_SECRET_KEYS) {
      const value = parsed[key];
      expect(value).toBeTruthy();
      if (value !== undefined) {
        expect(result.stdout).not.toContain(value);
        expect(result.stderr).not.toContain(value);
      }
    }
  });
});

describe.each(posixInterpreters())('install.sh noodara_secure_env_file (%s)', (interpreter) => {
  it('re-asserts mode 600 on an existing, more-permissive file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'X=1\n', { mode: 0o644 });

    const result = runInstallerShell(interpreter, `noodara_secure_env_file ${shQuote(file)}`);

    expect(result.status).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
