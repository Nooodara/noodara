// 14-29: Docker Compose gives the shell environment precedence over .env. The real-host UAT
// (docs/releases/v0.2-uat-logs/uat-02-upgrade-rc1.log) ran the installer with
// NOODARA_VERSION=v0.2.0-rc.1: .env got the normalized 0.2.0-rc.1, but the raw pin was still
// exported, so `docker compose pull` asked for :v0.2.0-rc.1 and failed (exit 50) -- and .env was
// left naming a version that never ran.
//
// `docker` here is a real executable on PATH (never a shell function): a function would see every
// shell variable whether exported or not, which is exactly the difference this bug lives in. The
// stub records, per call, its argv, the NOODARA_* values it actually received in its environment,
// and the NOODARA_VERSION .env held at that moment.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { posixInterpreters, runInstallerShell } from './sh-harness.js';

const DOCKER_STUB = `#!/bin/sh
env_version=$(sed -n 's/^NOODARA_VERSION=//p' "$PWD/.env" 2>/dev/null)
printf '%s|version=%s|port=%s|prefix=%s|env=%s\\n' "$*" "\${NOODARA_VERSION-<unset>}" "\${NOODARA_PORT-<unset>}" "\${NOODARA_IMAGE_PREFIX-<unset>}" "$env_version" >> "$NOODARA_TEST_DOCKER_LOG"
case "$*" in
  "compose pull")
    [ "\${NOODARA_TEST_FAIL:-}" = pull ] && exit 1
    exit 0 ;;
  "compose up -d")
    case "\${NOODARA_TEST_FAIL:-}" in up-*) exit 1 ;; esac
    exit 0 ;;
  "compose ps -a --format json")
    case "\${NOODARA_TEST_FAIL:-}" in
      up-migrate) printf '{"Service":"migrate","ExitCode":1}\\n' ;;
      *) printf '{"Service":"migrate","ExitCode":0}\\n' ;;
    esac
    exit 0 ;;
  "compose ps -a")
    printf 'NAME STATE\\nnoodara-migrate-1 Exited\\n'
    exit 0 ;;
  "compose ps --format json")
    if [ "\${NOODARA_TEST_FAIL:-}" = health ]; then
      printf '{"Service":"api","Health":"unhealthy"}\\n{"Service":"web","Health":"healthy"}\\n'
    else
      printf '{"Service":"api","Health":"healthy"}\\n{"Service":"web","Health":"healthy"}\\n'
    fi
    exit 0 ;;
  "compose logs api")
    printf 'NOODARA_SETUP_TOKEN=abcDEFghij0123456789_-ABCDEFGHIJ\\n'
    exit 0 ;;
esac
exit 0
`;

const SHADOWS = [
  "id() { printf '0\\n'; }",
  "uname() { printf 'x86_64\\n'; }",
  'command() { return 0; }',
  "ss() { printf 'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\\n'; }",
  'df() {',
  "  printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n'",
  "  printf '/dev/sda1 100000000 1000000 10485760 1%% /\\n'",
  '}',
  'snap() { return 1; }',
  'chown() { return 0; }',
  "noodara_fetch_url() { printf 'noodara-test: unexpected network call: %s\\n' \"$*\" >&2; return 1; }",
  'noodara_main',
].join('\n');

interface Scenario {
  installDir: string;
  logPath: string;
  env: Record<string, string>;
}

function buildScenario(pin: string, extraEnv: Record<string, string> = {}): Scenario {
  const root = mkdtempSync(join(tmpdir(), 'noodara-compose-env-'));
  const stubDir = join(root, 'bin');
  mkdirSync(stubDir);
  writeFileSync(join(stubDir, 'docker'), DOCKER_STUB, 'utf8');
  chmodSync(join(stubDir, 'docker'), 0o755);
  writeFileSync(join(root, 'os-release'), 'ID=ubuntu\nVERSION_ID="22.04"\nVERSION_CODENAME=jammy\n', 'utf8');
  writeFileSync(join(root, 'meminfo'), 'MemTotal:       4194304 kB\nMemFree:        102400 kB\n', 'utf8');
  const installDir = join(root, 'noodara');
  const logPath = join(root, 'docker-calls.log');
  writeFileSync(logPath, '', 'utf8');

  return {
    installDir,
    logPath,
    env: {
      PATH: `${stubDir}:${process.env.PATH ?? ''}`,
      NOODARA_INSTALL_DIR: installDir,
      NOODARA_OS_RELEASE_FILE: join(root, 'os-release'),
      NOODARA_MEMINFO_FILE: join(root, 'meminfo'),
      NOODARA_VERSION: pin,
      NOODARA_PUBLIC_URL: 'http://198.51.100.7:3000',
      NOODARA_HEALTH_WAIT_ATTEMPTS: '2',
      NOODARA_HEALTH_WAIT_INTERVAL: '0',
      NOODARA_TEST_DOCKER_LOG: logPath,
      ...extraEnv,
    },
  };
}

