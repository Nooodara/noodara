import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

// Phase-1 subset of `pnpm security:scan-leaks` (noodara-security skill §9): drives runtime-
// generated canary values through the logger, a thrown HTTP error and `writeActivityEvent`'s
// metadata column, and asserts none of them appear in the raw captured output. The full
// flow-driven scan covering SSH stdout/stderr and AI prompts arrives with SEC-02 (phase 3) and
// QA-05 (phase 5) — this proves the primitives those later scans build on (`appRedactor`,
// `writeActivityEvent`, pino's `redact.paths`).
//
// Every dynamic import below happens only after `startTestApp()` has already written a valid
// test environment to `process.env`, matching Plan 01-07's convention — `env.ts`/`logger.ts`/
// `activity/redaction.ts` all transitively fail-fast at *import time* (INST-06), so a static
// top-level import here would crash the whole worker before any test ran.

let fixture: TestAppFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  const stray = containers.filter((c) => c.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
});

describe('canary proof: a known secret leaks through none of the logger, an HTTP error body, or the activity log', () => {
  it('redacts a runtime SSH-password canary, a private-key canary and the master key from all three captured outputs', async () => {
    fixture = await startTestApp();
    const { writeActivityEvent } = await import(
      '../../../apps/control-plane/src/activity/write-activity-event.js'
    );
    const { appRedactor } = await import('../../../apps/control-plane/src/activity/redaction.js');
    const { createLogger, writableForTests } = await import('../../../apps/control-plane/src/logger.js');
    const { env } = await import('../../../apps/control-plane/src/env.js');

    // `randomBytes` per-run generation (not a hardcoded literal) so a stale canary can never
    // accidentally pass this test by coincidence.
    const sshPasswordCanary = randomBytes(24).toString('hex');
    const privateKeyCanary = `-----BEGIN OPENSSH PRIVATE KEY-----\n${randomBytes(24).toString('hex')}\n-----END OPENSSH PRIVATE KEY-----`;
    const masterKeyValue = env.NOODARA_MASTER_KEY;

    appRedactor.register(sshPasswordCanary, 'ssh_password');
    appRedactor.register(privateKeyCanary, 'ssh_private_key');

    try {
      // (a) logger.error — nested under the exact object shapes `logger.ts`'s pino `redact.paths`
      // already covers (`*.credential`, `req.body.sshPrivateKey`, `*.masterKey`), matching the
      // same canary pattern `logger.test.ts` already exercises for this logger.
      const { stream, records } = writableForTests();
      const logger = createLogger({ level: 'info', destination: stream });
      logger.error({
        connection: { credential: sshPasswordCanary },
        req: { body: { sshPrivateKey: privateKeyCanary } },
        boot: { masterKey: masterKeyValue },
      });
      const logOutput = JSON.stringify(records());

      // (b) a thrown error serialised by a Fastify error handler. No production route touches a
      // credential yet (that lands with phase 3's application services and phase 4's HTTP
      // routes; `app.ts` is intentionally not modified by this plan) — this wires onto the
      // running test app instance the exact pattern those future routes must follow: redact the
      // message through `appRedactor` before it ever reaches the client.
      fixture.app.get('/__canary/throw', (_request, _reply) => {
        throw new Error(
          `ssh auth failed for password=${sshPasswordCanary} key=${privateKeyCanary} masterKey=${masterKeyValue}`,
        );
      });
      fixture.app.setErrorHandler((error, _request, reply) => {
        reply
          .status(500)
          .send({ error: 'Internal Server Error', message: appRedactor.redact(error.message) });
      });
      const response = await fixture.app.inject({ method: 'GET', url: '/__canary/throw' });
      const errorBody = response.body;

      // (c) activity_events.metadata — the canaries sit under ordinary (non-forbidden) key
      // names, so this specifically proves the Redactor's value-based pass rather than
      // `buildActivityEvent`'s key-name guard (covered separately in auth-events.test.ts).
      const rowId = await writeActivityEvent(fixture.db, {
        actorType: 'user',
        actorId: null,
        entityType: 'user',
        entityId: randomUUID(),
        action: 'auth.login_failed',
        outcome: 'failure',
        metadata: {
          attempt: {
            note: sshPasswordCanary,
            keyNote: privateKeyCanary,
            masterKeyNote: masterKeyValue,
          },
        },
      });
      const persisted = await fixture.db.execute<{ metadata: unknown }>(
        sql`select metadata from activity_events where id = ${rowId}`,
      );
      const persistedMetadata = JSON.stringify(persisted.rows[0]?.metadata);

      for (const captured of [logOutput, errorBody, persistedMetadata]) {
        expect(captured).not.toContain(sshPasswordCanary);
        expect(captured).not.toContain(privateKeyCanary);
        expect(captured).not.toContain('BEGIN OPENSSH PRIVATE KEY');
        expect(captured).not.toContain(masterKeyValue);
      }
    } finally {
      appRedactor.release(sshPasswordCanary);
      appRedactor.release(privateKeyCanary);
    }
  });
});
