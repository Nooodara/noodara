import type { FastifyPluginCallback } from 'fastify';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { toFetchHeaders } from './fetch-headers.js';
import { createRequireSession, type SessionResolver } from './require-session.js';

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
function buildTestApp(getSession: SessionResolver) {
  const app = Fastify();

  const apiScope: FastifyPluginCallback = (instance, _opts, done) => {
    createRequireSession({ getSession })(instance, {}, () => {
      instance.get('/inside', (request) => Promise.resolve({ actor: request.actor }));
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

  it('decorates request.actor from the resolved session and reaches the handler', async () => {
    const getSession = vi.fn<SessionResolver>(() =>
      Promise.resolve({ session: { id: 's1' }, user: { id: 'u1' } }),
    );
    const app = buildTestApp(getSession);

    const response = await app.inject({ method: 'GET', url: '/inside' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ actor: { type: 'user', id: 'u1' } });
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
