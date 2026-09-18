// D-21/T-4-12: `GET /api/config` — guarded, read-only, exposes only the master key's truncated
// SHA-256 fingerprint.
import parseSetCookie from 'set-cookie-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { revealSecret } from '@noodara/domain/security';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';

let fixture: TestAppFixture | undefined;

beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  const stray = containers.filter((c) => c.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
});

function cookieHeaderFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const rawCookies = Array.isArray(raw) ? raw : raw !== undefined ? [String(raw)] : [];
  const parsed = parseSetCookie.parse(rawCookies, { map: false });
  return parsed.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

async function bootAuthenticated(): Promise<{ app: TestAppFixture['app']; cookie: string }> {
  fixture = await startTestApp();
  const issued = await issueToken(fixture.db, 'setup', new Date());
  const setupResponse = await fixture.app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { token: revealSecret(issued.token), email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Admin' },
  });
  if (setupResponse.statusCode !== 200) {
    throw new Error(`setup failed: ${setupResponse.statusCode.toString()} ${setupResponse.body}`);
  }
  const signInResponse = await fixture.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (signInResponse.statusCode !== 200) {
    throw new Error(`sign-in failed: ${signInResponse.statusCode.toString()} ${signInResponse.body}`);
  }
  return { app: fixture.app, cookie: cookieHeaderFrom(signInResponse) };
}

describe('GET /api/config (D-21)', () => {
  it('returns 401 unauthenticated', async () => {
    fixture = await startTestApp();
    const response = await fixture.app.inject({ method: 'GET', url: '/api/config' });
    expect(response.statusCode).toBe(401);
  });

  it('returns 200 with version/publicUrl/masterKeyFingerprint/sshTimeouts/workerConcurrency', async () => {
    const { app, cookie } = await bootAuthenticated();
    const response = await app.inject({ method: 'GET', url: '/api/config', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      version: string;
      publicUrl: string;
      masterKeyFingerprint: string;
      sshTimeouts: { connectMs: number; commandMs: number; discoveryMs: number };
      workerConcurrency: number;
    };
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    expect(body.publicUrl).toBe(process.env.NOODARA_PUBLIC_URL);
    expect(body.masterKeyFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof body.sshTimeouts.connectMs).toBe('number');
    expect(typeof body.sshTimeouts.commandMs).toBe('number');
    expect(typeof body.sshTimeouts.discoveryMs).toBe('number');
    expect(typeof body.workerConcurrency).toBe('number');
  });

  it('never leaks the raw master key or its prefix in the response body', async () => {
    const { app, cookie } = await bootAuthenticated();
    const rawMasterKey = process.env.NOODARA_MASTER_KEY;
    if (rawMasterKey === undefined) throw new Error('NOODARA_MASTER_KEY not set by test fixture');

    const response = await app.inject({ method: 'GET', url: '/api/config', headers: { cookie } });
    const rawBody = response.body;

    expect(rawBody).not.toContain(rawMasterKey);
    expect(rawBody).not.toContain(rawMasterKey.slice(0, 8));
  });

  it('has no PUT (404, never confirmed as a guarded-but-wrong-method route)', async () => {
    const { app, cookie } = await bootAuthenticated();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });

  it('has no PATCH', async () => {
    const { app, cookie } = await bootAuthenticated();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });

  it('version equals CONTROL_PLANE_VERSION and publicUrl equals NOODARA_PUBLIC_URL', async () => {
    const { app, cookie } = await bootAuthenticated();
    const { CONTROL_PLANE_VERSION } = await import('../../../apps/control-plane/src/config-version.js');

    const response = await app.inject({ method: 'GET', url: '/api/config', headers: { cookie } });
    const body = response.json() as { version: string; publicUrl: string };

    expect(body.version).toBe(CONTROL_PLANE_VERSION);
    expect(body.publicUrl).toBe(process.env.NOODARA_PUBLIC_URL);
  });
});
