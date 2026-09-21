// 06-02-PLAN.md: install.sh's preflight predicates -- each a separate, injectable `sh` function
// with its own exit code and message (06-CONTEXT.md D-17), exercised under every available real
// POSIX interpreter (`/bin/sh`, plus `dash` when present), never `bash` (06-RESEARCH.md Pitfall 1).
//
// Every probe this file exercises (id, uname, /etc/os-release, /proc/meminfo, ss, df, snap) is
// injected via env var override or shell-function shadowing, never the host's real state
// (hard_rule #9) -- this file must pass identically on the macOS dev machine and on real Ubuntu CI.
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { posixInterpreters, runInstallerShell } from './sh-harness.js';

function writeOsReleaseFixture(dir: string, id: string, versionId: string): string {
  const file = join(dir, 'os-release');
  writeFileSync(file, `ID=${id}\nVERSION_ID="${versionId}"\n`, 'utf8');
  return file;
}

function writeMeminfoFixture(dir: string, totalKb: number): string {
  const file = join(dir, 'meminfo');
  writeFileSync(file, `MemTotal:       ${totalKb} kB\nMemFree:        102400 kB\n`, 'utf8');
  return file;
}

// `df -Pk` shape: header line + one data line, Available in column 4 (1024-blocks). Overriding
// `df` as a shell function is injectable regardless of the real host's disk state (hard_rule #9).
function dfFunctionSnippet(availableKb: number): string {
  return [
    'df() {',
    "  printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n'",
    `  printf '/dev/sda1 100000000 1000000 ${availableKb} 1%% /\\n'`,
    '}',
  ].join('\n');
}

// A fully-passing preflight environment (06-02-PLAN.md Task 3): root, all base commands, ubuntu
// 22.04, x86_64, ample RAM/disk, no snap Docker, a free port. `fixturesDir` holds the os-release
// and meminfo fixture files; `installDir` is the (normally empty) directory noodara_preflight
// must never write into -- kept separate so a test can assert installDir stays empty afterwards.
function buildPassingEnv(
  fixturesDir: string,
  installDir: string,
): { snippet: string; env: Record<string, string> } {
  const osReleaseFile = writeOsReleaseFixture(fixturesDir, 'ubuntu', '22.04');
  const meminfoFile = writeMeminfoFixture(fixturesDir, 4194304);
  const snippet = [
    "id() { printf '0\\n'; }",
    "uname() { printf 'x86_64\\n'; }",
    'command() { return 0; }',
    "ss() { printf 'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\\n'; }",
    dfFunctionSnippet(10485760),
    'snap() { return 1; }',
  ].join('\n');

  return {
    snippet,
    env: {
      NOODARA_OS_RELEASE_FILE: osReleaseFile,
      NOODARA_MEMINFO_FILE: meminfoFile,
      NOODARA_INSTALL_DIR: installDir,
    },
  };
}

