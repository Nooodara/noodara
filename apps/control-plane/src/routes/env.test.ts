import { Writable } from 'node:stream';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_ENV_VALUE_BYTES } from '@noodara/domain';
import type { Database } from '../db/client.js';
import type { EnvServiceDeps } from '../env/env-services.js';
import envRoutes from './env.js';
import { ENV_ROUTE_BODY_LIMIT_BYTES } from './env-schemas.js';

// 23-02 (H1, H2): the error paths of the variables API with a canary value. The paths below are
// decided before or at the database; none may echo the value in a body or a log line.
const CANARY = 'canary-0f3b9d2e-value';
const PROJECT = '0190a000-0000-7000-8000-000000000001';
const SERVICE = '0190a000-0000-7000-8000-000000000002';
const VARIABLE = '0190a000-0000-7000-8000-000000000003';
const BASE = `/api/projects/${PROJECT}/services/${SERVICE}/env`;

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** A database whose every query fails the way Drizzle does: the bound value in the message. */
function leakyDb(): Database {
  const fail = () => {
    const error = new Error(`Failed query: insert into "environment_variables" params: ${CANARY}`);
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
  const deps: EnvServiceDeps = { db, now: () => new Date('2026-11-01T10:00:00Z') };
  app.decorate('getEnvServices', () => Promise.resolve(deps));
  await app.register(envRoutes);
  await app.ready();
  return { app, logs };
}

describe('variables API error paths never echo a value (23-02 H1)', () => {
  it.each<[string, Record<string, unknown>, number, string]>([
    ['a multi-line value', { key: 'API_KEY', value: `${CANARY}\nline2` }, 422, 'ENV_VALUE_MULTILINE'],
    ['a NUL byte', { key: 'API_KEY', value: `${CANARY}\u0000` }, 422, 'ENV_VALUE_MULTILINE'],
    ['a malformed reference', { key: 'API_KEY', value: `<secret: ${CANARY}>` }, 422, 'ENV_INPUT_INVALID'],
    ['a value pasted as key', { key: CANARY, value: 'x' }, 422, 'ENV_INPUT_INVALID'],
    ['a too long value', { key: 'API_KEY', value: CANARY.repeat(MAX_ENV_VALUE_BYTES / CANARY.length + 1) }, 400, 'VALIDATION_FAILED'],
    ['an unknown field', { key: 'API_KEY', value: 'x', secret: CANARY }, 400, 'VALIDATION_FAILED'],
  ])('rejects %s', async (_label, body, status, error) => {
    const { app, logs } = await build();
    const response = await app.inject({ method: 'POST', url: BASE, payload: body });
    expect(response.statusCode, response.body).toBe(status);
    if (error !== 'VALIDATION_FAILED') expect(response.json<{ error: string }>().error).toBe(error);
    expect(response.body).not.toContain(CANARY);
    expect(logs.join('')).not.toContain(CANARY);
  });

  it('applies the same value checks on update (H2)', async () => {
    const { app } = await build();
    const multiline = await app.inject({ method: 'PATCH', url: `${BASE}/${VARIABLE}`, payload: { value: `${CANARY}\r` } });
    expect(multiline.statusCode).toBe(422);
    expect(multiline.json<{ error: string }>().error).toBe('ENV_VALUE_MULTILINE');
    const badKey = await app.inject({ method: 'PATCH', url: `${BASE}/${VARIABLE}`, payload: { key: 'lower', value: 'x' } });
    expect(badKey.statusCode).toBe(422);
    expect(badKey.json<{ reason: string }>().reason).toBe('ENV_KEY_INVALID');
    expect(multiline.body + badKey.body).not.toContain(CANARY);
  });

  it('caps the body', async () => {
    const { app, logs } = await build();
    const response = await app.inject({
      method: 'POST',
      url: BASE,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ key: 'API_KEY', value: CANARY.repeat(ENV_ROUTE_BODY_LIMIT_BYTES / CANARY.length + 1) }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.body).not.toContain(CANARY);
    expect(logs.join('')).not.toContain(CANARY);
  });

  it('rethrows a driver error without its message', async () => {
    const { app, logs } = await build(leakyDb());
    for (const [method, url] of [
      ['POST', BASE],
      ['PATCH', `${BASE}/${VARIABLE}`],
      ['DELETE', `${BASE}/${VARIABLE}`],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        ...(method === 'DELETE' ? {} : { payload: { key: 'API_KEY', value: CANARY } }),
      });
      expect(response.statusCode, response.body).toBe(500);
      expect(response.body).not.toContain(CANARY);
    }
    expect(logs.join('')).toContain('SQLSTATE 23514');
    expect(logs.join('')).not.toContain(CANARY);
  });
});
