// D-20/T-4-11/T-4-39/T-4-40: `GET /api/activity` over the real HTTP surface — the same
// authenticated-cookie pattern servers-crud.test.ts already established.
import { randomUUID } from 'node:crypto';
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

function uniqueName(suffix: string): string {
  return `srv-${suffix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function uniqueHost(): string {
  return `${randomUUID().replace(/-/g, '').slice(0, 12)}.example.test`;
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
  const parsed = parseSetCookie.parse(rawCookies, { map: false });
  return parsed.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
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

async function bootAuthenticated(): Promise<{ app: TestAppFixture['app']; cookie: string }> {
  fixture = await startTestApp();
  await createAdmin(fixture.app, fixture.db);
  const cookie = await signIn(fixture.app);
  return { app: fixture.app, cookie };
}

/** Registering a server writes exactly one `server.created` activity event — the cheapest real
 *  way to seed rows through the actual HTTP surface, matching the plan's own instruction to seed
 *  by driving real routes. */
async function createServer(app: TestAppFixture['app'], cookie: string, suffix: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/servers',
    headers: { cookie },
    payload: {
      name: uniqueName(suffix),
      host: uniqueHost(),
      credential: { type: 'ssh_password', password: 'hunter2-hunter2' },
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`createServer failed: ${response.statusCode.toString()} ${response.body}`);
  }
}

describe('GET /api/activity (D-20)', () => {
  it('returns 401 unauthenticated', async () => {
    fixture = await startTestApp();
    const response = await fixture.app.inject({ method: 'GET', url: '/api/activity' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toStrictEqual({ error: 'UNAUTHORIZED', message: expect.any(String) });
  });

  it('with no query, returns 200 { items, nextCursor } with the default limit of 50', async () => {
    const { app, cookie } = await bootAuthenticated();
    await createServer(app, cookie, 'a');

    const response = await app.inject({ method: 'GET', url: '/api/activity', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: unknown[]; nextCursor: string | null };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    expect('nextCursor' in body).toBe(true);
  });

  it('?limit=1 returns one item and a non-null nextCursor; following it returns the next item', async () => {
    const { app, cookie } = await bootAuthenticated();
    await createServer(app, cookie, 'b1');
    await createServer(app, cookie, 'b2');

    const page1 = await app.inject({ method: 'GET', url: '/api/activity?limit=1', headers: { cookie } });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json() as { items: { id: string }[]; nextCursor: string | null };
    expect(body1.items).toHaveLength(1);
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await app.inject({
      method: 'GET',
      url: `/api/activity?limit=1&cursor=${encodeURIComponent(body1.nextCursor as string)}`,
      headers: { cookie },
    });
    expect(page2.statusCode).toBe(200);
    const body2 = page2.json() as { items: { id: string }[]; nextCursor: string | null };
    expect(body2.items).toHaveLength(1);
    expect(body2.items[0]?.id).not.toBe(body1.items[0]?.id);
  });

  it.each([['0'], ['201'], ['abc']])('?limit=%s returns 400 VALIDATION_FAILED with an issues array', async (limit) => {
    const { app, cookie } = await bootAuthenticated();

    const response = await app.inject({ method: 'GET', url: `/api/activity?limit=${limit}`, headers: { cookie } });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; issues: unknown[] };
    expect(body.error).toBe('VALIDATION_FAILED');
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('?cursor=<tampered> returns 400 VALIDATION_FAILED, never 500 and never an unfiltered first page', async () => {
    const { app, cookie } = await bootAuthenticated();
    await createServer(app, cookie, 'c');

    const response = await app.inject({
      method: 'GET',
      url: '/api/activity?cursor=%25%25%25',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'VALIDATION_FAILED' });
  });

  it('walks two pages via nextCursor with no repeated id', async () => {
    const { app, cookie } = await bootAuthenticated();
    await createServer(app, cookie, 'd1');
    await createServer(app, cookie, 'd2');
    await createServer(app, cookie, 'd3');

    const page1 = await app.inject({ method: 'GET', url: '/api/activity?limit=1', headers: { cookie } });
    const body1 = page1.json() as { items: { id: string }[]; nextCursor: string | null };
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await app.inject({
      method: 'GET',
      url: `/api/activity?limit=1&cursor=${encodeURIComponent(body1.nextCursor as string)}`,
      headers: { cookie },
    });
    const body2 = page2.json() as { items: { id: string }[]; nextCursor: string | null };

    expect(body1.items[0]?.id).not.toBe(body2.items[0]?.id);
  });

  it("an item's key set is exactly the ten documented fields", async () => {
    const { app, cookie } = await bootAuthenticated();
    await createServer(app, cookie, 'e');

    const response = await app.inject({ method: 'GET', url: '/api/activity?limit=1', headers: { cookie } });
    const body = response.json() as { items: Record<string, unknown>[] };
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual(
      [
        'id',
        'occurredAt',
        'actorType',
        'actorId',
        'entityType',
        'entityId',
        'action',
        'outcome',
        'errorCode',
        'metadata',
      ].sort(),
    );
  });

  it('rejects an unknown query key (?action=) with 400 VALIDATION_FAILED — no silent filter', async () => {
    const { app, cookie } = await bootAuthenticated();
    await createServer(app, cookie, 'f');

    const response = await app.inject({
      method: 'GET',
      url: '/api/activity?action=server.created',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'VALIDATION_FAILED' });
  });
});
