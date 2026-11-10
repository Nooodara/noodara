import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Real Node entrypoint, pipes, detached child and close handling. Only Docker and
// the launched Vitest child are controlled at the platform import boundary.
for (const code of [0, 7]) test(`entrypoint runs controlled child exit ${code} without raw output`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'ssh-supervisor-test-'));
  try {
    const mock = join(directory, 'mock.mjs');
    const loader = join(directory, 'loader.mjs');
    const audit = join(directory, 'commands.jsonl');
    const owner = '12345678-1234-4123-8123-123456789abc';
    const sensitive = 'synthetic-private-child-output';
    const line = `SSH_DIAGNOSTIC ${JSON.stringify({ kind: 'stage', owner, stage: 'image_build', outcome: 'begin', elapsedMs: 0, secret: sensitive })}\n`;
    const childScript = `process.stdout.write(${JSON.stringify(sensitive + '\n' + line)});process.stderr.write(${JSON.stringify(sensitive)});process.exitCode=${code};`;
    writeFileSync(mock, `import { spawn as actualSpawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
export const spawn = (file, args, options) => { appendFileSync(${JSON.stringify(audit)}, JSON.stringify(['spawn',file,args,options])+'\\n'); return actualSpawn(process.execPath,['-e',${JSON.stringify(childScript)}],options); };
export const spawnSync = (file, args, options) => { appendFileSync(${JSON.stringify(audit)}, JSON.stringify([file,args,options])+'\\n'); return {status:0, stdout:args[0]==='version'?'linux/amd64 27.0.0':args[0]==='buildx'?'sha256:'+'a'.repeat(64):''}; };
`);
    const mockURL = pathToFileURL(mock).href;
    writeFileSync(loader, `export async function resolve(specifier, context, next) { if (specifier==='node:child_process' && context.parentURL!==${JSON.stringify(mockURL)}) return {url:${JSON.stringify(mockURL)},shortCircuit:true}; return next(specifier,context); }`);
    const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, 'docs/testing/ssh-fixture-timeouts/runner.mjs'], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
      env: { ...process.env, SSH_DIAGNOSTIC_UBUNTU: '24.04', GITHUB_SHA: 'b'.repeat(40) },
    });
    assert.equal(result.status, code === 0 ? 0 : 1);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.includes(sensitive), false);
    const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.at(-1).outcome, code === 0 ? 'success' : 'failure');
    assert.equal(rows.at(-1).exitCode, code);
    assert.equal(rows.filter(row => row.kind === 'stage').length, 1);
    assert.equal(rows.find(row => row.kind === 'owned_container_cleanup').outcome, 'absent');
    const commands = readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(commands.find(row => row[0] === 'spawn')[2], ['node_modules/vitest/vitest.mjs', 'run', '--config', 'docs/testing/ssh-fixture-timeouts/runner.config.ts']);
    assert.deepEqual(commands.filter(row => row[0] === 'docker').slice(2).map(row => row[1]), [
      ['rm', '-f', '-v', `noodara-sshd-24.04-${owner}`], ['ps', '-aq', '--filter', `name=^/noodara-sshd-24.04-${owner}$`], ['image', 'rm', `noodara-test/sshd-diagnostics:${owner}`],
    ]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
