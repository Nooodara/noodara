import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

// Execute the actual entrypoint, replacing only Node/platform boundaries. No copied parser.
const source = readFileSync(new URL('../../../docs/testing/ssh-fixture-timeouts/runner.mjs', import.meta.url), 'utf8').replace(/^import .*;$/gm, '');
const owner = '12345678-1234-4123-8123-123456789abc';
const secret = 'synthetic-private-output-do-not-emit';
const event = (extra = {}) => `SSH_DIAGNOSTIC ${JSON.stringify({ kind: 'stage', owner, stage: 'image_build', outcome: 'begin', elapsedMs: 0, ...extra })}\n`;
function harness(options = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 12345;
  const output = [], commands = [], signals = [], timers = new Map();
  let blocked = false, exitCode;
  let sink;
  const sandbox = {
    spawn: (...args) => { commands.push(['spawn', ...args]); if (options.spawnThrow) throw Error(secret); return child; },
    spawnSync: (command, args, config) => {
      commands.push([command, args, config]);
      if (options.dockerThrow) throw Error(secret);
      if (args[0] === 'version') return { status: 0, stdout: 'linux/amd64 27.0.0' };
      if (args[0] === 'buildx') return { status: 0, stdout: `sha256:${'a'.repeat(64)}` };
      return { status: options.cleanupFail ? 1 : 0, stdout: options.cleanupFail ? secret : '' };
    },
    createHash, readFileSync: () => 'controlled-source',
    setTimeout: (fn, ms) => { const id = Symbol(); timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    process: { env: { SSH_DIAGNOSTIC_UBUNTU: '24.04', GITHUB_SHA: 'b'.repeat(40) }, execPath: '/controlled/node',
      stdout: Object.assign(new EventEmitter(), { write: (line) => { if (options.sinkThrow) throw Error(secret); if (blocked) throw Error('write after backpressure'); output.push(JSON.parse(line)); if (options.backpressure) { blocked = true; return false; } return true; } }),
      kill: (pid, signal) => { signals.push([pid, signal]); if (options.killThrow) throw Error(secret); },
      set exitCode(code) { exitCode = code; }, get exitCode() { return exitCode; },
      exit: () => { throw Error('unexpected exit'); },
    },
  };
  sink = sandbox.process.stdout;
  vm.runInNewContext(source, sandbox, { filename: 'runner.mjs' });
  return { sink, child, output, commands, signals, timers, get exitCode() { return exitCode; }, fire(ms) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } } };
}

