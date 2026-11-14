// 36-03 H2: CLI wiring of scripts/test-preflight.mjs (argv -> usage/exit code, report -> exit code).
// Spawns the real script with execFile. Docker-free: the child's PATH holds only the directory of
// the running Node binary, so every docker/pnpm probe resolves to "missing" at once.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { USAGE } from '../../../scripts/test-preflight-lib.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const SCRIPT = path.join(ROOT, 'scripts/test-preflight.mjs');
const CLI_TIMEOUT_MS = 20_000;
const STACK_FRAME = /\n\s+at .+[:(]\d+:\d+\)?/;

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      {
        cwd: ROOT,
        timeout: CLI_TIMEOUT_MS,
        env: { PATH: path.dirname(process.execPath), NO_COLOR: '1' },
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe('test-preflight.mjs CLI wiring (H2)', () => {
  it.each([
    ['an unknown flag', ['--bogus']],
    ['--tier without a value', ['--tier']],
    ['an invalid --tier value', ['--tier', 'smoke']],
    ['an empty --tier= value', ['--tier=']],
    ['a positional argument', ['unit']],
  ])('%s exits 2 with the usage on stderr and nothing on stdout', async (_label, args) => {
    const result = await runCli(args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(USAGE);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toMatch(STACK_FRAME);
  }, CLI_TIMEOUT_MS + 5_000);

  it('--help exits 0 with the usage on stdout', async () => {
    const result = await runCli(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(USAGE);
    expect(result.stderr).toBe('');
  }, CLI_TIMEOUT_MS + 5_000);

  it('--tier unit prints a report and exits 0 or 1 with no stack trace', async () => {
    const result = await runCli(['--tier', 'unit']);
    expect([0, 1]).toContain(result.code);
    expect(result.stdout).toMatch(/Node\.js/);
    expect(result.stdout).not.toContain(USAGE);
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(STACK_FRAME);
  }, CLI_TIMEOUT_MS + 5_000);
});
