import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { deployments } from '../../../apps/control-plane/src/db/schema/deployments.js';
import { services } from '../../../apps/control-plane/src/db/schema/services.js';
import { webhookDeliveries } from '../../../apps/control-plane/src/db/schema/webhook-deliveries.js';
import { noopServerEventPublisher } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import type { DeployServiceJobPayload } from '../../../apps/control-plane/src/queue/deploy-job-payload.js';
import type { DeployEnqueueResult, DeployQueue } from '../../../apps/control-plane/src/queue/deploy-queue.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

// 18-02: the GitHub receiver over the real HTTP surface and a migrated Postgres. The deploy queue
// is a recording fake (its enqueue can be made to fail, H3); everything else is real.

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';
const PUBLIC_URL = 'http://noodara.example.test:3000';
const REPO = 'https://github.com/acme/api.git';
const PAYLOAD_CANARY = 'PAYLOAD-CANARY-18-02';

type Json = Record<string, unknown>;

let postgres: PostgresFixture;
let app: FastifyInstance;
let cookie: string;
let logRecords: () => unknown[];
const stubBroadcaster = { start: () => Promise.resolve(), stop: () => Promise.resolve(), closeAll: () => Promise.resolve() };
const enqueued: DeployServiceJobPayload[] = [];
// 'claimed': the job landed and a worker took the row out of QUEUED, but enqueue still reports failure.
let enqueueMode: 'ok' | 'unavailable' | 'throw' | 'claimed' = 'ok';
const issuedSecrets: string[] = [];
const signatures: string[] = [];
const errorBodies: string[] = [];

const queue: DeployQueue = {
  async enqueue(payload): Promise<DeployEnqueueResult> {
    enqueued.push(payload);
    if (enqueueMode === 'claimed') {
      await postgres.db.update(deployments).set({ status: 'PREPARING' }).where(eq(deployments.id, payload.deploymentId));
      throw new Error('ack lost');
    }
    if (enqueueMode === 'throw') throw new Error('redis down');
    if (enqueueMode === 'unavailable') return { ok: false, code: 'QUEUE_UNAVAILABLE', message: 'down' };
    return { ok: true, jobId: payload.deploymentId };
  },
  removeJob: () => Promise.resolve(false),
  isJobPending: () => Promise.resolve(false),
  close: () => Promise.resolve(),
};

function cookieHeaderFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const rawCookies = Array.isArray(raw) ? raw : raw !== undefined ? [String(raw)] : [];
  return parseSetCookie
    .parse(rawCookies, { map: false })
    .map((entry) => `${entry.name}=${entry.value}`)
    .join('; ');
}

async function signIn(): Promise<string> {
  const issued = await issueToken(postgres.db, 'setup', new Date());
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { token: revealSecret(issued.token), email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Admin' },
  });
  if (setup.statusCode !== 200) throw new Error(`setup failed: ${setup.statusCode.toString()}`);
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (response.statusCode !== 200) throw new Error(`sign-in failed: ${response.statusCode.toString()}`);
  return cookieHeaderFrom(response);
}

async function api(method: 'POST' | 'DELETE', url: string, payload?: Json): Promise<{ statusCode: number; body: Json }> {
  const response = await app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload } : {}) });
  return { statusCode: response.statusCode, body: (response.body.length > 0 ? response.json() : {}) as Json };
}

