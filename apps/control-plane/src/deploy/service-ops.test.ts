// 12-14: stop / restart / remove of a deployed service and the remote cleanup of a deleted one.
import { createRedactor } from '@noodara/domain/security';
import type { RemoteCommand, SshDeploySession, StreamOptions, StreamResult } from '@noodara/ssh';
import { describe, expect, it, vi } from 'vitest';
import {
  cleanupServiceRemote,
  createServiceRemoteCleanup,
  DEFAULT_SERVICE_OPS_LIMITS,
  MAX_CLEANUP_DEPLOYMENTS,
  runServiceOperation,
  SERVICE_OPS_MESSAGES,
} from './service-ops.js';

const SERVICE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OTHER_SERVICE_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const DEP_NEW = '3f2b8c1e-9d4a-4f6b-8a2c-1e5d7f9b0c3a';
const DEP_OLD = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SERVER_ID = '5d6e7f80-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
const CONTAINER = `noodara-${SERVICE_ID}`;
const RAW = 'permission denied for user root password=hunter2 at /var/lib/docker';

interface Script {
  readonly outcome?: StreamResult['outcome'];
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly reject?: Error;
}

function psLine(state: string, name = CONTAINER, serviceId = SERVICE_ID): string {
  return JSON.stringify({
    ID: 'b'.repeat(64),
    Image: `noodara/${serviceId}:${DEP_NEW}`,
    Names: name,
    State: state,
    Status: state === 'running' ? 'Up 2 hours' : 'Exited (0) 1 minute ago',
    Labels: `noodara.managed=true,noodara.service_id=${serviceId}`,
    Ports: '',
  });
}

class FakeSession {
  readonly calls: { name: string; argv: readonly string[]; options: StreamOptions }[] = [];
  private readonly cursors = new Map<string, number>();
  constructor(private readonly scripts: Record<string, Script | Script[]> = {}) {}

