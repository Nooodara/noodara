// 06-09-PLAN.md: install.sh's noodara_main wiring -- preflight -> Docker -> install-directory
// bootstrap -> .env generate-or-merge -> compose file placement -> pull -> up -> health wait ->
// setup token/ufw/summary/log. Exercised under every available real POSIX interpreter (/bin/sh,
// plus dash when present), never bash (06-RESEARCH.md Pitfall 1), mirroring preflight.test.ts's,
// resolution.test.ts's and docker-install.test.ts's own conventions.
//
// hard_rule #8: no test here ever performs a real network call, a real docker/apt-get/systemctl/
// ufw invocation, or a write outside a mkdtemp directory. `docker`, `apt-get`, `ufw`, `snap`, `ss`,
// `df`, `id`, `uname`, `command` and `noodara_fetch_url` are all shadowed -- `docker`/`apt-get` via
// the same PATH-stub-executable technique docker-install.test.ts established (hyphenated commands
// and, here, a stub the test's own argv-recording call log needs to survive across every one of
// noodara_main's several `docker ...` invocations), everything else via shell-function shadowing
// after sourcing install.sh.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INSTALL_SH, posixInterpreters, runInstallerShell } from './sh-harness.js';

const REPO_ROOT = dirname(INSTALL_SH);
const REAL_COMPOSE_FILE = readFileSync(join(REPO_ROOT, 'docker-compose.yml'), 'utf8');

function writeOsReleaseFixture(dir: string, codename: string): string {
  const file = join(dir, 'os-release');
  writeFileSync(file, `ID=ubuntu\nVERSION_ID="22.04"\nVERSION_CODENAME=${codename}\n`, 'utf8');
  return file;
}

function writeMeminfoFixture(dir: string, totalKb: number): string {
  const file = join(dir, 'meminfo');
  writeFileSync(file, `MemTotal:       ${totalKb} kB\nMemFree:        102400 kB\n`, 'utf8');
  return file;
}

function dfFunctionSnippet(availableKb: number): string {
  return [
    'df() {',
    "  printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n'",
    `  printf '/dev/sda1 100000000 1000000 ${availableKb} 1%% /\\n'`,
    '}',
  ].join('\n');
}

/** Parses a written .env file into a plain key/value map, stripping one layer of surrounding
 *  single quotes -- mirrors env-file.test.ts's own parseEnvFile convention and what Compose
 *  itself does when it reads a single-quoted dotenv value. */
function parseEnvFile(path: string): Record<string, string> {
  const content = readFileSync(path, 'utf8');
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx);
    let value = line.slice(idx + 1);
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** A fully-passing environment for driving noodara_main end to end: root, base commands, Ubuntu
 *  22.04, ample RAM/disk, no snap Docker, a free port, Docker/Compose already present and
 *  healthy (so noodara_ensure_docker no-ops without ever needing an apt-get stub), and an explicit
 *  NOODARA_VERSION/NOODARA_PUBLIC_URL so noodara_resolve_version/noodara_resolve_public_url take
 *  zero network paths -- noodara_fetch_url is still shadowed to fail loudly if ever called, so a
 *  test can prove zero real network use even without asserting on it directly. */