test('filters split, oversized, newline-free, malformed and sensitive output; stderr is never forwarded', () => {
  const h = harness();
  const line = event({ password: secret });
  h.child.stdout.emit('data', line.slice(0, 17)); h.child.stdout.emit('data', line.slice(17));
  h.child.stdout.emit('data', `${secret}\nSSH_DIAGNOSTIC {bad}\n${'x'.repeat(100000)}${event()}${event({ stage: secret })}`);
  h.child.stdout.emit('data', event({ outcome: 'success' }));
  h.child.stderr.emit('data', secret + event());
  assert.deepEqual(h.output.filter(x => x.kind === 'stage').map(x => x.outcome), ['begin', 'success']);
  assert.equal(JSON.stringify(h.output).includes(secret), false);
  assert.deepEqual(Object.keys(h.output.find(x => x.kind === 'stage')).sort(), ['elapsedMs', 'kind', 'outcome', 'owner', 'stage']);
  h.child.emit('close', 0); assert.equal(h.exitCode, 0); assert.equal(h.timers.size, 0);
});
test('caps admitted events and rejects malformed owners without cleanup admission', () => {
  const h = harness();
  for (const bad of ['../../foreign', owner.toUpperCase(), 'foreign', null, 123]) h.child.stdout.emit('data', event({ owner: bad }));
  h.child.stdout.emit('data', event({ elapsedMs: -1 }) + event({ elapsedMs: 900001 }) + event({ outcome: secret }));
  for (let i = 0; i < 150; i++) h.child.stdout.emit('data', event());
  h.child.emit('close', 0);
  assert.equal(h.output.filter(x => x.kind === 'stage').length, 140);
  assert.equal(h.commands.filter(x => x[0] === 'docker' && x[1][0] === 'rm').length, 1);
  assert.equal(JSON.stringify(h.output).includes(secret), false);
});
test('uses exact owner cleanup commands on child failure and reports cleanup failure safely', () => {
  const h = harness({ cleanupFail: true }); h.child.stdout.emit('data', event()); h.child.emit('close', 7);
  const cleanup = h.commands.filter(x => x[0] === 'docker').slice(2);
  assert.deepEqual(cleanup.map(x => Array.from(x[1])), [
    ['rm', '-f', '-v', `noodara-sshd-24.04-${owner}`], ['ps', '-aq', '--filter', `name=^/noodara-sshd-24.04-${owner}$`], ['image', 'rm', `noodara-test/sshd-diagnostics:${owner}`],
  ]);
  assert.ok(cleanup.every(x => x[2].timeout === 30000 && x[2].maxBuffer === 65536));
  assert.equal(h.exitCode, 1); assert.equal(h.output.at(-1).outcome, 'failure');
  assert.equal(h.output.find(x => x.kind === 'owned_container_cleanup').outcome, 'unconfirmed');
  assert.equal(JSON.stringify(h.output).includes(secret), false);
});
test('deadline terminates detached process group then escalates; close retains timeout and clears timers', () => {
  const h = harness(); assert.equal(h.commands[2][3].detached, true);
  h.fire(420000); h.fire(425000);
  assert.deepEqual(h.signals, [[-12345, 'SIGTERM'], [-12345, 'SIGKILL']]);
  h.child.emit('close', 0); assert.equal(h.exitCode, 1); assert.equal(h.output.at(-1).outcome, 'timeout'); assert.equal(h.timers.size, 0);
});
test('close before deadline prevents termination and duplicate close cannot clean twice', () => {
  const h = harness(); h.child.stdout.emit('data', event()); h.child.emit('close', 0); h.child.emit('close', 0); h.fire(420000); h.fire(425000);
  assert.equal(h.signals.length, 0); assert.equal(h.commands.filter(x => x[0] === 'docker' && x[1][0] === 'rm').length, 1);
});
test('spawn error followed by close cannot report success', () => {
  const h = harness(); h.child.emit('error', Error(secret)); h.child.emit('close', 0);
  assert.equal(h.exitCode, 1); assert.equal(h.output.at(-1).outcome, 'spawn_failure'); assert.equal(h.timers.size, 0);
});
test('synchronous spawn failure remains a safe terminal failure', () => {
  const h = harness({ spawnThrow: true }); assert.equal(h.exitCode, 1); assert.equal(h.output.at(-1).outcome, 'spawn_failure');
});
test('throwing signal delivery still escalates and cleans owned resources', () => {
  const h = harness({ killThrow: true }); h.child.stdout.emit('data', event()); h.fire(420000); h.fire(425000); h.child.emit('close', null);
  assert.equal(h.exitCode, 1); assert.equal(h.signals.length, 2); assert.ok(h.output.some(x => x.kind === 'owned_container_cleanup'));
});
test('throwing Docker calls remain bounded safe failures and do not prevent terminal outcome', () => {
  const h = harness({ dockerThrow: true }); h.child.stdout.emit('data', event()); h.child.emit('close', 0);
  assert.equal(h.exitCode, 0); assert.equal(h.output.find(x => x.kind === 'owned_container_cleanup').outcome, 'unconfirmed');
  assert.equal(JSON.stringify(h.output).includes(secret), false);
});
for (const option of ['sinkThrow', 'backpressure']) test(`${option} cannot prevent deadline and cleanup or accumulate output`, () => {
  const h = harness({ [option]: true }); for (let i = 0; i < 1000; i++) h.child.stdout.emit('data', event()); h.fire(420000); h.fire(425000); h.child.emit('close', 0);
  assert.equal(h.exitCode, 1); assert.equal(h.signals.length, 2); assert.equal(h.commands.filter(x => x[0] === 'docker' && x[1][0] === 'rm').length, 1);
  assert.ok(h.output.length <= 1); assert.equal(JSON.stringify(h.output).includes(secret), false);
});

test('asynchronous closed sink is observational and never writes again', () => {
  const h = harness(); const count = h.output.length; h.sink.emit('error', Error(secret));
  h.child.stdout.emit('data', event()); h.fire(420000); h.fire(425000); h.child.emit('close', 0);
  assert.equal(h.exitCode, 1); assert.equal(h.output.length, count); assert.equal(h.signals.length, 2);
});
test('close racing TERM retains group escalation before exact-owner cleanup', () => {
  const h = harness(); h.child.stdout.emit('data', event()); h.fire(420000); h.child.emit('close', null);
  assert.equal(h.commands.filter(x => x[0] === 'docker' && x[1][0] === 'rm').length, 0);
  h.fire(425000);
  assert.deepEqual(h.signals, [[-12345, 'SIGTERM'], [-12345, 'SIGKILL']]);
  assert.equal(h.commands.filter(x => x[0] === 'docker' && x[1][0] === 'rm').length, 1);
  assert.equal(h.exitCode, 1); assert.equal(h.timers.size, 0);
});
test('force-kill deadline finalizes cleanup even if child close never arrives', () => {
  const h = harness(); h.child.stdout.emit('data', event()); h.fire(420000); h.fire(425000);
  assert.equal(h.exitCode, 1); assert.equal(h.output.at(-1).outcome, 'timeout');
  assert.equal(h.commands.filter(x => x[0] === 'docker' && x[1][0] === 'rm').length, 1);
});
test('admits only string owners and bounds cleanup ownership to two fixture calls', () => {
  const h = harness(); h.child.stdout.emit('data', event({ owner: [owner] }));
  for (const suffix of ['abc', 'abd', 'abe']) h.child.stdout.emit('data', event({ owner: owner.slice(0, -3) + suffix }));
  h.child.emit('close', 0);
  assert.equal(h.output.filter(x => x.kind === 'stage').length, 2);
  assert.ok(h.output.filter(x => x.kind === 'stage').every(x => typeof x.owner === 'string'));
  assert.equal(h.commands.filter(x => x[0] === 'docker' && x[1][0] === 'rm').length, 2);
});
