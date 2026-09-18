// D-22/T-4-05/T-4-04: the phase-4 extension of `pnpm security:scan-leaks` — the same canary
// discipline `canary.test.ts` (Phase 1) and `canary-full-flow.test.ts` (Phase 3) already apply,
// now driven at the real HTTP layer this phase adds: a per-run random password canary and a
// per-run random private-key passphrase canary submitted through `POST /api/servers` and
// `PATCH /api/servers/:id`, scanned across every new surface — success bodies, error bodies
// (4xx and a forced 500 on a live route, through the real production error handler), SSE frames,
// captured logs, `activity_events.metadata` and `discovery_snapshots.payload`.
//
// Every dynamic import below happens only after `startTestApp()` has already written a valid test
// environment to `process.env` — `env.ts`/`logger.ts`/`activity/redaction.ts` all transitively
// fail-fast at *import time* (INST-06), matching every other suite in this phase.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { activityEvents, discoverySnapshots } from '../../../apps/control-plane/src/db/schema/index.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { revealSecret } from '@noodara/domain/security';
import { startRedis, type RedisFixture } from '../helpers/redis.js';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';
import { buildFakeSshPort, buildFakeSshSession } from '../services/helpers/service-fixture.js';

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';

let fixture: TestAppFixture | undefined;
let redis: RedisFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;
  await redis?.stop();
  redis = undefined;

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  const stray = containers.filter((c) => c.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
});

