// 06-02-PLAN.md: install.sh's preflight predicates -- each a separate, injectable `sh` function
// with its own exit code and message (06-CONTEXT.md D-17), exercised under every available real
// POSIX interpreter (`/bin/sh`, plus `dash` when present), never `bash` (06-RESEARCH.md Pitfall 1).
//
// Every probe this file exercises (id, uname, /etc/os-release, /proc/meminfo, ss, df, snap) is
// injected via env var override or shell-function shadowing, never the host's real state
// (hard_rule #9) -- this file must pass identically on the macOS dev machine and on real Ubuntu CI.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { posixInterpreters, runInstallerShell } from './sh-harness.js';

function writeOsReleaseFixture(dir: string, id: string, versionId: string): string {
  const file = join(dir, 'os-release');
  writeFileSync(file, `ID=${id}\nVERSION_ID="${versionId}"\n`, 'utf8');
  return file;
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
});