function buildMainFlowEnv(overrides: Record<string, string> = {}): {
  snippet: string;
  env: Record<string, string>;
  installDir: string;
  fixturesDir: string;
} {
  const fixturesDir = mkdtempSync(join(tmpdir(), 'noodara-main-flow-fixtures-'));
  const installParentDir = mkdtempSync(join(tmpdir(), 'noodara-main-flow-parent-'));
  const installDir = join(installParentDir, 'noodara');
  const osReleaseFile = writeOsReleaseFixture(fixturesDir, 'jammy');
  const meminfoFile = writeMeminfoFixture(fixturesDir, 4194304);

  const snippet = [
    "id() { printf '0\\n'; }",
    "uname() { printf 'x86_64\\n'; }",
    'command() { return 0; }',
    "ss() { printf 'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\\n'; }",
    dfFunctionSnippet(10485760),
    'snap() { return 1; }',
    // noodara_check_root needs `id -u` = 0 to pass; noodara_secure_env_file then also sees that
    // same shadowed `id -u` = 0 and treats a real (non-root, macOS dev) chown failure as a fatal
    // error rather than tolerating it -- shadow chown too, matching what a genuine root-run
    // install would observe (chown genuinely succeeding).
    'chown() { return 0; }',
    // Generic docker() covering the whole noodara_main flow once Task 2 wires pull/up/health-wait
    // in for real: any subcommand succeeds, and `compose ps --format json` (the health poll)
    // reports both api and web healthy on the very first call, so a full noodara_main run through
    // this fixture never sleeps through the real NOODARA_HEALTH_WAIT_INTERVAL default.
    'docker() {',
    '  case "$*" in',
    '    "compose ps --format json")',
    '      printf \'{"Service":"api","Health":"healthy"}\\n{"Service":"web","Health":"healthy"}\\n\'',
    '      return 0 ;;',
    '  esac',
    '  return 0',
    '}',
    "noodara_fetch_url() { printf 'noodara-test: unexpected network call: %s\\n' \"$*\" >&2; return 1; }",
  ].join('\n');

  return {
    snippet,
    env: {
      NOODARA_INSTALL_DIR: installDir,
      NOODARA_OS_RELEASE_FILE: osReleaseFile,
      NOODARA_MEMINFO_FILE: meminfoFile,
      NOODARA_VERSION: '1.2.3',
      NOODARA_PUBLIC_URL: 'http://198.51.100.7:3000',
      NOODARA_HEALTH_WAIT_ATTEMPTS: '3',
      NOODARA_HEALTH_WAIT_INTERVAL: '0',
      ...overrides,
    },
    installDir,
    fixturesDir,
  };
}

describe.each(posixInterpreters())('install.sh noodara_is_installed (%s)', (interpreter) => {
  it('is false when the install directory does not exist at all', () => {
    const parent = mkdtempSync(join(tmpdir(), 'noodara-is-installed-'));
    const installDir = join(parent, 'noodara');

    const result = runInstallerShell(interpreter, 'noodara_is_installed', {
      env: { NOODARA_INSTALL_DIR: installDir },
    });

    expect(result.status).not.toBe(0);
  });

  it('is false when the directory exists but has no .env', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-is-installed-'));

    const result = runInstallerShell(interpreter, 'noodara_is_installed', {
      env: { NOODARA_INSTALL_DIR: installDir },
    });

    expect(result.status).not.toBe(0);
  });

  it('is true when .env exists inside the install directory', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-is-installed-'));
    writeFileSync(join(installDir, '.env'), 'NOODARA_VERSION=1.0.0\n', 'utf8');

    const result = runInstallerShell(interpreter, 'noodara_is_installed', {
      env: { NOODARA_INSTALL_DIR: installDir },
    });

    expect(result.status).toBe(0);
  });
});

describe.each(posixInterpreters())('install.sh noodara_prepare_install_dir (%s)', (interpreter) => {
  it('creates the install directory mode 700 when absent', () => {
    const parent = mkdtempSync(join(tmpdir(), 'noodara-prepare-dir-'));
    const installDir = join(parent, 'noodara');

    const result = runInstallerShell(interpreter, 'noodara_prepare_install_dir', {
      env: { NOODARA_INSTALL_DIR: installDir },
    });

    expect(result.status).toBe(0);
    expect(existsSync(installDir)).toBe(true);
    expect(statSync(installDir).mode & 0o777).toBe(0o700);
  });

  it('re-asserts mode 700 when the directory already exists with a looser mode', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-prepare-dir-'));
    chmodSync(installDir, 0o755);

    const result = runInstallerShell(interpreter, 'noodara_prepare_install_dir', {
      env: { NOODARA_INSTALL_DIR: installDir },
    });

    expect(result.status).toBe(0);
    expect(statSync(installDir).mode & 0o777).toBe(0o700);
  });

  it('fails with exit code 30 when the directory cannot be created', () => {
    const parent = mkdtempSync(join(tmpdir(), 'noodara-prepare-dir-unwritable-'));
    chmodSync(parent, 0o555);
    try {
      const installDir = join(parent, 'noodara');

      const result = runInstallerShell(interpreter, 'noodara_prepare_install_dir', {
        env: { NOODARA_INSTALL_DIR: installDir },
      });

      expect(result.status).toBe(30);
    } finally {
      chmodSync(parent, 0o755);
    }
  });
});