function short(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

interface Hooked {
  readonly projectId: string;
  readonly serviceId: string;
  readonly hookId: string;
  secret: string;
  readonly webhookPath: string;
}

/** A fresh project, environment, connected server and git service with its webhook enabled. */
async function hookedService(): Promise<Hooked> {
  const project = await api('POST', '/api/projects', { name: `Recv ${short()}` });
  expect(project.statusCode).toBe(201);
  const projectId = String(project.body.id);
  const environment = await api('POST', `/api/projects/${projectId}/environments`, { name: 'production' });
  const server = await api('POST', '/api/servers', {
    name: `srv-${short()}`,
    host: `${short()}.example.test`,
    credential: { type: 'ssh_password', password: 'not-used-by-this-test' },
  });
  expect(server.statusCode).toBe(201);
  const { servers } = await import('../../../apps/control-plane/src/db/schema/servers.js');
  await postgres.db
    .update(servers)
    .set({ status: 'CONNECTED', dockerInstalled: true, dockerBuildkitAvailable: true })
    .where(eq(servers.id, String(server.body.id)));
  const service = await api('POST', `/api/projects/${projectId}/services`, {
    environmentId: String(environment.body.id),
    serverId: String(server.body.id),
    name: `svc-${short()}`,
    source: { kind: 'git', repositoryUrl: REPO, branch: 'main' },
    internalPort: 8080,
  });
  expect(service.statusCode).toBe(201);
  const serviceId = String(service.body.id);
  const webhookPath = `/api/projects/${projectId}/services/${serviceId}/webhook`;
  const enabled = await api('POST', webhookPath);
  expect(enabled.statusCode).toBe(200);
  const secret = String(enabled.body.secret);
  issuedSecrets.push(secret);
  const hookId = String(enabled.body.payloadUrl).slice(`${PUBLIC_URL}/webhooks/github/`.length);
  return { projectId, serviceId, hookId, secret, webhookPath };
}

function sign(body: string, secret: string): string {
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  signatures.push(signature);
  return signature;
}

function pushBody(sha: string, extra: Json = {}): string {
  // Hand-written spacing: the receiver must verify these exact bytes, not a re-serialization.
  return `{ "ref": "refs/heads/main", "after": "${sha}", "deleted": false,\n  "repository": { "clone_url": "${REPO}", "ssh_url": "git@github.com:acme/api.git" },\n  "head_commit": { "id": "${sha}", "message": "${PAYLOAD_CANARY}" }${
    Object.keys(extra).length > 0 ? `, ${JSON.stringify(extra).slice(1, -1)}` : ''
  } }`;
}

const PING_BODY = `{"zen":"${PAYLOAD_CANARY}","hook_id":42}`;

function newSha(): string {
  return randomBytes(20).toString('hex');
}

interface DeliveryOptions {
  readonly event?: string;
  readonly delivery?: string | null;
  readonly signature?: string | null;
  readonly contentType?: string;
  readonly origin?: string;
  readonly target?: FastifyInstance;
}

async function deliver(hookId: string, body: string, secret: string, options: DeliveryOptions = {}) {
  const headers: Record<string, string> = {
    'content-type': options.contentType ?? 'application/json',
    'x-github-event': options.event ?? 'push',
    'user-agent': 'GitHub-Hookshot/abc123',
  };
  const delivery = options.delivery === undefined ? randomUUID() : options.delivery;
  if (delivery !== null) headers['x-github-delivery'] = delivery;
  const signature = options.signature === undefined ? sign(body, secret) : options.signature;
  if (signature !== null) headers['x-hub-signature-256'] = signature;
  if (options.origin !== undefined) headers.origin = options.origin;
  const response = await (options.target ?? app).inject({ method: 'POST', url: `/webhooks/github/${hookId}`, headers, payload: body });
  if (response.statusCode >= 400) errorBodies.push(response.body);
  return { statusCode: response.statusCode, body: response.body.length > 0 ? (response.json() as Json) : {}, raw: response.body, delivery };
}

async function deploymentsOf(serviceId: string) {
  return postgres.db.select().from(deployments).where(eq(deployments.serviceId, serviceId));
}

async function deliveriesOf(serviceId: string) {
  return postgres.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.serviceId, serviceId));
}

beforeAll(async () => {
  postgres = await startPostgres();
  process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL = postgres.connectionString;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.NOODARA_PUBLIC_URL = PUBLIC_URL;
  const { writableForTests, createLogger } = await import('../../../apps/control-plane/src/logger.js');
  const capture = writableForTests();
  logRecords = capture.records;
  const { buildApp } = await import('../../../apps/control-plane/src/app.js');
  app = buildApp({
    eventPublisher: noopServerEventPublisher,
    broadcaster: stubBroadcaster as never,
    deployQueue: queue,
    // Generous limits: the whole suite comes from one IP. The 429 path has its own app below.
    webhookRateLimits: { perHook: { limit: 1000, windowMs: 60_000 }, perIp: { limit: 10_000, windowMs: 60_000 }, maxKeys: 1000 },
    logger: createLogger({ level: 'trace', destination: capture.stream }) as unknown as FastifyInstance['log'],
  });
  cookie = await signIn();
});

