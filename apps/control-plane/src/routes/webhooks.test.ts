import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { noopServerEventPublisher } from '../events/server-event-publisher.js';
import { createLogger } from '../logger.js';
import {
  verifyGithubSignature,
  type WebhookDeliveryInput,
  type WebhookIngest,
  type WebhookIngestResult,
} from '../services/webhook-ingest.js';
import { WEBHOOK_RATE_LIMITED_BODY, WEBHOOK_UNAUTHORIZED_BODY } from './webhooks.js';

const HOOK = 'h'.repeat(32);
const SECRET = 's3cr3t-'.repeat(8);
const DEPLOYMENT_ID = '01900000-0000-7000-8000-000000000001';
const stubBroadcaster = { start: () => Promise.resolve(), stop: () => Promise.resolve(), closeAll: () => Promise.resolve() };

const sign = (body: string | Buffer, secret = SECRET): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/** Verifies like the real ingest (known hook + HMAC over the bytes the route passed). */
function fakeIngest(next: (input: WebhookDeliveryInput) => WebhookIngestResult): WebhookIngest & { calls: WebhookDeliveryInput[] } {
  const calls: WebhookDeliveryInput[] = [];
  return {
    calls,
    ingest(input) {
      calls.push(input);
      if (input.hookId !== HOOK || !verifyGithubSignature(SECRET, input.rawBody, input.signature)) {
        return Promise.resolve({ kind: 'unauthorized' });
      }
      return Promise.resolve(next(input));
    },
  };
}

const deployed: WebhookIngestResult = { kind: 'recorded', status: 202, outcome: 'deployed', deploymentId: DEPLOYMENT_ID, duplicate: false };

let app: FastifyInstance | undefined;
let logLines: string[] = [];

function build(ingest: WebhookIngest, limits?: { perHook: number; perIp: number }): FastifyInstance {
  logLines = [];
  app = buildApp({
    logger: createLogger({ level: 'debug', destination: { write: (line: string) => void logLines.push(line) } }),
    broadcaster: stubBroadcaster as never,
    eventPublisher: noopServerEventPublisher,
    webhookIngest: ingest,
    ...(limits !== undefined
      ? {
          webhookRateLimits: {
            perHook: { limit: limits.perHook, windowMs: 60_000 },
            perIp: { limit: limits.perIp, windowMs: 60_000 },
            maxKeys: 100,
          },
        }
      : {}),
  });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function post(target: FastifyInstance, body: string | Buffer, headers: Record<string, string> = {}, hook = HOOK) {
  return target.inject({
    method: 'POST',
    url: `/webhooks/github/${hook}`,
    payload: body,
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-github-delivery': 'd-1',
      'x-hub-signature-256': sign(body),
      ...headers,
    },
  });
}