describe.each(posixInterpreters())('install.sh noodara_place_compose_file (%s)', (interpreter) => {
  it('writes a compose file byte-identical to the repo docker-compose.yml, mode 644', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-place-compose-'));

    const result = runInstallerShell(interpreter, 'noodara_place_compose_file', {
      env: { NOODARA_INSTALL_DIR: installDir, NOODARA_COMPOSE_FILE: 'docker-compose.yml' },
    });

    expect(result.status).toBe(0);
    const written = readFileSync(join(installDir, 'docker-compose.yml'), 'utf8');
    expect(written).toBe(REAL_COMPOSE_FILE);
    expect(statSync(join(installDir, 'docker-compose.yml')).mode & 0o777).toBe(0o644);
  });

  it('overwrites any previous copy on every run', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-place-compose-'));
    writeFileSync(join(installDir, 'docker-compose.yml'), 'stale content\n', 'utf8');

    const result = runInstallerShell(interpreter, 'noodara_place_compose_file', {
      env: { NOODARA_INSTALL_DIR: installDir, NOODARA_COMPOSE_FILE: 'docker-compose.yml' },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(join(installDir, 'docker-compose.yml'), 'utf8')).toBe(REAL_COMPOSE_FILE);
  });

  it('never leaves a stray .tmp file behind on success', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-place-compose-'));

    runInstallerShell(interpreter, 'noodara_place_compose_file', {
      env: { NOODARA_INSTALL_DIR: installDir, NOODARA_COMPOSE_FILE: 'docker-compose.yml' },
    });

    const entries = readdirSync(installDir);
    expect(entries).toEqual(['docker-compose.yml']);
  });
});

describe('install.sh noodara_main function names', () => {
  it('contains noodara_is_installed, noodara_prepare_install_dir and noodara_place_compose_file', () => {
    const source = readFileSync(INSTALL_SH, 'utf8');

    expect(source).toContain('noodara_is_installed');
    expect(source).toContain('noodara_prepare_install_dir');
    expect(source).toContain('noodara_place_compose_file');
  });
});