describe.each(posixInterpreters())('install.sh preflight predicates (%s)', (interpreter) => {
  describe('noodara_check_root', () => {
    it('succeeds when id -u prints 0', () => {
      const result = runInstallerShell(interpreter, "id() { printf '0\\n'; }\nnoodara_check_root");

      expect(result.status).toBe(0);
    });

    it('fails with exit code 10 and a message naming sudo when id -u is non-zero', () => {
      const result = runInstallerShell(
        interpreter,
        "id() { printf '1000\\n'; }\nnoodara_check_root",
      );

      expect(result.status).toBe(10);
      expect(result.stderr).toContain('sudo');
    });
  });

  describe('noodara_check_base_commands', () => {
    it('succeeds when every required command is present', () => {
      const result = runInstallerShell(
        interpreter,
        'command() { return 0; }\nnoodara_check_base_commands',
      );

      expect(result.status).toBe(0);
    });

    it('fails with exit code 11 naming the first missing command', () => {
      const result = runInstallerShell(
        interpreter,
        [
          'command() {',
          '  if [ "$1" = "-v" ] && [ "$2" = "ss" ]; then',
          '    return 1',
          '  fi',
          '  return 0',
          '}',
          'noodara_check_base_commands',
        ].join('\n'),
      );

      expect(result.status).toBe(11);
      expect(result.stderr).toContain('ss');
    });
  });

  describe('noodara_detect_os_version', () => {
    it('reads NOODARA_OS_RELEASE_FILE and prints "<ID> <VERSION_ID>"', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-preflight-'));
      const osReleaseFile = writeOsReleaseFixture(dir, 'ubuntu', '22.04');

      const result = runInstallerShell(interpreter, 'noodara_detect_os_version', {
        env: { NOODARA_OS_RELEASE_FILE: osReleaseFile },
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('ubuntu 22.04');
    });
  });

  describe('noodara_check_os', () => {
    it('accepts ubuntu 22.04', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-preflight-'));
      const osReleaseFile = writeOsReleaseFixture(dir, 'ubuntu', '22.04');

      const result = runInstallerShell(interpreter, 'noodara_check_os', {
        env: { NOODARA_OS_RELEASE_FILE: osReleaseFile },
      });

      expect(result.status).toBe(0);
    });

    it('accepts ubuntu 24.04', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-preflight-'));
      const osReleaseFile = writeOsReleaseFixture(dir, 'ubuntu', '24.04');

      const result = runInstallerShell(interpreter, 'noodara_check_os', {
        env: { NOODARA_OS_RELEASE_FILE: osReleaseFile },
      });

      expect(result.status).toBe(0);
    });

    it('fails with exit code 12 for ubuntu 20.04, naming the detected value and supported versions', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-preflight-'));
      const osReleaseFile = writeOsReleaseFixture(dir, 'ubuntu', '20.04');

      const result = runInstallerShell(interpreter, 'noodara_check_os', {
        env: { NOODARA_OS_RELEASE_FILE: osReleaseFile },
      });

      expect(result.status).toBe(12);
      expect(result.stderr).toContain('20.04');
      expect(result.stderr).toContain('22.04');
      expect(result.stderr).toContain('24.04');
    });

    it('fails with exit code 12 for debian 12', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-preflight-'));
      const osReleaseFile = writeOsReleaseFixture(dir, 'debian', '12');

      const result = runInstallerShell(interpreter, 'noodara_check_os', {
        env: { NOODARA_OS_RELEASE_FILE: osReleaseFile },
      });

      expect(result.status).toBe(12);
      expect(result.stderr).toContain('debian');
    });

    it('fails with exit code 12 when the os-release file is missing', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-preflight-'));
      const missingFile = join(dir, 'does-not-exist');

      const result = runInstallerShell(interpreter, 'noodara_check_os', {
        env: { NOODARA_OS_RELEASE_FILE: missingFile },
      });

      expect(result.status).toBe(12);
      expect(result.stderr.length).toBeGreaterThan(0);
    });
  });

  describe('noodara_detect_arch', () => {
    it('maps x86_64 to amd64', () => {
      const result = runInstallerShell(
        interpreter,
        "uname() { printf 'x86_64\\n'; }\nnoodara_detect_arch",
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('amd64');
    });

    it('maps aarch64 to arm64', () => {
      const result = runInstallerShell(
        interpreter,
        "uname() { printf 'aarch64\\n'; }\nnoodara_detect_arch",
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('arm64');
    });

    it('maps arm64 to arm64', () => {
      const result = runInstallerShell(
        interpreter,
        "uname() { printf 'arm64\\n'; }\nnoodara_detect_arch",
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('arm64');
    });
  });

  describe('noodara_check_arch', () => {
    it('succeeds for x86_64', () => {
      const result = runInstallerShell(
        interpreter,
        "uname() { printf 'x86_64\\n'; }\nnoodara_check_arch",
      );

      expect(result.status).toBe(0);
    });

    it('succeeds for aarch64', () => {
      const result = runInstallerShell(
        interpreter,
        "uname() { printf 'aarch64\\n'; }\nnoodara_check_arch",
      );

      expect(result.status).toBe(0);
    });

    it('fails with exit code 13 for armv7l, naming the detected and supported architectures', () => {
      const result = runInstallerShell(
        interpreter,
        "uname() { printf 'armv7l\\n'; }\nnoodara_check_arch",
      );

      expect(result.status).toBe(13);
      expect(result.stderr).toContain('armv7l');
      expect(result.stderr).toContain('amd64');
      expect(result.stderr).toContain('arm64');
    });

    it('fails with exit code 13 for riscv64', () => {
      const result = runInstallerShell(
        interpreter,
        "uname() { printf 'riscv64\\n'; }\nnoodara_check_arch",
      );

      expect(result.status).toBe(13);
      expect(result.stderr).toContain('riscv64');
    });
  });

  describe('noodara_total_ram_mb / noodara_check_resources', () => {
    it('reads MemTotal from NOODARA_MEMINFO_FILE and prints whole megabytes', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-preflight-'));
      const meminfoFile = writeMeminfoFixture(dir, 2097152);

      const result = runInstallerShell(interpreter, 'noodara_total_ram_mb', {
        env: { NOODARA_MEMINFO_FILE: meminfoFile },
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('2048');
    });

    it('fails with exit code 14 when total RAM is below 1024MB', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-preflight-'));
      const meminfoFile = writeMeminfoFixture(dir, 524288);

      const result = runInstallerShell(interpreter, 'noodara_check_resources', {
        env: { NOODARA_MEMINFO_FILE: meminfoFile, NOODARA_INSTALL_DIR: dir },
      });

      expect(result.status).toBe(14);
      expect(result.stderr).toContain('512');
    });

    it('warns to stderr and returns 0 when RAM is between 1024 and 2047MB', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-preflight-'));
      const meminfoFile = writeMeminfoFixture(dir, 1572864);
      const snippet = `${dfFunctionSnippet(10485760)}\nnoodara_check_resources`;

      const result = runInstallerShell(interpreter, snippet, {
        env: { NOODARA_MEMINFO_FILE: meminfoFile, NOODARA_INSTALL_DIR: dir },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('warning');
    });

    it('is silent and returns 0 when RAM is 2048MB or above and disk is sufficient', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-preflight-'));
      const meminfoFile = writeMeminfoFixture(dir, 4194304);
      const snippet = `${dfFunctionSnippet(10485760)}\nnoodara_check_resources`;

      const result = runInstallerShell(interpreter, snippet, {
        env: { NOODARA_MEMINFO_FILE: meminfoFile, NOODARA_INSTALL_DIR: dir },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('fails with exit code 15 when free disk is below 5GB', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-preflight-'));
      const meminfoFile = writeMeminfoFixture(dir, 4194304);
      const snippet = `${dfFunctionSnippet(1048576)}\nnoodara_check_resources`;

      const result = runInstallerShell(interpreter, snippet, {
        env: { NOODARA_MEMINFO_FILE: meminfoFile, NOODARA_INSTALL_DIR: dir },
      });

      expect(result.status).toBe(15);
    });

    it('skips both checks and emits a note when NOODARA_SKIP_RESOURCE_CHECK=1', () => {
      const dir = mkdtempSync(join(tmpdir(), 'noodara-preflight-'));
      const missingMeminfo = join(dir, 'does-not-exist-meminfo');

      const result = runInstallerShell(interpreter, 'noodara_check_resources', {
        env: {
          NOODARA_SKIP_RESOURCE_CHECK: '1',
          NOODARA_MEMINFO_FILE: missingMeminfo,
          NOODARA_INSTALL_DIR: dir,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
    });
  });

  describe('noodara_resolve_port / noodara_check_port', () => {
    it('resolves to 3000 when NOODARA_PORT is unset', () => {
      const result = runInstallerShell(interpreter, 'noodara_resolve_port');

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('3000');
    });

    it('resolves to the override when NOODARA_PORT=8080', () => {
      const result = runInstallerShell(interpreter, 'noodara_resolve_port', {
        env: { NOODARA_PORT: '8080' },
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('8080');
    });

    it('fails with exit code 16 for a non-numeric NOODARA_PORT', () => {
      const result = runInstallerShell(interpreter, 'noodara_resolve_port', {
        env: { NOODARA_PORT: 'abc' },
      });

      expect(result.status).toBe(16);
    });

    it('fails with exit code 16 when NOODARA_PORT is 0 (out of range)', () => {
      const result = runInstallerShell(interpreter, 'noodara_resolve_port', {
        env: { NOODARA_PORT: '0' },
      });

      expect(result.status).toBe(16);
    });

    it('fails with exit code 16 when NOODARA_PORT is 70000 (out of range)', () => {
      const result = runInstallerShell(interpreter, 'noodara_resolve_port', {
        env: { NOODARA_PORT: '70000' },
      });

      expect(result.status).toBe(16);
    });

    it('fails with exit code 16 naming the port and suggesting NOODARA_PORT when busy', () => {
      const snippet =
        "ss() { printf 'LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:*\\n'; }\nnoodara_check_port";

      const result = runInstallerShell(interpreter, snippet);

      expect(result.status).toBe(16);
      expect(result.stderr).toContain('3000');
      expect(result.stderr).toContain('NOODARA_PORT');
    });

    it('returns 0 when the port is free', () => {
      const snippet =
        "ss() { printf 'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\\n'; }\nnoodara_check_port";

      const result = runInstallerShell(interpreter, snippet);

      expect(result.status).toBe(0);
    });

    it('does not mistake a busy port 30000 for port 3000 (anchored match)', () => {
      const snippet =
        "ss() { printf 'LISTEN 0 4096 0.0.0.0:30000 0.0.0.0:*\\n'; }\nnoodara_check_port";

      const result = runInstallerShell(interpreter, snippet);

      expect(result.status).toBe(0);
    });

    // Post-execution fix (orchestrator audit Finding A): on an existing installation, the panel
    // port recorded in .env is expected to be busy -- it is this installation's own running web
    // container -- and must never fail preflight. Orchestrator's own reproduction: an install dir
    // containing a .env, `ss` reporting the recorded port as listening.
    it('does not fail when the install directory has an existing .env and its recorded port is busy (orchestrator probe)', () => {
      const installDir = mkdtempSync(join(tmpdir(), 'noodara-check-port-installed-'));
      writeFileSync(
        join(installDir, '.env'),
        'NOODARA_VERSION=1.0.0\nNOODARA_PORT=3000\n',
        'utf8',
      );
      const snippet = "ss() { printf 'LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:*\\n'; }\nnoodara_check_port";

      const result = runInstallerShell(interpreter, snippet, {
        env: { NOODARA_INSTALL_DIR: installDir },
      });

      expect(result.status).toBe(0);
    });

    it('still fails with exit code 16 on a genuinely fresh install (no .env) with a busy port', () => {
      const parent = mkdtempSync(join(tmpdir(), 'noodara-check-port-fresh-'));
      const installDir = join(parent, 'noodara');
      const snippet = "ss() { printf 'LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:*\\n'; }\nnoodara_check_port";

      const result = runInstallerShell(interpreter, snippet, {
        env: { NOODARA_INSTALL_DIR: installDir },
      });

      expect(result.status).toBe(16);
    });

    it('warns naming both values, and never fails, when NOODARA_PORT differs from the recorded .env port on an existing installation', () => {
      const installDir = mkdtempSync(join(tmpdir(), 'noodara-check-port-installed-'));
      writeFileSync(
        join(installDir, '.env'),
        'NOODARA_VERSION=1.0.0\nNOODARA_PORT=3000\n',
        'utf8',
      );
      // The busy-port stub reports the *recorded* .env port (3000), not the operator's override
      // (4000) -- proving the check genuinely skips the busy-port test rather than accidentally
      // passing because the wrong port was probed.
      const snippet = "ss() { printf 'LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:*\\n'; }\nnoodara_check_port";

      const result = runInstallerShell(interpreter, snippet, {
        env: { NOODARA_INSTALL_DIR: installDir, NOODARA_PORT: '4000' },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('4000');
      expect(result.stderr).toContain('3000');
      expect(result.stderr.toLowerCase()).toContain('.env');
      // Post-execution fix (orchestrator audit Finding 3, 06-14 follow-up): re-running the
      // installer never applies an edited .env (a same-version healthy-stack re-run is a true
      // no-op) -- the message must point at the real apply command instead, built from
      // NOODARA_INSTALL_DIR, never a hard-coded /opt/noodara.
      expect(result.stderr).not.toContain('re-run this installer');
      expect(result.stderr).toContain(`docker compose -f ${installDir}/docker-compose.yml up -d`);
    });

    it('does not warn when NOODARA_PORT matches the recorded .env port exactly', () => {
      const installDir = mkdtempSync(join(tmpdir(), 'noodara-check-port-installed-'));
      writeFileSync(
        join(installDir, '.env'),
        'NOODARA_VERSION=1.0.0\nNOODARA_PORT=3000\n',
        'utf8',
      );
      const snippet = "ss() { printf 'LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:*\\n'; }\nnoodara_check_port";

      const result = runInstallerShell(interpreter, snippet, {
        env: { NOODARA_INSTALL_DIR: installDir, NOODARA_PORT: '3000' },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });
  });

  describe('noodara_check_docker_snap', () => {
    it('returns 0 when snap is not installed', () => {
      const result = runInstallerShell(interpreter, 'noodara_check_docker_snap', {
        env: { PATH: '/nonexistent-noodara-test-path' },
      });

      expect(result.status).toBe(0);
    });

    it('returns 0 when snap exists but docker is not installed via snap', () => {
      const snippet = 'snap() { return 1; }\nnoodara_check_docker_snap';

      const result = runInstallerShell(interpreter, snippet);

      expect(result.status).toBe(0);
    });

    it('fails with exit code 17 naming sudo snap remove docker when docker is installed via snap', () => {
      const snippet = 'snap() { return 0; }\nnoodara_check_docker_snap';

      const result = runInstallerShell(interpreter, snippet);

      expect(result.status).toBe(17);
      expect(result.stderr).toContain('sudo snap remove docker');
    });
  });

  describe('noodara_preflight', () => {
    it('runs root first: a non-root user fails at root (10), never a later check', () => {
      const snippet = "id() { printf '1000\\n'; }\nnoodara_preflight";

      const result = runInstallerShell(interpreter, snippet);

      expect(result.status).toBe(10);
    });

    it('with Docker-via-snap AND a busy port both present, exits 17 and names snap, never the port', () => {
      const fixturesDir = mkdtempSync(join(tmpdir(), 'noodara-preflight-fixtures-'));
      const installDir = mkdtempSync(join(tmpdir(), 'noodara-preflight-installdir-'));
      const { env } = buildPassingEnv(fixturesDir, installDir);
      const snippet = [
        "id() { printf '0\\n'; }",
        "uname() { printf 'x86_64\\n'; }",
        'command() { return 0; }',
        "ss() { printf 'LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:*\\n'; }",
        dfFunctionSnippet(10485760),
        'snap() { return 0; }',
        'noodara_preflight',
      ].join('\n');

      const result = runInstallerShell(interpreter, snippet, { env });

      expect(result.status).toBe(17);
      expect(result.stderr).toContain('snap');
      expect(result.stderr).not.toContain('already in use');
    });

    it('with an unsupported OS AND insufficient RAM both present, exits 12 and names the OS', () => {
      const fixturesDir = mkdtempSync(join(tmpdir(), 'noodara-preflight-fixtures-'));
      const osReleaseFile = writeOsReleaseFixture(fixturesDir, 'debian', '12');
      const meminfoFile = writeMeminfoFixture(fixturesDir, 524288);
      const snippet = [
        "id() { printf '0\\n'; }",
        "uname() { printf 'x86_64\\n'; }",
        'command() { return 0; }',
        'noodara_preflight',
      ].join('\n');

      const result = runInstallerShell(interpreter, snippet, {
        env: { NOODARA_OS_RELEASE_FILE: osReleaseFile, NOODARA_MEMINFO_FILE: meminfoFile },
      });

      expect(result.status).toBe(12);
      expect(result.stderr).toContain('debian');
    });

    it('returns 0 and writes at least one progressive step line to stdout on a fully passing environment', () => {
      const fixturesDir = mkdtempSync(join(tmpdir(), 'noodara-preflight-fixtures-'));
      const installDir = mkdtempSync(join(tmpdir(), 'noodara-preflight-installdir-'));
      const { snippet: fnSnippet, env } = buildPassingEnv(fixturesDir, installDir);

      const result = runInstallerShell(interpreter, `${fnSnippet}\nnoodara_preflight`, { env });

      expect(result.status).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
    });

    it('writes nothing under the install directory and invokes no package manager', () => {
      const fixturesDir = mkdtempSync(join(tmpdir(), 'noodara-preflight-fixtures-'));
      const installDir = mkdtempSync(join(tmpdir(), 'noodara-preflight-installdir-'));
      const { snippet: fnSnippet, env } = buildPassingEnv(fixturesDir, installDir);
      const sentinel = join(installDir, 'sentinel-should-not-exist');
      const snippet = [
        fnSnippet,
        `apt_get() { printf 'x' > '${sentinel}'; }`,
        `docker() { printf 'x' > '${sentinel}'; }`,
        'noodara_preflight',
      ].join('\n');

      const result = runInstallerShell(interpreter, snippet, { env });

      expect(result.status).toBe(0);
      expect(existsSync(sentinel)).toBe(false);
      expect(readdirSync(installDir)).toEqual([]);
    });

    // Post-execution fix (orchestrator audit Finding A): the orchestrator's exact reproduction --
    // an install dir with a .env, the panel port genuinely listening (this installation's own
    // container) -- passes the full preflight sequence end to end, never just the isolated
    // noodara_check_port unit above.
    it('passes end to end on a re-run against an existing installation whose own panel port is busy', () => {
      const fixturesDir = mkdtempSync(join(tmpdir(), 'noodara-preflight-fixtures-'));
      const installDir = mkdtempSync(join(tmpdir(), 'noodara-preflight-installdir-'));
      writeFileSync(join(installDir, '.env'), 'NOODARA_VERSION=1.0.0\nNOODARA_PORT=3000\n', 'utf8');
      const { env } = buildPassingEnv(fixturesDir, installDir);
      const snippet = [
        "id() { printf '0\\n'; }",
        "uname() { printf 'x86_64\\n'; }",
        'command() { return 0; }',
        "ss() { printf 'LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:*\\n'; }",
        dfFunctionSnippet(10485760),
        'snap() { return 1; }',
        'noodara_preflight',
      ].join('\n');

      const result = runInstallerShell(interpreter, snippet, { env });

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('already in use');
    });
  });
});
