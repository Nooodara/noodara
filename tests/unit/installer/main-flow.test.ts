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
import { createHash } from 'node:crypto';
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

/** Writes a minimal but complete existing-installation .env -- shared by the "upgrade" and "full
 *  noodara_main flow" describe blocks below (previously duplicated once per block). */
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
    // Blanket command() override: makes `command -v <cmd>` succeed for every base command
    // noodara_check_base_commands needs (including ss/ip, which genuinely do not exist on this
    // macOS dev machine). This also makes `command -v ufw`/`command -v docker` report present
    // even when the real binary is absent -- harmless for `docker` (it is separately shadowed as
    // a real shell function below, so it genuinely works when called), and harmless for `ufw`
    // (noodara_check_ufw's own `ufw status || return 0` fallback still degrades gracefully to "no
    // advisory" when the real `ufw` binary genuinely does not exist on PATH, exactly the outcome
    // the "ufw absent" test asserts). A shell function named `command` cannot delegate to the real
    // builtin via a leading backslash -- POSIX/dash/bash all still resolve `\command` to this same
    // function (confirmed empirically), unlike a backslash's real effect of only defeating alias
    // expansion -- so this file deliberately does not attempt that trick.
    'command() { return 0; }',
    "ss() { printf 'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\\n'; }",
    dfFunctionSnippet(10485760),
    'snap() { return 1; }',
    // noodara_check_root needs `id -u` = 0 to pass; noodara_secure_env_file then also sees that
    // same shadowed `id -u` = 0 and treats a real (non-root, macOS dev) chown failure as a fatal
    // error rather than tolerating it -- shadow chown too, matching what a genuine root-run
    // install would observe (chown genuinely succeeding).
    'chown() { return 0; }',
    // Generic docker() covering the whole noodara_main flow once Tasks 2-3 wire pull/up/health-wait/
    // summary in for real: any subcommand succeeds, `compose ps --format json` (the health poll)
    // reports both api and web healthy on the very first call (so a full run never sleeps through
    // the real NOODARA_HEALTH_WAIT_INTERVAL default), and `compose logs api` returns a
    // validly-shaped setup-token line (the common fresh-install case; tests needing the
    // admin-exists or admin-preseed path override docker() themselves).
    'docker() {',
    '  case "$*" in',
    '    "compose ps --format json")',
    '      printf \'{"Service":"api","Health":"healthy"}\\n{"Service":"web","Health":"healthy"}\\n\'',
    '      return 0 ;;',
    '    "compose logs api")',
    '      printf \'NOODARA_SETUP_TOKEN=abcDEFghij0123456789_-ABCDEFGHIJ\\n\'',
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

    // hard_rule #8 canary extension: no secret leaks anywhere on the version-changed upgrade path.
    const installLogPath = join(installDir, 'install.log');
    const logContent = existsSync(installLogPath) ? readFileSync(installLogPath, 'utf8') : '';
    for (const secret of [before.NOODARA_MASTER_KEY, before.POSTGRES_PASSWORD, before.REDIS_PASSWORD, before.BETTER_AUTH_SECRET]) {
      expect(logContent).not.toContain(secret);
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
    }
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

  // Post-execution fix (orchestrator audit Finding B): an upgrade must use the public URL/port
  // already recorded in .env -- never re-resolve from the network -- and must never depend on
  // outbound reachability to do so.
  it('uses the public URL recorded in .env on an upgrade, never a network lookup, when the operator supplies no override', () => {
    const { snippet, env, installDir } = buildMainFlowEnv({ NOODARA_VERSION: '1.1.0' });
    const { NOODARA_PUBLIC_URL: _drop, ...envWithoutPublicUrl } = env;
    seedExistingInstall(installDir, '1.0.0', {});
    // Overwrite the seeded PUBLIC_URL to a distinctive value so a network-resolved value (which
    // would come from an ifconfig.io-style IP, never this hostname) is unmistakably wrong.
    writeFileSync(
      join(installDir, '.env'),
      readFileSync(join(installDir, '.env'), 'utf8').replace(
        "NOODARA_PUBLIC_URL='http://198.51.100.7:3000'",
        "NOODARA_PUBLIC_URL='https://panel.example.com'",
      ),
      'utf8',
    );
    const fullSnippet = [snippet, 'noodara_main'].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, { env: envWithoutPublicUrl });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('unexpected network call');
    const after = parseEnvFile(join(installDir, '.env'));
    expect(after.NOODARA_PUBLIC_URL).toBe('https://panel.example.com');
    expect(result.stdout).toContain('https://panel.example.com');
  });

  it('an upgrade never fails with exit 41 (public-url-resolution-failed) even when the network is fully unreachable, as long as .env already has NOODARA_PUBLIC_URL', () => {
    const { snippet, env, installDir } = buildMainFlowEnv({ NOODARA_VERSION: '1.1.0' });
    const { NOODARA_PUBLIC_URL: _drop, ...envWithoutPublicUrl } = env;
    seedExistingInstall(installDir, '1.0.0');
    const fullSnippet = [
      snippet,
      // ip absent too -- both D-07 network tiers unavailable. Must never be reached.
      "ip() { printf 'noodara-test: unexpected ip call\\n' >&2; return 1; }",
      'noodara_main',
    ].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, { env: envWithoutPublicUrl });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('unexpected network call');
    expect(result.stderr).not.toContain('unexpected ip call');
  });

  it('warns naming both values, and .env still wins, when an explicit NOODARA_PUBLIC_URL override differs from the recorded one', () => {
    const { snippet, env, installDir } = buildMainFlowEnv({
      NOODARA_VERSION: '1.1.0',
      NOODARA_PUBLIC_URL: 'https://operator-override.example.com',
    });
    seedExistingInstall(installDir, '1.0.0');
    const fullSnippet = [snippet, 'noodara_main'].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, { env });

    expect(result.status).toBe(0);
    const after = parseEnvFile(join(installDir, '.env'));
    expect(after.NOODARA_PUBLIC_URL).toBe('http://198.51.100.7:3000');
    expect(result.stderr).toContain('operator-override.example.com');
    expect(result.stderr).toContain('198.51.100.7');
    expect(result.stderr.toLowerCase()).toContain('.env');
  });

  it('the ufw advisory and summary both name the port and URL actually recorded in .env, not an operator override', () => {
    const { snippet, env, installDir } = buildMainFlowEnv({
      NOODARA_VERSION: '1.1.0',
      NOODARA_PUBLIC_URL: 'https://operator-override.example.com',
    });
    seedExistingInstall(installDir, '1.0.0');
    const fullSnippet = [
      snippet,
      'ufw() { printf "Status: active\\n"; return 0; }',
      'noodara_main',
    ].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, { env });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('http://198.51.100.7:3000');
    expect(result.stdout).toContain('sudo ufw allow 3000/tcp');
    expect(result.stdout).not.toContain('operator-override.example.com');
  });

  // Post-execution fix (orchestrator audit Finding C): D-09's own wording is explicit, not silent
  // -- "si ya está en esa versión, no cambia nada y solo verifica salud". A same-version re-run
  // with nothing missing from .env is a true no-op: no backup, .env byte-identical, no pull, no
  // `docker compose up -d`.
  it('a same-version re-run with nothing missing from .env is a true no-op (Finding C)', () => {
    const { snippet, env, installDir } = buildMainFlowEnv({ NOODARA_VERSION: '1.0.0' });
    seedExistingInstall(installDir, '1.0.0', { NOODARA_PREVIOUS_VERSION: '0.9.0' });
    const before = parseEnvFile(join(installDir, '.env'));
    const beforeChecksum = createHash('sha256').update(readFileSync(join(installDir, '.env'))).digest('hex');
    const callLog = join(installDir, 'docker-calls.log');
    const fullSnippet = [
      snippet,
      'docker() {',
      '  printf "%s\\n" "docker $*" >> "$NOODARA_TEST_CALL_LOG"',
      '  case "$*" in',
      '    "compose ps --format json") printf \'{"Service":"api","Health":"healthy"}\\n{"Service":"web","Health":"healthy"}\\n\' ;;',
      '    "compose logs api") printf "no bootstrap needed\\n" ;;',
      '  esac',
      '  return 0',
      '}',
      'noodara_main',
    ].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, {
      env: { ...env, NOODARA_TEST_CALL_LOG: callLog },
    });

    expect(result.status).toBe(0);
    const afterChecksum = createHash('sha256').update(readFileSync(join(installDir, '.env'))).digest('hex');
    expect(afterChecksum).toBe(beforeChecksum);
    const entries: string[] = readdirSync(installDir);
    expect(entries.some((name) => name.startsWith('.env.bak-'))).toBe(false);
    const calls = existsSync(callLog) ? readFileSync(callLog, 'utf8') : '';
    expect(calls).not.toMatch(/compose pull\b/);
    expect(calls).not.toMatch(/compose up -d\b/);
    // Health check + summary still ran.
    expect(calls).toMatch(/compose ps --format json/);
    expect(result.stdout).toContain('Noodara is running');

    // hard_rule #8 canary extension: no secret leaks anywhere on this re-run path either.
    const installLogPath = join(installDir, 'install.log');
    const logContent = existsSync(installLogPath) ? readFileSync(installLogPath, 'utf8') : '';
    for (const secret of [before.NOODARA_MASTER_KEY, before.POSTGRES_PASSWORD, before.REDIS_PASSWORD, before.BETTER_AUTH_SECRET]) {
      expect(calls).not.toContain(secret);
      expect(logContent).not.toContain(secret);
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
    }
  });

  it('a same-version re-run still merges (one backup, no full no-op) when a required key is missing from .env', () => {
    const { snippet, env, installDir } = buildMainFlowEnv({ NOODARA_VERSION: '1.0.0' });
    mkdirSync(installDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(installDir, '.env'),
      [
        'NOODARA_VERSION=1.0.0',
        'NOODARA_PREVIOUS_VERSION=1.0.0',
        'NOODARA_IMAGE_PREFIX=ghcr.io/example',
        'NOODARA_PORT=3000',
        // NOODARA_PUBLIC_URL deliberately absent -- simulates a release-added required key.
        'NOODARA_MASTER_KEY=dGVzdC1tYXN0ZXIta2V5LTMyLWJ5dGVzLWV4YWN0bHkhIQ==',
        'BETTER_AUTH_SECRET=abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567',
        'POSTGRES_USER=noodara',
        'POSTGRES_PASSWORD=abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567',
        'POSTGRES_DB=noodara',
        'REDIS_PASSWORD=abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567',
        'DATABASE_URL=postgresql://noodara:x@postgres:5432/noodara',
        'REDIS_URL=redis://:x@redis:6379',
        'PORT=3000',
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(join(installDir, '.env'), 0o600);
    const callLog = join(installDir, 'docker-calls.log');
    const fullSnippet = [
      snippet,
      'docker() {',
      '  printf "%s\\n" "docker $*" >> "$NOODARA_TEST_CALL_LOG"',
      '  case "$*" in',
      '    "compose ps --format json") printf \'{"Service":"api","Health":"healthy"}\\n{"Service":"web","Health":"healthy"}\\n\' ;;',
      '    "compose logs api") printf "no bootstrap needed\\n" ;;',
      '  esac',
      '  return 0',
      '}',
      'noodara_main',
    ].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, {
      env: { ...env, NOODARA_TEST_CALL_LOG: callLog },
    });

    expect(result.status).toBe(0);
    const after = parseEnvFile(join(installDir, '.env'));
    expect(after.NOODARA_PUBLIC_URL).toBe('http://198.51.100.7:3000');
    const entries: string[] = readdirSync(installDir);
    expect(entries.some((name) => name.startsWith('.env.bak-'))).toBe(true);
    const calls = readFileSync(callLog, 'utf8');
    expect(calls).toMatch(/compose pull\b/);
    expect(calls).toMatch(/compose up -d\b/);
  });

  // Post-execution fix (orchestrator audit Finding E, 06-09 follow-up): a no-op *candidate*
  // (same version, every merge key present) whose stack is not actually healthy -- a half-finished
  // first install (pull/up never succeeded) or a manually stopped stack -- must repair itself
  // (pull + up + the real bounded wait), never poll for up to 5 minutes against containers that
  // were never started and then give up.
  it('same version, keys present, healthy on the first read: no pull, no up -d (Finding E test 1)', () => {
    const { snippet, env, installDir } = buildMainFlowEnv({ NOODARA_VERSION: '1.0.0' });
    seedExistingInstall(installDir, '1.0.0', { NOODARA_PREVIOUS_VERSION: '0.9.0' });
    const beforeChecksum = createHash('sha256').update(readFileSync(join(installDir, '.env'))).digest('hex');
    const callLog = join(installDir, 'docker-calls.log');
    const fullSnippet = [
      snippet,
      'docker() {',
      '  printf "%s\\n" "docker $*" >> "$NOODARA_TEST_CALL_LOG"',
      '  case "$*" in',
      '    "compose ps --format json") printf \'{"Service":"api","Health":"healthy"}\\n{"Service":"web","Health":"healthy"}\\n\' ;;',
      '    "compose logs api") printf "no bootstrap needed\\n" ;;',
      '  esac',
      '  return 0',
      '}',
      'noodara_main',
    ].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, {
      env: { ...env, NOODARA_TEST_CALL_LOG: callLog },
    });

    expect(result.status).toBe(0);
    const afterChecksum = createHash('sha256').update(readFileSync(join(installDir, '.env'))).digest('hex');
    expect(afterChecksum).toBe(beforeChecksum);
    expect(readdirSync(installDir).some((name) => name.startsWith('.env.bak-'))).toBe(false);
    const calls = readFileSync(callLog, 'utf8');
    expect(calls).not.toMatch(/compose pull\b/);
    expect(calls).not.toMatch(/compose up -d\b/);
    // A single health read only (one `docker compose ps --format json` call per service, api and
    // web) -- never a polling loop that reads again after a sleep.
    expect(calls.match(/compose ps --format json/g)?.length ?? 0).toBe(2);
  });

  it('same version, keys present, NOT healthy on the first read (half-finished first install): pulls and starts the stack, .env stays untouched (Finding E test 2)', () => {
    const { snippet, env, installDir } = buildMainFlowEnv({ NOODARA_VERSION: '1.0.0' });
    seedExistingInstall(installDir, '1.0.0', { NOODARA_PREVIOUS_VERSION: '1.0.0' });
    const before = parseEnvFile(join(installDir, '.env'));
    const beforeChecksum = createHash('sha256').update(readFileSync(join(installDir, '.env'))).digest('hex');
    const callLog = join(installDir, 'docker-calls.log');
    const fullSnippet = [
      snippet,
      'docker() {',
      '  printf "%s\\n" "docker $*" >> "$NOODARA_TEST_CALL_LOG"',
      '  case "$*" in',
      // No containers at all on the first read (the prior compose up -d never ran/succeeded) --
      // healthy only after `up -d` has itself been recorded in the call log.
      '    "compose ps --format json")',
      '      if grep -q "compose up -d" "$NOODARA_TEST_CALL_LOG" 2>/dev/null; then',
      '        printf \'{"Service":"api","Health":"healthy"}\\n{"Service":"web","Health":"healthy"}\\n\'',
      '      fi',
      '      ;;',
      `    "compose logs api") printf 'NOODARA_SETUP_TOKEN=${VALID_TOKEN}\\n' ;;`,
      '    "compose exec -T api node -e"*) printf "missing\\n" ;;',
      '  esac',
      '  return 0',
      '}',
      'noodara_main',
    ].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, {
      env: { ...env, NOODARA_TEST_CALL_LOG: callLog },
    });

    expect(result.status).toBe(0);
    const afterChecksum = createHash('sha256').update(readFileSync(join(installDir, '.env'))).digest('hex');
    expect(afterChecksum).toBe(beforeChecksum);
    expect(readdirSync(installDir).some((name) => name.startsWith('.env.bak-'))).toBe(false);
    const calls = readFileSync(callLog, 'utf8');
    expect(calls).toMatch(/compose pull\b/);
    expect(calls).toMatch(/compose up -d\b/);
    // pull and up -d both happened strictly after the single, initial health read.
    const firstPsIndex = calls.indexOf('compose ps --format json');
    const pullIndex = calls.indexOf('compose pull');
    const upIndex = calls.indexOf('compose up -d');
    expect(firstPsIndex).toBeGreaterThanOrEqual(0);
    expect(pullIndex).toBeGreaterThan(firstPsIndex);
    expect(upIndex).toBeGreaterThan(pullIndex);
    expect(result.stdout).toContain('The stack is not healthy; starting it.');
    expect(result.stdout).toContain(VALID_TOKEN);

    // hard_rule #8 canary extension: no secret leaks on this repair path either.
    const installLogPath = join(installDir, 'install.log');
    const logContent = existsSync(installLogPath) ? readFileSync(installLogPath, 'utf8') : '';
    for (const secret of [before.NOODARA_MASTER_KEY, before.POSTGRES_PASSWORD, before.REDIS_PASSWORD, before.BETTER_AUTH_SECRET]) {
      expect(calls).not.toContain(secret);
      expect(logContent).not.toContain(secret);
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
    }
  });

  it('same version, keys present, the stack never becomes healthy: exits 53 with a redacted tail, and never claims an upgrade happened (Finding E test 3)', () => {
    const { snippet, env, installDir } = buildMainFlowEnv({
      NOODARA_VERSION: '1.0.0',
      NOODARA_HEALTH_WAIT_ATTEMPTS: '2',
      NOODARA_HEALTH_WAIT_INTERVAL: '0',
    });
    seedExistingInstall(installDir, '1.0.0', { NOODARA_PREVIOUS_VERSION: '0.9.0' });
    const callLog = join(installDir, 'docker-calls.log');
    const fullSnippet = [
      snippet,
      'docker() {',
      '  printf "%s\\n" "docker $*" >> "$NOODARA_TEST_CALL_LOG"',
      '  case "$*" in',
      '    "compose ps --format json") printf \'{"Service":"api","Health":"unhealthy"}\\n{"Service":"web","Health":"unhealthy"}\\n\' ;;',
      '    "compose logs --tail 50 api") printf "api never came up: NOODARA_SETUP_TOKEN=%s postgresql://noodara:leaked@postgres:5432/noodara\\n" "' + VALID_TOKEN + '" ;;',
      '  esac',
      '  return 0',
      '}',
      'noodara_main',
    ].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, {
      env: { ...env, NOODARA_TEST_CALL_LOG: callLog },
    });

    expect(result.status).toBe(53);
    expect(result.stderr).toContain('api');
    expect(result.stderr).toContain('[REDACTED]');
    expect(result.stderr).not.toContain(VALID_TOKEN);
    expect(result.stderr).not.toContain('leaked');
    // Finding E: no version change happened on this repair path -- the rollback hint must not
    // claim an upgrade took place.
    expect(result.stderr).not.toContain('NOODARA_VERSION=0.9.0');
    expect(result.stderr).not.toMatch(/re-run this installer with NOODARA_VERSION=/);
    const calls = readFileSync(callLog, 'utf8');
    expect(calls).not.toMatch(/compose (down|rm)\b/);
    expect(calls).not.toMatch(/volume rm/);
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

// 06-09-PLAN.md Task 3: setup token, ufw advisory, final summary and install.log.
const VALID_TOKEN = 'abcDEFghij0123456789_-ABCDEFGHIJ';

describe.each(posixInterpreters())('install.sh noodara_read_setup_token (%s)', (interpreter) => {
  it('extracts the value after the last NOODARA_SETUP_TOKEN= occurrence', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-token-'));
    const snippet = [
      `docker() { case "$*" in "compose logs api") printf 'noise\\nNOODARA_SETUP_TOKEN=stale-one\\nmore noise\\nNOODARA_SETUP_TOKEN=${VALID_TOKEN}\\n'; return 0 ;; esac; return 0; }`,
      'noodara_read_setup_token',
    ].join('\n');

    const result = runInstallerShell(interpreter, snippet, { env: { NOODARA_INSTALL_DIR: installDir } });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(VALID_TOKEN);
  });

  it('returns non-zero and prints nothing when no token line exists (admin already exists)', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-token-'));
    const snippet = [
      'docker() { case "$*" in "compose logs api") printf "ordinary boot log, no admin bootstrap needed\\n"; return 0 ;; esac; return 0; }',
      'noodara_read_setup_token',
    ].join('\n');

    const result = runInstallerShell(interpreter, snippet, { env: { NOODARA_INSTALL_DIR: installDir } });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  });

  it('rejects a log line corrupted by non-token characters rather than echoing it raw', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-token-'));
    const snippet = [
      // An embedded terminal escape / space makes the "token" fail the charset check.
      'docker() { case "$*" in "compose logs api") printf "NOODARA_SETUP_TOKEN=junk with spaces and \\033[31mcolor\\n"; return 0 ;; esac; return 0; }',
      'noodara_read_setup_token',
    ].join('\n');

    const result = runInstallerShell(interpreter, snippet, { env: { NOODARA_INSTALL_DIR: installDir } });

    expect(result.status).not.toBe(0);
  });
});