describe.each(posixInterpreters())('install.sh noodara_main fresh install (%s)', (interpreter) => {
  it('calls noodara_generate_env and never noodara_merge_env on a fresh run', () => {
    const { snippet, env, installDir } = buildMainFlowEnv();
    const fullSnippet = [
      snippet,
      'noodara_merge_env() { printf "noodara-test: noodara_merge_env must not run on a fresh install\\n" >&2; exit 97; }',
      'noodara_main',
    ].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, { env });

    expect(result.status).toBe(0);
    expect(existsSync(join(installDir, '.env'))).toBe(true);
  });

  it('writes a complete .env with the resolved version, image prefix and public URL', () => {
    const { snippet, env, installDir } = buildMainFlowEnv({
      NOODARA_VERSION: '2.0.0',
      NOODARA_PUBLIC_URL: 'http://198.51.100.9:3000',
    });
    const fullSnippet = [snippet, 'noodara_main'].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, { env });

    expect(result.status).toBe(0);
    const written = parseEnvFile(join(installDir, '.env'));
    expect(written.NOODARA_VERSION).toBe('2.0.0');
    expect(written.NOODARA_PUBLIC_URL).toBe('http://198.51.100.9:3000');
    expect(written.NOODARA_PREVIOUS_VERSION).toBe('2.0.0');
  });

  it('also places the compose file in the install directory', () => {
    const { snippet, env, installDir } = buildMainFlowEnv();
    const fullSnippet = [snippet, 'noodara_main'].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, { env });

    expect(result.status).toBe(0);
    expect(readFileSync(join(installDir, 'docker-compose.yml'), 'utf8')).toBe(REAL_COMPOSE_FILE);
  });

  it('fails with exit code 30 when the install directory cannot be created', () => {
    const parent = mkdtempSync(join(tmpdir(), 'noodara-main-flow-unwritable-'));
    chmodSync(parent, 0o555);
    try {
      const { snippet, env } = buildMainFlowEnv({ NOODARA_INSTALL_DIR: join(parent, 'noodara') });
      const fullSnippet = [snippet, 'noodara_main'].join('\n');

      const result = runInstallerShell(interpreter, fullSnippet, { env });

      expect(result.status).toBe(30);
    } finally {
      chmodSync(parent, 0o755);
    }
  });
});

describe.each(posixInterpreters())('install.sh noodara_main upgrade (%s)', (interpreter) => {
  function seedExistingInstall(installDir: string, version: string, extra: Record<string, string> = {}): void {
    mkdirSync(installDir, { recursive: true, mode: 0o700 });
    const lines = [
      `NOODARA_VERSION=${version}`,
      `NOODARA_PREVIOUS_VERSION=${extra.NOODARA_PREVIOUS_VERSION ?? version}`,
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

  it('calls noodara_merge_env and never noodara_generate_env on a re-run', () => {
    const { snippet, env, installDir } = buildMainFlowEnv({ NOODARA_VERSION: '1.1.0' });
    seedExistingInstall(installDir, '1.0.0');
    const fullSnippet = [
      snippet,
      'noodara_generate_env() { printf "noodara-test: noodara_generate_env must not run on a re-run\\n" >&2; exit 97; }',
      'noodara_main',
    ].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, { env });

    expect(result.status).toBe(0);
  });

  it('preserves the existing secrets byte-for-byte across an upgrade', () => {
    const { snippet, env, installDir } = buildMainFlowEnv({ NOODARA_VERSION: '1.1.0' });
    seedExistingInstall(installDir, '1.0.0');
    const before = parseEnvFile(join(installDir, '.env'));
    const fullSnippet = [snippet, 'noodara_main'].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, { env });

    expect(result.status).toBe(0);
    const after = parseEnvFile(join(installDir, '.env'));
    expect(after.NOODARA_MASTER_KEY).toBe(before.NOODARA_MASTER_KEY);
    expect(after.POSTGRES_PASSWORD).toBe(before.POSTGRES_PASSWORD);
    expect(after.REDIS_PASSWORD).toBe(before.REDIS_PASSWORD);
    expect(after.BETTER_AUTH_SECRET).toBe(before.BETTER_AUTH_SECRET);
  });

  it('records NOODARA_PREVIOUS_VERSION as the prior version when the version actually changes', () => {
    const { snippet, env, installDir } = buildMainFlowEnv({ NOODARA_VERSION: '2.0.0' });
    seedExistingInstall(installDir, '1.0.0', { NOODARA_PREVIOUS_VERSION: '1.0.0' });
    const fullSnippet = [snippet, 'noodara_main'].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, { env });

    expect(result.status).toBe(0);
    const after = parseEnvFile(join(installDir, '.env'));
    expect(after.NOODARA_VERSION).toBe('2.0.0');
    expect(after.NOODARA_PREVIOUS_VERSION).toBe('1.0.0');
  });

  it('leaves NOODARA_PREVIOUS_VERSION untouched on a same-version, health-check-only re-run', () => {
    const { snippet, env, installDir } = buildMainFlowEnv({ NOODARA_VERSION: '1.0.0' });
    seedExistingInstall(installDir, '1.0.0', { NOODARA_PREVIOUS_VERSION: '0.9.0' });
    const fullSnippet = [snippet, 'noodara_main'].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, { env });

    expect(result.status).toBe(0);
    const after = parseEnvFile(join(installDir, '.env'));
    expect(after.NOODARA_VERSION).toBe('1.0.0');
    expect(after.NOODARA_PREVIOUS_VERSION).toBe('0.9.0');
  });

  it('creates a timestamped .env backup before mutating anything (D-11)', () => {
    const { snippet, env, installDir } = buildMainFlowEnv({ NOODARA_VERSION: '1.1.0' });
    seedExistingInstall(installDir, '1.0.0');
    const fullSnippet = [snippet, 'noodara_main'].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, { env });

    expect(result.status).toBe(0);
    const entries: string[] = readdirSync(installDir);
    expect(entries.some((name) => name.startsWith('.env.bak-'))).toBe(true);
  });

  it('re-places the compose file on every re-run too', () => {
    const { snippet, env, installDir } = buildMainFlowEnv({ NOODARA_VERSION: '1.1.0' });
    seedExistingInstall(installDir, '1.0.0');
    writeFileSync(join(installDir, 'docker-compose.yml'), 'stale\n', 'utf8');
    const fullSnippet = [snippet, 'noodara_main'].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, { env });

    expect(result.status).toBe(0);
    expect(readFileSync(join(installDir, 'docker-compose.yml'), 'utf8')).toBe(REAL_COMPOSE_FILE);
  });
});

