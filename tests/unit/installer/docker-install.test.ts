// 06-08-PLAN.md: install.sh's Docker Engine + Compose plugin installation (06-CONTEXT.md D-14,
// INST-01). Exercised under every available real POSIX interpreter (/bin/sh, plus dash when
// present), never bash (06-RESEARCH.md Pitfall 1), mirroring preflight.test.ts's and
// resolution.test.ts's own conventions.
//
// hard_rule #8: no test here ever performs a real network call, a real apt-get/dpkg/gpg/install/
// chmod/systemctl invocation, or a write outside a mkdtemp directory. `docker`, `dpkg`, `install`,
// `chmod` and `noodara_fetch_url` are all shadowed as shell functions after sourcing install.sh.
// `apt-get` cannot be shadowed the same way -- POSIX shell function names cannot contain a hyphen
// (confirmed empirically against real dash: `apt-get() { :; }` raises "Syntax error: Bad function
// name") -- so it is shadowed instead by a real executable stub file prepended onto PATH, the only
// portable way to override a hyphenated command name. Every filesystem target these functions
// write to (the keyring directory, the sources-list file) is redirected into a fresh mkdtemp
// directory via NOODARA_DOCKER_KEYRING_DIR / NOODARA_DOCKER_SOURCES_FILE, never a real /etc path.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INSTALL_SH, posixInterpreters, runInstallerShell } from './sh-harness.js';

/** Writes a real executable file named `name` into `dir` -- the only reliable way to shadow a
 *  hyphenated command like `apt-get` (see file header). */
function writeCommandStub(dir: string, name: string, script: string): void {
  const filePath = join(dir, name);
  writeFileSync(filePath, `#!/bin/sh\n${script}\n`, 'utf8');
  chmodSync(filePath, 0o755);
}

/** A valid Ubuntu 22.04 os-release fixture including VERSION_CODENAME -- preflight.test.ts's own
 *  writeOsReleaseFixture helper does not write VERSION_CODENAME, which noodara_docker_write_sources_list
 *  needs. */
function writeOsReleaseFixture(dir: string, codename: string): string {
  const file = join(dir, 'os-release');
  writeFileSync(file, `ID=ubuntu\nVERSION_ID="22.04"\nVERSION_CODENAME=${codename}\n`, 'utf8');
  return file;
}

function withPath(stubDir: string, extraEnv: Record<string, string> = {}): Record<string, string> {
  return { PATH: `${stubDir}:${process.env.PATH ?? ''}`, ...extraEnv };
}

/** A complete, forward-compatible environment for exercising noodara_ensure_docker's install
 *  paths: a real apt-get stub (records every invocation to NOODARA_TEST_CALL_LOG and, when the
 *  invocation's argv contains "docker-ce", touches NOODARA_TEST_SENTINEL to simulate Docker
 *  becoming genuinely present after the engine package installs), plus dpkg/install/chmod/
 *  noodara_fetch_url shadows and a valid Ubuntu 22.04 os-release fixture. Provided from Task 1
 *  onward so these tests remain green once Task 2 adds architecture/codename validation to the
 *  real sources-list step -- Task 1's own coarse implementation does not require all of this yet,
 *  but a forward-compatible fixture avoids every Task-1 test needing rewriting once Task 2 lands.
 */
