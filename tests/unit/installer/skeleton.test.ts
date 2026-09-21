// 06-01-PLAN.md Task 2: install.sh's skeleton -- exit-code table, output helpers, library/
// source-only mode, truncation-safe dispatch -- exercised under every available real POSIX
// interpreter (`/bin/sh`, plus `dash` when present), never `bash` (06-RESEARCH.md Pitfall 1).
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { INSTALL_SH, isDashFamily, posixInterpreters, runInstallerShell } from './sh-harness.js';

describe.each(posixInterpreters())('install.sh skeleton (%s)', (interpreter) => {
  it('sources cleanly as a library: defines functions, writes nothing, exits 0', () => {
    const result = runInstallerShell(interpreter, 'true');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('noodara_exit_code_for maps every reason to its numbered exit code', () => {
    const cases: Array<[string, number]> = [
      ['not-root', 10],
      ['missing-command', 11],
      ['unsupported-os', 12],
      ['unsupported-arch', 13],
      ['insufficient-ram', 14],
      ['insufficient-disk', 15],
      ['port-in-use', 16],
      ['docker-via-snap', 17],
      ['docker-install-failed', 20],
      ['compose-plugin-missing', 21],
      // Post-execution fix (06-08-PLAN.md orchestrator audit Finding 2): a docker binary present
      // with an unresponsive daemon gets its own exit code, distinct from docker-install-failed --
      // the installer never treats "daemon down" as "Docker absent" and must never run apt/gpg/
      // systemctl to "fix" it.
      ['docker-daemon-unavailable', 22],
      ['env-write-failed', 30],
      ['version-resolution-failed', 40],
      ['public-url-resolution-failed', 41],
      ['image-pull-failed', 50],
      ['compose-up-failed', 51],
      ['migrations-failed', 52],
      ['health-check-failed', 53],
    ];

    for (const [reason, code] of cases) {
      const result = runInstallerShell(interpreter, `noodara_exit_code_for ${reason}`);

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(String(code));
    }
  });

  it('noodara_exit_code_for exits non-zero for an unknown reason', () => {
    const result = runInstallerShell(interpreter, 'noodara_exit_code_for some-unknown-reason');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unknown exit reason');
  });

  it('noodara_fail writes "noodara: <message>" to stderr only and exits with the mapped code', () => {
    const result = runInstallerShell(interpreter, 'noodara_fail not-root "nope"');

    expect(result.status).toBe(10);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('noodara: nope');
  });

  it('noodara_step writes a single progressive line to stdout and nothing to stderr', () => {
    const result = runInstallerShell(interpreter, 'noodara_step "Checking system"');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('Checking system\n');
    expect(result.stderr).toBe('');
  });

  it('noodara_warn writes to stderr with a "noodara: warning:" prefix and does not exit', () => {
    const result = runInstallerShell(interpreter, 'noodara_warn "low disk"; echo after');

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('noodara: warning: low disk');
    expect(result.stdout.trim()).toBe('after');
  });

  // Plan 06-09 wired preflight -> Docker -> .env -> compose up -> health-wait -> summary into the
  // real noodara_main (06-01's own version only printed a banner and returned 0). Running
  // install.sh directly, unprivileged and with no env overrides, now genuinely reaches and fails
  // noodara_preflight's first real gate -- not-root (exit 10) -- rather than a crash or a silent
  // success. This is the correct, actionable behavior D-17 requires, not a regression: the guard
  // block dispatch still runs to completion (proving the truncation-safe entry point genuinely
  // reaches noodara_main), it just now does real work once it gets there.
  it('reaches noodara_main and fails preflight with exit 10 (not-root) when run directly unprivileged', () => {
    const result = spawnSync(interpreter, [INSTALL_SH], { encoding: 'utf8' });

    expect(result.status).toBe(10);
    expect(result.stderr).toContain('root');
  });
});

it('CI always exercises a dash-family interpreter, never a silently bash-flavoured /bin/sh', () => {
  if (process.env.CI === undefined) return;

  expect(posixInterpreters().some((interpreter) => isDashFamily(interpreter))).toBe(true);
});