afterAll(async () => {
  await app.close();
  await postgres.stop();
});

describe('transport (A1)', () => {
  it('needs no session and ignores a foreign Origin; a ping answers 200 and is recorded', async () => {
    const hook = await hookedService();
    const res = await deliver(hook.hookId, PING_BODY, hook.secret, { event: 'ping', origin: 'https://evil.example' });
    expect(res.statusCode, res.raw).toBe(200);
    expect(res.body).toStrictEqual({ outcome: 'ping' });
    const rows = await deliveriesOf(hook.serviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deliveryId: res.delivery, event: 'ping', outcome: 'ping', deploymentId: null });
  });

  it('caps the body at 1 MiB (413) and accepts only application/json (415)', async () => {
    const hook = await hookedService();
    const big = `{"pad":"${'x'.repeat(1_048_576)}"}`;
    expect((await deliver(hook.hookId, big, hook.secret)).statusCode).toBe(413);
    for (const contentType of ['application/x-www-form-urlencoded', 'text/plain']) {
      expect((await deliver(hook.hookId, PING_BODY, hook.secret, { event: 'ping', contentType })).statusCode).toBe(415);
    }
    expect(await deliveriesOf(hook.serviceId)).toHaveLength(0);
  });
});

describe('signature (A2, H1)', () => {
  it('missing, malformed, wrong, unknown-hook and disabled deliveries share one 401 body', async () => {
    const hook = await hookedService();
    const body = pushBody(newSha());
    const good = sign(body, hook.secret);
    const attempts = [
      await deliver(hook.hookId, body, hook.secret, { signature: null }),
      await deliver(hook.hookId, body, hook.secret, { signature: 'sha256=xyz' }),
      await deliver(hook.hookId, body, hook.secret, { signature: good.slice(0, -2) }),
      await deliver(hook.hookId, body, hook.secret, { signature: sign(body, 'f'.repeat(64)) }),
      await deliver(hook.hookId, `${body} `, hook.secret, { signature: good }),
      await deliver('A'.repeat(32), body, hook.secret),
      await deliver('not a hook id', body, hook.secret),
    ];
    expect((await api('DELETE', hook.webhookPath)).statusCode).toBe(200);
    attempts.push(await deliver(hook.hookId, body, hook.secret));
    const raws = new Set(attempts.map((a) => a.raw));
    expect(attempts.map((a) => a.statusCode)).toStrictEqual(Array(8).fill(401));
    expect(raws.size).toBe(1);
    expect(attempts[0]?.body).toStrictEqual({ error: 'UNAUTHORIZED', message: expect.any(String) });
    expect(await deliveriesOf(hook.serviceId)).toHaveLength(0);
    expect(await deploymentsOf(hook.serviceId)).toHaveLength(0);
  });

  it('a rotated-out secret fails at once and the new one works', async () => {
    const hook = await hookedService();
    const rotated = await api('POST', `${hook.webhookPath}/rotate`);
    expect(rotated.statusCode).toBe(200);
    const fresh = String(rotated.body.secret);
    issuedSecrets.push(fresh);
    expect((await deliver(hook.hookId, PING_BODY, hook.secret, { event: 'ping' })).statusCode).toBe(401);
    expect((await deliver(hook.hookId, PING_BODY, fresh, { event: 'ping' })).statusCode).toBe(200);
  });

  it('a missing or malformed X-GitHub-Delivery is 400, but only after the signature passes (H2)', async () => {
    const hook = await hookedService();
    const body = pushBody(newSha());
    const unsigned = await deliver(hook.hookId, body, hook.secret, { delivery: null, signature: null });
    expect(unsigned.statusCode).toBe(401);
    const missing = await deliver(hook.hookId, body, hook.secret, { delivery: null });
    expect(missing.statusCode).toBe(400);
    expect(missing.body).toStrictEqual({ error: 'VALIDATION_FAILED', message: expect.any(String) });
    expect((await deliver(hook.hookId, body, hook.secret, { delivery: 'has spaces' })).statusCode).toBe(400);
    expect(await deliveriesOf(hook.serviceId)).toHaveLength(0);
  });
});

