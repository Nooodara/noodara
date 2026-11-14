import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  build: vi.fn(), postgresStop: vi.fn(), redisStop: vi.fn(), postgresStart: vi.fn(), redisStart: vi.fn(),
  spawns: [] as { env: NodeJS.ProcessEnv; args: string[]; proc: { killGroup: () => Promise<void> } }[],
  race: undefined as undefined | 'api' | 'web',
  inject: undefined as undefined | (() => Promise<void>),
}));
vi.mock('../../integration/helpers/postgres.js', () => ({ startPostgres: state.postgresStart }));
vi.mock('../../integration/helpers/redis.js', () => ({ startRedis: state.redisStart }));
vi.mock('../../integration/helpers/ssh.js', () => ({ startSshd: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn((_cmd, _args, _opts, callback) => callback(null, { stdout: '', stderr: '' })) };
});
vi.mock('../../integration/helpers/boot-process.js', async (original) => {
  const actual = await original<typeof import('../../integration/helpers/boot-process.js')>();
  return {
    ...actual, buildWorkspace: state.build, buildValidBootEnv: () => ({}),
    spawnBootProcess: (options: import('../../integration/helpers/boot-process.js').SpawnBootProcessOptions) => {
      const kind = options.args.includes('next') ? 'web' : options.args.some((arg) => arg.endsWith('worker.js')) ? 'worker' : 'api';
      // Real owned Node process: binding failure exits, so foreign HTTP success cannot count as readiness.
      const script = kind === 'worker'
        ? "console.log('Worker ready'); setInterval(() => {}, 1000)"
        : `require('node:net').createServer().listen(Number(process.env.PORT), () => console.log(${JSON.stringify(kind === 'api' ? `Server listening at http://localhost:${options.env.PORT ?? ''}` : 'Ready in 1ms')}))`;
      const proc = new actual.BootProcess({ ...options, command: process.execPath, args: ['-e', script] });
      const originalWait = proc.waitForStdoutMatch.bind(proc);
      proc.waitForStdoutMatch = async (pattern, timeout) => {
        const result = await originalWait(pattern, Math.min(timeout, 2_000));
        if (kind === 'worker' && state.race === 'web') await state.inject?.();
        return result;
      };
      vi.spyOn(proc, 'killGroup');
      state.spawns.push({ env: options.env, args: options.args, proc });
      return proc;
    },
  };
});
import { startStack, stopStack, type Stack } from '../../e2e/fixtures/stack.js';

