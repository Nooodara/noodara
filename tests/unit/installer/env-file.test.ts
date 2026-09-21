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
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
 *  (D-11), which only ever checks presence via an anchored `KEY=` prefix. The one exception: a
 *  value wrapped in a single leading and trailing `'` has that one wrapper layer stripped, since
 *  post-06-04's security fix (Finding B) writes NOODARA_PUBLIC_URL/NOODARA_ADMIN_EMAIL/
 *  NOODARA_ADMIN_PASSWORD single-quoted so Docker Compose's own `.env` parser takes them
 *  literally -- this mirrors what Compose itself strips when populating a container's
 *  environment, proven separately in tests/integration/installer/env-compose-roundtrip.test.ts. */
function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq);
    let value = line.slice(eq + 1);
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    values[key] = value;
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
  'NOODARA_PREVIOUS_VERSION',
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

  it('initializes NOODARA_PREVIOUS_VERSION to the same value as NOODARA_VERSION on a fresh install', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
    const envPath = join(dir, '.env');

    generateEnv(interpreter, envPath, 'https://noodara.example.com', '3000', '0.1.0', 'ghcr.io/example/noodara');
    const parsed = parseEnvFile(readFileSync(envPath, 'utf8'));

    expect(parsed.NOODARA_PREVIOUS_VERSION).toBe('0.1.0');
    expect(parsed.NOODARA_VERSION).toBe('0.1.0');
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

const COMPLETE_ENV_LINES = [
  'NOODARA_VERSION=0.1.0',
  'NOODARA_PREVIOUS_VERSION=0.1.0',
  'NOODARA_IMAGE_PREFIX=ghcr.io/example/noodara',
  'NOODARA_PORT=3000',
  'NOODARA_PUBLIC_URL=https://noodara.example.com',
  'NOODARA_MASTER_KEY=abcdEFGH1234567890abcdEFGH1234567890abcd==',
  'BETTER_AUTH_SECRET=aValueWithAHash#NotAComment',
  'POSTGRES_USER=noodara',
  'POSTGRES_PASSWORD=abc123=def',
  'POSTGRES_DB=noodara',
  'REDIS_PASSWORD=redispw123',
  'DATABASE_URL=postgresql://noodara:abc123=def@postgres:5432/noodara',
  'REDIS_URL=redis://:redispw123@redis:6379',
  'PORT=3000',
  '',
];

describe.each(posixInterpreters())('install.sh env merge and backup (D-11) (%s)', (interpreter) => {
  describe('noodara_env_has_key', () => {
    it('matches only an anchored KEY= line, never a suffix or prefix collision', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
      const file = join(dir, '.env');
      writeFileSync(file, 'DATABASE_URL=postgres://x\nDATABASE_URL_EXTRA=y\n');

      const hasIt = runInstallerShell(interpreter, `noodara_env_has_key ${shQuote(file)} DATABASE_URL`);
      expect(hasIt.status).toBe(0);

      const suffixMiss = runInstallerShell(interpreter, `noodara_env_has_key ${shQuote(file)} ATABASE_URL`);
      expect(suffixMiss.status).not.toBe(0);

      const prefixMiss = runInstallerShell(
        interpreter,
        `noodara_env_has_key ${shQuote(file)} DATABASE_URL_EXTRA_TWO`,
      );
      expect(prefixMiss.status).not.toBe(0);
    });
  });

  describe('noodara_env_append_if_missing', () => {
    it('appends a line only when the key is absent', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
      const file = join(dir, '.env');
      writeFileSync(file, 'EXISTING_KEY=1\n');

      const result = runInstallerShell(
        interpreter,
        `noodara_env_append_if_missing ${shQuote(file)} NEW_KEY newvalue`,
      );

      expect(result.status).toBe(0);
      expect(readFileSync(file, 'utf8')).toContain('NEW_KEY=newvalue');
    });

    it('returns 0 without writing when the key is already present', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
      const file = join(dir, '.env');
      writeFileSync(file, 'EXISTING_KEY=original\n');

      const result = runInstallerShell(
        interpreter,
        `noodara_env_append_if_missing ${shQuote(file)} EXISTING_KEY replacement`,
      );

      expect(result.status).toBe(0);
      expect(readFileSync(file, 'utf8')).toBe('EXISTING_KEY=original\n');
    });
  });

  describe('noodara_backup_env', () => {
    it('copies to <path>.bak-<timestamp> and chmods the copy 600', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
      const file = join(dir, '.env');
      writeFileSync(file, 'X=1\n', { mode: 0o600 });

      const result = runInstallerShell(interpreter, `noodara_backup_env ${shQuote(file)}`);

      expect(result.status).toBe(0);
      const backups = readdirSync(dir).filter((name) => name.startsWith('.env.bak-'));
      expect(backups).toHaveLength(1);
      const backupPath = join(dir, backups[0] ?? '');
      expect(readFileSync(backupPath, 'utf8')).toBe('X=1\n');
      expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    });
  });

  describe('noodara_set_env_value', () => {
    it('rewrites one line in place, leaving every other line byte-identical', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
      const file = join(dir, '.env');
      writeFileSync(file, COMPLETE_ENV_LINES.join('\n'));
      const before = readFileSync(file, 'utf8');

      const result = runInstallerShell(interpreter, `noodara_set_env_value ${shQuote(file)} NOODARA_VERSION 0.2.0`);

      expect(result.status).toBe(0);
      const after = readFileSync(file, 'utf8');
      const beforeLines = before.split('\n');
      const afterLines = after.split('\n');
      expect(afterLines).toHaveLength(beforeLines.length);
      const diffIndexes = beforeLines
        .map((line, i) => (line !== afterLines[i] ? i : -1))
        .filter((i) => i !== -1);
      expect(diffIndexes).toEqual([0]);
      expect(afterLines[0]).toBe('NOODARA_VERSION=0.2.0');
    });
  });

  describe('noodara_merge_env', () => {
    it('on a file containing every current key, changes exactly one line -- NOODARA_VERSION', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
      const file = join(dir, '.env');
      writeFileSync(file, COMPLETE_ENV_LINES.join('\n'));
      const before = readFileSync(file, 'utf8');

      const result = runInstallerShell(interpreter, `noodara_merge_env ${shQuote(file)} 0.2.0`);

      expect(result.status).toBe(0);
      const after = readFileSync(file, 'utf8');
      const beforeLines = before.split('\n');
      const afterLines = after.split('\n');
      expect(afterLines).toHaveLength(beforeLines.length);
      const diffs = beforeLines.filter((line, i) => line !== afterLines[i]);
      expect(diffs).toHaveLength(1);
      const parsed = parseEnvFile(after);
      expect(parsed.NOODARA_VERSION).toBe('0.2.0');
    });

    it('on a file missing a newly required key, appends that key and leaves pre-existing lines byte-identical', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
      const file = join(dir, '.env');
      const linesWithoutOne = COMPLETE_ENV_LINES.filter((line) => !line.startsWith('NOODARA_IMAGE_PREFIX='));
      writeFileSync(file, linesWithoutOne.join('\n'));
      const before = readFileSync(file, 'utf8');

      const result = runInstallerShell(
        interpreter,
        `noodara_merge_env ${shQuote(file)} 0.1.0 NOODARA_IMAGE_PREFIX ${shQuote('ghcr.io/example/noodara')}`,
      );

      expect(result.status).toBe(0);
      const after = readFileSync(file, 'utf8');
      for (const line of before.split('\n')) {
        if (line === '') continue;
        expect(after).toContain(line);
      }
      const parsed = parseEnvFile(after);
      expect(parsed.NOODARA_IMAGE_PREFIX).toBe('ghcr.io/example/noodara');
    });

    it('backs up the file exactly once before the first write and re-secures it to mode 600 afterward', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
      const file = join(dir, '.env');
      writeFileSync(file, COMPLETE_ENV_LINES.join('\n'), { mode: 0o644 });

      const result = runInstallerShell(interpreter, `noodara_merge_env ${shQuote(file)} 0.2.0`);

      expect(result.status).toBe(0);
      const backups = readdirSync(dir).filter((name) => name.startsWith('.env.bak-'));
      expect(backups).toHaveLength(1);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });
  });
});

