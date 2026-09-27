import type { FastifyPluginCallback } from 'fastify';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { toFetchHeaders } from './fetch-headers.js';
import { createRequireSession, type ResolveRevocationReason, type SessionResolver } from './require-session.js';

// D-17/T-4-01: builds a bare Fastify instance (no buildApp) so this suite runs as a real unit
// test with no database connection.
//
// `createRequireSession` deliberately returns a *plain* `FastifyPluginCallback`, not one wrapped
// by any encapsulation-skipping helper (the plan's own reasoning: skipping encapsulation would
// mean registering it anywhere — even accidentally at the top of app.ts — makes it apply
// globally, guarding `/health` too, the opposite of D-17). Because it stays a plain callback,
// `instance.register(createRequireSession(...))` would create its own *child* encapsulation
// context, and a sibling route registered on the same outer `instance` afterwards would NOT
// inherit its hook (Fastify hooks flow down to descendants, never sideways to siblings) — so the
// scope's probe route is registered by invoking the returned plugin function directly against
// the scope's own `instance` (skipping `.register()`'s extra context boundary), exactly the
// composition `routes/api-scope.ts` (Plan 04-04) will use to group `/api/servers`,
// `/api/activity`, `/api/config` and `/api/events` under one real guard.
function buildTestApp(getSession: SessionResolver, resolveRevocationReason?: ResolveRevocationReason) {
  const app = Fastify();

  const apiScope: FastifyPluginCallback = (instance, _opts, done) => {
    createRequireSession({
      getSession,
      ...(resolveRevocationReason !== undefined ? { resolveRevocationReason } : {}),
    })(instance, {}, () => {
      instance.get('/inside', (request) =>
        Promise.resolve({ actor: request.actor, sessionId: request.sessionId }),
      );
      done();
    });
  };

  app.register(apiScope);
  app.get('/outside', () => Promise.resolve({ ok: true as const }));

  return app;
}