let dir: string;
let running: Stack | undefined;
const foreign: net.Server[] = [];
async function listen(port = 0): Promise<number> {
  const server = net.createServer((socket) => socket.end('foreign-listener'));
  foreign.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, resolve); });
  return (server.address() as net.AddressInfo).port;
}
// Both listeners stay open until both ports are known: releasing the first before asking for the
// second lets the OS hand the same ephemeral port back, which the stack rejects as non-distinct.
async function distinctFreePorts(): Promise<[number, number]> {
  const first = await listen();
  const second = await listen();
  const servers = foreign.splice(-2);
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  return [first, second];
}
async function responds(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port);
    let body = '';
    socket.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    socket.on('end', () => resolve(body));
    socket.on('error', reject);
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.spawns.length = 0;
  state.race = undefined;
  state.inject = undefined;
  dir = mkdtempSync(path.join(tmpdir(), 'noodara-stack-unit-'));
  vi.stubEnv('NOODARA_E2E_RUN_DIR', dir);
  vi.stubEnv('NOODARA_API_ORIGIN', process.env.NOODARA_API_ORIGIN);
  vi.stubEnv('NOODARA_PUBLIC_URL', process.env.NOODARA_PUBLIC_URL);
  const [webPort, apiPort] = await distinctFreePorts();
  vi.stubEnv('NOODARA_E2E_WEB_PORT', String(webPort));
  vi.stubEnv('NOODARA_E2E_API_PORT', String(apiPort));
  state.postgresStart.mockResolvedValue({ connectionString: 'fixture-db', stop: state.postgresStop, container: { getId: () => 'fixture-postgres' } });
  state.redisStart.mockImplementation(async () => {
    if (state.race === 'api') await state.inject?.();
    return { connectionUrl: 'fixture-redis', stop: state.redisStop, container: { getId: () => 'fixture-redis' } };
  });
});
afterEach(async () => {
  if (running !== undefined) await stopStack(running);
  running = undefined;
  await Promise.allSettled(state.spawns.map(({ proc }) => proc.killGroup()));
  await Promise.all(foreign.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('selected-port stack lifecycle', () => {
  it('rejects invalid selections before builds or resources without echoing input', async () => {
    vi.stubEnv('NOODARA_E2E_WEB_PORT', 'synthetic-sensitive-invalid');
    await expect(startStack()).rejects.toThrow('NOODARA_E2E_WEB_PORT');
    expect(state.build).not.toHaveBeenCalled();
    expect(state.postgresStart).not.toHaveBeenCalled();
  });
  it.each(['NOODARA_E2E_WEB_PORT', 'NOODARA_E2E_API_PORT'])('preflights only selected %s and leaves its listener alive', async (name) => {
    const port = Number(process.env[name]);
    await listen(port);
    await expect(startStack()).rejects.toThrow(`host ports in use: ${String(port)}`);
    expect(state.build).not.toHaveBeenCalled();
    expect(state.postgresStart).not.toHaveBeenCalled();
    expect(await responds(port)).toBe('foreign-listener');
  });
  it('cleans up postgres when redis startup fails', async () => {
    state.redisStart.mockRejectedValueOnce(new Error('fixture failure'));
    await expect(startStack()).rejects.toThrow('fixture failure');
    expect(state.postgresStop).toHaveBeenCalledOnce();
    expect(state.spawns).toHaveLength(0);
  });
  it.each(['api', 'web'] as const)('survives a foreign %s check/bind race and cleans every owned handle', async (kind) => {
    state.race = kind;
    const port = Number(process.env[kind === 'api' ? 'NOODARA_E2E_API_PORT' : 'NOODARA_E2E_WEB_PORT']);
    state.inject = async () => { await listen(port); };
    await expect(startStack()).rejects.toThrow(`on port ${String(port)} did not become ready within 60000ms`);
    expect(state.build).toHaveBeenCalledOnce();
    expect(state.spawns).toHaveLength(kind === 'api' ? 1 : 3);
    for (const { proc } of state.spawns) expect(proc.killGroup).toHaveBeenCalledOnce();
    expect(state.postgresStop).toHaveBeenCalledOnce();
    expect(state.redisStop).toHaveBeenCalledOnce();
    expect(await responds(port)).toBe('foreign-listener');
    const otherPort = Number(process.env[kind === 'api' ? 'NOODARA_E2E_WEB_PORT' : 'NOODARA_E2E_API_PORT']);
    await listen(otherPort);
    await stopStack({ baseUrl: 'unused', adminEmail: '', adminPassword: '' });
  });
  it('propagates selected origins to build, API, worker and explicit Next binding; teardown is idempotent', async () => {
    const webPort = Number(process.env.NOODARA_E2E_WEB_PORT);
    const apiPort = Number(process.env.NOODARA_E2E_API_PORT);
    state.build.mockImplementationOnce(() => {
      expect(process.env.NOODARA_API_ORIGIN).toBe(`http://localhost:${String(apiPort)}`);
      expect(process.env.NOODARA_PUBLIC_URL).toBe(`http://localhost:${String(webPort)}`);
    });
    running = await startStack();
    expect(running.baseUrl).toBe(`http://localhost:${String(webPort)}`);
    expect(state.spawns).toHaveLength(3);
    for (const { env } of state.spawns) {
      expect(env.NOODARA_API_ORIGIN).toBe(`http://localhost:${String(apiPort)}`);
      expect(env.NOODARA_PUBLIC_URL).toBe(running.baseUrl);
    }
    expect(state.spawns.map(({ env }) => env.PORT)).toEqual([String(apiPort), String(apiPort), String(webPort)]);
    expect(state.spawns[2]?.args).toEqual(['--filter', '@noodara/web', 'exec', 'next', 'start', '--port', String(webPort)]);
    await stopStack(running);
    await stopStack(running);
    expect(state.postgresStop).toHaveBeenCalledOnce();
    expect(state.redisStop).toHaveBeenCalledOnce();
    for (const { proc } of state.spawns) expect(proc.killGroup).toHaveBeenCalledOnce();
    // Both selected ports really bind again after cleanup.
    await listen(webPort);
    await listen(apiPort);
    running = undefined;
  });
});