describe('events and rate limit (A3)', () => {
  it('records an ignored event and a non-matching branch with their outcome and 200', async () => {
    const hook = await hookedService();
    const issues = await deliver(hook.hookId, '{"action":"opened"}', hook.secret, { event: 'issues' });
    expect(issues.statusCode).toBe(200);
    expect(issues.body).toStrictEqual({ outcome: 'ignored_event' });
    const branch = await deliver(hook.hookId, pushBody(newSha()).replace('refs/heads/main', 'refs/heads/dev'), hook.secret);
    expect(branch.statusCode).toBe(200);
    expect(branch.body).toStrictEqual({ outcome: 'ignored_branch' });
    expect((await deliveriesOf(hook.serviceId)).map((row) => row.outcome).sort()).toStrictEqual(['ignored_branch', 'ignored_event']);
    expect(await deploymentsOf(hook.serviceId)).toHaveLength(0);
  });

  it('answers 429 once the per-hook or per-IP window is spent', async () => {
    const hook = await hookedService();
    const { buildApp } = await import('../../../apps/control-plane/src/app.js');
    const limited = buildApp({
      eventPublisher: noopServerEventPublisher,
      broadcaster: stubBroadcaster as never,
      deployQueue: queue,
      webhookRateLimits: { perHook: { limit: 2, windowMs: 60_000 }, perIp: { limit: 4, windowMs: 60_000 }, maxKeys: 100 },
    });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        codes.push((await deliver(hook.hookId, PING_BODY, hook.secret, { event: 'ping', target: limited })).statusCode);
      }
      expect(codes).toStrictEqual([200, 200, 429]);
      // Two more IP hits on other hooks spend the per-IP window (4).
      expect((await deliver('B'.repeat(32), PING_BODY, hook.secret, { event: 'ping', target: limited })).statusCode).toBe(401);
      const ipLimited = await deliver('C'.repeat(32), PING_BODY, hook.secret, { event: 'ping', target: limited });
      expect(ipLimited.statusCode).toBe(429);
      expect(ipLimited.body).toStrictEqual({ error: 'RATE_LIMITED', message: expect.any(String) });
    } finally {
      await limited.close();
    }
  });
});

describe('push deploy and dedupe (A4, H2)', () => {
  it('a matching push creates a webhook deployment with the requested SHA, linked to its delivery', async () => {
    const hook = await hookedService();
    const sha = newSha();
    const before = enqueued.length;
    const res = await deliver(hook.hookId, pushBody(sha), hook.secret);
    expect(res.statusCode, res.raw).toBe(202);
    expect(res.body).toStrictEqual({ outcome: 'deployed', deploymentId: expect.any(String) });
    const [deployment] = await deploymentsOf(hook.serviceId);
    expect(deployment).toMatchObject({
      id: res.body.deploymentId,
      status: 'QUEUED',
      trigger: 'webhook',
      triggeredBy: `github:${String(res.delivery)}`,
      commitSha: sha,
    });
    const [delivery] = await deliveriesOf(hook.serviceId);
    expect(delivery).toMatchObject({ deliveryId: res.delivery, outcome: 'deployed', pushedSha: sha, deploymentId: deployment?.id });
    expect(deployment?.webhookDeliveryId).toBe(delivery?.id);
    expect(enqueued.slice(before)).toStrictEqual([
      expect.objectContaining({ deploymentId: deployment?.id, serviceId: hook.serviceId }),
    ]);

    // A4: the same X-GitHub-Delivery again returns the original id and creates nothing.
    const again = await deliver(hook.hookId, pushBody(sha), hook.secret, { delivery: res.delivery });
    expect(again.statusCode).toBe(202);
    expect(again.body).toStrictEqual({ outcome: 'deployed', deploymentId: deployment?.id, duplicate: true });
    expect(await deploymentsOf(hook.serviceId)).toHaveLength(1);
    expect(await deliveriesOf(hook.serviceId)).toHaveLength(1);
    expect(enqueued.length).toBe(before + 1);
  });

  it('two concurrent identical deliveries create exactly one deployment and both answer its id (H2)', async () => {
    const hook = await hookedService();
    const body = pushBody(newSha());
    const delivery = randomUUID();
    const [a, b] = await Promise.all([
      deliver(hook.hookId, body, hook.secret, { delivery }),
      deliver(hook.hookId, body, hook.secret, { delivery }),
    ]);
    expect([a?.statusCode, b?.statusCode]).toStrictEqual([202, 202]);
    expect(a?.body.deploymentId).toBeDefined();
    expect(a?.body.deploymentId).toBe(b?.body.deploymentId);
    expect(await deploymentsOf(hook.serviceId)).toHaveLength(1);
    expect(
      await postgres.db
        .select()
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.serviceId, hook.serviceId), eq(webhookDeliveries.deliveryId, delivery))),
    ).toHaveLength(1);
  });
});

