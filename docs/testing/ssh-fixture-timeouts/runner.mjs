import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const ubuntu = process.env.SSH_DIAGNOSTIC_UBUNTU;
if (!['22.04', '24.04'].includes(ubuntu)) process.exit(2);
// Stop emitting permanently on sink failure/backpressure: no queue, retry or raw fallback.
let sinkClosed = false;
process.stdout.on('error', () => { sinkClosed = true; });
const emit = (value) => {
  if (sinkClosed) return;
  try { if (!process.stdout.write(`${JSON.stringify(value)}\n`)) sinkClosed = true; }
  catch { sinkClosed = true; }
};
const docker = (args) => {
  try {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
    return { status: result.status, stdout: typeof result.stdout === 'string' ? result.stdout : '' };
  } catch { return { status: null, stdout: '' }; }
};
const owners = new Set();
const source = ['tests/integration/helpers/ssh.ts', `tests/integration/images/sshd-ubuntu-${ubuntu}/Dockerfile`, 'tests/integration/images/sshd-common/entrypoint.sh', 'tests/integration/images/sshd-common/setup-users.sh'];
emit({ kind: 'source', sha: process.env.GITHUB_SHA, files: Object.fromEntries(source.map((p) => [p, createHash('sha256').update(readFileSync(p)).digest('hex')])) });
const version = docker(['version', '--format', '{{.Server.Os}}/{{.Server.Arch}} {{.Server.Version}}']);
emit({ kind: 'daemon', outcome: version.status === 0 ? 'success' : 'failure', identity: /^[a-z0-9/. -]{1,80}$/i.test(version.stdout.trim()) ? version.stdout.trim() : 'unavailable' });
const manifest = docker(['buildx', 'imagetools', 'inspect', `ubuntu:${ubuntu}`, '--format', '{{.Manifest.Digest}}']);
emit({ kind: 'base_manifest', ubuntu, digest: /^sha256:[0-9a-f]{64}$/.test(manifest.stdout.trim()) ? manifest.stdout.trim() : 'unavailable' });
let rows = 0, buffer = '', dropping = false;
const stageAllowlist = ['image_build','container_create','container_start','published_port','ssh_readiness','cleanup'];
const outcomeAllowlist = ['begin','success','failure','timeout','cancelled'];
const accept = (line) => {
  if (!line.startsWith('SSH_DIAGNOSTIC ') || rows >= 140) return;
  try {
    const value = JSON.parse(line.slice(15));
    if (value.kind === 'context' && value.ubuntu === ubuntu && ['cold','warm'].includes(value.cache)) {
      rows++; emit({ kind: 'context', ubuntu, cache: value.cache }); return;
    }
    if (value.kind !== 'stage' || typeof value.owner !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.owner) || !stageAllowlist.includes(value.stage) || !outcomeAllowlist.includes(value.outcome) || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 900000) return;
    // The diagnostic suite has exactly two fixture calls: cold and warm.
    if (!owners.has(value.owner) && owners.size >= 2) return;
    owners.add(value.owner); rows++;
    emit({ kind: 'stage', owner: value.owner, stage: value.stage, outcome: value.outcome, elapsedMs: value.elapsedMs });
  } catch { /* discard raw output; no fallback serialization */ }
};
let child, timeout, kill;
let timedOut = false, escalated = false, finished = false, spawnFailed = false, exitCode = null;
const finish = () => {
  if (finished || (timedOut && !escalated)) return;
  finished = true;
  clearTimeout(timeout); clearTimeout(kill);
  for (const owner of owners) {
    const name = `noodara-sshd-${ubuntu}-${owner}`;
    const remove = docker(['rm','-f','-v',name]);
    const remaining = docker(['ps','-aq','--filter',`name=^/${name}$`]);
    emit({ kind: 'owned_container_cleanup', owner, outcome: remaining.status === 0 && remaining.stdout.trim() === '' ? 'absent' : 'unconfirmed', removeSucceeded: remove.status === 0 });
    const image = docker(['image','rm',`noodara-test/sshd-diagnostics:${owner}`]);
    emit({ kind: 'owned_image_cleanup', owner, outcome: image.status === 0 ? 'removed' : 'unconfirmed' });
  }
  emit({ kind: 'process', outcome: spawnFailed ? 'spawn_failure' : timedOut ? 'timeout' : exitCode === 0 ? 'success' : 'failure', exitCode });
  process.exitCode = spawnFailed || timedOut || exitCode !== 0 ? 1 : 0;
};
const signalGroup = (signal) => {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) return;
  try { process.kill(-child.pid, signal); } catch { /* process may already be gone */ }
};
try {
  child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs','run','--config','docs/testing/ssh-fixture-timeouts/runner.config.ts'], { detached: true, stdio: ['ignore','pipe','pipe'] });
} catch { spawnFailed = true; finish(); }
if (child) {
  child.stdout.on('data', (chunk) => {
    if (finished) return;
    // Bounded line parser even for arbitrary output without newlines.
    for (const char of chunk.toString()) {
      if (char === '\n') { if (!dropping) accept(buffer); buffer = ''; dropping = false; }
      else if (!dropping) { if (buffer.length < 2048) buffer += char; else { buffer = ''; dropping = true; } }
    }
  });
  child.stderr.on('data', () => {});
  timeout = setTimeout(() => {
    timedOut = true;
    emit({ kind: 'outer_deadline', elapsedMs: 420000 });
    signalGroup('SIGTERM');
  }, 420000);
  kill = setTimeout(() => {
    if (timedOut) {
      signalGroup('SIGKILL'); escalated = true;
      finish();
    }
  }, 425000);
  child.on('error', () => { spawnFailed = true; finish(); });
  child.on('close', (code) => { exitCode = code; finish(); });
}