// Post-06-04 security fix (orchestrator audit): Finding A -- line injection into .env. Every
// write boundary must reject a value containing an embedded LF/CR before writing a single byte,
// naming the variable but never echoing the value. Finding B -- Docker Compose's own .env parser
// interpolates $VAR/${VAR} and treats ' #' as an inline comment in an unquoted or double-quoted
// value, so NOODARA_PUBLIC_URL/NOODARA_ADMIN_EMAIL/NOODARA_ADMIN_PASSWORD are written
// single-quoted, which Compose's own parser takes fully literally
// (tests/integration/installer/env-compose-roundtrip.test.ts proves the round trip against a
// real `docker compose config`) -- and a value containing a literal single quote is rejected
// outright, since a single-quoted dotenv value has no escape sequence for one.
describe.each(posixInterpreters())('install.sh .env write-boundary injection guard (%s)', (interpreter) => {
  describe('noodara_env_assert_single_line', () => {
    it('exits 0 and writes nothing to either stream for a value with no LF or CR', () => {
      const result = runInstallerShell(interpreter, 'noodara_env_assert_single_line TEST_VAR safe-value');

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });

    it('fails naming the variable, never the value, for an embedded newline', () => {
      const result = runInstallerShell(
        interpreter,
        `noodara_env_assert_single_line SECRET_VAR ${shQuote('safe\ninjected')}`,
      );

      expect(result.status).toBe(30);
      expect(result.stderr).toContain('SECRET_VAR');
      expect(result.stderr).not.toContain('injected');
    });

    it('fails for an embedded carriage return', () => {
      const result = runInstallerShell(
        interpreter,
        `noodara_env_assert_single_line SECRET_VAR ${shQuote(`safe${String.fromCharCode(13)}injected`)}`,
      );

      expect(result.status).toBe(30);
      expect(result.stderr).toContain('SECRET_VAR');
    });
  });

  describe('noodara_generate_env', () => {
    it('rejects a NOODARA_PUBLIC_URL containing an embedded newline and writes neither .env nor a temp file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
      const envPath = join(dir, '.env');

      const result = generateEnv(interpreter, envPath, 'http://x\nPORT=1', '3000', '0.1.0', 'ghcr.io/example/noodara');

      expect(result.status).toBe(30);
      expect(result.stderr).toContain('NOODARA_PUBLIC_URL');
      expect(readdirSync(dir)).toEqual([]);
    });

    // Mirrors the orchestrator's own reproduction verbatim: an admin password carrying an
    // embedded NOODARA_MASTER_KEY=attacker line must never reach the file, and the attacker's
    // chosen value must never appear on any output stream either.
    it('rejects an admin password carrying a line-injection payload, writes nothing, and never echoes the payload', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
      const envPath = join(dir, '.env');
      const injectedPassword = 'pw\nNOODARA_MASTER_KEY=attacker';

      const result = generateEnv(
        interpreter,
        envPath,
        'https://noodara.example.com',
        '3000',
        '0.1.0',
        'ghcr.io/example/noodara',
        { NOODARA_ADMIN_EMAIL: 'a@b.co', NOODARA_ADMIN_PASSWORD: injectedPassword },
      );

      expect(result.status).toBe(30);
      expect(result.stderr).toContain('NOODARA_ADMIN_PASSWORD');
      expect(result.stderr).not.toContain('attacker');
      expect(result.stderr).not.toContain('NOODARA_MASTER_KEY=attacker');
      expect(readdirSync(dir)).toEqual([]);
    });

    it('rejects a value containing a carriage return', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
      const envPath = join(dir, '.env');

      const result = generateEnv(
        interpreter,
        envPath,
        `http://x${String.fromCharCode(13)}y`,
        '3000',
        '0.1.0',
        'ghcr.io/example/noodara',
      );

      expect(result.status).toBe(30);
      expect(readdirSync(dir)).toEqual([]);
    });

    it('validates before creating even the missing parent directory -- no directory, no file, no temp file survive a rejected value', () => {
      const base = mkdtempSync(join(tmpdir(), 'noodara-env-'));
      const envDir = join(base, 'nested', 'opt-noodara');
      const envPath = join(envDir, '.env');

      const result = generateEnv(
        interpreter,
        envPath,
        'http://x\nPORT=1',
        '3000',
        '0.1.0',
        'ghcr.io/example/noodara',
      );

      expect(result.status).toBe(30);
      expect(existsSync(envDir)).toBe(false);
      expect(readdirSync(base)).toEqual([]);
    });

    it('rejects a NOODARA_PUBLIC_URL containing a single quote -- unrepresentable in a single-quoted .env value', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
      const envPath = join(dir, '.env');

      const result = generateEnv(
        interpreter,
        envPath,
        "http://ex'ample.com",
        '3000',
        '0.1.0',
        'ghcr.io/example/noodara',
      );

      expect(result.status).toBe(30);
      expect(result.stderr).toContain('NOODARA_PUBLIC_URL');
      expect(readdirSync(dir)).toEqual([]);
    });

    it('rejects an admin email containing a single quote', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
      const envPath = join(dir, '.env');

      const result = generateEnv(
        interpreter,
        envPath,
        'https://noodara.example.com',
        '3000',
        '0.1.0',
        'ghcr.io/example/noodara',
        { NOODARA_ADMIN_EMAIL: "a'dmin@example.com", NOODARA_ADMIN_PASSWORD: 'a-fresh-test-password' },
      );

      expect(result.status).toBe(30);
      expect(result.stderr).toContain('NOODARA_ADMIN_EMAIL');
      expect(readdirSync(dir)).toEqual([]);
    });

    it('single-quotes NOODARA_PUBLIC_URL/ADMIN_EMAIL/ADMIN_PASSWORD so a value with $, spaces and # survives literally in the file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
      const envPath = join(dir, '.env');
      const trickyPassword = 'p@ss$word with space #not-a-comment';

      const result = generateEnv(
        interpreter,
        envPath,
        'https://noodara.example.com',
        '3000',
        '0.1.0',
        'ghcr.io/example/noodara',
        { NOODARA_ADMIN_EMAIL: 'admin@example.com', NOODARA_ADMIN_PASSWORD: trickyPassword },
      );

      expect(result.status).toBe(0);
      const raw = readFileSync(envPath, 'utf8');
      expect(raw).toContain(`NOODARA_ADMIN_PASSWORD='${trickyPassword}'`);
      const parsed = parseEnvFile(raw);
      expect(parsed.NOODARA_ADMIN_PASSWORD).toBe(trickyPassword);
    });
  });

  describe('noodara_env_append_if_missing', () => {
    it('rejects a value containing a newline and leaves the file byte-identical', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
      const file = join(dir, '.env');
      writeFileSync(file, 'EXISTING_KEY=1\n');
      const before = readFileSync(file, 'utf8');

      const result = runInstallerShell(
        interpreter,
        `noodara_env_append_if_missing ${shQuote(file)} NEW_KEY ${shQuote('bad\nINJECTED=1')}`,
      );

      expect(result.status).toBe(30);
      expect(result.stderr).toContain('NEW_KEY');
      expect(readFileSync(file, 'utf8')).toBe(before);
    });
  });

  describe('noodara_set_env_value', () => {
    it('rejects a value containing a newline and leaves the file byte-identical', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
      const file = join(dir, '.env');
      writeFileSync(file, COMPLETE_ENV_LINES.join('\n'));
      const before = readFileSync(file, 'utf8');

      const result = runInstallerShell(
        interpreter,
        `noodara_set_env_value ${shQuote(file)} NOODARA_VERSION ${shQuote('0.2.0\nINJECTED=1')}`,
      );

      expect(result.status).toBe(30);
      expect(result.stderr).toContain('NOODARA_VERSION');
      expect(readFileSync(file, 'utf8')).toBe(before);
    });

    it('preserves a literal backslash-n two-character sequence byte-identically -- never converts it to a real newline via awk -v escape processing', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-env-'));
      const file = join(dir, '.env');
      writeFileSync(file, COMPLETE_ENV_LINES.join('\n'));
      const literalBackslashN = 'value-\\n-literal';

      const result = runInstallerShell(
        interpreter,
        `noodara_set_env_value ${shQuote(file)} NOODARA_VERSION ${shQuote(literalBackslashN)}`,
      );

      expect(result.status).toBe(0);
      const after = readFileSync(file, 'utf8');
      const afterLines = after.split('\n');
      expect(afterLines[0]).toBe(`NOODARA_VERSION=${literalBackslashN}`);
    });
  });
});