describe('POST /webhooks/github/:hookId', () => {
  it('passes the raw bytes exactly as received, without a session or Origin check (A1)', async () => {
    const ingest = fakeIngest(() => deployed);
    const target = build(ingest);
    // Odd whitespace and key order: any JSON round trip would break the signature.
    const body = '{ "ref":"refs/heads/main" ,\n  "after": "x"  }';
    const res = await post(target, body, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ outcome: 'deployed', deploymentId: DEPLOYMENT_ID });
    expect(ingest.calls[0]?.rawBody.toString('utf8')).toBe(body);
    expect(ingest.calls[0]).toMatchObject({ hookId: HOOK, deliveryId: 'd-1', event: 'push' });
  });

  it('accepts application/json with a charset parameter', async () => {
    const target = build(fakeIngest(() => deployed));
    const res = await post(target, '{}', { 'content-type': 'application/json; charset=utf-8' });
    expect(res.statusCode).toBe(202);
  });

  it('rejects a body over 1 MiB with 413 before the ingest runs (A1)', async () => {
    const ingest = fakeIngest(() => deployed);
    const target = build(ingest);
    const body = `{"pad":"${'x'.repeat(1_048_576)}"}`;
    const res = await post(target, body);
    expect(res.statusCode).toBe(413);
    expect(ingest.calls).toHaveLength(0);
  });

  it('rejects any content type but application/json with 415 (A1)', async () => {
    const ingest = fakeIngest(() => deployed);
    const target = build(ingest);
    for (const type of ['application/x-www-form-urlencoded', 'text/plain', 'application/octet-stream']) {
      const res = await post(target, 'payload=%7B%7D', { 'content-type': type });
      expect(res.statusCode).toBe(415);
    }
    expect(ingest.calls).toHaveLength(0);
  });

  it('answers missing, malformed and wrong signatures and unknown hooks with the same 401 body (A2)', async () => {
    const target = build(fakeIngest(() => deployed));
    const body = '{"zen":"z","hook_id":1}';
    const responses = await Promise.all([
      post(target, body, { 'x-hub-signature-256': '' }),
      post(target, body, { 'x-hub-signature-256': 'sha256=nothex' }),
      post(target, body, { 'x-hub-signature-256': sign(body, 'wrong-secret') }),
      post(target, body, { 'x-hub-signature-256': sign(body).slice(0, -4) }),
      post(target, body, {}, 'u'.repeat(32)),
    ]);
    for (const res of responses) {
      expect(res.statusCode).toBe(401);
      expect(res.body).toBe(JSON.stringify(WEBHOOK_UNAUTHORIZED_BODY));
    }
  });

  it('rejects a repeated signature header (joined or listed, never verified)', async () => {
    const ingest = fakeIngest(() => deployed);
    const target = build(ingest);
    const body = '{}';
    const res = await target.inject({
      method: 'POST',
      url: `/webhooks/github/${HOOK}`,
      payload: body,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': [sign(body), sign(body)] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe(JSON.stringify(WEBHOOK_UNAUTHORIZED_BODY));
  });

  it('rate-limits per hook with 429 and a retry-after (A3)', async () => {
    const target = build(fakeIngest(() => deployed), { perHook: 2, perIp: 100 });
    const codes = [];
    for (let i = 0; i < 3; i += 1) codes.push((await post(target, '{}')).statusCode);
    expect(codes).toEqual([202, 202, 429]);
    const limited = await post(target, '{}');
    expect(limited.headers['retry-after']).toBe('60');
    expect(limited.json()).toEqual(WEBHOOK_RATE_LIMITED_BODY);
  });

  it('rate-limits per IP across hooks (A3)', async () => {
    const target = build(fakeIngest(() => deployed), { perHook: 100, perIp: 2 });
    const codes = [];
    for (const hook of [HOOK, 'a'.repeat(32), 'b'.repeat(32)]) codes.push((await post(target, '{}', {}, hook)).statusCode);
    expect(codes).toEqual([202, 401, 429]);
  });

  it('maps ingest outcomes: ping 200, ignored 200, duplicate, 400, 422 and 503 without internal ids (A3, A5)', async () => {
    const results: WebhookIngestResult[] = [
      { kind: 'recorded', status: 200, outcome: 'ping', deploymentId: null, duplicate: false },
      { kind: 'recorded', status: 200, outcome: 'ignored_event', deploymentId: null, duplicate: false },
      { kind: 'recorded', status: 202, outcome: 'deployed', deploymentId: DEPLOYMENT_ID, duplicate: true },
      { kind: 'bad_request', message: 'Missing or invalid X-GitHub-Delivery header' },
      { kind: 'recorded', status: 422, outcome: 'repository_mismatch', deploymentId: null, duplicate: false },
      { kind: 'queue_unavailable' },
    ];
    const queue = [...results];
    const target = build(fakeIngest(() => queue.shift() ?? deployed));
    const res = [];
    for (const _result of results) res.push(await post(target, '{}'));
    expect(res.map((r) => r.statusCode)).toEqual([200, 200, 202, 400, 422, 503]);
    expect(res[0]?.json()).toEqual({ outcome: 'ping' });
    expect(res[1]?.json()).toEqual({ outcome: 'ignored_event' });
    expect(res[2]?.json()).toEqual({ outcome: 'deployed', deploymentId: DEPLOYMENT_ID, duplicate: true });
    expect(res[3]?.json()).toMatchObject({ error: 'VALIDATION_FAILED' });
    expect(res[4]?.json()).toMatchObject({ error: 'WEBHOOK_DELIVERY_REJECTED', outcome: 'repository_mismatch' });
    for (const r of [res[3], res[4], res[5]]) {
      expect(r?.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(r?.body).not.toContain(HOOK);
    }
    expect(res[5]?.headers['cache-control']).toBe('no-store');
  });

  it('never logs the payload, the signature or the secret (A5)', async () => {
    const target = build(fakeIngest(() => deployed));
    const body = '{"marker":"PAYLOAD-CANARY-7f3a"}';
    const signature = sign(body);
    await post(target, body);
    await post(target, body, { 'x-hub-signature-256': sign(body, 'other') });
    await post(target, `{"pad":"${'PAYLOAD-CANARY-7f3a'.repeat(60_000)}"}`);
    await post(target, body, { 'content-type': 'text/plain' });
    const logs = logLines.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain('PAYLOAD-CANARY-7f3a');
    expect(logs).not.toContain(signature.slice('sha256='.length));
    expect(logs).not.toContain(SECRET);
  });
});
