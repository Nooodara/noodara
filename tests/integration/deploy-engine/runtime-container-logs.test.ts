// 12-16 (A1-A3, H1): runtime container logs on the real sshd + dockerd fixture, over real HTTP.
// The routes are servicesRoutes on a minimal Fastify with the service lookup faked (no database:
// the reader only needs the server id) and createContainerLogs connected over a pinned SSH
// session, the same shape app.ts builds. Root-side truth comes from `stack.exec`: after a follow
// ends (max duration or client abort) no `docker logs` process and no run dir may remain.
// App modules are imported dynamically after a valid test env is written: some import env.ts,
// which fail-fasts at import time (INST-06).
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedactor, secretValue } from '@noodara/domain/security';
import { createSsh2Adapter, type HostFingerprint } from '@noodara/ssh';
import type { ContainerLogs } from '../../../apps/control-plane/src/services/container-logs.js';
import type { ServiceServices } from '../../../apps/control-plane/src/services/service-services.js';
import { DEPLOY_ENGINE_UBUNTU_VERSIONS, startDeployEngineStack, type DeployEngineStack } from '../helpers/deploy-engine.js';

type ContainerLogsModule = typeof import('../../../apps/control-plane/src/services/container-logs.js');
type ServicesRoutesModule = typeof import('../../../apps/control-plane/src/routes/services.js');
/** The slice of a Fastify instance this test drives (fastify is not a root dependency). */
interface TestServer {
  setValidatorCompiler(compiler: unknown): void;
  setSerializerCompiler(compiler: unknown): void;
  decorateRequest(name: string, value: unknown): void;
  decorate(name: string, value: unknown): void;
  addHook(name: 'onRequest', hook: (request: { actor: unknown }) => Promise<void>): void;
  addHook(name: 'preClose', hook: () => Promise<void>): void;
  register(plugin: unknown): Promise<unknown>;
  listen(options: { host: string; port: number }): Promise<string>;
  close(): Promise<void>;
  readonly server: { address(): AddressInfo | string | null };
}
type FastifyFactory = () => TestServer;
interface ZodProviderModule {
  readonly validatorCompiler: unknown;
  readonly serializerCompiler: unknown;
}

// fastify and its zod provider are control-plane dependencies, not root ones.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const controlPlaneRequire = createRequire(path.resolve(HERE, '../../../apps/control-plane/package.json'));
async function importFromControlPlane<T>(specifier: string): Promise<T> {
  return (await import(pathToFileURL(controlPlaneRequire.resolve(specifier)).href)) as T;
}

const STACK_TIMEOUT_MS = 900_000;
const CASE_TIMEOUT_MS = 120_000;
const FOLLOW_MAX_MS = 4_000;
const KILL_CONFIRM_MS = 15_000;
const RUN_ROOT = '/opt/noodara-deploy';
const USER_ID = 'runtime-logs-user';
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
// eslint-disable-next-line no-control-regex -- the point is to prove none reach the client
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
/** ANSI-coloured first line, a line with binary bytes, then a tick every 200 ms. */
const CHATTY_SCRIPT = [
  'process.stdout.write("\\x1b[31mred-line\\x1b[0m\\n");',
  'process.stdout.write("bin\\x00\\x07-end\\n");',
  'let i = 0;',
  'setInterval(() => { process.stdout.write("tick " + String(i++) + "\\n"); }, 200);',
].join(' ');