function seedInstalled(installDir: string, version: string, previous: string): void {
  mkdirSync(installDir, { recursive: true, mode: 0o700 });
  const lines = [
    `NOODARA_VERSION=${version}`,
    `NOODARA_PREVIOUS_VERSION=${previous}`,
    'NOODARA_IMAGE_PREFIX=ghcr.io/example',
    'NOODARA_PORT=3000',
    "NOODARA_PUBLIC_URL='http://198.51.100.7:3000'",
    'NOODARA_MASTER_KEY=dGVzdC1tYXN0ZXIta2V5LTMyLWJ5dGVzLWV4YWN0bHkhIQ==',
    'BETTER_AUTH_SECRET=abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567',
    'POSTGRES_USER=noodara',
    'POSTGRES_PASSWORD=abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567',
    'POSTGRES_DB=noodara',
    'REDIS_PASSWORD=abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567',
    'DATABASE_URL=postgresql://noodara:x@postgres:5432/noodara',
    'REDIS_URL=redis://:x@redis:6379',
    'PORT=3000',
  ];
  writeFileSync(join(installDir, '.env'), `${lines.join('\n')}\n`, 'utf8');
  chmodSync(join(installDir, '.env'), 0o600);
}

interface ComposeCall {
  argv: string;
  version: string;
  port: string;
  prefix: string;
  envFileVersion: string;
}

function composeCalls(logPath: string): ComposeCall[] {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('compose '))
    .map((line) => {
      const [argv = '', ...fields] = line.split('|');
      const map = Object.fromEntries(fields.map((f) => [f.slice(0, f.indexOf('=')), f.slice(f.indexOf('=') + 1)]));
      return {
        argv,
        version: map.version ?? '',
        port: map.port ?? '',
        prefix: map.prefix ?? '',
        envFileVersion: map.env ?? '',
      };
    });
}

function envValue(installDir: string, key: string): string | undefined {
  const line = readFileSync(join(installDir, '.env'), 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1);
}

/** `compose version` (the plugin-presence probe) runs before any version is resolved, so it must
 *  see NOODARA_VERSION unset; every other compose call must see the normalized target. */
function expectNormalizedEverywhere(calls: ComposeCall[], normalized: string): void {
  for (const call of calls) {
    expect(call.version, call.argv).toBe(call.argv === 'compose version' ? '<unset>' : normalized);
  }
}

const PINS: Array<[string, string]> = [
  ['v1.1.0', '1.1.0'],
  ['1.1.0', '1.1.0'],
  ['v0.2.0-rc.1', '0.2.0-rc.1'],
];

