// WR-A-02 (05-REVIEW.md; 05-VERIFICATION.md gap 6's second linked defect). RED for the
// status-independent pendingFingerprint clear on an identity-changing edit.
//
// Before this plan's Task 3 fix, `editServer` only clears `pendingFingerprint` /
// `pendingFingerprintSeenAt` inside `else if (row.status === 'ERROR' && row.pendingFingerprint !==
// null)` — a false premise: `applyConnectionResult` keeps `pendingFingerprint` non-null across a
// successful connect and every non-HOST_KEY_CHANGED failure too, so a fingerprint captured
// against the *old* host/port/user can survive an identity edit made from CONNECTED or
// UNREACHABLE, and a subsequent `HOST_KEY_CHANGED` against the *new* identity is spuriously
// pre-empted (or a stale value sits promotable). This suite drives the real HTTP `PATCH
// /api/servers/:id` route (never the service directly, matching
// trust-fingerprint-binding.test.ts's own discipline), arranging the pending-fingerprint state
// with a direct Drizzle row write (mirrors tests/integration/routes/servers-crud.test.ts's own
// `SERVER_BUSY` arrangement: `db.update(servers).set({ status: 'CONNECTING' })`).
//
// tests/integration/services/edit-server.test.ts's existing "UF-01" describe block already covers
// the ERROR-status case (host/port/user changes clearing a stale pending fingerprint) at the
// service layer — this file adds the two statuses UF-01's own guard never covered (CONNECTED,
// UNREACHABLE) at the HTTP layer, per the plan's WR-A-02 regression requirement.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import parseSetCookie from 'set-cookie-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { servers } from '../../../apps/control-plane/src/db/schema/index.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
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

async function bootAuthenticated(): Promise<{
  app: TestAppFixture['app'];
  cookie: string;
  db: TestAppFixture['db'];
}> {
  fixture = await startTestApp();
  await createAdmin(fixture.app, fixture.db);
  const cookie = await signIn(fixture.app);
  return { app: fixture.app, cookie, db: fixture.db };
}

async function createServer(
  app: TestAppFixture['app'],
  cookie: string,
  overrides: Partial<{ host: string; sshPort: number; sshUser: string }> = {},
): Promise<{ id: string; name: string; host: string; sshPort: number; sshUser: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/servers',
    headers: { cookie },
    payload: {
      name: uniqueName('t'),
      host: overrides.host ?? uniqueHost(),
      ...(overrides.sshPort !== undefined ? { sshPort: overrides.sshPort } : {}),
      ...(overrides.sshUser !== undefined ? { sshUser: overrides.sshUser } : {}),
      credential: { type: 'ssh_password', password: randomUUID() },
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`createServer failed: ${response.statusCode.toString()} ${response.body}`);
  }
  const body = response.json() as { id: string; name: string; host: string; sshPort: number; sshUser: string };
  return body;
}

const STALE_FP = 'ssh-ed25519 SHA256:STALEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE';

/** Direct row UPDATE arranging a server that is (a) in some status other than CONNECTING, and (b)
 *  already carrying a pending fingerprint — exactly the pre-condition WR-A-02 says the old
 *  ERROR-only guard could not clear. Never a service call: this is data already sitting in
 *  Postgres, standing in for whatever real connect/discover history put it there. */
async function arrangeServerWithStatusAndPendingFingerprint(
  db: TestAppFixture['db'],
  serverId: string,
  status: typeof servers.$inferInsert.status,
): Promise<void> {
  await db
    .update(servers)
    .set({ status, pendingFingerprint: STALE_FP, pendingFingerprintSeenAt: new Date() })
    .where(eq(servers.id, serverId));
}

async function rawServerRow(db: TestAppFixture['db'], serverId: string) {
  const [row] = await db.select().from(servers).where(eq(servers.id, serverId));
  if (!row) {
    throw new Error(`rawServerRow: server ${serverId} not found`);
  }
  return row;
}

describe('PATCH /api/servers/:id clears pendingFingerprint on every identity-changing edit (WR-A-02)', () => {
  it('clears pendingFingerprint/pendingFingerprintSeenAt on a host change from UNREACHABLE', async () => {
    const { app, cookie, db } = await bootAuthenticated();
    const created = await createServer(app, cookie);
    await arrangeServerWithStatusAndPendingFingerprint(db, created.id, 'UNREACHABLE');

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/servers/${created.id}`,
      headers: { cookie },
      payload: { host: uniqueHost() },
    });

    expect(response.statusCode).toBe(200);
    const after = await rawServerRow(db, created.id);
    expect(after.pendingFingerprint).toBeNull();
    expect(after.pendingFingerprintSeenAt).toBeNull();
  });

  it('clears pendingFingerprint/pendingFingerprintSeenAt on an sshPort change from UNREACHABLE', async () => {
    const { app, cookie, db } = await bootAuthenticated();
    const created = await createServer(app, cookie, { sshPort: 22 });
    await arrangeServerWithStatusAndPendingFingerprint(db, created.id, 'UNREACHABLE');

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/servers/${created.id}`,
      headers: { cookie },
      payload: { sshPort: 2222 },
    });

    expect(response.statusCode).toBe(200);
    const after = await rawServerRow(db, created.id);
    expect(after.pendingFingerprint).toBeNull();
    expect(after.pendingFingerprintSeenAt).toBeNull();
  });

  it('clears pendingFingerprint/pendingFingerprintSeenAt on a host change from CONNECTED, alongside the existing D-14 identity_changed transition', async () => {
    const { app, cookie, db } = await bootAuthenticated();
    const created = await createServer(app, cookie);
    await arrangeServerWithStatusAndPendingFingerprint(db, created.id, 'CONNECTED');

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/servers/${created.id}`,
      headers: { cookie },
      payload: { host: uniqueHost() },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string };
    // D-14's existing identity_changed transition (unaffected by this plan): CONNECTED -> PENDING.
    expect(body.status).toBe('PENDING');
    const after = await rawServerRow(db, created.id);
    expect(after.pendingFingerprint).toBeNull();
    expect(after.pendingFingerprintSeenAt).toBeNull();
  });

  it('leaves pendingFingerprint untouched on a non-identity (name-only) edit from UNREACHABLE', async () => {
    const { app, cookie, db } = await bootAuthenticated();
    const created = await createServer(app, cookie);
    await arrangeServerWithStatusAndPendingFingerprint(db, created.id, 'UNREACHABLE');

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/servers/${created.id}`,
      headers: { cookie },
      payload: { name: uniqueName('renamed') },
    });

    expect(response.statusCode).toBe(200);
    const after = await rawServerRow(db, created.id);
    expect(after.pendingFingerprint).toBe(STALE_FP);
    expect(after.pendingFingerprintSeenAt).not.toBeNull();
  });

  it('still returns 409 SERVER_BUSY on CONNECTING, unaffected by this fix', async () => {
    const { app, cookie, db } = await bootAuthenticated();
    const created = await createServer(app, cookie);
    await db.update(servers).set({ status: 'CONNECTING' }).where(eq(servers.id, created.id));

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/servers/${created.id}`,
      headers: { cookie },
      payload: { host: uniqueHost() },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toStrictEqual({ error: 'SERVER_BUSY', message: expect.any(String) as string });
  });
});