function buildInstallEnv(): {
  snippet: string;
  env: Record<string, string>;
  logFile: string;
  sentinel: string;
} {
  const stubDir = mkdtempSync(join(tmpdir(), 'noodara-docker-install-stub-'));
  const fixturesDir = mkdtempSync(join(tmpdir(), 'noodara-docker-install-fixtures-'));
  const keyringDir = mkdtempSync(join(tmpdir(), 'noodara-docker-install-keyring-'));
  const sourcesDir = mkdtempSync(join(tmpdir(), 'noodara-docker-install-sources-'));
  const logFile = join(fixturesDir, 'calls.log');
  const sentinel = join(fixturesDir, 'docker-installed.sentinel');
  const osReleaseFile = writeOsReleaseFixture(fixturesDir, 'jammy');
  const sourcesFile = join(sourcesDir, 'docker.list');

  writeCommandStub(
    stubDir,
    'apt-get',
    [
      'printf "apt-get %s\\n" "$*" >> "$NOODARA_TEST_CALL_LOG"',
      // Simulates a real install taking effect: once the engine or the plugin package has been
      // "installed" (i.e. named in an install invocation this stub recorded), the sentinel file
      // flips docker()/docker-compose stubs in the tests below from absent to present.
      'case "$*" in',
      '  *install*docker-ce*) : > "$NOODARA_TEST_SENTINEL" ;;',
      '  *install*docker-compose-plugin*) : > "$NOODARA_TEST_SENTINEL" ;;',
      'esac',
      'exit 0',
    ].join('\n'),
  );

  const snippet = [
    'dpkg() { printf "amd64\\n"; }',
    'install() { printf "install %s\\n" "$*" >> "$NOODARA_TEST_CALL_LOG"; }',
    'chmod() { printf "chmod %s\\n" "$*" >> "$NOODARA_TEST_CALL_LOG"; }',
    'noodara_fetch_url() { printf "FAKE-GPG-KEY-BODY"; return 0; }',
  ].join('\n');

  return {
    snippet,
    env: withPath(stubDir, {
      NOODARA_TEST_CALL_LOG: logFile,
      NOODARA_TEST_SENTINEL: sentinel,
      NOODARA_OS_RELEASE_FILE: osReleaseFile,
      NOODARA_DOCKER_KEYRING_DIR: keyringDir,
      NOODARA_DOCKER_SOURCES_FILE: sourcesFile,
    }),
    logFile,
    sentinel,
  };
}

