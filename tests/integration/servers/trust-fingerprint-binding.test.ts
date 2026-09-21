// Gap 6 / T-5G-27 (05-VERIFICATION.md gap 6; .planning/todos/pending/2026-09-19-trust-fingerprint-toctou.md,
// priority high; 05-REVIEW.md WR-A-02). RED for the fingerprint-bound, atomic, typed trust path.
//
// Before this plan's Task 2 fix: `POST /api/servers/:id/trust-fingerprint` declares no request
// body at all and promotes whatever `pending_fingerprint` the row holds at the moment the request
// lands — regardless of what the admin was shown when they clicked "Trust". This suite drives the
// real HTTP route (never the service directly, per the plan's own read_first note: "the todo's
// point is that the route is the boundary"), arranging pending-fingerprint state with a direct
// Drizzle row write (mirroring tests/integration/services/trust-fingerprint.test.ts's own
// `patchServerRow` precedent for arranging state no service call can be paused mid-flight to
// produce).
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import parseSetCookie from 'set-cookie-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { activityEvents, servers } from '../../../apps/control-plane/src/db/schema/index.js';
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

/** Boots a fresh app, creates the one admin and signs in — the setup every test in this file
 *  needs. Returns `db` alongside `app`/`cookie` so arrangement helpers never need to reach back
 *  into the module-level `fixture` (and never need an `as TestAppFixture` cast to do it). */
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

async function createServer(app: TestAppFixture['app'], cookie: string): Promise<{ id: string; name: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/servers',
    headers: { cookie },
    payload: {
      name: uniqueName('t'),
      host: uniqueHost(),
      credential: { type: 'ssh_password', password: randomUUID() },
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`createServer failed: ${response.statusCode.toString()} ${response.body}`);
  }
  const body = response.json() as { id: string; name: string };
  return { id: body.id, name: body.name };
}

const FP_A = 'ssh-ed25519 SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const FP_B = 'ssh-ed25519 SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const FP_C = 'ssh-ed25519 SHA256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

/** Direct row UPDATE, never a service call — arranges a pending-fingerprint state a real
 *  `connectAndDiscover` HOST_KEY_CHANGED outcome would have produced, without paying for a real
 *  SSH round-trip in every test in this file. Defaults to `ERROR` with `pending_fingerprint =
 *  FP_B` and `last_error_code = 'HOST_KEY_CHANGED'`, the only row shape a real HOST_KEY_CHANGED
 *  connect can produce (gap 6 / GR-01) — the new `trustFingerprint` guard reads `last_error_code`,
 *  so a helper that left it `null` would arrange an impossible row and mask the very gate this
 *  file exists to test. `overrides` spreads last so an individual case can still override it
 *  (e.g. to simulate a later, unrelated failure superseding the parked value). */
async function arrangePendingFingerprint(
  db: TestAppFixture['db'],
  serverId: string,
  overrides: Partial<typeof servers.$inferInsert> = {},
): Promise<void> {
  await db
    .update(servers)
    .set({
      status: 'ERROR',
      pendingFingerprint: FP_B,
      pendingFingerprintSeenAt: new Date(),
      hostFingerprint: null,
      lastErrorCode: 'HOST_KEY_CHANGED',
      ...overrides,
    })
    .where(eq(servers.id, serverId));
}

async function rawServerRow(db: TestAppFixture['db'], serverId: string) {
  const [row] = await db.select().from(servers).where(eq(servers.id, serverId));
  if (!row) {
    throw new Error(`rawServerRow: server ${serverId} not found`);
  }
  return row;
}

async function fingerprintTrustedEventCount(db: TestAppFixture['db'], serverId: string): Promise<number> {
  const rows = await db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, serverId), eq(activityEvents.action, 'server.fingerprint_trusted')));
  return rows.length;
}

