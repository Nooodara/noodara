// 35-03 A2/H1: the archived SSH diagnostic supervisor (docs/testing/ssh-fixture-timeouts/runner.mjs)
// is exercised through its real Node entrypoint, pipes, detached child and close handling. Only
// Docker and the launched Vitest child are replaced, at the node:child_process import boundary,
// so no Docker daemon, image build or network is touched. Supersedes the former node:test file
// docs/testing/ssh-fixture-timeouts/runner-supervisor-process.test.mjs (retained at dabdd438).
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const RUNNER = 'docs/testing/ssh-fixture-timeouts/runner.mjs';
const MARKER = 'synthetic-sensitive-child-output';

interface SupervisorRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly rows: Record<string, unknown>[];
  readonly dockerCommands: string[][];
  readonly spawned: unknown[];
}

/** Runs runner.mjs with a controlled child whose body is `childSource` (an ES module). */
function runSupervisor(childSource: string): SupervisorRun {
  const directory = mkdtempSync(path.join(tmpdir(), 'ssh-supervisor-'));
  try {
    const child = path.join(directory, 'child.mjs');
    const mock = path.join(directory, 'mock.mjs');
    const loader = path.join(directory, 'loader.mjs');
    const audit = path.join(directory, 'commands.jsonl');
    writeFileSync(child, childSource);
    writeFileSync(mock, `import { spawn as actualSpawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
export const spawn = (file, args, options) => {
  appendFileSync(${JSON.stringify(audit)}, JSON.stringify(['spawn', file, args]) + '\\n');
  return actualSpawn(process.execPath, [${JSON.stringify(child)}], options);
};
export const spawnSync = (file, args) => {
  appendFileSync(${JSON.stringify(audit)}, JSON.stringify([file, args]) + '\\n');
  return { status: 0, stdout: args[0] === 'version' ? 'linux/amd64 27.0.0' : args[0] === 'buildx' ? 'sha256:' + 'a'.repeat(64) : '' };
};
`);
    const mockUrl = pathToFileURL(mock).href;
    writeFileSync(loader, `export async function resolve(specifier, context, next) {
  if (specifier === 'node:child_process' && context.parentURL !== ${JSON.stringify(mockUrl)}) return { url: ${JSON.stringify(mockUrl)}, shortCircuit: true };
  return next(specifier, context);
}
`);
    const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, RUNNER], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, SSH_DIAGNOSTIC_UBUNTU: '24.04', GITHUB_SHA: 'b'.repeat(40) },
    });
    const commands = readFileSync(audit, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as unknown[]);
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      rows: result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
      dockerCommands: commands.filter((row) => row[0] === 'docker').map((row) => row[1] as string[]),
      spawned: commands.filter((row) => row[0] === 'spawn').map((row) => row[2]),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const stageLine = (fields: Record<string, unknown>): string =>
  `SSH_DIAGNOSTIC ${JSON.stringify({ kind: 'stage', stage: 'image_build', outcome: 'begin', elapsedMs: 0, ...fields })}\n`;

/** Child module writing `lines` to stdout (synchronously on a Linux pipe), then exiting `code`. */
const childWriting = (lines: string, code = 0, prelude = ''): string =>
  `${prelude}\nprocess.stdout.write(${JSON.stringify(lines)});\nprocess.stderr.write(${JSON.stringify(MARKER)});\nprocess.exitCode = ${String(code)};\n`;

const stages = (run: SupervisorRun) => run.rows.filter((row) => row.kind === 'stage');