// 06-09-PLAN.md Task 2: pull, up, health wait, and D-12's failure diagnostics. `docker` is
// shadowed as a shell function whose behaviour branches on its own recorded argv, scripted per
// scenario -- never a real `docker compose` invocation.
describe.each(posixInterpreters())('install.sh noodara_compose_json_field_for_service (%s)', (interpreter) => {
  it('parses the newline-delimited-object shape', () => {
    const fixturesDir = mkdtempSync(join(tmpdir(), 'noodara-json-field-'));
    const file = join(fixturesDir, 'ps.json');
    writeFileSync(
      file,
      '{"ID":"a","Service":"api","Health":"healthy"}\n{"ID":"b","Service":"web","Health":"starting"}\n',
      'utf8',
    );

    const result = runInstallerShell(
      interpreter,
      `cat "${file}" | noodara_compose_json_field_for_service web Health`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('starting');
  });

  it('parses the single-JSON-array shape', () => {
    const fixturesDir = mkdtempSync(join(tmpdir(), 'noodara-json-field-'));
    const file = join(fixturesDir, 'ps.json');
    writeFileSync(
      file,
      '[{"ID":"a","Service":"api","Health":"healthy"},{"ID":"b","Service":"web","Health":"starting"}]\n',
      'utf8',
    );

    const result = runInstallerShell(
      interpreter,
      `cat "${file}" | noodara_compose_json_field_for_service api Health`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('healthy');
  });
});

describe.each(posixInterpreters())('install.sh noodara_pull_images (%s)', (interpreter) => {
  it('runs docker compose pull and fails with exit 50 on failure', () => {
    const callLog = join(mkdtempSync(join(tmpdir(), 'noodara-pull-')), 'calls.log');
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-pull-install-'));
    const snippet = [
      'docker() { printf "%s\\n" "docker $*" >> "$NOODARA_TEST_CALL_LOG"; case "$*" in "compose pull") return 1 ;; esac; return 0; }',
      'noodara_pull_images',
    ].join('\n');

    const result = runInstallerShell(interpreter, snippet, {
      env: { NOODARA_INSTALL_DIR: installDir, NOODARA_TEST_CALL_LOG: callLog },
    });

    expect(result.status).toBe(50);
    expect(readFileSync(callLog, 'utf8')).toContain('compose pull');
  });

  it('succeeds silently when docker compose pull succeeds', () => {
    const callLog = join(mkdtempSync(join(tmpdir(), 'noodara-pull-')), 'calls.log');
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-pull-install-'));
    const snippet = [
      'docker() { printf "%s\\n" "docker $*" >> "$NOODARA_TEST_CALL_LOG"; return 0; }',
      'noodara_pull_images',
    ].join('\n');

    const result = runInstallerShell(interpreter, snippet, {
      env: { NOODARA_INSTALL_DIR: installDir, NOODARA_TEST_CALL_LOG: callLog },
    });

    expect(result.status).toBe(0);
  });

  it('skips the pull entirely when NOODARA_INTERNAL_IMAGE_PREFIX is set (D-19)', () => {
    const callLog = join(mkdtempSync(join(tmpdir(), 'noodara-pull-')), 'calls.log');
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-pull-install-'));
    const snippet = [
      // Fails loudly if ever invoked -- proves the pull is genuinely skipped, not merely stubbed
      // to succeed.
      'docker() { printf "%s\\n" "docker $*" >> "$NOODARA_TEST_CALL_LOG"; exit 98; }',
      'noodara_pull_images',
    ].join('\n');

    const result = runInstallerShell(interpreter, snippet, {
      env: {
        NOODARA_INSTALL_DIR: installDir,
        NOODARA_TEST_CALL_LOG: callLog,
        NOODARA_INTERNAL_IMAGE_PREFIX: 'localhost:5000/noodara-test',
      },
    });

    expect(result.status).toBe(0);
    expect(existsSync(callLog)).toBe(false);
  });
});

describe.each(posixInterpreters())('install.sh noodara_compose_up (%s)', (interpreter) => {
  it('succeeds silently when docker compose up -d succeeds', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-up-install-'));
    const snippet = ['docker() { return 0; }', 'noodara_compose_up'].join('\n');

    const result = runInstallerShell(interpreter, snippet, { env: { NOODARA_INSTALL_DIR: installDir } });

    expect(result.status).toBe(0);
  });

  it('fails with exit 51 (compose-up-failed) when up fails for a non-migrate reason', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-up-install-'));
    const snippet = [
      'docker() {',
      '  case "$*" in',
      '    "compose up -d") return 1 ;;',
      '    "compose ps -a --format json") printf "{\\"Service\\":\\"migrate\\",\\"ExitCode\\":0}\\n"; return 0 ;;',
      '  esac',
      '  return 0',
      '}',
      'noodara_compose_up',
    ].join('\n');

    const result = runInstallerShell(interpreter, snippet, { env: { NOODARA_INSTALL_DIR: installDir } });

    expect(result.status).toBe(51);
  });

  it('fails with exit 52 (migrations-failed) and shows the migrate log tail when migrate is the real cause', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-up-install-'));
    const snippet = [
      'docker() {',
      '  case "$*" in',
      '    "compose up -d") return 1 ;;',
      '    "compose ps -a --format json") printf "{\\"Service\\":\\"migrate\\",\\"ExitCode\\":1}\\n"; return 0 ;;',
      '    "compose logs --tail 50 migrate") printf "MIGRATION ERROR: relation already exists\\n"; return 0 ;;',
      '  esac',
      '  return 0',
      '}',
      'noodara_compose_up',
    ].join('\n');

    const result = runInstallerShell(interpreter, snippet, { env: { NOODARA_INSTALL_DIR: installDir } });

    expect(result.status).toBe(52);
    expect(result.stderr).toContain('MIGRATION ERROR: relation already exists');
  });

  it('never runs docker compose down, volume rm or deletes .env on any up failure', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-up-install-'));
    writeFileSync(join(installDir, '.env'), 'NOODARA_VERSION=1.0.0\n', 'utf8');
    const callLog = join(installDir, 'calls.log');
    const snippet = [
      'docker() {',
      '  printf "%s\\n" "docker $*" >> "$NOODARA_TEST_CALL_LOG"',
      '  case "$*" in',
      '    "compose up -d") return 1 ;;',
      '    "compose ps -a --format json") printf "{\\"Service\\":\\"migrate\\",\\"ExitCode\\":1}\\n"; return 0 ;;',
      '  esac',
      '  return 0',
      '}',
      'noodara_compose_up',
    ].join('\n');

    runInstallerShell(interpreter, snippet, { env: { NOODARA_INSTALL_DIR: installDir, NOODARA_TEST_CALL_LOG: callLog } });

    expect(existsSync(join(installDir, '.env'))).toBe(true);
    const calls = readFileSync(callLog, 'utf8');
    expect(calls).not.toMatch(/compose (down|rm)\b/);
    expect(calls).not.toMatch(/volume rm/);
  });
});