  exec(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  stream(command: RemoteCommand, options: StreamOptions): Promise<StreamResult> {
    this.calls.push({ name: command.name, argv: command.argv, options });
    const entry = this.scripts[command.name] ?? {};
    let script: Script;
    if (Array.isArray(entry)) {
      const index = this.cursors.get(command.name) ?? 0;
      this.cursors.set(command.name, index + 1);
      script = entry[Math.min(index, entry.length - 1)] ?? {};
    } else {
      script = entry;
    }
    if (script.reject !== undefined) return Promise.reject(script.reject);
    const stdout = script.stdout ?? '';
    const stderr = script.stderr ?? '';
    let seq = 0;
    if (stdout.length > 0) options.onChunk({ stream: 'stdout', text: stdout, seq: seq++, truncatedLine: false });
    if (stderr.length > 0) options.onChunk({ stream: 'stderr', text: stderr, seq: seq++, truncatedLine: false });
    return Promise.resolve({
      commandName: command.name,
      outcome: script.outcome ?? 'completed',
      exitCode: script.exitCode === undefined ? 0 : script.exitCode,
      exitSignal: null,
      durationMs: 1,
      totalBytes: stdout.length + stderr.length,
      truncated: false,
      stdoutTail: stdout,
      stderrTail: stderr,
    });
  }

  names(): string[] {
    return this.calls.map((call) => call.name);
  }

  asSession(): SshDeploySession {
    return this;
  }
}

function op(session: FakeSession, operation: 'stop' | 'restart' | 'remove', serviceId = SERVICE_ID) {
  return runServiceOperation({
    session: session.asSession(),
    redactor: createRedactor(),
    serviceId,
    operation,
    limits: DEFAULT_SERVICE_OPS_LIMITS,
  });
}

function cleanup(session: FakeSession, deploymentIds: readonly string[] = [DEP_NEW, DEP_OLD]) {
  return cleanupServiceRemote({
    session: session.asSession(),
    redactor: createRedactor(),
    serviceId: SERVICE_ID,
    deploymentIds,
    limits: DEFAULT_SERVICE_OPS_LIMITS,
  });
}

describe('runServiceOperation', () => {
  it('observes first, then stops the container and re-observes it stopped', async () => {
    const session = new FakeSession({ 'docker.ps': [{ stdout: psLine('running') }, { stdout: psLine('exited') }] });

    const result = await op(session, 'stop');

    expect(session.names()).toEqual(['docker.ps', 'docker.stop', 'docker.ps']);
    expect(session.calls[1]?.argv).toEqual(['docker', 'stop', '--timeout', '10', '--', CONTAINER]);
    expect(result).toMatchObject({
      ok: true,
      operation: 'stop',
      previousState: 'running',
      container: { kind: 'stopped' },
    });
  });

  it('restarts a stopped container', async () => {
    const session = new FakeSession({ 'docker.ps': [{ stdout: psLine('exited') }, { stdout: psLine('running') }] });

    const result = await op(session, 'restart');

    expect(session.names()).toEqual(['docker.ps', 'docker.restart', 'docker.ps']);
    expect(result).toMatchObject({ ok: true, previousState: 'exited', container: { kind: 'running' } });
  });

  it('remove stops a running container before removing it, and reports it absent', async () => {
    const session = new FakeSession({ 'docker.ps': [{ stdout: psLine('running') }, { stdout: '' }] });

    const result = await op(session, 'remove');

    expect(session.names()).toEqual(['docker.ps', 'docker.stop', 'docker.remove', 'docker.ps']);
    expect(result).toMatchObject({ ok: true, container: { kind: 'absent' } });
  });

  it('remove of an already stopped container skips the stop', async () => {
    const session = new FakeSession({ 'docker.ps': [{ stdout: psLine('exited') }, { stdout: '' }] });

    await op(session, 'remove');

    expect(session.names()).toEqual(['docker.ps', 'docker.remove', 'docker.ps']);
  });

  it('reports CONTAINER_NOT_FOUND without touching anything when the container is absent', async () => {
    const session = new FakeSession({
      'docker.ps': { stdout: psLine('running', `noodara-${OTHER_SERVICE_ID}`, OTHER_SERVICE_ID) },
    });

    const result = await op(session, 'stop');

    expect(session.names()).toEqual(['docker.ps']);
    expect(result).toMatchObject({ ok: false, code: 'CONTAINER_NOT_FOUND', message: SERVICE_OPS_MESSAGES.CONTAINER_NOT_FOUND });
  });

  it('reports an unknown container when the post-operation observation fails', async () => {
    const session = new FakeSession({
      'docker.ps': [{ stdout: psLine('running') }, { reject: new Error('ECONNRESET') }],
    });

    const result = await op(session, 'stop');

    expect(result).toMatchObject({ ok: true, container: { kind: 'unknown' } });
  });

  it.each([
    ['a thrown stream (SSH dropped)', { 'docker.ps': { reject: new Error(RAW) } }, 'SERVER_UNREACHABLE'],
    ['an unreachable daemon', { 'docker.ps': { exitCode: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' } }, 'SERVER_DOCKER_UNAVAILABLE'],
    ['docker missing', { 'docker.ps': { exitCode: 127, stderr: 'docker: command not found' } }, 'SERVER_DOCKER_UNAVAILABLE'],
    ['a timed out ps', { 'docker.ps': { outcome: 'timed_out', exitCode: null } }, 'SERVICE_OPERATION_TIMEOUT'],
    ['a failing stop', { 'docker.ps': { stdout: psLine('running') }, 'docker.stop': { exitCode: 1, stderr: RAW } }, 'SERVICE_OPERATION_FAILED'],
    ['a stalled stop', { 'docker.ps': { stdout: psLine('running') }, 'docker.stop': { outcome: 'idle_timeout', exitCode: null } }, 'SERVICE_OPERATION_TIMEOUT'],
    ['a stop that throws', { 'docker.ps': { stdout: psLine('running') }, 'docker.stop': { reject: new Error(RAW) } }, 'SERVER_UNREACHABLE'],
  ] as const)('maps %s to %s with a fixed message, never the raw output', async (_label, scripts, code) => {
    const session = new FakeSession(scripts);

    const result = await op(session, 'stop');

    expect(result).toMatchObject({ ok: false, code, message: SERVICE_OPS_MESSAGES[code] });
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(JSON.stringify(result)).not.toContain('/var/lib/docker');
  });

  it('rejects an invalid service id as a failure, never a remote call', async () => {
    const session = new FakeSession();

    const result = await op(session, 'stop', 'not-a-uuid; rm -rf /');

    expect(session.names()).toEqual([]);
    expect(result).toMatchObject({ ok: false, code: 'SERVICE_OPERATION_FAILED' });
  });
});

describe('cleanupServiceRemote', () => {
  it('removes the container, the network, then each deployment image and workspace', async () => {
    const session = new FakeSession({ 'docker.ps': { stdout: psLine('running') } });

    const result = await cleanup(session);

    expect(result).toEqual({ ok: true });
    expect(session.names()).toEqual([
      'docker.ps',
      'docker.stop',
      'docker.remove',
      'docker.network_remove',
      'docker.image_remove',
      'fs.remove_deploy_dir',
      'docker.image_remove',
      'fs.remove_deploy_dir',
    ]);
    const argv = session.calls.map((call) => call.argv.join(' '));
    expect(argv[3]).toContain(`noodara-net-${SERVICE_ID}`);
    expect(argv[4]).toContain(`noodara/${SERVICE_ID}:${DEP_NEW}`);
    expect(argv[5]).toContain(DEP_NEW);
    expect(argv[6]).toContain(`noodara/${SERVICE_ID}:${DEP_OLD}`);
  });

  it('is idempotent: an absent container, network, image and workspace all count as settled', async () => {
    const session = new FakeSession({
      'docker.ps': { stdout: '' },
      'docker.network_remove': { exitCode: 1, stderr: `Error: No such network: noodara-net-${SERVICE_ID}` },
      'docker.image_remove': { exitCode: 1, stderr: 'Error: No such image: x' },
      'fs.remove_deploy_dir': { exitCode: 1, stderr: 'rm: cannot remove: No such file or directory' },
    });

    const result = await cleanup(session);

    expect(result).toEqual({ ok: true });
    expect(session.names()).not.toContain('docker.stop');
    expect(session.names()).not.toContain('docker.remove');
  });

  it('only touches the network when the service was never claimed (no deployment ids)', async () => {
    const session = new FakeSession({ 'docker.ps': { stdout: '' } });

    await cleanup(session, []);

    expect(session.names()).toEqual(['docker.ps', 'docker.network_remove']);
  });

  it(`caps the per-deployment removals at ${String(MAX_CLEANUP_DEPLOYMENTS)} and skips invalid ids`, async () => {
    const session = new FakeSession({ 'docker.ps': { stdout: '' } });
    const ids = Array.from({ length: MAX_CLEANUP_DEPLOYMENTS + 5 }, () => DEP_NEW);

    await cleanup(session, ['../../etc', ...ids]);

    expect(session.names().filter((name) => name === 'docker.image_remove')).toHaveLength(MAX_CLEANUP_DEPLOYMENTS);
    expect(session.calls.some((call) => call.argv.join(' ').includes('etc'))).toBe(false);
  });

  it.each([
    ['a thrown ps', { 'docker.ps': { reject: new Error(RAW) } }, 'SERVER_UNREACHABLE'],
    ['an unreachable daemon', { 'docker.ps': { exitCode: 1, stderr: 'Cannot connect to the Docker daemon' } }, 'SERVER_DOCKER_UNAVAILABLE'],
    ['a failing rm', { 'docker.ps': { stdout: psLine('exited') }, 'docker.remove': { exitCode: 1, stderr: RAW } }, 'SERVICE_CLEANUP_FAILED'],
    ['a network still in use', { 'docker.ps': { stdout: '' }, 'docker.network_remove': { exitCode: 1, stderr: RAW } }, 'SERVICE_CLEANUP_FAILED'],
    ['a failing workspace removal', { 'docker.ps': { stdout: '' }, 'fs.remove_deploy_dir': { exitCode: 1, stderr: RAW } }, 'SERVICE_CLEANUP_FAILED'],
    ['a timed out image removal', { 'docker.ps': { stdout: '' }, 'docker.image_remove': { outcome: 'timed_out', exitCode: null } }, 'SERVICE_CLEANUP_FAILED'],
    ['a thrown image removal', { 'docker.ps': { stdout: '' }, 'docker.image_remove': { reject: new Error(RAW) } }, 'SERVER_UNREACHABLE'],
  ] as const)('maps %s to %s and stops there', async (_label, scripts, code) => {
    const session = new FakeSession(scripts);

    const result = await cleanup(session);

    expect(result).toEqual({ ok: false, code, message: SERVICE_OPS_MESSAGES[code] });
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('keeps an image in use by another container as settled, never forcing it', async () => {
    const session = new FakeSession({
      'docker.ps': { stdout: '' },
      'docker.image_remove': { exitCode: 1, stderr: 'conflict: unable to remove repository reference (must force) - container abc is using its referenced image' },
    });

    expect(await cleanup(session)).toEqual({ ok: true });
    const all = session.calls.filter((call) => call.name === 'docker.image_remove').flatMap((call) => [...call.argv]);
    expect(all).not.toContain('--force');
  });
});

describe('createServiceRemoteCleanup (the port)', () => {
  function port(connect: Parameters<typeof createServiceRemoteCleanup>[0]['connect']) {
    return createServiceRemoteCleanup({ connect, createRedactor, limits: DEFAULT_SERVICE_OPS_LIMITS });
  }

  it('connects to the service server, cleans up, and always closes', async () => {
    const session = new FakeSession({ 'docker.ps': { stdout: '' } });
    const close = vi.fn(() => Promise.resolve());
    const connect = vi.fn(() => Promise.resolve({ ok: true as const, session: session.asSession(), close }));

    const result = await port(connect)({ serverId: SERVER_ID, serviceId: SERVICE_ID, deploymentIds: [] });

    expect(result).toEqual({ ok: true });
    expect(connect).toHaveBeenCalledWith(SERVER_ID, expect.anything(), undefined);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    ['SERVER_UNREACHABLE', 'SERVER_UNREACHABLE'],
    ['DOCKER_UNAVAILABLE', 'SERVER_DOCKER_UNAVAILABLE'],
    ['REPOSITORY_AUTH_FAILED', 'SERVER_UNREACHABLE'],
  ] as const)('maps a %s connect failure to %s', async (connectCode, code) => {
    const connect = vi.fn(() => Promise.resolve({ ok: false as const, code: connectCode }));

    const result = await port(connect)({ serverId: SERVER_ID, serviceId: SERVICE_ID, deploymentIds: [] });

    expect(result).toEqual({ ok: false, code, message: SERVICE_OPS_MESSAGES[code] });
  });

  it('never throws: a rejected connect or close is SERVER_UNREACHABLE / ignored', async () => {
    const rejected = await port(() => Promise.reject(new Error(RAW)))({ serverId: SERVER_ID, serviceId: SERVICE_ID, deploymentIds: [] });
    expect(rejected).toEqual({ ok: false, code: 'SERVER_UNREACHABLE', message: SERVICE_OPS_MESSAGES.SERVER_UNREACHABLE });

    const session = new FakeSession({ 'docker.ps': { stdout: '' } });
    const closeFails = await port(() =>
      Promise.resolve({ ok: true as const, session: session.asSession(), close: () => Promise.reject(new Error('closed')) }),
    )({ serverId: SERVER_ID, serviceId: SERVICE_ID, deploymentIds: [] });
    expect(closeFails).toEqual({ ok: true });
  });
});
