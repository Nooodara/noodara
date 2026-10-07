// 14-04 H1: the direct POSIX forms that replaced the check-posix-sh workarounds, executed under
// every real POSIX interpreter (dash when present), including empty/zero/non-numeric operands.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INSTALL_SH, posixInterpreters, runInstallerShell } from './sh-harness.js';

const meminfo = (content: string): string => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'noodara-mem-')), 'meminfo');
  writeFileSync(file, content);
  return file;
};

describe.each(posixInterpreters())('install.sh direct POSIX forms (%s)', (interpreter: string) => {
  it.each([
    ['MemTotal:        2097152 kB\n', '2048'],
    ['MemTotal:        1023 kB\n', '0'],
    ['MemTotal:        0 kB\n', '0'],
    ['MemTotal:        abc kB\n', '0'],
    ['MemTotal:\n', '0'],
    ['SomethingElse: 5 kB\n', '0'],
    ['', '0'],
  ])('noodara_total_ram_mb on %j prints %s', (content, expected) => {
    const result = runInstallerShell(interpreter, 'noodara_total_ram_mb', {
      env: { NOODARA_MEMINFO_FILE: meminfo(content) },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
    expect(result.stderr).toBe('');
  });

  it('shell arithmetic increment used by the wait loops works from 0 and counts up', () => {
    const result = runInstallerShell(
      interpreter,
      'n=0; n=$((n + 1)); n=$((n + 1)); printf "%s\\n" "$n"',
    );
    expect(result.stdout.trim()).toBe('2');
  });

  it('writes the compose healthcheck arrow functions literally', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'noodara-compose-'));
    const result = runInstallerShell(interpreter, 'noodara_place_compose_file', {
      env: { NOODARA_INSTALL_DIR: dir },
    });
    expect(result.status).toBe(0);
    const written = readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
    expect(written).toContain('.catch(()=>process.exit(1))');
  });
});

describe('install.sh source no longer carries the workarounds', () => {
  const src = readFileSync(INSTALL_SH, 'utf8');
  it('uses no awk-based counter increment or division', () => {
    expect(src).not.toMatch(/BEGIN \{ (print n \+ 1|printf "%d\\n", kb \/ 1024) \}/);
    expect(src).not.toContain('_noodara_pcf_lp');
  });
});
