// Phase 33: production buildApp resolver, real authenticated HTTP, migrated encrypted PostgreSQL
// and pinned SSH to sshd+dockerd. Canary strings are deliberately ordinary, never vendor-shaped.
import { randomBytes, randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { ClientChannel } from '@noodara/ssh/testing';
import type { AddressInfo } from 'node:net';
import { and, eq, sql } from 'drizzle-orm';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { credentials, environments, projects, secrets, servers, services } from '../../../apps/control-plane/src/db/schema/index.js';
import { DEPLOY_ENGINE_UBUNTU_VERSIONS, startDeployEngineStack, type DeployEngineStack } from '../helpers/deploy-engine.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';
import { runTeardown, settleWithin } from '../helpers/teardown.js';

type App = ReturnType<typeof import('../../../apps/control-plane/src/app.js')['buildApp']>;
type Store = typeof import('../../../apps/control-plane/src/secrets/secret-store.js');
type Frame = { type: 'line'; stream: string; text: string; timestamp: string | null } | { type: 'end'; reason: string };
const STACK_TIMEOUT_MS = 900_000;
const CASE_TIMEOUT_MS = 120_000;
const FOLLOW_MS = 10_000;
const CLEANUP_MS = 15_000;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + CLEANUP_MS;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('legacy log cleanup/readiness deadline exceeded');
    await delay(100);
  }
}
function frames(body: string): Frame[] {
  return body.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Frame);
}
interface Follow {
  status: number;
  text(): string;
  done: Promise<void>;
  abort(): void;
}

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('legacy log secret redaction on Ubuntu %s (33-02)', (ubuntu) => {
  let stackStart: Promise<DeployEngineStack> | undefined;
  let postgresStart: Promise<PostgresFixture> | undefined;
  let redisStart: Promise<RedisFixture> | undefined;
  let stack: DeployEngineStack | undefined;
  let postgres: PostgresFixture | undefined;
  let redis: RedisFixture | undefined;
  let app: App | undefined;
  let store: Store;
  let capture: { records(): unknown[] };
  let env: typeof import('../../../apps/control-plane/src/env.js')['env'];
  let closeDb: (() => Promise<void>) | undefined;
  let cookie = '';
  let baseUrl = '';
  let connects = 0;
  let sessions = 0;
  let opens = 0;
  let openings = 0;
  let fragmentedSecrets = 0;
  const masterKey = randomBytes(32);
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const serviceId = randomUUID();
  const finalServiceId = randomUUID();
  const siblingServiceId = randomUUID();
  const otherProjectId = randomUUID();
  const foreignProjectId = randomUUID();
  const otherEnvironmentId = randomUUID();
  const otherServiceId = randomUUID();
  const noSecretServiceId = randomUUID();
  const serverId = randomUUID();
  const values = Array.from({ length: 5 }, (_, i) => `ordinary-${String(i)} ${randomBytes(12).toString('hex')}/+=`);
  const multiline = `${values[3] ?? ''}\r\n${values[4] ?? ''}`;
  const variants = values.flatMap((value) => [value, Buffer.from(value).toString('base64'), encodeURIComponent(value)]);
  variants.push(multiline, Buffer.from(multiline).toString('base64'), encodeURIComponent(multiline));
  const visibleSecretIds: string[] = [];
  const selectedSecretIds: string[][] = [];
  const containers: string[] = [];
  const follows: Follow[] = [];
  const bodies: string[] = [];
  const root = (argv: readonly string[]) => {
    if (!stack) throw new Error('stack not started');
    return stack.exec(argv, { user: 'root' });
  };
  const url = (suffix = '', sid = serviceId, pid = projectId): string => `${baseUrl}/api/projects/${pid}/services/${sid}/logs${suffix}`;
  function safe(raw: string): void {
    // Boolean assertions intentionally prevent a failing RED run from echoing synthetic values.
    expect(variants.some((value) => raw.includes(value)), 'canary escaped redaction').toBe(false);
  }
  async function get(suffix = '', sid = serviceId, pid = projectId, authenticated = true): Promise<{ status: number; raw: string }> {
    const response = await fetch(url(suffix, sid, pid), { headers: authenticated ? { cookie } : {} });
    const raw = await response.text();
    bodies.push(raw);
    safe(raw);
    return { status: response.status, raw };
  }
  async function follow(sid = serviceId): Promise<Follow> {
    const controller = new AbortController();
    const response = await fetch(url('/follow?tail=1000', sid), { headers: { cookie }, signal: controller.signal });
    let raw = '';
    const done = (async () => {
      const reader = response.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          raw += decoder.decode(chunk.value as Uint8Array, { stream: true });
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        bodies.push(raw);
      }
    })();
    const result = { status: response.status, text: () => raw, done, abort: () => { controller.abort(); } };
    follows.push(result);
    return result;
  }
  async function clean(): Promise<void> {
    await until(() => sessions === 0 && (app?.getContainerLogs().activeFollows() ?? 0) === 0);
    await until(async () => (await root(['pgrep', '-f', 'docker logs'])).exitCode === 1);
    const dirs = await root(['sh', '-c', 'test ! -d /home/deployer/.noodara/deploy || test -z "$(find /home/deployer/.noodara/deploy -mindepth 1 -maxdepth 1 -type d -print -quit)"']);
    expect(dirs.exitCode).toBe(0);
  }

  beforeAll(async () => {
    // Each Ubuntu block needs fresh env/getDb/auth singletons, never the previous stopped DB.
    vi.resetModules();
    stackStart = startDeployEngineStack({ ubuntu });
    postgresStart = startPostgres().then((started) => { postgres = started; return started; });
    redisStart = startRedis().then((started) => { redis = started; return started; });
    [stack, postgres, redis] = await Promise.all([stackStart, postgresStart, redisStart]);
    process.env.NOODARA_MASTER_KEY = masterKey.toString('base64');
    process.env.BETTER_AUTH_SECRET = `legacy-http-${randomUUID()}-${randomUUID()}`;
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.REDIS_URL = redis.connectionUrl;
    process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';
    process.env.NOODARA_RUNTIME_LOG_FOLLOW_MAX_MS = String(FOLLOW_MS);
    const { createRedactor, revealSecret, secretValue } = await import('@noodara/domain/security');
    store = await import('../../../apps/control-plane/src/secrets/secret-store.js');
    ({ env } = await import('../../../apps/control-plane/src/env.js'));
    ({ closeDb } = await import('../../../apps/control-plane/src/db/client.js'));
    const { encodeCredential } = await import('../../../apps/control-plane/src/services/credential-store.js');
    const { issueToken } = await import('../../../apps/control-plane/src/services/setup-token-repository.js');
    const { createLogger, writableForTests } = await import('../../../apps/control-plane/src/logger.js');
    const output = writableForTests();
    capture = output;

    const sshModule = await import('@noodara/ssh');
    const ssh = sshModule.createSsh2Adapter();
    const probe = await ssh.connect({
      target: { host: stack.ssh.host, port: stack.ssh.port, user: stack.ssh.user },
      credential: { kind: 'private_key', privateKey: secretValue(stack.ssh.privateKey, 'ssh_private_key') },
      timeouts: { connectMs: 20_000, commandMs: 60_000, discoveryMs: 120_000 },
      trustedFingerprint: null, redactor: createRedactor(),
    });
    if (!probe.ok) throw new Error(`fingerprint probe failed: ${probe.errorCode}`);
    const fingerprint = probe.fingerprint;
    await probe.session.close();
    const encoded = encodeCredential({ kind: 'private_key', privateKey: stack.ssh.privateKey }, { key: masterKey, version: 1 }, createRedactor());
    if (!encoded.ok) throw new Error('fixture credential invalid');
    const credentialId = randomUUID();
    await postgres.db.insert(credentials).values({ id: credentialId, type: encoded.type, encryptedValue: encoded.encryptedValue, keyVersion: encoded.keyVersion });
    await postgres.db.insert(servers).values({ id: serverId, name: 'legacy-redaction', host: stack.ssh.host, sshPort: stack.ssh.port, sshUser: stack.ssh.user, credentialId, hostFingerprint: sshModule.formatFingerprint(fingerprint), dockerInstalled: true, status: 'CONNECTED' });
    await postgres.db.insert(projects).values([
      { id: projectId, name: 'legacy', slug: `legacy-${randomUUID()}` },
      { id: otherProjectId, name: 'unrelated', slug: `unrelated-${randomUUID()}` },
      { id: foreignProjectId, name: 'foreign', slug: `foreign-${randomUUID()}` },
    ]);
    await postgres.db.insert(environments).values([{ id: environmentId, projectId, name: 'production' }, { id: otherEnvironmentId, projectId: otherProjectId, name: 'production' }]);
    for (const [id, pid, eid] of [[serviceId, projectId, environmentId], [finalServiceId, projectId, environmentId], [siblingServiceId, projectId, environmentId], [otherServiceId, otherProjectId, otherEnvironmentId], [noSecretServiceId, otherProjectId, otherEnvironmentId]]) {
      if (!id || !pid || !eid) throw new Error('invalid fixture IDs');
      await postgres.db.insert(services).values({ id, projectId: pid, environmentId: eid, serverId, name: `svc-${id}`, sourceType: 'git', repositoryUrl: 'https://example.invalid/logs.git', branch: 'main', buildContext: '.', dockerfilePath: 'Dockerfile', internalPort: 3000, status: 'RUNNING' });
    }
    const owners = [{ scope: 'project' as const, projectId }, { scope: 'environment' as const, projectId, environmentId }, { scope: 'service' as const, projectId, serviceId }];
    for (const [i, owner] of owners.entries()) {
      const row = await store.createSecret(postgres.db, { owner, name: `VALUE_${String(i)}`, value: secretValue(values[i] ?? '', 'app_secret') }, { current: masterKey });
      visibleSecretIds.push(row.id);
    }
    for (const sid of [serviceId, finalServiceId]) {
      const row = await store.createSecret(postgres.db, { owner: { scope: 'service', projectId, serviceId: sid }, name: 'MULTILINE', value: secretValue(multiline, 'app_secret') }, { current: masterKey });
      if (sid === serviceId) visibleSecretIds.push(row.id);
    }
    // Poison unrelated rows: any broad secret query/decrypt would fail this service's request.
    await postgres.db.insert(secrets).values([
      { scope: 'service', projectId, serviceId: siblingServiceId, name: 'UNRELATED_SIBLING', encryptedValue: 'malformed-unrelated', keyVersion: 1, hint: '' },
      { scope: 'environment', projectId, environmentId: (await postgres.db.insert(environments).values({ projectId, name: 'staging' }).returning({ id: environments.id }))[0]?.id, name: 'UNRELATED_ENV', encryptedValue: 'malformed-unrelated', keyVersion: 1, hint: '' },
      { scope: 'service', projectId: otherProjectId, serviceId: otherServiceId, name: 'UNRELATED_PROJECT', encryptedValue: 'malformed-unrelated', keyVersion: 1, hint: '' },
      { scope: 'project', projectId: foreignProjectId, name: 'UNRELATED_PROJECT_ROOT', encryptedValue: 'malformed-unrelated', keyVersion: 1, hint: '' },
    ]);
    const rows = await postgres.db.select({ encryptedValue: secrets.encryptedValue }).from(secrets).where(eq(secrets.serviceId, serviceId));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.encryptedValue.startsWith('v1:')).toBe(true);
      safe(row.encryptedValue);
    }

    // Re-segment real SSH channel bytes into seven-byte data events before the production
    // line buffer sees them. No output is fabricated, and no canary enters a test redactor.
    // This guarantees a canary spans data events independent of SSH/network packet coalescing.
    const { Client } = await import('@noodara/ssh/testing');
    function fragment(stream: EventEmitter): void {
      stream.emit = new Proxy(stream.emit.bind(stream), {
        apply(emit, receiver, args: unknown[]): boolean {
          const data = args[1];
          if (args[0] !== 'data' || !Buffer.isBuffer(data)) return Reflect.apply(emit, receiver, args) as boolean;
          if (values.some((value) => data.includes(Buffer.from(value)))) fragmentedSecrets += 1;
          for (let i = 0; i < data.length; i += 7) Reflect.apply(emit, receiver, ['data', data.subarray(i, i + 7)]);
          return true;
        },
      });
    }
    const realFactory = sshModule.createSsh2Adapter;
    vi.spyOn(sshModule, 'createSsh2Adapter').mockImplementation((...args) => {
      type ClientFactory = NonNullable<NonNullable<Parameters<typeof realFactory>[0]>['createClient']>;
      const createClient: ClientFactory = () => {
        const client = new Client();
        client.exec = new Proxy(client.exec.bind(client), {
          apply(exec, receiver, input: unknown[]): unknown {
            const callback = input.at(-1) as (error: Error | undefined, channel: ClientChannel) => void;
            input[input.length - 1] = (error: Error | undefined, channel: ClientChannel): void => {
              if (error === undefined) { fragment(channel); fragment(channel.stderr); }
              callback(error, channel);
            };
            return Reflect.apply(exec, receiver, input) as unknown;
          },
        });
        return client as unknown as ReturnType<ClientFactory>;
      };
      const adapter = realFactory({ ...args[0], createClient });
      const connect = adapter.connect.bind(adapter);
      adapter.connect = async (...input) => {
        connects += 1;
        const result = await connect(...input);
        if (result.ok) {
          sessions += 1;
          let closed = false;
          const close = result.session.close.bind(result.session);
          result.session.close = async () => {
            if (!closed) { closed = true; sessions -= 1; }
            await close();
          };
        }
        return result;
      };
      return adapter;
    });
    const legacy = await import('../../../apps/control-plane/src/observability/logs/log-sources.js');
    const realOpen = legacy.openServiceRedactor;
    vi.spyOn(legacy, 'openServiceRedactor').mockImplementation((...args) => { openings += 1; return realOpen(...args); });
    const realDecrypt = store.decryptForDeploy;
    vi.spyOn(store, 'decryptForDeploy').mockImplementation((...args) => { opens += 1; selectedSecretIds.push([...args[1].secretIds]); return realDecrypt(...args); });
    const { buildApp } = await import('../../../apps/control-plane/src/app.js');
    app = buildApp({ logger: createLogger({ level: 'info', destination: output.stream }) });
    const issued = await issueToken(postgres.db, 'setup', new Date());
    const email = 'legacy@example.com';
    const password = 'LegacyRegressionOnly42!';
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { token: revealSecret(issued.token), email, password, name: 'Admin' } });
    expect(setup.statusCode).toBe(200);
    const login = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email, password } });
    expect(login.statusCode).toBe(200);
    cookie = parseSetCookie.parse(login.headers['set-cookie'] ?? [], { map: false }).map((entry) => `${entry.name}=${entry.value}`).join('; ');
    await app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
    const image = stack.baseImages.find((ref) => ref.startsWith('node:'));
    if (!image) throw new Error('no node fixture image');
    const script = `const lines=${JSON.stringify(variants)}; let n=0; async function emit(){for(const value of lines){const out=n++%2?process.stderr:process.stdout;out.write('ordinary readable '+value.slice(0,5));await new Promise(r=>setTimeout(r,120));out.write(value.slice(5)+'\\r\\n');}} (async()=>{await emit();setInterval(()=>{process.stdout.write('heartbeat readable\\n');},200);})();`;
    for (const [sid, source] of [[serviceId, script], [noSecretServiceId, "console.log('no secrets readable');setInterval(()=>{},1000000)"]]) {
      if (!sid || !source) throw new Error('invalid container fixture');
      const name = `noodara-${sid}`;
      const run = await root(['docker', 'run', '-d', '--name', name, '--label', 'noodara.managed=true', '--label', `noodara.service_id=${sid}`, '--label', 'noodara.test=true', image, 'node', '-e', source]);
      expect(run.exitCode).toBe(0);
      containers.push(name);
    }
    await until(async () => (await root(['docker', 'logs', `noodara-${serviceId}`])).stdout.includes('heartbeat readable'));
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    // Pending starts settle in parallel within the existing 240s budget; no partial fixture
    // handle is lost when another startup fails. The remaining steps stay inside the 900s hook.
    const [started, startedPostgres, startedRedis] = await Promise.all([
      stack ?? settleWithin(stackStart, 240_000),
      postgres ?? settleWithin(postgresStart, 240_000),
      redis ?? settleWithin(redisStart, 240_000),
    ]);
    await runTeardown(`legacy log redaction Ubuntu ${ubuntu}`, [
      { name: 'abort follows', run: async () => { for (const stream of follows) stream.abort(); await Promise.all(follows.map((stream) => stream.done)); } },
      { name: 'app.close', run: () => app?.close() },
      { name: 'closeDb', run: () => closeDb?.() },
      { name: 'restore instrumentation', run: () => { vi.restoreAllMocks(); } },
      { name: 'remove containers', run: async () => { for (const name of containers) await started?.exec(['docker', 'rm', '-f', name], { user: 'root' }); } },
      { name: 'stack.stop', run: () => started?.stop(), timeoutMs: 300_000 },
      { name: 'database fixtures.stop', run: async () => {
        const stopped = await Promise.allSettled([startedPostgres?.stop(), startedRedis?.stop()]);
        for (const result of stopped) if (result.status === 'rejected') throw result.reason;
      } },
    ], { stepTimeoutMs: 60_000 });
  }, STACK_TIMEOUT_MS);

  it('redacts project, environment, service and multiline values and variants in both streams', async () => {
    const tail = await get('?tail=1000');
    expect(tail.status).toBe(200);
    const body = JSON.parse(tail.raw) as { lines: { text: string; stream: string }[]; truncated: boolean };
    expect(body.truncated).toBe(false);
    expect(fragmentedSecrets).toBeGreaterThan(0);
    expect(new Set(body.lines.map((line) => line.stream))).toEqual(new Set(['stdout', 'stderr']));
    expect(body.lines.filter((line) => line.text.includes('[REDACTED:app_secret]')).length).toBeGreaterThanOrEqual(variants.length);
    expect(body.lines.some((line) => line.text === 'heartbeat readable')).toBe(true);
    expect(body.lines.some((line) => line.text.startsWith('ordinary readable '))).toBe(true);
    await clean();
  }, CASE_TIMEOUT_MS);

  it('keeps unrelated poisoned rows outside the loaded scope and serves a service with no secrets', async () => {
    const main = await get();
    expect(main.status).toBe(200);
    expect(new Set(selectedSecretIds.at(-1))).toEqual(new Set(visibleSecretIds));
    const before = opens;
    const none = await get('', noSecretServiceId, otherProjectId);
    expect(none.status).toBe(200);
    expect(none.raw).toContain('no secrets readable');
    expect(opens).toBe(before);
    await clean();
  }, CASE_TIMEOUT_MS);

  it('rejects auth, scope and validation before opening secrets or SSH', async () => {
    const before = { openings, opens, connects };
    for (const suffix of ['', '/follow']) {
      expect((await get(suffix, serviceId, projectId, false)).status).toBe(401);
      expect((await get(suffix, serviceId, otherProjectId)).status).toBe(404);
      expect((await get(suffix, randomUUID())).status).toBe(404);
      expect((await get(`${suffix}?tail=0`)).status).toBe(422);
      expect((await get(`${suffix}?tail=1&tail=2`)).status).toBe(400);
    }
    expect({ openings, opens, connects }).toEqual(before);
  }, CASE_TIMEOUT_MS);

  it('fails closed for DB, key and decrypt opening errors, then recovers without leaked slots', async () => {
    if (!postgres) throw new Error('postgres not started');
    const db = postgres.db;
    for (const mode of ['db', 'key', 'decrypt'] as const) {
      const before = connects;
      const savedKey = env.NOODARA_MASTER_KEY;
      const where = and(eq(secrets.serviceId, serviceId), eq(secrets.name, 'MULTILINE'));
      const [saved] = await db.select().from(secrets).where(where);
      if (!saved) throw new Error('secret missing');
      try {
        if (mode === 'db') await db.execute(sql`ALTER TABLE secrets RENAME TO temporarily_unavailable_secrets`);
        if (mode === 'key') env.NOODARA_MASTER_KEY = 'invalid-key' as typeof env.NOODARA_MASTER_KEY;
        if (mode === 'decrypt') await db.update(secrets).set({ encryptedValue: 'malformed-envelope' }).where(where);
        for (const suffix of ['', '/follow']) {
          const failed = await get(suffix);
          expect(failed.status).toBe(502);
          expect(failed.raw).not.toContain('ordinary readable');
          expect(failed.raw).not.toContain('malformed-envelope');
        }
        expect(connects).toBe(before);
        expect(app?.getContainerLogs().activeFollows()).toBe(0);
      } finally {
        env.NOODARA_MASTER_KEY = savedKey;
        if (mode === 'db') await db.execute(sql`ALTER TABLE temporarily_unavailable_secrets RENAME TO secrets`);
        if (mode === 'decrypt') await db.update(secrets).set({ encryptedValue: saved.encryptedValue }).where(where);
      }
      expect((await get()).status).toBe(200);
      await clean();
    }
  }, CASE_TIMEOUT_MS);

  it('redacts follow NDJSON through its timeout and removes its process and run directory', async () => {
    const stream = await follow();
    expect(stream.status).toBe(200);
    await stream.done;
    safe(stream.text());
    expect(stream.text()).toContain('[REDACTED:app_secret]');
    expect(stream.text()).toContain('heartbeat readable');
    expect(frames(stream.text()).at(-1)).toEqual({ type: 'end', reason: 'max_duration' });
    await clean();
  }, CASE_TIMEOUT_MS);

  it('enforces follow capacity before opening secrets and releases all client-cancelled resources', async () => {
    const running = await Promise.all([follow(), follow(), follow()]);
    expect(running.map((stream) => stream.status)).toEqual([200, 200, 200]);
    await until(() => running.every((stream) => stream.text().includes('[REDACTED:app_secret]')));
    const before = { openings, opens, connects };
    const refused = await follow();
    expect(refused.status).toBe(429);
    await refused.done;
    safe(refused.text());
    expect({ openings, opens, connects }).toEqual(before);
    for (const stream of running) stream.abort();
    await Promise.all(running.map((stream) => stream.done));
    for (const stream of running) safe(stream.text());
    await clean();
    const recovered = await follow();
    expect(recovered.status).toBe(200);
    recovered.abort();
    await recovered.done;
    await clean();
  }, CASE_TIMEOUT_MS);

  it('redacts CRLF multiline components and final unterminated stdout/stderr in tail and follow', async () => {
    if (!postgres || !stack) throw new Error('fixtures missing');
    const name = `noodara-${finalServiceId}`;
    const source = `process.stdout.write('plain readable\\r\\n'+${JSON.stringify(multiline)});process.stderr.write('stderr readable '+${JSON.stringify(values[4])});`;
    const image = stack.baseImages.find((ref) => ref.startsWith('node:'));
    if (!image) throw new Error('no node image');
    const result = await root(['docker', 'run', '-d', '--name', name, '--label', 'noodara.managed=true', '--label', `noodara.service_id=${finalServiceId}`, '--label', 'noodara.test=true', image, 'node', '-e', source]);
    expect(result.exitCode).toBe(0);
    containers.push(name);
    expect((await root(['docker', 'wait', name])).exitCode).toBe(0);
    const tail = await get('', finalServiceId);
    expect(tail.status).toBe(200);
    expect(tail.raw).toContain('plain readable');
    expect(tail.raw).toContain('stderr readable [REDACTED:app_secret]');
    const stream = await follow(finalServiceId);
    expect(stream.status).toBe(200);
    await stream.done;
    safe(stream.text());
    expect(stream.text()).toContain('plain readable');
    expect(stream.text()).toContain('stderr readable [REDACTED:app_secret]');
    expect(frames(stream.text()).at(-1)).toEqual({ type: 'end', reason: 'container_exited' });
    await clean();
  }, CASE_TIMEOUT_MS);

  it('never includes any canary representation in captured HTTP errors or application logs', () => {
    expect(bodies.length).toBeGreaterThan(20);
    for (const body of bodies) safe(body);
    const logs = capture.records();
    expect(logs.length).toBeGreaterThan(0);
    safe(JSON.stringify(logs));
  });
});