describe.each(posixInterpreters())('install.sh noodara_wait_for_health (%s)', (interpreter) => {
  it('returns 0 as soon as both api and web report healthy', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-health-install-'));
    const snippet = [
      'docker() {',
      '  case "$*" in',
      '    "compose ps --format json") printf "{\\"Service\\":\\"api\\",\\"Health\\":\\"healthy\\"}\\n{\\"Service\\":\\"web\\",\\"Health\\":\\"healthy\\"}\\n"; return 0 ;;',
      '  esac',
      '  return 0',
      '}',
      'noodara_wait_for_health',
    ].join('\n');

    const result = runInstallerShell(interpreter, snippet, {
      env: { NOODARA_INSTALL_DIR: installDir, NOODARA_HEALTH_WAIT_ATTEMPTS: '3', NOODARA_HEALTH_WAIT_INTERVAL: '0' },
    });

    expect(result.status).toBe(0);
  });

  it('polls more than once before becoming healthy, then returns 0', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-health-install-'));
    const pollCountFile = join(installDir, 'poll-count');
    writeFileSync(pollCountFile, '', 'utf8');
    const snippet = [
      'docker() {',
      '  case "$*" in',
      '    "compose ps --format json")',
      `      printf '.\\n' >> "${pollCountFile}"`,
      `      _n=$(wc -l < "${pollCountFile}" | tr -d ' ')`,
      '      if [ "$_n" -ge 2 ]; then',
      '        printf "{\\"Service\\":\\"api\\",\\"Health\\":\\"healthy\\"}\\n{\\"Service\\":\\"web\\",\\"Health\\":\\"healthy\\"}\\n"',
      '      else',
      '        printf "{\\"Service\\":\\"api\\",\\"Health\\":\\"healthy\\"}\\n{\\"Service\\":\\"web\\",\\"Health\\":\\"starting\\"}\\n"',
      '      fi',
      '      return 0 ;;',
      '  esac',
      '  return 0',
      '}',
      'noodara_wait_for_health',
    ].join('\n');

    const result = runInstallerShell(interpreter, snippet, {
      env: { NOODARA_INSTALL_DIR: installDir, NOODARA_HEALTH_WAIT_ATTEMPTS: '5', NOODARA_HEALTH_WAIT_INTERVAL: '0' },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(pollCountFile, 'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(2);
  });

  it('fails with exit 53 on timeout, naming the unhealthy service and the NOODARA_VERSION=<previous> remedy', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-health-install-'));
    const snippet = [
      'docker() {',
      '  case "$*" in',
      '    "compose ps --format json") printf "{\\"Service\\":\\"api\\",\\"Health\\":\\"healthy\\"}\\n{\\"Service\\":\\"web\\",\\"Health\\":\\"starting\\"}\\n"; return 0 ;;',
      '    "compose logs --tail 50 web") printf "WEB CONTAINER LOG TAIL\\n"; return 0 ;;',
      '  esac',
      '  return 0',
      '}',
      'noodara_wait_for_health',
    ].join('\n');

    const result = runInstallerShell(interpreter, snippet, {
      env: {
        NOODARA_INSTALL_DIR: installDir,
        NOODARA_HEALTH_WAIT_ATTEMPTS: '2',
        NOODARA_HEALTH_WAIT_INTERVAL: '0',
        NOODARA_PREVIOUS_VERSION: '0.9.0',
      },
    });

    expect(result.status).toBe(53);
    expect(result.stderr).toContain('web');
    expect(result.stderr).toContain('WEB CONTAINER LOG TAIL');
    expect(result.stderr).toContain('NOODARA_VERSION=0.9.0');
  });

  it('never prints .env contents on the timeout diagnostic path', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-health-install-'));
    const canary = 'noodara-canary-secret-never-in-diagnostics-9f3c1a';
    writeFileSync(join(installDir, '.env'), `NOODARA_MASTER_KEY=${canary}\n`, 'utf8');
    const snippet = [
      'docker() {',
      '  case "$*" in',
      '    "compose ps --format json") printf "{\\"Service\\":\\"api\\",\\"Health\\":\\"starting\\"}\\n{\\"Service\\":\\"web\\",\\"Health\\":\\"healthy\\"}\\n"; return 0 ;;',
      '    "compose logs --tail 50 api") printf "ordinary api log line\\n"; return 0 ;;',
      '  esac',
      '  return 0',
      '}',
      'noodara_wait_for_health',
    ].join('\n');

    const result = runInstallerShell(interpreter, snippet, {
      env: { NOODARA_INSTALL_DIR: installDir, NOODARA_HEALTH_WAIT_ATTEMPTS: '1', NOODARA_HEALTH_WAIT_INTERVAL: '0' },
    });

    expect(result.status).toBe(53);
    expect(result.stdout).not.toContain(canary);
    expect(result.stderr).not.toContain(canary);
  });

  it('never runs docker compose down, volume rm or deletes .env on a health-check timeout', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-health-install-'));
    writeFileSync(join(installDir, '.env'), 'NOODARA_VERSION=1.0.0\n', 'utf8');
    const callLog = join(installDir, 'calls.log');
    const snippet = [
      'docker() {',
      '  printf "%s\\n" "docker $*" >> "$NOODARA_TEST_CALL_LOG"',
      '  case "$*" in',
      '    "compose ps --format json") printf "{\\"Service\\":\\"api\\",\\"Health\\":\\"starting\\"}\\n{\\"Service\\":\\"web\\",\\"Health\\":\\"starting\\"}\\n"; return 0 ;;',
      '  esac',
      '  return 0',
      '}',
      'noodara_wait_for_health',
    ].join('\n');

    runInstallerShell(interpreter, snippet, {
      env: {
        NOODARA_INSTALL_DIR: installDir,
        NOODARA_TEST_CALL_LOG: callLog,
        NOODARA_HEALTH_WAIT_ATTEMPTS: '1',
        NOODARA_HEALTH_WAIT_INTERVAL: '0',
      },
    });

    expect(existsSync(join(installDir, '.env'))).toBe(true);
    const calls = readFileSync(callLog, 'utf8');
    expect(calls).not.toMatch(/compose (down|rm)\b/);
    expect(calls).not.toMatch(/volume rm/);
  });
});

describe('install.sh Task 2 structural checks', () => {
  it('grep -c "while true" install.sh returns 0 -- the poll loop is always bounded', () => {
    const source = readFileSync(INSTALL_SH, 'utf8');
    const count = (source.match(/while true/g) ?? []).length;

    expect(count).toBe(0);
  });

  it('install.sh contains noodara_pull_images, noodara_compose_up and noodara_wait_for_health', () => {
    const source = readFileSync(INSTALL_SH, 'utf8');

    expect(source).toContain('noodara_pull_images');
    expect(source).toContain('noodara_compose_up');
    expect(source).toContain('noodara_wait_for_health');
  });
});