describe('never triggers (H3)', () => {
  it('an archived project records project_archived and deploys nothing', async () => {
    const hook = await hookedService();
    expect((await api('POST', `/api/projects/${hook.projectId}/archive`)).statusCode).toBe(200);
    const res = await deliver(hook.hookId, pushBody(newSha()), hook.secret);
    expect(res.statusCode).toBe(200);
    expect(res.body).toStrictEqual({ outcome: 'project_archived' });
    expect((await deliveriesOf(hook.serviceId)).map((row) => row.outcome)).toStrictEqual(['project_archived']);
    expect(await deploymentsOf(hook.serviceId)).toHaveLength(0);
  });

  it('an image-source service records source_not_git and deploys nothing', async () => {
    const hook = await hookedService();
    await postgres.db
      .update(services)
      .set({ sourceType: 'image', imageRef: 'nginx:1.27', repositoryUrl: null, branch: null, buildContext: null, dockerfilePath: null, buildTarget: null })
      .where(eq(services.id, hook.serviceId));
    const res = await deliver(hook.hookId, pushBody(newSha()), hook.secret);
    expect(res.statusCode).toBe(200);
    expect(res.body).toStrictEqual({ outcome: 'source_not_git' });
    expect(await deploymentsOf(hook.serviceId)).toHaveLength(0);
  });

  it('a disabled webhook answers the shared 401 and records nothing', async () => {
    const hook = await hookedService();
    expect((await api('DELETE', hook.webhookPath)).statusCode).toBe(200);
    const res = await deliver(hook.hookId, pushBody(newSha()), hook.secret);
    expect(res.statusCode).toBe(401);
    expect(await deliveriesOf(hook.serviceId)).toHaveLength(0);
    expect(await deploymentsOf(hook.serviceId)).toHaveLength(0);
  });

  it.each(['unavailable', 'throw'] as const)('a failed enqueue (%s) ends the deployment FAILED/ENQUEUE_FAILED, never QUEUED', async (mode) => {
    const hook = await hookedService();
    enqueueMode = mode;
    try {
      const res = await deliver(hook.hookId, pushBody(newSha()), hook.secret);
      expect(res.statusCode).toBe(503);
      expect(res.body).toStrictEqual({ error: 'QUEUE_UNAVAILABLE', message: expect.any(String) });
    } finally {
      enqueueMode = 'ok';
    }
    const [deployment] = await deploymentsOf(hook.serviceId);
    expect(deployment).toMatchObject({ status: 'FAILED', errorCode: 'ENQUEUE_FAILED', trigger: 'webhook' });
    expect((await deliveriesOf(hook.serviceId)).map((row) => row.outcome)).toStrictEqual(['deployed']);
  });

  it('an enqueue that reports failure after a worker already claimed the job answers 202, not 503', async () => {
    const hook = await hookedService();
    enqueueMode = 'claimed';
    let res: Awaited<ReturnType<typeof deliver>>;
    try {
      res = await deliver(hook.hookId, pushBody(newSha()), hook.secret);
    } finally {
      enqueueMode = 'ok';
    }
    const [deployment] = await deploymentsOf(hook.serviceId);
    expect(res.statusCode).toBe(202);
    expect(res.body).toStrictEqual({ outcome: 'deployed', deploymentId: deployment?.id });
    expect(deployment).toMatchObject({ status: 'PREPARING', errorCode: null });
  });

  it('a redelivery of a delivery whose deployment ended ENQUEUE_FAILED retries it with a new deployment', async () => {
    const hook = await hookedService();
    const sha = newSha();
    const body = pushBody(sha);
    const delivery = randomUUID();
    enqueueMode = 'unavailable';
    try {
      expect((await deliver(hook.hookId, body, hook.secret, { delivery })).statusCode).toBe(503);
    } finally {
      enqueueMode = 'ok';
    }
    const [failed] = await deploymentsOf(hook.serviceId);
    expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'ENQUEUE_FAILED' });

    const before = enqueued.length;
    const retry = await deliver(hook.hookId, body, hook.secret, { delivery });
    expect(retry.statusCode).toBe(202);
    expect(retry.body).toStrictEqual({ outcome: 'deployed', deploymentId: expect.any(String) });
    expect(retry.body.deploymentId).not.toBe(failed?.id);
    const retried = (await deploymentsOf(hook.serviceId)).find((row) => row.id === retry.body.deploymentId);
    expect(retried).toMatchObject({ status: 'QUEUED', trigger: 'webhook', triggeredBy: `github:${delivery}`, commitSha: sha });
    expect(enqueued.slice(before).map((payload) => payload.deploymentId)).toStrictEqual([retry.body.deploymentId]);
    const rows = await deliveriesOf(hook.serviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'deployed', deploymentId: retry.body.deploymentId });
    expect(retried?.webhookDeliveryId).toBe(rows[0]?.id);

    // Once the retry is queued, a further redelivery is a plain duplicate again.
    const again = await deliver(hook.hookId, body, hook.secret, { delivery });
    expect(again.statusCode).toBe(202);
    expect(again.body).toStrictEqual({ outcome: 'deployed', deploymentId: retry.body.deploymentId, duplicate: true });
    expect(await deploymentsOf(hook.serviceId)).toHaveLength(2);
    expect(enqueued.length).toBe(before + 1);
  });

  it('a redelivery after ENQUEUE_FAILED is superseded once a newer push deployed, and deploys nothing', async () => {
    const hook = await hookedService();
    const oldBody = pushBody(newSha());
    const delivery = randomUUID();
    enqueueMode = 'unavailable';
    try {
      expect((await deliver(hook.hookId, oldBody, hook.secret, { delivery })).statusCode).toBe(503);
    } finally {
      enqueueMode = 'ok';
    }
    const newer = await deliver(hook.hookId, pushBody(newSha()), hook.secret);
    expect(newer.statusCode).toBe(202);

    const before = enqueued.length;
    const stale = await deliver(hook.hookId, oldBody, hook.secret, { delivery });
    expect(stale.statusCode).toBe(200);
    expect(stale.body).toStrictEqual({ outcome: 'superseded', duplicate: true });
    expect(await deploymentsOf(hook.serviceId)).toHaveLength(2);
    expect(enqueued.length).toBe(before);
    const row = (await deliveriesOf(hook.serviceId)).find((candidate) => candidate.deliveryId === delivery);
    expect(row).toMatchObject({ outcome: 'superseded', deploymentId: null });
  });
});

describe('no leaks (A5)', () => {
  it('logs carry neither payload, signature nor secret; error bodies carry no internal ids', async () => {
    const hook = await hookedService();
    await deliver(hook.hookId, pushBody(newSha()), hook.secret);
    await deliver(hook.hookId, pushBody(newSha()), hook.secret, { signature: 'sha256=bad' });
    const logs = JSON.stringify(logRecords());
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(PAYLOAD_CANARY);
    for (const signature of signatures) expect(logs).not.toContain(signature.slice('sha256='.length));
    for (const secret of issuedSecrets) expect(logs).not.toContain(secret);
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    expect(errorBodies.length).toBeGreaterThan(0);
    for (const body of errorBodies) {
      expect(body).not.toMatch(uuid);
      expect(body).not.toContain(PAYLOAD_CANARY);
    }
  });
});