describe('archived SSH diagnostic supervisor (runner.mjs) process contract', () => {
  it.each([0, 7])('child exit %i: allowlisted stage only, raw output and extra fields dropped, owned cleanup', (code) => {
    const owner = randomUUID();
    const run = runSupervisor(childWriting(`${MARKER}\n${stageLine({ owner, secret: MARKER, cause: MARKER })}`, code));

    expect(run.status).toBe(code === 0 ? 0 : 1);
    expect(run.stderr).toBe('');
    expect(run.stdout).not.toContain(MARKER);
    expect(run.spawned).toEqual([['node_modules/vitest/vitest.mjs', 'run', '--config', 'docs/testing/ssh-fixture-timeouts/runner.config.ts']]);
    expect(stages(run)).toEqual([{ kind: 'stage', owner, stage: 'image_build', outcome: 'begin', elapsedMs: 0 }]);
    expect(run.rows.at(-1)).toEqual({ kind: 'process', outcome: code === 0 ? 'success' : 'failure', exitCode: code });
    expect(run.rows.find((row) => row.kind === 'owned_container_cleanup')).toEqual({
      kind: 'owned_container_cleanup', owner, outcome: 'absent', removeSucceeded: true,
    });
    expect(run.dockerCommands.slice(2)).toEqual([
      ['rm', '-f', '-v', `noodara-sshd-24.04-${owner}`],
      ['ps', '-aq', '--filter', `name=^/noodara-sshd-24.04-${owner}$`],
      ['image', 'rm', `noodara-test/sshd-diagnostics:${owner}`],
    ]);
  });

  it('rejects an oversized (>2048 char) line without emitting any of its bytes, then resumes', () => {
    const dropped = randomUUID();
    const kept = randomUUID();
    const oversized = stageLine({ owner: dropped, pad: `${MARKER}${'x'.repeat(4096)}` });
    expect(oversized.length).toBeGreaterThan(2048);
    const run = runSupervisor(childWriting(`${oversized}${stageLine({ owner: kept })}`));

    expect(run.stdout).not.toContain(MARKER);
    expect(run.stdout).not.toContain(dropped);
    expect(stages(run).map((row) => row.owner)).toEqual([kept]);
  });

  it('bounds multi-megabyte output without a newline and never echoes it', () => {
    const owner = randomUUID();
    const prelude = `process.stdout.write(${JSON.stringify(MARKER)} + 'A'.repeat(4 * 1024 * 1024));`;
    const run = runSupervisor(childWriting(`\n${stageLine({ owner })}`, 0, prelude));

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain(MARKER);
    expect(run.stdout.length).toBeLessThan(8 * 1024);
    expect(stages(run).map((row) => row.owner)).toEqual([owner]);
  });

  it('caps accepted diagnostic rows at 140', () => {
    const owner = randomUUID();
    const lines = Array.from({ length: 200 }, (_, n) => stageLine({ owner, elapsedMs: n })).join('');
    const run = runSupervisor(childWriting(lines));

    expect(stages(run)).toHaveLength(140);
    expect(stages(run).at(-1)?.elapsedMs).toBe(139);
  });

  it('accepts at most two fixture owners and cleans up only those', () => {
    const owners = [randomUUID(), randomUUID(), randomUUID()];
    const run = runSupervisor(childWriting(owners.map((owner) => stageLine({ owner })).join('')));

    expect(stages(run).map((row) => row.owner)).toEqual(owners.slice(0, 2));
    expect(run.rows.filter((row) => row.kind === 'owned_container_cleanup').map((row) => row.owner))
      .toEqual(owners.slice(0, 2));
    expect(run.stdout).not.toContain(owners[2]);
  });

  it('drops non-v4 owners, unknown stages/outcomes, out-of-range elapsed values and foreign contexts', () => {
    const owner = randomUUID();
    const lines = [
      stageLine({ owner: '00000000-0000-1000-8000-000000000000' }),
      stageLine({ owner: `${MARKER}` }),
      stageLine({ owner, stage: MARKER }),
      stageLine({ owner, outcome: MARKER }),
      stageLine({ owner, elapsedMs: -1 }),
      stageLine({ owner, elapsedMs: 900_001 }),
      stageLine({ owner, elapsedMs: 1.5 }),
      `SSH_DIAGNOSTIC ${JSON.stringify({ kind: 'context', ubuntu: '22.04', cache: 'cold' })}\n`,
      `SSH_DIAGNOSTIC ${JSON.stringify({ kind: 'context', ubuntu: '24.04', cache: MARKER })}\n`,
      `SSH_DIAGNOSTIC {not json ${MARKER}\n`,
      `SSH_DIAGNOSTIC ${JSON.stringify({ kind: 'context', ubuntu: '24.04', cache: 'warm', secret: MARKER })}\n`,
    ].join('');
    const run = runSupervisor(childWriting(lines));

    expect(stages(run)).toEqual([]);
    expect(run.rows.filter((row) => row.kind === 'context')).toEqual([{ kind: 'context', ubuntu: '24.04', cache: 'warm' }]);
    expect(run.stdout).not.toContain(MARKER);
    expect(run.rows.filter((row) => row.kind === 'owned_container_cleanup')).toEqual([]);
  });
});