describe('POST /api/servers/:id/trust-fingerprint binds to the fingerprint the admin actually saw (gap 6, T-5G-27)', () => {
  it('returns 409 FINGERPRINT_MISMATCH and promotes nothing when the submitted fingerprint does not match pending', async () => {
    const { app, cookie, db } = await bootAuthenticated();
    const { id: serverId } = await createServer(app, cookie);
    await arrangePendingFingerprint(db, serverId, { pendingFingerprint: FP_B });

    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/trust-fingerprint`,
      headers: { cookie },
      payload: { fingerprint: FP_A },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'FINGERPRINT_MISMATCH' });
    const after = await rawServerRow(db, serverId);
    expect(after.hostFingerprint).toBeNull();
    expect(after.pendingFingerprint).toBe(FP_B);
    expect(after.status).toBe('ERROR');
    expect(await fingerprintTrustedEventCount(db, serverId)).toBe(0);
  });

  it('returns 200 and promotes host_fingerprint when the submitted fingerprint matches pending exactly', async () => {
    const { app, cookie, db } = await bootAuthenticated();
    const { id: serverId } = await createServer(app, cookie);
    await arrangePendingFingerprint(db, serverId, { pendingFingerprint: FP_B });

    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/trust-fingerprint`,
      headers: { cookie },
      payload: { fingerprint: FP_B },
    });

    expect(response.statusCode).toBe(200);
    const after = await rawServerRow(db, serverId);
    expect(after.hostFingerprint).toBe(FP_B);
    expect(after.pendingFingerprint).toBeNull();
    expect(after.pendingFingerprintSeenAt).toBeNull();
    expect(after.status).toBe('PENDING');
    expect(await fingerprintTrustedEventCount(db, serverId)).toBe(1);
  });

  it('returns 400 VALIDATION_FAILED and promotes nothing when the body has no fingerprint', async () => {
    const { app, cookie, db } = await bootAuthenticated();
    const { id: serverId } = await createServer(app, cookie);
    await arrangePendingFingerprint(db, serverId, { pendingFingerprint: FP_B });

    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/trust-fingerprint`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'VALIDATION_FAILED' });
    const after = await rawServerRow(db, serverId);
    expect(after.pendingFingerprint).toBe(FP_B);
    expect(after.hostFingerprint).toBeNull();
  });

  it('returns 400 VALIDATION_FAILED and promotes nothing for an empty-string fingerprint', async () => {
    const { app, cookie, db } = await bootAuthenticated();
    const { id: serverId } = await createServer(app, cookie);
    await arrangePendingFingerprint(db, serverId, { pendingFingerprint: FP_B });

    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/trust-fingerprint`,
      headers: { cookie },
      payload: { fingerprint: '' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'VALIDATION_FAILED' });
    const after = await rawServerRow(db, serverId);
    expect(after.pendingFingerprint).toBe(FP_B);
  });

  it('never promotes a fingerprint that changed after the admin last saw it (TOCTOU, the todo\'s own scenario)', async () => {
    const { app, cookie, db } = await bootAuthenticated();
    const { id: serverId } = await createServer(app, cookie);
    // T1: the admin's dialog is showing FP_B — arranged as the currently-pending value.
    await arrangePendingFingerprint(db, serverId, { pendingFingerprint: FP_B });

    // T1.5: a second connect attempt commits independently of the admin's pending review,
    // observing yet another key and overwriting pending_fingerprint to FP_C — exactly the window
    // the todo describes. Reproduced here as a direct row write standing in for a second
    // connectAndDiscover run landing between the admin's GET and their POST (same "corrupt/change
    // data already in Postgres" standin tests/integration/servers/connect-wedge.test.ts's own
    // header comment documents for this harness).
    await db.update(servers).set({ pendingFingerprint: FP_C }).where(eq(servers.id, serverId));

    // T2: the admin submits the value they actually saw at T1 (FP_B), now stale relative to the
    // row's live pending_fingerprint (FP_C). The atomic conditional UPDATE this proves must never
    // promote FP_C just because it happens to be "whatever is currently pending".
    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/trust-fingerprint`,
      headers: { cookie },
      payload: { fingerprint: FP_B },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'FINGERPRINT_MISMATCH' });
    const after = await rawServerRow(db, serverId);
    expect(after.hostFingerprint).toBeNull();
    expect(after.pendingFingerprint).toBe(FP_C);
    expect(await fingerprintTrustedEventCount(db, serverId)).toBe(0);
  });

  it('returns 409 SERVER_NOT_TRUSTABLE and promotes nothing when a later AUTH_FAILED supersedes the parked HOST_KEY_CHANGED (gap 6 / GR-01 bypass, case 1)', async () => {
    const { app, cookie, db } = await bootAuthenticated();
    const { id: serverId } = await createServer(app, cookie);
    // T1: a real HOST_KEY_CHANGED connect parks FP_B while the previously trusted host_fingerprint
    // is still FP_A.
    await arrangePendingFingerprint(db, serverId, { pendingFingerprint: FP_B, hostFingerprint: FP_A });
    // T1.5: a second, unrelated connect failure (AUTH_FAILED) supersedes the parked
    // HOST_KEY_CHANGED without clearing pending_fingerprint or status — the exact row state
    // `applyConnectionResult` produced before plan 05-38's fix shipped, and still reachable for
    // any row written before that fix. This is a deliberate two-step sequence, not a single
    // arrangement call.
    await db.update(servers).set({ lastErrorCode: 'AUTH_FAILED' }).where(eq(servers.id, serverId));

    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/trust-fingerprint`,
      headers: { cookie },
      payload: { fingerprint: FP_B },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'SERVER_NOT_TRUSTABLE' });
    const after = await rawServerRow(db, serverId);
    expect(after.hostFingerprint).toBe(FP_A);
    expect(after.pendingFingerprint).toBe(FP_B);
    expect(after.status).toBe('ERROR');
    expect(await fingerprintTrustedEventCount(db, serverId)).toBe(0);
  });

  it('returns 409 SERVER_NOT_TRUSTABLE and promotes nothing when a later COMMAND_TIMEOUT supersedes the parked HOST_KEY_CHANGED (gap 6 / GR-01 bypass, case 2)', async () => {
    const { app, cookie, db } = await bootAuthenticated();
    const { id: serverId } = await createServer(app, cookie);
    // T1: same arrangement as case 1.
    await arrangePendingFingerprint(db, serverId, { pendingFingerprint: FP_B, hostFingerprint: FP_A });
    // T1.5: a second, unrelated connect failure — this time COMMAND_TIMEOUT, a different
    // non-host-key ERROR-landing code, proving the gate is not an AUTH_FAILED special case.
    await db.update(servers).set({ lastErrorCode: 'COMMAND_TIMEOUT' }).where(eq(servers.id, serverId));

    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/trust-fingerprint`,
      headers: { cookie },
      payload: { fingerprint: FP_B },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'SERVER_NOT_TRUSTABLE' });
    const after = await rawServerRow(db, serverId);
    expect(after.hostFingerprint).toBe(FP_A);
    expect(after.pendingFingerprint).toBe(FP_B);
    expect(after.status).toBe('ERROR');
    expect(await fingerprintTrustedEventCount(db, serverId)).toBe(0);
  });

  it('returns 409 and promotes nothing when a later successful reconnect supersedes the parked HOST_KEY_CHANGED (gap 6 / GR-01 bypass, case 3)', async () => {
    const { app, cookie, db } = await bootAuthenticated();
    const { id: serverId } = await createServer(app, cookie);
    // T1: the parked state a real HOST_KEY_CHANGED connect produces.
    await arrangePendingFingerprint(db, serverId, { pendingFingerprint: FP_B });
    // T1.5: a later successful connect supersedes the parked HOST_KEY_CHANGED — status moves to
    // CONNECTED and last_error_code clears to null, but pending_fingerprint is left present
    // (the exact row-consistency gap plan 05-38 closed at the source; this proves the boundary
    // refuses it independently too). `canTrustFingerprint('CONNECTED')` may already refuse this on
    // its own — either guard must refuse it, and the promotion must not happen either way.
    await db.update(servers).set({ status: 'CONNECTED', lastErrorCode: null }).where(eq(servers.id, serverId));

    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/trust-fingerprint`,
      headers: { cookie },
      payload: { fingerprint: FP_B },
    });

    expect(response.statusCode).toBe(409);
    const after = await rawServerRow(db, serverId);
    expect(after.hostFingerprint).toBeNull();
    expect(after.pendingFingerprint).toBe(FP_B);
    expect(after.status).toBe('CONNECTED');
    expect(await fingerprintTrustedEventCount(db, serverId)).toBe(0);
  });

  it('the refusal body for the superseded-parking bypass leaks nothing (gap 6 / GR-01 bypass, case 5)', async () => {
    const { app, cookie, db } = await bootAuthenticated();
    const { id: serverId } = await createServer(app, cookie);
    await arrangePendingFingerprint(db, serverId, { pendingFingerprint: FP_B, hostFingerprint: FP_A });
    await db.update(servers).set({ lastErrorCode: 'AUTH_FAILED' }).where(eq(servers.id, serverId));

    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/trust-fingerprint`,
      headers: { cookie },
      payload: { fingerprint: FP_B },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['error', 'message']);
    expect(String(body.message)).not.toContain(FP_B);
    const lowerMessage = String(body.message).toLowerCase();
    expect(lowerMessage).not.toContain('password');
    expect(lowerMessage).not.toContain('privatekey');
    expect(lowerMessage).not.toContain('credential');
    expect([
      'NOT_FOUND',
      'SERVER_BUSY',
      'NO_PENDING_FINGERPRINT',
      'SERVER_NOT_TRUSTABLE',
      'FINGERPRINT_MISMATCH',
    ]).toContain(body.error);
  });

  it('returns a typed 409 SERVER_NOT_TRUSTABLE, never a 500, when trusting from a non-ERROR status', async () => {
    const { app, cookie, db } = await bootAuthenticated();
    const { id: serverId } = await createServer(app, cookie);
    await arrangePendingFingerprint(db, serverId, { status: 'UNREACHABLE', pendingFingerprint: FP_B });

    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/trust-fingerprint`,
      headers: { cookie },
      payload: { fingerprint: FP_B },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'SERVER_NOT_TRUSTABLE' });
    const after = await rawServerRow(db, serverId);
    expect(after.pendingFingerprint).toBe(FP_B);
    expect(after.hostFingerprint).toBeNull();
    expect(after.status).toBe('UNREACHABLE');
  });

  it('returns 401 with no cookie', async () => {
    fixture = await startTestApp();

    const response = await fixture.app.inject({
      method: 'POST',
      url: `/api/servers/${randomUUID()}/trust-fingerprint`,
      payload: { fingerprint: FP_B },
    });

    expect(response.statusCode).toBe(401);
  });
});