describe.each(posixInterpreters())('install.sh noodara_check_ufw (%s)', (interpreter) => {
  it('reports nothing when ufw is absent', () => {
    // No command()/ufw() shadow at all -- relies on the real `command -v ufw` genuinely failing
    // on the machine running this test (true for every CI/dev environment this repo targets: ufw
    // is a Linux-only tool). PATH is additionally restricted to be certain.
    const result = runInstallerShell(interpreter, 'noodara_check_ufw', {
      env: { PATH: '/usr/bin:/bin' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('reports nothing when ufw is present but inactive', () => {
    const snippet = ['ufw() { printf "Status: inactive\\n"; return 0; }', 'noodara_check_ufw'].join('\n');

    const result = runInstallerShell(interpreter, snippet);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('prints the exact advisory wording, the allow command and the cloud-firewall reminder when active', () => {
    const snippet = ['ufw() { printf "Status: active\\n"; return 0; }', 'noodara_check_ufw'].join('\n');

    const result = runInstallerShell(interpreter, snippet, { env: { NOODARA_PORT: '3000' } });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('typically bypass');
    expect(result.stdout).toContain('sudo ufw allow 3000/tcp');
    expect(result.stdout.toLowerCase()).toContain('cloud provider');
  });

  it('never invokes a mutating ufw subcommand', () => {
    const callLog = join(mkdtempSync(join(tmpdir(), 'noodara-ufw-')), 'calls.log');
    const snippet = [
      'ufw() { printf "%s\\n" "ufw $*" >> "$NOODARA_TEST_CALL_LOG"; printf "Status: active\\n"; return 0; }',
      'noodara_check_ufw',
    ].join('\n');

    runInstallerShell(interpreter, snippet, { env: { NOODARA_TEST_CALL_LOG: callLog } });

    const calls = readFileSync(callLog, 'utf8');
    expect(calls).not.toMatch(/ufw (allow|enable|deny|delete|reset)\b/);
    expect(calls).toContain('ufw status');
  });
});

describe.each(posixInterpreters())('install.sh noodara_redact_diagnostic_text (%s)', (interpreter) => {
  it('redacts a setup-token line', () => {
    const result = runInstallerShell(
      interpreter,
      `printf 'before\\nNOODARA_SETUP_TOKEN=${VALID_TOKEN}\\nafter\\n' | noodara_redact_diagnostic_text`,
    );

    expect(result.stdout).not.toContain(VALID_TOKEN);
    expect(result.stdout).toContain('NOODARA_SETUP_TOKEN=[REDACTED]');
  });

  it('redacts a userinfo-bearing connection-string-shaped URL', () => {
    const result = runInstallerShell(
      interpreter,
      "printf 'connecting to postgresql://noodara:s3cr3tpass@postgres:5432/noodara\\n' | noodara_redact_diagnostic_text",
    );

    expect(result.stdout).not.toContain('s3cr3tpass');
    expect(result.stdout).toContain('postgresql://[REDACTED]@postgres:5432/noodara');
  });
});

describe('install.sh Task 3 function names', () => {
  it('contains noodara_read_setup_token, noodara_check_ufw, noodara_write_log and noodara_print_summary', () => {
    const source = readFileSync(INSTALL_SH, 'utf8');

    expect(source).toContain('noodara_read_setup_token');
    expect(source).toContain('noodara_check_ufw');
    expect(source).toContain('noodara_write_log');
    expect(source).toContain('noodara_print_summary');
  });
});

describe.each(posixInterpreters())('install.sh noodara_print_summary (%s)', (interpreter) => {
  it('prints the panel URL and the token on a fresh install with no admin pre-seed', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-summary-'));
    const snippet = [
      `docker() { case "$*" in "compose logs api") printf 'NOODARA_SETUP_TOKEN=${VALID_TOKEN}\\n'; return 0 ;; esac; return 0; }`,
      `ufw() { return 1; }`,
      'noodara_print_summary "https://panel.example.com" "/nonexistent/.env" "1.0.0"',
    ].join('\n');

    const result = runInstallerShell(interpreter, snippet, { env: { NOODARA_INSTALL_DIR: installDir } });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('https://panel.example.com');
    expect(result.stdout).toContain(VALID_TOKEN);
  });

  it('prints the URL and an admin-exists line, never a token field, on a re-run with an existing admin', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-summary-'));
    const snippet = [
      'docker() { case "$*" in "compose logs api") printf "ordinary boot, no bootstrap needed\\n"; return 0 ;; esac; return 0; }',
      'noodara_print_summary "https://panel.example.com" "/nonexistent/.env" "1.0.0"',
    ].join('\n');

    const result = runInstallerShell(interpreter, snippet, { env: { NOODARA_INSTALL_DIR: installDir } });

    expect(result.status).toBe(0);
    expect(result.stdout.toLowerCase()).toContain('already exists');
    expect(result.stdout).not.toContain('setup token');
    expect(result.stdout).not.toMatch(/token:\s*\(none\)/i);
  });

  it('prints neither a token nor the admin email/password when NOODARA_ADMIN_EMAIL/PASSWORD are supplied (INST-05)', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-summary-'));
    const snippet = [
      // Fails loudly if ever invoked -- proves the token path is genuinely skipped.
      'docker() { exit 98; }',
      'noodara_print_summary "https://panel.example.com" "/nonexistent/.env" "1.0.0"',
    ].join('\n');

    const result = runInstallerShell(interpreter, snippet, {
      env: {
        NOODARA_INSTALL_DIR: installDir,
        NOODARA_ADMIN_EMAIL: 'admin@example.com',
        NOODARA_ADMIN_PASSWORD: 'a-tricky-p@ssw0rd',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('admin@example.com');
    expect(result.stdout).not.toContain('a-tricky-p@ssw0rd');
    expect(result.stdout.toLowerCase()).toContain('created from the supplied');
  });

  it('includes the unencrypted-traffic warning for an http:// URL and omits it for https://', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-summary-'));
    const snippet = [
      'docker() { case "$*" in "compose logs api") printf "no bootstrap needed\\n"; return 0 ;; esac; return 0; }',
      'noodara_print_summary "$1" "/nonexistent/.env" "1.0.0"',
    ].join('\n');

    const httpResult = runInstallerShell(interpreter, `set -- "http://198.51.100.7:3000"\n${snippet}`, {
      env: { NOODARA_INSTALL_DIR: installDir },
    });
    const httpsResult = runInstallerShell(interpreter, `set -- "https://panel.example.com"\n${snippet}`, {
      env: { NOODARA_INSTALL_DIR: installDir },
    });

    expect(httpResult.stdout.toUpperCase()).toContain('WARNING');
    expect(httpResult.stdout.toLowerCase()).toContain('unencrypted');
    expect(httpsResult.stdout.toUpperCase()).not.toContain('WARNING');
  });

  it('names the upgrade rollback hint only when the version genuinely changed', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-summary-'));
    const envPath = join(installDir, '.env');
    writeFileSync(envPath, 'NOODARA_VERSION=2.0.0\nNOODARA_PREVIOUS_VERSION=1.0.0\n', 'utf8');
    const snippet = [
      'docker() { case "$*" in "compose logs api") printf "no bootstrap needed\\n"; return 0 ;; esac; return 0; }',
      `noodara_print_summary "https://panel.example.com" "${envPath}" "2.0.0"`,
    ].join('\n');

    const result = runInstallerShell(interpreter, snippet, { env: { NOODARA_INSTALL_DIR: installDir } });

    expect(result.stdout).toContain('NOODARA_VERSION=1.0.0');
  });

  it('omits the upgrade rollback hint on a same-version, no-op re-run', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'noodara-summary-'));
    const envPath = join(installDir, '.env');
    writeFileSync(envPath, 'NOODARA_VERSION=1.0.0\nNOODARA_PREVIOUS_VERSION=1.0.0\n', 'utf8');
    const snippet = [
      'docker() { case "$*" in "compose logs api") printf "no bootstrap needed\\n"; return 0 ;; esac; return 0; }',
      `noodara_print_summary "https://panel.example.com" "${envPath}" "1.0.0"`,
    ].join('\n');

    const result = runInstallerShell(interpreter, snippet, { env: { NOODARA_INSTALL_DIR: installDir } });

    expect(result.stdout).not.toContain('Upgraded from');
  });
});

describe.each(posixInterpreters())('install.sh full noodara_main flow (%s)', (interpreter) => {
  it('fresh install: prints the token, writes install.log with step names only, secrets appear nowhere but .env (canary)', () => {
    const { snippet, env, installDir } = buildMainFlowEnv();
    const fullSnippet = [snippet, 'noodara_main'].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, { env });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(VALID_TOKEN);
    // The token must appear exactly once across the whole combined stdout+stderr capture.
    const combined = result.stdout + result.stderr;
    expect(combined.split(VALID_TOKEN).length - 1).toBe(1);
    expect(result.stderr).not.toContain(VALID_TOKEN);

    const writtenEnv = parseEnvFile(join(installDir, '.env'));
    const generatedSecrets: string[] = [
      writtenEnv.NOODARA_MASTER_KEY,
      writtenEnv.BETTER_AUTH_SECRET,
      writtenEnv.POSTGRES_PASSWORD,
      writtenEnv.REDIS_PASSWORD,
    ].filter((value): value is string => value !== undefined);
    expect(generatedSecrets).toHaveLength(4);

    const installLogPath = join(installDir, 'install.log');
    expect(existsSync(installLogPath)).toBe(true);
    const logContent = readFileSync(installLogPath, 'utf8');
    expect(statSync(installLogPath).mode & 0o777).toBe(0o600);

    for (const secret of generatedSecrets) {
      expect(secret.length).toBeGreaterThan(0);
      expect(logContent).not.toContain(secret);
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
    }
    expect(logContent).not.toContain(VALID_TOKEN);

    // Every non-.env, non-backup file under the install dir must be free of every canary/secret.
    for (const entry of readdirSync(installDir)) {
      if (entry === '.env' || entry.startsWith('.env.bak-')) continue;
      const full = join(installDir, entry);
      if (statSync(full).isDirectory()) continue;
      const content = readFileSync(full, 'utf8');
      expect(content).not.toContain(VALID_TOKEN);
      for (const secret of generatedSecrets) {
        expect(content).not.toContain(secret);
      }
    }
  });

  it('re-run with an existing admin: prints the URL and an admin-exists line, no token', () => {
    const { snippet, env, installDir } = buildMainFlowEnv({ NOODARA_VERSION: '1.1.0' });
    seedExistingInstall(installDir, '1.0.0');
    const fullSnippet = [
      snippet,
      // No token line in the api logs on this run -- an admin already exists.
      'docker() { case "$*" in "compose ps --format json") printf \'{"Service":"api","Health":"healthy"}\\n{"Service":"web","Health":"healthy"}\\n\' ;; "compose logs api") printf "no bootstrap needed\\n" ;; esac; return 0; }',
      'noodara_main',
    ].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, { env });

    expect(result.status).toBe(0);
    expect(result.stdout.toLowerCase()).toContain('already exists');
    expect(result.stdout).not.toContain('NOODARA_SETUP_TOKEN');
  });

  // Post-execution fix (orchestrator audit Finding D): a reliable "does an admin already exist"
  // signal (the existing POST /api/setup route, probed via `docker compose exec -T api node -e`)
  // must override a stale NOODARA_SETUP_TOKEN= line still sitting in the api container's own log
  // history from an earlier boot -- bootstrapAdmin only re-emits that line at boot time, so it
  // never disappears on its own once an admin is created without the container restarting.
  it('re-run with an existing admin (probe-confirmed): never prints a stale token line still present in the logs', () => {
    const { snippet, env, installDir } = buildMainFlowEnv({ NOODARA_VERSION: '1.1.0' });
    seedExistingInstall(installDir, '1.0.0');
    const fullSnippet = [
      snippet,
      'docker() {',
      '  case "$*" in',
      '    "compose ps --format json") printf \'{"Service":"api","Health":"healthy"}\\n{"Service":"web","Health":"healthy"}\\n\' ;;',
      `    "compose logs api") printf 'NOODARA_SETUP_TOKEN=${VALID_TOKEN}\\n' ;;`,
      '    "compose exec -T api node -e"*) printf "exists\\n" ;;',
      '  esac',
      '  return 0',
      '}',
      'noodara_main',
    ].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, { env });

    expect(result.status).toBe(0);
    expect(result.stdout.toLowerCase()).toContain('already exists');
    expect(result.stdout).not.toContain('NOODARA_SETUP_TOKEN');
    expect(result.stdout).not.toContain(VALID_TOKEN);
    expect(result.stderr).not.toContain(VALID_TOKEN);
  });

  it('re-run of a half-finished first install (no admin yet, probe-confirmed missing): still prints the token', () => {
    const { snippet, env, installDir } = buildMainFlowEnv({ NOODARA_VERSION: '1.1.0' });
    seedExistingInstall(installDir, '1.0.0');
    const before = parseEnvFile(join(installDir, '.env'));
    const fullSnippet = [
      snippet,
      'docker() {',
      '  case "$*" in',
      '    "compose ps --format json") printf \'{"Service":"api","Health":"healthy"}\\n{"Service":"web","Health":"healthy"}\\n\' ;;',
      `    "compose logs api") printf 'NOODARA_SETUP_TOKEN=${VALID_TOKEN}\\n' ;;`,
      '    "compose exec -T api node -e"*) printf "missing\\n" ;;',
      '  esac',
      '  return 0',
      '}',
      'noodara_main',
    ].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, { env });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(VALID_TOKEN);
    expect(result.stdout).not.toContain('already exists');

    // hard_rule #8 canary extension: the setup token itself is the one deliberate exception
    // (INST-04's own contract); every generated secret must still never leak on this path.
    const installLogPath = join(installDir, 'install.log');
    const logContent = existsSync(installLogPath) ? readFileSync(installLogPath, 'utf8') : '';
    for (const secret of [before.NOODARA_MASTER_KEY, before.POSTGRES_PASSWORD, before.REDIS_PASSWORD, before.BETTER_AUTH_SECRET]) {
      expect(logContent).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
    }
  });

  it('the admin-exists probe never appears on any docker argv with a secret, and is itself redacted-safe', () => {
    const { snippet, env, installDir } = buildMainFlowEnv({ NOODARA_VERSION: '1.1.0' });
    seedExistingInstall(installDir, '1.0.0');
    const callLog = join(installDir, 'docker-calls.log');
    const before = parseEnvFile(join(installDir, '.env'));
    const fullSnippet = [
      snippet,
      'docker() {',
      '  printf "%s\\n" "docker $*" >> "$NOODARA_TEST_CALL_LOG"',
      '  case "$*" in',
      '    "compose ps --format json") printf \'{"Service":"api","Health":"healthy"}\\n{"Service":"web","Health":"healthy"}\\n\' ;;',
      '    "compose logs api") printf "no bootstrap needed\\n" ;;',
      '    "compose exec -T api node -e"*) printf "exists\\n" ;;',
      '  esac',
      '  return 0',
      '}',
      'noodara_main',
    ].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, {
      env: { ...env, NOODARA_TEST_CALL_LOG: callLog },
    });

    expect(result.status).toBe(0);
    const calls = readFileSync(callLog, 'utf8');
    for (const secret of [before.NOODARA_MASTER_KEY, before.POSTGRES_PASSWORD, before.REDIS_PASSWORD, before.BETTER_AUTH_SECRET]) {
      expect(calls).not.toContain(secret);
    }
    expect(result.stdout).not.toContain(before.NOODARA_MASTER_KEY);
    expect(result.stderr).not.toContain(before.NOODARA_MASTER_KEY);
  });

  it('D-12: a failed health check exits non-zero, names the unhealthy service, shows a redacted log tail, states the rollback remedy, and never runs a destructive command', () => {
    const { snippet, env, installDir } = buildMainFlowEnv({
      NOODARA_VERSION: '2.0.0',
      NOODARA_HEALTH_WAIT_ATTEMPTS: '1',
    });
    mkdirSync(installDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(installDir, '.env'),
      [
        'NOODARA_VERSION=1.0.0',
        'NOODARA_PREVIOUS_VERSION=1.0.0',
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
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(join(installDir, '.env'), 0o600);
    const callLog = join(installDir, 'docker-calls.log');
    const fullSnippet = [
      snippet,
      'docker() {',
      '  printf "%s\\n" "docker $*" >> "$NOODARA_TEST_CALL_LOG"',
      '  case "$*" in',
      '    "compose ps --format json") printf \'{"Service":"api","Health":"healthy"}\\n{"Service":"web","Health":"unhealthy"}\\n\' ;;',
      `    "compose logs --tail 50 web") printf 'web crashed: NOODARA_SETUP_TOKEN=${VALID_TOKEN} postgresql://noodara:leaked@postgres:5432/noodara\\n' ;;`,
      '  esac',
      '  return 0',
      '}',
      'noodara_main',
    ].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, {
      env: { ...env, NOODARA_TEST_CALL_LOG: callLog },
    });

    expect(result.status).toBe(53);
    expect(result.stderr).toContain('web');
    expect(result.stderr).toContain('NOODARA_VERSION=1.0.0');
    // The diagnostic tail is redacted before it ever reaches stderr.
    expect(result.stderr).not.toContain(VALID_TOKEN);
    expect(result.stderr).not.toContain('leaked');
    expect(result.stderr).toContain('[REDACTED]');
    // D-12: never an automatic rollback or destructive command; .env and volumes untouched.
    expect(existsSync(join(installDir, '.env'))).toBe(true);
    const calls = readFileSync(callLog, 'utf8');
    expect(calls).not.toMatch(/compose (down|rm)\b/);
    expect(calls).not.toMatch(/volume rm/);
  });
});