interface LineFrame {
  readonly type: 'line';
  readonly stream: string;
  readonly timestamp: string | null;
  readonly text: string;
}
interface EndFrame {
  readonly type: 'end';
  readonly reason: string;
}
type Frame = LineFrame | EndFrame;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseFrames(body: string): Frame[] {
  return body
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Frame);
}

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('runtime container logs on Ubuntu %s (12-16)', (ubuntu) => {
  let stack: DeployEngineStack | undefined;
  let app: TestServer | undefined;
  let logs: ContainerLogs | undefined;
  let baseUrl = '';
  const projectId = randomUUID();
  const serviceId = randomUUID();
  /** A service whose container was never created. */
  const missingServiceId = randomUUID();
  const serverId = randomUUID();
  const streamIds: string[] = [];
  const startedContainers: string[] = [];

  const s = (): DeployEngineStack => {
    if (!stack) throw new Error('stack not started');
    return stack;
  };
  const root = (argv: readonly string[]) => s().exec(argv, { user: 'root' });
  const url = (suffix: string, id = serviceId): string =>
    `${baseUrl}/api/projects/${projectId}/services/${id}/logs${suffix}`;

  /** No `docker logs` process left on the server (pgrep exits 1 on no match). */
  async function expectNoDockerLogs(): Promise<void> {
    const deadline = Date.now() + KILL_CONFIRM_MS;
    let last = await root(['pgrep', '-f', 'docker logs']);
    while (last.exitCode === 0 && Date.now() < deadline) {
      await delay(250);
      last = await root(['pgrep', '-f', 'docker logs']);
    }
    expect(last.exitCode, `docker logs still running: ${last.stdout}`).toBe(1);
  }

  async function expectRunDirGone(streamId: string): Promise<void> {
    const listed = await root(['test', '-e', `${RUN_ROOT}/${streamId}`]);
    expect(listed.exitCode).not.toBe(0);
  }

  beforeAll(async () => {
    stack = await startDeployEngineStack({ ubuntu });

    process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
    process.env.BETTER_AUTH_SECRET = `runtime-container-logs-${randomUUID()}-${randomUUID()}`;
    process.env.DATABASE_URL ??= 'postgres://noodara:noodara@127.0.0.1:1/noodara';
    process.env.REDIS_URL ??= 'redis://127.0.0.1:1';
    process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';
    const containerLogs: ContainerLogsModule = await import('../../../apps/control-plane/src/services/container-logs.js');
    const routes: ServicesRoutesModule = await import('../../../apps/control-plane/src/routes/services.js');

    // Pin the host key from a first trusted connect, as a CONNECTED server row would.
    const ssh = createSsh2Adapter();
    const sshInput = {
      target: { host: s().ssh.host, port: s().ssh.port, user: s().ssh.user },
      credential: { kind: 'private_key' as const, privateKey: secretValue(s().ssh.privateKey, 'ssh_private_key') },
      timeouts: { connectMs: 20_000, commandMs: 60_000, discoveryMs: 120_000 },
    };
    const probe = await ssh.connect({ ...sshInput, trustedFingerprint: null, redactor: createRedactor() });
    if (!probe.ok) throw new Error(`fingerprint probe failed: ${probe.errorCode}`);
    const fingerprint: HostFingerprint = probe.fingerprint;
    await probe.session.close();

    logs = containerLogs.createContainerLogs({
      connect: async (_serverId, redactor) => {
        const outcome = await ssh.connect({ ...sshInput, trustedFingerprint: fingerprint, redactor });
        if (!outcome.ok) return { ok: false, code: 'SERVER_UNREACHABLE' };
        const { session } = outcome;
        return { ok: true, session, close: () => session.close() };
      },
      createRedactor,
      limits: {
        ...containerLogs.DEFAULT_CONTAINER_LOGS_LIMITS,
        followMaxMs: FOLLOW_MAX_MS,
        killConfirmTimeoutMs: KILL_CONFIRM_MS,
        killPollIntervalMs: 100,
      },
      newStreamId: () => {
        const id = randomUUID();
        streamIds.push(id);
        return id;
      },
    });

    // The service's container, managed-labelled as a deploy would leave it.
    const name = `noodara-${serviceId}`;
    const nodeBase = s().baseImages.find((ref) => ref.startsWith('node:'));
    if (nodeBase === undefined) throw new Error('harness preloaded no node base image');
    const run = await root([
      'docker', 'run', '-d', '--name', name,
      '--label', 'noodara.managed=true',
      '--label', `noodara.service_id=${serviceId}`,
      '--label', 'noodara.test=true',
      nodeBase, 'node', '-e', CHATTY_SCRIPT,
    ]);
    if (run.exitCode !== 0) throw new Error(`docker run ${name} failed: ${run.stderr}`);
    startedContainers.push(name);

    const known = new Set<string>([serviceId, missingServiceId]);
    const fakeServices = {
      getService: (pid: string, sid: string) =>
        Promise.resolve(pid === projectId && known.has(sid) ? { id: sid, serverId } : null),
    } as unknown as ServiceServices;
    const fastify = await importFromControlPlane<{ default: FastifyFactory }>('fastify');
    const zodProvider = await importFromControlPlane<ZodProviderModule>('@fastify/type-provider-zod');
    const instance = fastify.default();
    instance.setValidatorCompiler(zodProvider.validatorCompiler);
    instance.setSerializerCompiler(zodProvider.serializerCompiler);
    instance.decorateRequest('actor', null);
    instance.addHook('onRequest', async (request) => {
      request.actor = { type: 'user', id: USER_ID };
    });
    instance.decorate('getServiceServices', () => Promise.resolve(fakeServices));
    const reader = logs;
    instance.decorate('getContainerLogs', () => reader);
    instance.addHook('preClose', async () => {
      await reader.closeAll();
    });
    await instance.register(routes.default);
    await instance.listen({ host: '127.0.0.1', port: 0 });
    app = instance;
    baseUrl = `http://127.0.0.1:${String((instance.server.address() as AddressInfo).port)}`;

    // Wait for a few ticks so a tail has something to cut.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const out = await root(['docker', 'logs', name]);
      if ((out.stdout.match(/tick /g) ?? []).length >= 5) break;
      await delay(250);
    }
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    await logs?.closeAll();
    await app?.close();
    for (const name of startedContainers) {
      await root(['docker', 'rm', '-f', name]).catch(() => undefined);
    }
    await stack?.stop();
  }, STACK_TIMEOUT_MS);

  it('A1: tail returns the last N lines with timestamps; the default tail returns the whole short log', async () => {
    const response = await fetch(url('?tail=3'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { lines: LineFrame[]; truncated: boolean };
    expect(body.lines).toHaveLength(3);
    expect(body.truncated).toBe(false);
    for (const line of body.lines) {
      expect(line.stream).toBe('stdout');
      expect(line.timestamp).toMatch(TIMESTAMP);
      expect(line.text).toMatch(/^tick \d+$/);
    }

    const all = (await (await fetch(url(''))).json()) as { lines: LineFrame[] };
    expect(all.lines.length).toBeGreaterThan(3);
    expect(all.lines.at(-1)?.text).toMatch(/^tick \d+$/);
  }, CASE_TIMEOUT_MS);

  it('A3: ANSI escapes and binary bytes never reach the client', async () => {
    const body = (await (await fetch(url(''))).json()) as { lines: LineFrame[] };
    const texts = body.lines.map((line) => line.text);
    expect(texts[0]).toContain('red-line');
    expect(texts[1]).toContain('bin');
    for (const text of texts) expect(text).not.toMatch(CONTROL);
    expect(JSON.stringify(body)).not.toContain('[31m');
  }, CASE_TIMEOUT_MS);

  it('H1: tail outside 1..10000 or not an integer is a named 422; no SSH work is done', async () => {
    for (const raw of ['0', '-1', 'abc', '1.5', '10001', '']) {
      const response = await fetch(url(`?tail=${encodeURIComponent(raw)}`));
      expect(response.status, raw).toBe(422);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe('RUNTIME_LOG_TAIL_INVALID');
    }
    const follow = await fetch(url('/follow?tail=0'));
    expect(follow.status).toBe(422);
  }, CASE_TIMEOUT_MS);

  it('ERR: a service without a container is CONTAINER_NOT_FOUND (409); an unknown service is 404', async () => {
    const missing = await fetch(url('?tail=5', missingServiceId));
    expect(missing.status).toBe(409);
    expect(((await missing.json()) as { error: string }).error).toBe('CONTAINER_NOT_FOUND');

    const followMissing = await fetch(url('/follow?tail=5', missingServiceId));
    expect(followMissing.status).toBe(409);
    expect(logs?.activeFollows()).toBe(0);

    const unknown = await fetch(url('?tail=5', randomUUID()));
    expect(unknown.status).toBe(404);
  }, CASE_TIMEOUT_MS);

  it('A2: follow streams live lines and ends at the max duration, killing the remote docker logs', async () => {
    const before = streamIds.length;
    const startedAt = Date.now();
    const response = await fetch(url('/follow?tail=1'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    const frames = parseFrames(await response.text());
    const elapsed = Date.now() - startedAt;

    const lines = frames.filter((frame): frame is LineFrame => frame.type === 'line');
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) {
      expect(line.timestamp).toMatch(TIMESTAMP);
      expect(line.text).not.toMatch(CONTROL);
    }
    expect(frames.at(-1)).toEqual({ type: 'end', reason: 'max_duration' });
    expect(elapsed).toBeGreaterThanOrEqual(FOLLOW_MAX_MS - 500);
    expect(elapsed).toBeLessThan(FOLLOW_MAX_MS + KILL_CONFIRM_MS);

    await expectNoDockerLogs();
    const streamId = streamIds[before];
    if (streamId === undefined) throw new Error('no follow stream id recorded');
    await expectRunDirGone(streamId);
    expect(logs?.activeFollows()).toBe(0);
  }, CASE_TIMEOUT_MS);

  it('A2: a client that disconnects ends the follow and the remote docker logs is killed', async () => {
    const before = streamIds.length;
    const controller = new AbortController();
    const response = await fetch(url('/follow?tail=1'), { signal: controller.signal });
    expect(response.status).toBe(200);
    if (response.body === null) throw new Error('no body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes('"type":"line"')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
    }
    expect(received).toContain('"type":"line"');
    // Still running remotely while the client reads.
    expect((await root(['pgrep', '-f', 'docker logs'])).exitCode).toBe(0);

    controller.abort();
    await reader.cancel().catch(() => undefined);

    await expectNoDockerLogs();
    const deadline = Date.now() + KILL_CONFIRM_MS;
    while ((logs?.activeFollows() ?? 0) > 0 && Date.now() < deadline) await delay(100);
    expect(logs?.activeFollows()).toBe(0);
    const streamId = streamIds[before];
    if (streamId === undefined) throw new Error('no follow stream id recorded');
    await expectRunDirGone(streamId);
  }, CASE_TIMEOUT_MS);
});