function uniqueName(): string {
  return `canary-http-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function uniqueHost(): string {
  return `${randomUUID().replace(/-/g, '').slice(0, 12)}.example.test`;
}

/** A real, genuinely passphrase-locked ed25519 key, generated per-run into a temp dir (never a
 *  committed literal) — needed because `editServer`'s credential validation (`loadPrivateKey`)
 *  actually parses and decrypts the key with the submitted passphrase before persisting it, so
 *  only a real, matching key/passphrase pair reaches a 200 response. */
function generateLockedEd25519Key(passphrase: string): { privateKey: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'noodara-canary-http-key-'));
  execFileSync('ssh-keygen', ['-q', '-N', passphrase, '-t', 'ed25519', '-f', join(dir, 'key')], {
    stdio: 'ignore',
  });
  const privateKey = readFileSync(join(dir, 'key'), 'utf8');
  return { privateKey, cleanup: () => { rmSync(dir, { recursive: true, force: true }); } };
}

async function createAdmin(app: TestAppFixture['app'], db: TestAppFixture['db']): Promise<void> {
  const issued = await issueToken(db, 'setup', new Date());
  const response = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { token: revealSecret(issued.token), email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Admin' },
  });
  if (response.statusCode !== 200) {
    throw new Error(`setup failed: ${response.statusCode.toString()} ${response.body}`);
  }
}

function cookieHeaderFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const rawCookies = Array.isArray(raw) ? raw : raw !== undefined ? [String(raw)] : [];
  return rawCookies.map((cookie) => String(cookie).split(';')[0]).join('; ');
}

async function signIn(app: TestAppFixture['app']): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (response.statusCode !== 200) {
    throw new Error(`sign-in failed: ${response.statusCode.toString()} ${response.body}`);
  }
  return cookieHeaderFrom(response);
}

const FAKE_FINGERPRINT = { keyType: 'ssh-ed25519', fingerprint: `SHA256:${'C'.repeat(43)}` } as const;

describe('canary proof: the HTTP and SSE surfaces this phase adds leak no secret (D-22, T-4-04, T-4-05)', () => {
  it(
    'redacts a runtime SSH-password canary and a private-key-passphrase canary from success ' +
      'bodies, error bodies, a forced 500, SSE frames, logs, activity metadata and discovery ' +
      'snapshot payloads',
    async () => {
      redis = await startRedis();

      let logRecords: (() => unknown[]) | undefined;
      let redactor: { register: (v: string, t: string) => void; release: (v: string) => void } | undefined;

      fixture = await startTestApp({
        redisUrl: redis.connectionUrl,
        buildLogger: async () => {
          const { writableForTests, createLogger } = await import('../../../apps/control-plane/src/logger.js');
          const { appRedactor } = await import('../../../apps/control-plane/src/activity/redaction.js');
          redactor = appRedactor;
          const capture = writableForTests();
          logRecords = capture.records;
          return createLogger({ level: 'info', destination: capture.stream });
        },
      });

      // Per-run random canaries only — never a committed literal (noodara-security skill §9).
      // Declared with `let` and assigned below, but the route referencing them is registered
      // *before* `createAdmin`/`signIn` make this app's first `inject()` call — Fastify refuses
      // new route registration once the instance has started listening/become ready, and the
      // closure below only reads these bindings once the route actually fires, well after they
      // are assigned.
      let passwordCanary = '';
      let passphraseCanary = '';
      fixture.app.get('/__canary/http-throw', () => {
        throw new Error(`ssh auth failed for password=${passwordCanary} passphrase=${passphraseCanary}`);
      });

      await createAdmin(fixture.app, fixture.db);
      const cookie = await signIn(fixture.app);

      passwordCanary = randomBytes(24).toString('hex');
      passphraseCanary = randomBytes(18).toString('base64url');
      const lockedKey = generateLockedEd25519Key(passphraseCanary);

      redactor?.register(passwordCanary, 'ssh_password');
      redactor?.register(passphraseCanary, 'ssh_private_key');

      try {
        // Open the SSE stream before any canary is submitted, and keep it open across the whole
        // flow — `app.inject({ payloadAsStream: true })` never resolves the naive way (RESEARCH
        // Pitfall 4), so every frame is collected off the readable stream as it arrives.
        const streamResponse = await fixture.app.inject({
          method: 'GET',
          url: '/api/events',
          headers: { cookie },
          payloadAsStream: true,
        });
        const streamChunks: string[] = [];
        const streamReadable = streamResponse.stream();
        streamReadable.on('data', (chunk: Buffer) => {
          streamChunks.push(chunk.toString('utf8'));
        });

        // Act 1 (success body, non-vacuity: the canary is the actual submitted credential value —
        // a 201 proves the server genuinely accepted and persisted it, not that the request was
        // silently rejected before ever reaching the credential-encoding path).
        const serverName = uniqueName();
        const registerResponse = await fixture.app.inject({
          method: 'POST',
          url: '/api/servers',
          headers: { cookie },
          payload: {
            name: serverName,
            host: uniqueHost(),
            credential: { type: 'ssh_password', password: passwordCanary },
          },
        });
        expect(registerResponse.statusCode).toBe(201);
        const serverId = (registerResponse.json() as { id: string }).id;

        // Act 2 (success body): replace the credential with the locked key + passphrase canary.
        const editResponse = await fixture.app.inject({
          method: 'PATCH',
          url: `/api/servers/${serverId}`,
          headers: { cookie },
          payload: {
            credential: { type: 'ssh_private_key', privateKey: lockedKey.privateKey, passphrase: passphraseCanary },
          },
        });
        expect(editResponse.statusCode).toBe(200);

        const successBodies = [registerResponse.body, editResponse.body];

        // Act 3 (4xx error body): re-submit the same canary in an otherwise-invalid payload — a
        // duplicate name.
        const duplicateResponse = await fixture.app.inject({
          method: 'POST',
          url: '/api/servers',
          headers: { cookie },
          payload: {
            name: serverName,
            host: uniqueHost(),
            credential: { type: 'ssh_password', password: passwordCanary },
          },
        });
        expect(duplicateResponse.statusCode).toBe(409);

        // Act 4 (forced 500 on a live route): canaries re-registered immediately before this
        // capture per Phase 3's own attempt-scoped-registration finding, so this capture cannot
        // depend on the up-front registration above having survived every prior request. The
        // route itself was registered earlier, before `app.ready()` (Fastify refuses new routes
        // once ready) — only the redactor registration needs to happen fresh here.
        redactor?.register(passwordCanary, 'ssh_password');
        redactor?.register(passphraseCanary, 'ssh_private_key');
        const throwResponse = await fixture.app.inject({ method: 'GET', url: '/__canary/http-throw' });
        expect(throwResponse.statusCode).toBe(500);
        // T-4-04: this is the real, production `app.setErrorHandler` (app.ts) — no test-local
        // handler is installed anywhere in this file.
        expect(throwResponse.json()).toStrictEqual({ error: 'INTERNAL_ERROR', message: 'Internal error' });

        const errorBodies = [duplicateResponse.body, throwResponse.body];

        // Act 5: a real connectAndDiscover run (fake SshPort — no sshd container needed for this
        // canary suite; the real-sshd proof lives in canary-full-flow.test.ts and api-e2e.test.ts)
        // over the exact same Postgres row and a real Redis-backed publisher on this app's own
        // channel, so a genuine discovery_snapshots row exists and the SSE stream receives its
        // server.updated frames too.
        redactor?.register(passwordCanary, 'ssh_password');
        redactor?.register(passphraseCanary, 'ssh_private_key');
        const { resolveServerServicesDeps } = await import(
          '../../../apps/control-plane/src/services/server-service-deps.js'
        );
        const { createServerServices } = await import('../../../apps/control-plane/src/services/server-services.js');
        const { createRedisServerEventPublisher } = await import(
          '../../../apps/control-plane/src/events/redis-server-event-publisher.js'
        );
        const { createPublisherRedisConnection } = await import('../../../apps/control-plane/src/redis/connections.js');

        const publisherConnection = createPublisherRedisConnection(redis.connectionUrl);
        const eventPublisher = createRedisServerEventPublisher(publisherConnection, fixture.app.log);
        const fakeSsh = buildFakeSshPort({
          ok: true,
          session: buildFakeSshSession({}),
          fingerprint: FAKE_FINGERPRINT,
          fingerprintCaptured: true,
          attempts: 1,
        });
        const deps = await resolveServerServicesDeps({ db: fixture.db, ssh: fakeSsh, events: eventPublisher });
        const services = createServerServices(deps);
        const connectResult = await services.connectAndDiscover({ actor: { type: 'system' }, serverId });
        if (!connectResult.ok) {
          throw new Error(`connectAndDiscover failed unexpectedly: ${connectResult.code}`);
        }
        publisherConnection.disconnect();

        // Give the SSE broadcaster's real Redis subscription a moment to fan the two
        // connectAndDiscover publishes out to the already-open stream above.
        await new Promise((resolve) => {
          setTimeout(resolve, 500);
        });

        // Assert: every captured surface is canary-free.
        for (const body of [...successBodies, ...errorBodies]) {
          expect(body).not.toContain(passwordCanary);
          expect(body).not.toContain(passphraseCanary);
        }

        const framesText = streamChunks.join('');
        expect(framesText).not.toContain(passwordCanary);
        expect(framesText).not.toContain(passphraseCanary);

        const logsText = JSON.stringify(logRecords?.() ?? []);
        expect(logsText).not.toContain(passwordCanary);
        expect(logsText).not.toContain(passphraseCanary);
        expect(logsText).not.toContain('BEGIN OPENSSH PRIVATE KEY');

        const metadataRows = await fixture.db
          .select({ metadata: activityEvents.metadata })
          .from(activityEvents)
          .where(eq(activityEvents.entityId, serverId));
        expect(metadataRows.length).toBeGreaterThan(0);
        const metadataText = JSON.stringify(metadataRows);
        expect(metadataText).not.toContain(passwordCanary);
        expect(metadataText).not.toContain(passphraseCanary);

        const snapshotRows = await fixture.db
          .select()
          .from(discoverySnapshots)
          .where(eq(discoverySnapshots.serverId, serverId));
        // Non-vacuity for this specific surface: a real snapshot row exists, so the absence
        // assertion below is a genuine scan, not a vacuously-true check of an empty table.
        expect(snapshotRows.length).toBeGreaterThan(0);
        const snapshotText = JSON.stringify(snapshotRows);
        expect(snapshotText).not.toContain(passwordCanary);
        expect(snapshotText).not.toContain(passphraseCanary);

        streamReadable.destroy();
      } finally {
        redactor?.release(passwordCanary);
        redactor?.release(passphraseCanary);
        lockedKey.cleanup();
      }
    },
  );
});
