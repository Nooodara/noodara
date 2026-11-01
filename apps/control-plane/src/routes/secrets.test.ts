import { Writable } from 'node:stream';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_SECRET_VALUE_LENGTH } from '@noodara/domain/api-contract';
import type { Database } from '../db/client.js';
import type { SecretServiceDeps } from '../secrets/secret-services.js';
import { SECRET_ROUTE_BODY_LIMIT_BYTES } from './secret-schemas.js';
import secretsRoutes from './secrets.js';

// 23-03 (A1, H1): the error paths of the secrets API with a canary value. The paths below are
// decided before or at the database; none may echo the value in a body or a log line.
const CANARY = 'canary-4be8f1c0-secret-value';
const PROJECT = '0190a000-0000-7000-8000-000000000001';
const SERVICE = '0190a000-0000-7000-8000-000000000002';
const SECRET = '0190a000-0000-7000-8000-000000000003';
const BASE = `/api/projects/${PROJECT}/services/${SERVICE}/secrets`;

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** A database whose every query fails the way Drizzle does: the bound value in the message. */
function leakyDb(): Database {
  const fail = () => {
    const error = new Error(`Failed query: insert into "secrets" params: ${CANARY}`);
    Object.assign(error, { cause: Object.assign(new Error(`value ${CANARY} violates check`), { code: '23514' }) });
    return Promise.reject(error);
  };
  return { transaction: fail } as unknown as Database;
}

async function build(db: Database = {} as Database): Promise<{ app: FastifyInstance; logs: string[] }> {
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      logs.push(chunk.toString('utf8'));
      done();
    },
  });
  const app = Fastify({ logger: { level: 'trace', stream } });
  apps.push(app);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('actor', null);
  app.addHook('onRequest', (request, _reply, done) => {
    request.actor = { type: 'user', id: 'user-1' };
    done();
  });
  const deps: SecretServiceDeps = {
    db,
    now: () => new Date('2026-11-01T10:00:00Z'),
    masterKeys: { current: Buffer.alloc(32, 7) },
  };
  app.decorate('getSecretServices', () => Promise.resolve(deps));
  await app.register(secretsRoutes);
  await app.ready();
  return { app, logs };
}

describe('secrets API error paths never echo a value (23-03 H1)', () => {
  it.each<[string, Record<string, unknown>, number, string]>([
    ['a multi-line value', { name: 'api_key', value: `${CANARY}\nline2` }, 422, 'ENV_VALUE_MULTILINE'],
    ['a NUL byte', { name: 'api_key', value: `${CANARY}\u0000` }, 422, 'ENV_VALUE_MULTILINE'],
    ['an empty value', { name: 'api_key', value: '' }, 422, 'ENV_INPUT_INVALID'],
    ['a value pasted as name', { name: CANARY, value: 'x' }, 422, 'ENV_INPUT_INVALID'],
    ['a too long value', { name: 'api_key', value: 'x'.repeat(MAX_SECRET_VALUE_LENGTH) + CANARY }, 400, 'VALIDATION_FAILED'],
    ['a number value', { name: 'api_key', value: 4_242_424_242 }, 400, 'VALIDATION_FAILED'],
    ['an array value', { name: 'api_key', value: [CANARY] }, 400, 'VALIDATION_FAILED'],
    ['an object value', { name: 'api_key', value: { raw: CANARY } }, 400, 'VALIDATION_FAILED'],
    ['an unknown field', { name: 'api_key', value: 'x', extra: CANARY }, 400, 'VALIDATION_FAILED'],
  ])('create rejects %s', async (_label, body, status, error) => {
    const { app, logs } = await build();
    const response = await app.inject({ method: 'POST', url: BASE, payload: body });
    expect(response.statusCode, response.body).toBe(status);
    if (error !== 'VALIDATION_FAILED') expect(response.json<{ error: string }>().error).toBe(error);
    expect(response.body).not.toContain(CANARY);
    expect(response.body).not.toContain('4242424242');
    expect(logs.join('')).not.toContain(CANARY);
  });

  it('applies the same value checks on replace and rejects a name in the body', async () => {
    const { app, logs } = await build();
    const multiline = await app.inject({ method: 'PUT', url: `${BASE}/${SECRET}`, payload: { value: `${CANARY}\r` } });
    expect(multiline.statusCode).toBe(422);
    expect(multiline.json<{ error: string }>().error).toBe('ENV_VALUE_MULTILINE');
    const empty = await app.inject({ method: 'PUT', url: `${BASE}/${SECRET}`, payload: { value: '' } });
    expect(empty.statusCode).toBe(422);
    expect(empty.json<{ reason: string }>().reason).toBe('SECRET_VALUE_REQUIRED');
    const renamed = await app.inject({ method: 'PUT', url: `${BASE}/${SECRET}`, payload: { value: CANARY, name: 'other' } });
    expect(renamed.statusCode).toBe(400);
    expect(multiline.body + empty.body + renamed.body).not.toContain(CANARY);
    expect(logs.join('')).not.toContain(CANARY);
  });

  it('caps the body', async () => {
    const { app, logs } = await build();
    for (const [method, url] of [
      ['POST', BASE],
      ['PUT', `${BASE}/${SECRET}`],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'api_key', value: CANARY.repeat(SECRET_ROUTE_BODY_LIMIT_BYTES / CANARY.length + 1) }),
      });
      expect(response.statusCode).toBe(413);
      expect(response.body).not.toContain(CANARY);
    }
    expect(logs.join('')).not.toContain(CANARY);
  });

  it('rethrows a driver error without its message', async () => {
    const { app, logs } = await build(leakyDb());
    for (const [method, url, payload] of [
      ['POST', BASE, { name: 'api_key', value: CANARY }],
      ['PUT', `${BASE}/${SECRET}`, { value: CANARY }],
      ['DELETE', `${BASE}/${SECRET}`, undefined],
    ] as const) {
      const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
      expect(response.statusCode, response.body).toBe(500);
      expect(response.body).not.toContain(CANARY);
    }
    expect(logs.join('')).toContain('SQLSTATE 23514');
    expect(logs.join('')).not.toContain(CANARY);
  });

  it('has no reveal route', async () => {
    const { app } = await build();
    for (const url of [`${BASE}/${SECRET}/value`, `${BASE}/${SECRET}/reveal`]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(404);
    }
  });
});
