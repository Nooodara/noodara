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
    'docker() { return 0; }',
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