describe.each(posixInterpreters())('install.sh compose environment (%s)', (interpreter) => {
  it.each(PINS)('fresh install pinned %s: every compose call sees NOODARA_VERSION=%s', (pin, normalized) => {
    const s = buildScenario(pin);

    const result = runInstallerShell(interpreter, SHADOWS, { env: s.env });

    expect(result.stderr).not.toContain('unexpected network call');
    expect(result.status).toBe(0);
    const calls = composeCalls(s.logPath);
    expect(calls.map((c) => c.argv)).toEqual(expect.arrayContaining(['compose pull', 'compose up -d']));
    expectNormalizedEverywhere(calls, normalized);
    expect(envValue(s.installDir, 'NOODARA_VERSION')).toBe(normalized);
  });

  it.each(PINS)('upgrade pinned %s: every compose call sees NOODARA_VERSION=%s', (pin, normalized) => {
    const s = buildScenario(pin);
    seedInstalled(s.installDir, '1.0.0', '1.0.0');

    const result = runInstallerShell(interpreter, SHADOWS, { env: s.env });

    expect(result.status).toBe(0);
    const calls = composeCalls(s.logPath);
    expect(calls.length).toBeGreaterThan(0);
    expectNormalizedEverywhere(calls, normalized);
    expect(envValue(s.installDir, 'NOODARA_VERSION')).toBe(normalized);
    expect(envValue(s.installDir, 'NOODARA_PREVIOUS_VERSION')).toBe('1.0.0');
  });

  it('a re-run never lets an exported NOODARA_PORT or NOODARA_IMAGE_PREFIX override .env inside compose', () => {
    const s = buildScenario('1.1.0', { NOODARA_PORT: '8080', NOODARA_IMAGE_PREFIX: 'evil.example/x' });
    seedInstalled(s.installDir, '1.0.0', '1.0.0');

    const result = runInstallerShell(interpreter, SHADOWS, { env: s.env });

    expect(result.status).toBe(0);
    const calls = composeCalls(s.logPath);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.port, call.argv).toBe('<unset>');
      expect(call.prefix, call.argv).toBe('<unset>');
    }
  });

  it('.env names the new version only after the images were pulled', () => {
    const s = buildScenario('v1.1.0');
    seedInstalled(s.installDir, '1.0.0', '0.9.0');

    const result = runInstallerShell(interpreter, SHADOWS, { env: s.env });

    expect(result.status).toBe(0);
    const calls = composeCalls(s.logPath);
    expect(calls.find((c) => c.argv === 'compose pull')?.envFileVersion).toBe('1.0.0');
    expect(calls.find((c) => c.argv === 'compose up -d')?.envFileVersion).toBe('1.1.0');
  });

  it('a failed pull (exit 50) leaves .env naming the version that is still running', () => {
    const s = buildScenario('v1.1.0', { NOODARA_TEST_FAIL: 'pull' });
    seedInstalled(s.installDir, '1.0.0', '0.9.0');

    const result = runInstallerShell(interpreter, SHADOWS, { env: s.env });

    expect(result.status).toBe(50);
    expect(envValue(s.installDir, 'NOODARA_VERSION')).toBe('1.0.0');
    expect(envValue(s.installDir, 'NOODARA_PREVIOUS_VERSION')).toBe('0.9.0');
    expect(composeCalls(s.logPath).find((c) => c.argv === 'compose pull')?.version).toBe('1.1.0');
  });

  it('a failed migration (exit 52) restores .env to the previous version', () => {
    const s = buildScenario('1.1.0', { NOODARA_TEST_FAIL: 'up-migrate' });
    seedInstalled(s.installDir, '1.0.0', '0.9.0');

    const result = runInstallerShell(interpreter, SHADOWS, { env: s.env });

    expect(result.status).toBe(52);
    expect(envValue(s.installDir, 'NOODARA_VERSION')).toBe('1.0.0');
    expect(envValue(s.installDir, 'NOODARA_PREVIOUS_VERSION')).toBe('0.9.0');
  });

  it('a failed up -d with no running api (exit 51) restores .env and still names the rollback pin', () => {
    const s = buildScenario('1.1.0', { NOODARA_TEST_FAIL: 'up-start' });
    seedInstalled(s.installDir, '1.0.0', '0.9.0');

    const result = runInstallerShell(interpreter, SHADOWS, { env: s.env });

    expect(result.status).toBe(51);
    expect(result.stderr).toContain('NOODARA_VERSION=1.0.0');
    expect(envValue(s.installDir, 'NOODARA_VERSION')).toBe('1.0.0');
    expect(envValue(s.installDir, 'NOODARA_PREVIOUS_VERSION')).toBe('0.9.0');
  });

  it('a health-check failure (exit 53) keeps .env on the new version, which is the one Compose started', () => {
    const s = buildScenario('1.1.0', { NOODARA_TEST_FAIL: 'health' });
    seedInstalled(s.installDir, '1.0.0', '0.9.0');

    const result = runInstallerShell(interpreter, SHADOWS, { env: s.env });

    expect(result.status).toBe(53);
    expect(result.stderr).toContain('NOODARA_VERSION=1.0.0');
    expect(envValue(s.installDir, 'NOODARA_VERSION')).toBe('1.1.0');
    expect(envValue(s.installDir, 'NOODARA_PREVIOUS_VERSION')).toBe('1.0.0');
  });
});