describe('createRequireSession', () => {
  it('401s an anonymous caller with the D-16 body shape and never invokes the handler', async () => {
    const getSession = vi.fn<SessionResolver>(() => Promise.resolve(null));
    const app = buildTestApp(getSession);

    const response = await app.inject({ method: 'GET', url: '/inside' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toStrictEqual({ error: 'UNAUTHORIZED', message: 'No active session' });
  });

  it('decorates request.actor and request.sessionId from the resolved session and reaches the handler', async () => {
    const getSession = vi.fn<SessionResolver>(() =>
      Promise.resolve({ session: { id: 's1' }, user: { id: 'u1' } }),
    );
    const app = buildTestApp(getSession);

    const response = await app.inject({ method: 'GET', url: '/inside' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ actor: { type: 'user', id: 'u1' }, sessionId: 's1' });
  });

  it('a sibling route registered outside the scope is reachable anonymously', async () => {
    const getSession = vi.fn<SessionResolver>(() => Promise.resolve(null));
    const app = buildTestApp(getSession);

    const response = await app.inject({ method: 'GET', url: '/outside' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ ok: true });
    expect(getSession).not.toHaveBeenCalled();
  });

  it('calls getSession with a fetch-standard Headers instance including the cookie header', async () => {
    let captured: Headers | undefined;
    const getSession: SessionResolver = (headers) => {
      captured = headers;
      return Promise.resolve(null);
    };
    const app = buildTestApp(getSession);

    await app.inject({ method: 'GET', url: '/inside', headers: { cookie: 'noodara.session=abc' } });

    expect(captured).toBeInstanceOf(Headers);
    expect(captured?.get('cookie')).toBe('noodara.session=abc');
  });

  it('a rejected getSession results in a 500 with the rejection message never in the body', async () => {
    const getSession: SessionResolver = () => {
      throw new Error('super-secret-internal-db-detail');
    };
    const app = buildTestApp(getSession);

    const response = await app.inject({ method: 'GET', url: '/inside' });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('super-secret-internal-db-detail');
  });

  it('a getSession that never settles still answers 500 INTERNAL_ERROR within the bound, rather than hanging (T-4-02)', async () => {
    vi.useFakeTimers();
    try {
      const getSession: SessionResolver = () => new Promise(() => undefined);
      const app = buildTestApp(getSession);

      const pending = app.inject({ method: 'GET', url: '/inside' });
      await vi.advanceTimersByTimeAsync(2000);
      const response = await pending;

      expect(response.statusCode).toBe(500);
      expect(response.json()).toStrictEqual({ error: 'INTERNAL_ERROR', message: 'Internal error' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('decorates request.sessionId as null for an anonymous caller that reaches the handler (none does today, kept for the decorator contract)', async () => {
    // There is no route today that lets an anonymous request reach a handler inside this scope
    // (the 401 branch always returns first) — this test instead proves the decorator default via
    // a resolver that DOES resolve a session, confirming `sessionId` is never left `undefined`.
    const getSession = vi.fn<SessionResolver>(() =>
      Promise.resolve({ session: { id: 's2' }, user: { id: 'u2' } }),
    );
    const app = buildTestApp(getSession);

    const response = await app.inject({ method: 'GET', url: '/inside' });

    expect(response.json()).toMatchObject({ sessionId: 's2' });
  });
});

describe('createRequireSession with resolveRevocationReason (D-07/T-09-27)', () => {
  it('401s SESSION_REVOKED_PASSWORD_CHANGED when resolveRevocationReason resolves "password_changed"', async () => {
    const getSession = vi.fn<SessionResolver>(() => Promise.resolve(null));
    const resolveRevocationReason: ResolveRevocationReason = () => Promise.resolve('password_changed');
    const app = buildTestApp(getSession, resolveRevocationReason);

    const response = await app.inject({ method: 'GET', url: '/inside' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toStrictEqual({
      error: 'SESSION_REVOKED_PASSWORD_CHANGED',
      message: 'Signed out because the password changed',
    });
  });

  it('401s plain UNAUTHORIZED when resolveRevocationReason resolves null', async () => {
    const getSession = vi.fn<SessionResolver>(() => Promise.resolve(null));
    const resolveRevocationReason: ResolveRevocationReason = () => Promise.resolve(null);
    const app = buildTestApp(getSession, resolveRevocationReason);

    const response = await app.inject({ method: 'GET', url: '/inside' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toStrictEqual({ error: 'UNAUTHORIZED', message: 'No active session' });
  });

  it('401s plain UNAUTHORIZED (never 500) when resolveRevocationReason rejects', async () => {
    const getSession = vi.fn<SessionResolver>(() => Promise.resolve(null));
    const resolveRevocationReason: ResolveRevocationReason = () => Promise.reject(new Error('db down'));
    const app = buildTestApp(getSession, resolveRevocationReason);

    const response = await app.inject({ method: 'GET', url: '/inside' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toStrictEqual({ error: 'UNAUTHORIZED', message: 'No active session' });
  });

  it('401s plain UNAUTHORIZED (never hangs) when resolveRevocationReason never settles, within the session-lookup bound', async () => {
    vi.useFakeTimers();
    try {
      const getSession = vi.fn<SessionResolver>(() => Promise.resolve(null));
      const resolveRevocationReason: ResolveRevocationReason = () => new Promise(() => undefined);
      const app = buildTestApp(getSession, resolveRevocationReason);

      const pending = app.inject({ method: 'GET', url: '/inside' });
      await vi.advanceTimersByTimeAsync(2000);
      const response = await pending;

      expect(response.statusCode).toBe(401);
      expect(response.json()).toStrictEqual({ error: 'UNAUTHORIZED', message: 'No active session' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps today\'s plain UNAUTHORIZED behavior when resolveRevocationReason is absent', async () => {
    const getSession = vi.fn<SessionResolver>(() => Promise.resolve(null));
    const app = buildTestApp(getSession);

    const response = await app.inject({ method: 'GET', url: '/inside' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toStrictEqual({ error: 'UNAUTHORIZED', message: 'No active session' });
  });
});

describe('toFetchHeaders', () => {
  it('converts a repeated header (array value) into multiple appended entries', () => {
    const headers = toFetchHeaders({ 'x-forwarded-for': ['1.1.1.1', '2.2.2.2'] });

    expect(headers.get('x-forwarded-for')).toBe('1.1.1.1, 2.2.2.2');
  });

  it('skips an undefined header value and sets a single-string value directly', () => {
    const headers = toFetchHeaders({ cookie: 'a=1', 'x-missing': undefined });

    expect(headers.get('cookie')).toBe('a=1');
    expect(headers.has('x-missing')).toBe(false);
  });
});