describe.each(posixInterpreters())('install.sh noodara_docker_present (%s)', (interpreter) => {
  it('returns 0 when `docker version` succeeds', () => {
    const snippet = ['docker() { [ "$1" = "version" ] && return 0; return 1; }', 'noodara_docker_present'].join(
      '\n',
    );

    const result = runInstallerShell(interpreter, snippet);

    expect(result.status).toBe(0);
  });

  it('returns non-zero when the docker command fails', () => {
    const snippet = ['docker() { return 1; }', 'noodara_docker_present'].join('\n');

    const result = runInstallerShell(interpreter, snippet);

    expect(result.status).not.toBe(0);
  });

  it('returns non-zero when the docker command is absent from PATH', () => {
    const result = runInstallerShell(interpreter, 'PATH=/nonexistent-noodara-test-path noodara_docker_present');

    expect(result.status).not.toBe(0);
  });

  it('discards docker version output -- nothing appears on stdout or stderr', () => {
    const snippet = [
      'docker() { printf "Docker version 27.0.0, build abc\\n"; return 0; }',
      'noodara_docker_present',
    ].join('\n');

    const result = runInstallerShell(interpreter, snippet);

    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
});

describe.each(posixInterpreters())('install.sh noodara_compose_present (%s)', (interpreter) => {
  it('returns 0 when `docker compose version` succeeds', () => {
    const snippet = [
      'docker() { if [ "$1" = "compose" ] && [ "$2" = "version" ]; then return 0; fi; return 1; }',
      'noodara_compose_present',
    ].join('\n');

    const result = runInstallerShell(interpreter, snippet);

    expect(result.status).toBe(0);
  });

  it('returns non-zero when the compose plugin subcommand fails', () => {
    const snippet = ['docker() { return 1; }', 'noodara_compose_present'].join('\n');

    const result = runInstallerShell(interpreter, snippet);

    expect(result.status).not.toBe(0);
  });

  it('checks the compose plugin subcommand, never a standalone docker-compose binary', () => {
    const source = readFileSync(INSTALL_SH, 'utf8');
    const fnStart = source.indexOf('noodara_compose_present() {');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart, source.indexOf('\n}\n', fnStart));

    expect(fnBody).toContain('docker compose version');
    expect(fnBody).not.toContain('docker-compose');
  });
});

describe('install.sh Docker install function names', () => {
  it('contains noodara_docker_present, noodara_compose_present and noodara_ensure_docker', () => {
    const source = readFileSync(INSTALL_SH, 'utf8');

    expect(source).toContain('noodara_docker_present');
    expect(source).toContain('noodara_compose_present');
    expect(source).toContain('noodara_ensure_docker');
  });
});

describe.each(posixInterpreters())('install.sh noodara_ensure_docker (%s)', (interpreter) => {
  it('performs zero apt-get calls when Docker and the Compose plugin are both already present', () => {
    const stubDir = mkdtempSync(join(tmpdir(), 'noodara-docker-install-'));
    writeCommandStub(stubDir, 'apt-get', 'printf "apt-get %s\\n" "$*" >> "$NOODARA_TEST_CALL_LOG"\nexit 0');
    const logFile = join(stubDir, 'calls.log');
    const snippet = ['docker() { return 0; }', 'noodara_ensure_docker'].join('\n');

    const result = runInstallerShell(interpreter, snippet, {
      env: withPath(stubDir, { NOODARA_TEST_CALL_LOG: logFile }),
    });

    expect(result.status).toBe(0);
    expect(existsSync(logFile)).toBe(false);
  });

  it('emits a note that Docker is already installed when both are present', () => {
    const snippet = ['docker() { return 0; }', 'noodara_ensure_docker'].join('\n');

    const result = runInstallerShell(interpreter, snippet);

    expect(result.status).toBe(0);
    expect(result.stdout.toLowerCase()).toContain('already installed');
  });

  it('installs only the Compose plugin when Docker is present but the plugin is missing', () => {
    const { snippet, env, logFile, sentinel } = buildInstallEnv();
    const fullSnippet = [
      snippet,
      // Docker itself is always present; `docker compose version` only starts succeeding once
      // the apt-get stub has recorded an install invocation naming the plugin package (the
      // sentinel file), simulating the real install taking effect.
      `docker() { if [ "$1" = "compose" ]; then [ -f "${sentinel}" ] && return 0; return 1; fi; return 0; }`,
      'noodara_ensure_docker',
    ].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, { env });

    expect(result.status).toBe(0);
    const calls = readFileSync(logFile, 'utf8');
    expect(calls).toContain('docker-compose-plugin');
    expect(calls).not.toContain('docker-ce ');
    expect(calls).not.toContain('docker-ce-cli');
  });

  it('fails with exit code 21 when the Compose plugin is still missing after installation', () => {
    const { snippet, env } = buildInstallEnv();
    const fullSnippet = [
      snippet,
      // Docker itself is present; `docker compose` never succeeds, even after the plugin
      // "install" (the apt-get stub is a no-op beyond logging, so this simulates the plugin
      // genuinely still being unusable afterward).
      'docker() { if [ "$1" = "compose" ]; then return 1; fi; return 0; }',
      'noodara_ensure_docker',
    ].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, { env });

    expect(result.status).toBe(21);
    expect(result.stderr.toLowerCase()).toContain('compose');
  });

  it('runs the full installation sequence when Docker is absent, and succeeds once it becomes present', () => {
    const { snippet, env, sentinel } = buildInstallEnv();
    const fullSnippet = [
      snippet,
      `docker() { if [ -f "${sentinel}" ]; then return 0; fi; return 1; }`,
      'noodara_ensure_docker',
    ].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, { env });

    expect(result.status).toBe(0);
  });

  it('fails with exit code 20 when Docker is still absent after the full installation sequence', () => {
    const { snippet, env } = buildInstallEnv();
    const fullSnippet = [snippet, 'docker() { return 1; }', 'noodara_ensure_docker'].join('\n');

    const result = runInstallerShell(interpreter, fullSnippet, { env });

    expect(result.status).toBe(20);
  });

  it('never calls apt-get with the standalone docker-compose binary as an install target', () => {
    const { snippet, env, logFile } = buildInstallEnv();
    const fullSnippet = [
      snippet,
      `docker() { if [ -f "${env.NOODARA_TEST_SENTINEL}" ]; then return 0; fi; return 1; }`,
      'noodara_ensure_docker',
    ].join('\n');

    runInstallerShell(interpreter, fullSnippet, { env });

    const calls = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    expect(calls).not.toMatch(/install[^\n]*\bdocker-compose\b(?!-)/);
  });
});

