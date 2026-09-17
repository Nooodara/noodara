import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

// D-22/Task 2: proves `app.ts`'s global `setErrorHandler` is real production wiring, not just the
// pattern `tests/integration/activity/canary.test.ts` demonstrated on a test-local handler. Every
// dynamic import below happens only after `startTestApp()` has written a valid test environment
// to `process.env` (Plan 01-07's convention — `env.ts`/`logger.ts` fail-fast at import time).

let fixture: TestAppFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  const stray = containers.filter((c) => c.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
});

describe('global error handler (D-22, T-4-04, T-4-20, T-4-21, T-4-22)', () => {
  it('an unhandled throw responds with an opaque redacted 500 and the process stays alive', async () => {
    const canary = randomBytes(24).toString('hex');
    let records: (() => unknown[]) | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural Redactor shape, no import before startTestApp
    let redactor: { register: (v: string, t: string) => void; release: (v: string) => void } | undefined;

    fixture = await startTestApp({
      buildLogger: async () => {
        const { writableForTests, createLogger } = await import('../../../apps/control-plane/src/logger.js');
        const { appRedactor } = await import('../../../apps/control-plane/src/activity/redaction.js');
        redactor = appRedactor;
        const capture = writableForTests();
        records = capture.records;
        return createLogger({ level: 'info', destination: capture.stream });
      },
    });

    // Mirrors `tests/integration/activity/canary.test.ts`'s pattern: the redactor only redacts
    // values it has been told about — this proves the error handler routes every unhandled
    // exception's message through `appRedactor.redact`, not that an arbitrary unregistered string
    // gets scrubbed by magic.
    redactor?.register(canary, 'test_canary');

    fixture.app.get('/__probe/throw', () => {
      throw new Error(`boom: ${canary}`);
    });
    await fixture.app.ready();

    try {
      const response = await fixture.app.inject({ method: 'GET', url: '/__probe/throw' });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toStrictEqual({ error: 'INTERNAL_ERROR', message: 'Internal error' });
      expect(response.body).not.toContain('boom');
      expect(response.body).not.toContain(canary);
      expect(response.body).not.toContain('at ');

      const capturedRecords = records?.() ?? [];
      const logged = JSON.stringify(capturedRecords);
      expect(logged).not.toContain(canary);

      const errorRecord = capturedRecords.find(
        (record): record is { requestId: string; reqId: string } =>
          typeof record === 'object' &&
          record !== null &&
          'msg' in record &&
          (record as { msg: unknown }).msg === 'unhandled error',
      );
      expect(errorRecord?.requestId).toBeTruthy();
      expect(errorRecord?.requestId).toBe(errorRecord?.reqId);

      const health = await fixture.app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
    } finally {
      redactor?.release(canary);
    }
  });

  it('a Zod body validation failure responds 400 VALIDATION_FAILED with only path/message issues', async () => {
    fixture = await startTestApp();

    fixture.app.withTypeProvider<ZodTypeProvider>().route({
      method: 'POST',
      url: '/__probe/validate',
      schema: { body: z.object({ name: z.string().min(1) }) },
      handler: (_request, reply) => {
        reply.send({ ok: true });
      },
    });
    await fixture.app.ready();

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/__probe/validate',
      payload: { name: 42 },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; issues: unknown[] };
    expect(body.error).toBe('VALIDATION_FAILED');
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
    for (const issue of body.issues) {
      expect(Object.keys(issue as object).sort()).toStrictEqual(['message', 'path']);
    }
  });

  it('a response that fails its own response schema responds 500 INTERNAL_ERROR', async () => {
    fixture = await startTestApp();

    fixture.app.withTypeProvider<ZodTypeProvider>().route({
      method: 'GET',
      url: '/__probe/bad-response',
      schema: { response: { 200: z.object({ ok: z.literal(true) }) } },
      // Deliberately violates its own declared response schema.
      handler: (_request, reply) => {
        reply.send({ ok: false } as unknown as { ok: true });
      },
    });
    await fixture.app.ready();

    const response = await fixture.app.inject({ method: 'GET', url: '/__probe/bad-response' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toStrictEqual({ error: 'INTERNAL_ERROR', message: 'Internal error' });
  });

  it('a route replying with an explicit toErrorBody 4xx passes through untouched', async () => {
    const { toErrorBody } = await import('../../../apps/control-plane/src/routes/http-errors.js');
    fixture = await startTestApp();

    fixture.app.get('/__probe/explicit-409', async (_request, reply) => {
      await reply.code(409).send(toErrorBody('SERVER_BUSY', 'already busy'));
    });
    await fixture.app.ready();

    const response = await fixture.app.inject({ method: 'GET', url: '/__probe/explicit-409' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toStrictEqual({ error: 'SERVER_BUSY', message: 'already busy' });
  });
});