// 06-08-PLAN.md Task 2: the apt-repo installation sequence, one named step at a time -- exact
// literal external-command order, sources-list content (arch + codename pinned to
// signed-by=/etc/apt/keyrings/docker.asc), and per-step failure attribution.
describe.each(posixInterpreters())('install.sh noodara_install_docker step sequence (%s)', (interpreter) => {
  it(
    'runs remove -> update -> install prereqs -> create keyring dir -> download key -> chmod -> ' +
      'detect architecture -> update -> install engine, in exactly that order',
    () => {
      const stubDir = mkdtempSync(join(tmpdir(), 'noodara-docker-order-'));
      const fixturesDir = mkdtempSync(join(tmpdir(), 'noodara-docker-order-fixtures-'));
      const keyringDir = mkdtempSync(join(tmpdir(), 'noodara-docker-order-keyring-'));
      const sourcesDir = mkdtempSync(join(tmpdir(), 'noodara-docker-order-sources-'));
      const logFile = join(fixturesDir, 'calls.log');
      const osReleaseFile = writeOsReleaseFixture(fixturesDir, 'jammy');
      const sourcesFile = join(sourcesDir, 'docker.list');

      writeCommandStub(stubDir, 'apt-get', 'printf "apt-get %s\\n" "$*" >> "$NOODARA_TEST_CALL_LOG"\nexit 0');

      const snippet = [
        'dpkg() { printf "dpkg %s\\n" "$*" >> "$NOODARA_TEST_CALL_LOG"; printf "amd64\\n"; }',
        'install() { printf "install %s\\n" "$*" >> "$NOODARA_TEST_CALL_LOG"; }',
        'chmod() { printf "chmod %s\\n" "$*" >> "$NOODARA_TEST_CALL_LOG"; }',
        'noodara_fetch_url() { printf "fetch-url %s\\n" "$*" >> "$NOODARA_TEST_CALL_LOG"; printf "FAKE-GPG-KEY-BODY"; return 0; }',
        'noodara_install_docker',
      ].join('\n');

      const result = runInstallerShell(interpreter, snippet, {
        env: withPath(stubDir, {
          NOODARA_TEST_CALL_LOG: logFile,
          NOODARA_OS_RELEASE_FILE: osReleaseFile,
          NOODARA_DOCKER_KEYRING_DIR: keyringDir,
          NOODARA_DOCKER_SOURCES_FILE: sourcesFile,
        }),
      });

      expect(result.status).toBe(0);
      const calls = readFileSync(logFile, 'utf8').trim().split('\n');

      expect(calls).toHaveLength(9);
      expect(calls[0]).toMatch(/^apt-get .*remove.*docker\.io/);
      expect(calls[1]).toMatch(/^apt-get .*update/);
      expect(calls[1]).not.toContain('install');
      expect(calls[2]).toMatch(/^apt-get .*install.*ca-certificates.*curl.*gnupg/);
      expect(calls[3]).toMatch(/^install .*-d /);
      expect(calls[4]).toMatch(/^fetch-url body https:\/\/download\.docker\.com\/linux\/ubuntu\/gpg/);
      expect(calls[5]).toMatch(/^chmod .*a\+r/);
      expect(calls[6]).toMatch(/^dpkg .*--print-architecture/);
      expect(calls[7]).toMatch(/^apt-get .*update/);
      expect(calls[7]).not.toContain('install');
      expect(calls[8]).toMatch(
        /^apt-get .*install.*docker-ce\b.*docker-ce-cli.*containerd\.io.*docker-buildx-plugin.*docker-compose-plugin/,
      );
    },
  );

  it('does not fail the removal step when a conflicting package is simply not installed', () => {
    const stubDir = mkdtempSync(join(tmpdir(), 'noodara-docker-remove-'));
    writeCommandStub(stubDir, 'apt-get', 'exit 100');

    const result = runInstallerShell(interpreter, 'noodara_docker_remove_conflicting_packages', {
      env: withPath(stubDir),
    });

    expect(result.status).toBe(0);
  });
});

describe.each(posixInterpreters())('install.sh noodara_docker_write_sources_list (%s)', (interpreter) => {
  it('writes a sources line pinned to the real default keyring file, with arch and codename', () => {
    const fixturesDir = mkdtempSync(join(tmpdir(), 'noodara-docker-sources-'));
    const osReleaseFile = writeOsReleaseFixture(fixturesDir, 'jammy');
    const sourcesFile = join(fixturesDir, 'docker.list');

    // NOODARA_DOCKER_KEYRING_DIR is deliberately NOT overridden here -- 06-08-PLAN.md Task 2's own
    // acceptance criterion requires the generated line to contain the real default keyring path
    // (signed-by=/etc/apt/keyrings/docker.asc), so only the sources-list target itself is
    // redirected into a tmpdir (the plan's own documented pattern).
    const snippet = ['dpkg() { printf "amd64\\n"; }', 'noodara_docker_write_sources_list'].join('\n');

    const result = runInstallerShell(interpreter, snippet, {
      env: { NOODARA_OS_RELEASE_FILE: osReleaseFile, NOODARA_DOCKER_SOURCES_FILE: sourcesFile },
    });

    expect(result.status).toBe(0);
    const content = readFileSync(sourcesFile, 'utf8');
    expect(content).toContain('signed-by=/etc/apt/keyrings/docker.asc');
    expect(content).toContain('https://download.docker.com/linux/ubuntu');
    expect(content).toContain('arch=amd64');
    expect(content).toContain(' jammy ');
  });

  it('fails with exit code 20 when the architecture is not amd64 or arm64', () => {
    const fixturesDir = mkdtempSync(join(tmpdir(), 'noodara-docker-sources-'));
    const osReleaseFile = writeOsReleaseFixture(fixturesDir, 'jammy');
    const sourcesFile = join(fixturesDir, 'docker.list');
    const snippet = ['dpkg() { printf "riscv64\\n"; }', 'noodara_docker_write_sources_list'].join('\n');

    const result = runInstallerShell(interpreter, snippet, {
      env: { NOODARA_OS_RELEASE_FILE: osReleaseFile, NOODARA_DOCKER_SOURCES_FILE: sourcesFile },
    });

    expect(result.status).toBe(20);
    expect(existsSync(sourcesFile)).toBe(false);
  });

  it('fails with exit code 20 when the codename is not jammy or noble', () => {
    const fixturesDir = mkdtempSync(join(tmpdir(), 'noodara-docker-sources-'));
    const osReleaseFile = writeOsReleaseFixture(fixturesDir, 'focal');
    const sourcesFile = join(fixturesDir, 'docker.list');
    const snippet = ['dpkg() { printf "amd64\\n"; }', 'noodara_docker_write_sources_list'].join('\n');

    const result = runInstallerShell(interpreter, snippet, {
      env: { NOODARA_OS_RELEASE_FILE: osReleaseFile, NOODARA_DOCKER_SOURCES_FILE: sourcesFile },
    });

    expect(result.status).toBe(20);
    expect(existsSync(sourcesFile)).toBe(false);
  });
});

describe.each(posixInterpreters())('install.sh noodara_install_docker per-step failures (%s)', (interpreter) => {
  it('fails with exit code 20 naming the apt-get update step when it fails', () => {
    const stubDir = mkdtempSync(join(tmpdir(), 'noodara-docker-step-fail-'));
    writeCommandStub(stubDir, 'apt-get', 'exit 1');

    const result = runInstallerShell(interpreter, 'noodara_docker_apt_update', { env: withPath(stubDir) });

    expect(result.status).toBe(20);
    expect(result.stderr.toLowerCase()).toContain('apt-get update');
  });

  it('fails with exit code 20 naming the prerequisites install step when it fails', () => {
    const stubDir = mkdtempSync(join(tmpdir(), 'noodara-docker-step-fail-'));
    writeCommandStub(stubDir, 'apt-get', 'exit 1');

    const result = runInstallerShell(interpreter, 'noodara_docker_apt_install_prereqs', { env: withPath(stubDir) });

    expect(result.status).toBe(20);
    expect(result.stderr).toContain('ca-certificates');
  });

  it('fails with exit code 20 naming the GPG key download step when the response is empty', () => {
    const keyringDir = mkdtempSync(join(tmpdir(), 'noodara-docker-keyring-'));
    const snippet = ['noodara_fetch_url() { return 1; }', 'noodara_docker_download_gpg_key'].join('\n');

    const result = runInstallerShell(interpreter, snippet, { env: { NOODARA_DOCKER_KEYRING_DIR: keyringDir } });

    expect(result.status).toBe(20);
    expect(result.stderr.toLowerCase()).toContain('gpg key');
    expect(existsSync(join(keyringDir, 'docker.asc'))).toBe(false);
  });

  it('fails with exit code 20 naming the engine install step when it fails', () => {
    const stubDir = mkdtempSync(join(tmpdir(), 'noodara-docker-step-fail-'));
    writeCommandStub(stubDir, 'apt-get', 'exit 1');

    const result = runInstallerShell(interpreter, 'noodara_docker_apt_install_engine', { env: withPath(stubDir) });

    expect(result.status).toBe(20);
    expect(result.stderr).toContain('docker-ce');
  });
});

describe('install.sh Docker install structural checks (06-08-PLAN.md Task 2)', () => {
  it('never references a third-party curl-pipe-sh installer domain', () => {
    const source = readFileSync(INSTALL_SH, 'utf8');
    const count = (source.match(/get\.docker\.com/g) ?? []).length;

    expect(count).toBe(0);
  });

  it('every apt-get invocation is non-interactive (DEBIAN_FRONTEND appears)', () => {
    const source = readFileSync(INSTALL_SH, 'utf8');

    expect(source).toContain('DEBIAN_FRONTEND');
  });
});
