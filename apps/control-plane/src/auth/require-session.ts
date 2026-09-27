// D-17/T-4-01: session guard as a plain `FastifyPluginCallback`, deliberately not wrapped by any
// encapsulation-skipping helper — doing that would apply the guard to `/health` and
// `/api/auth/*` too, the exact opposite of D-17. Registered inside an encapsulated
// `fastify.register(async (instance) => {...})` scope covering `/api/servers`, `/api/activity`,
// `/api/config` and `/api/events`; a sibling route registered outside that scope never sees this
// plugin's `onRequest` hook at all.
//
// This module must not reach into the Better Auth binding module directly — the real wiring
// (`createRequireSession({ getSession: (headers) => auth.api.getSession({ headers }) })`) lives
// in Plan 04-04's `routes/api-scope.ts`. `SessionResolver` is a narrow structural type, not an
// import of Better Auth's own types, so a fake in tests is a real implementation of the contract
// without pulling in that dependency.
import type { FastifyPluginCallback } from 'fastify';
import { toErrorBody } from '../routes/http-errors.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import { toFetchHeaders } from './fetch-headers.js';
import { withSessionLookupTimeout } from './session-lookup.js';
import type { RevocationReason } from './session-revocation-markers.js';

export type SessionResolver = (
  headers: Headers,
) => Promise<{ session?: { id: string } | null; user?: { id: string } | null } | null>;

/** D-07: resolves whether the token carried by `headers` was revoked by a password change —
 *  never why any other kind of session lookup failure happened. The real implementation
 *  (`api-scope.ts`) reads the cookie's raw token and asks `session-revocation-markers.ts`;
 *  a rejection or a hang here must never surface as anything other than plain `UNAUTHORIZED`
 *  (T-09-27) — this module's own `onRequest` hook enforces that, not the caller. */
export type ResolveRevocationReason = (headers: Headers) => Promise<RevocationReason | null>;

declare module 'fastify' {
  interface FastifyRequest {
    actor: ServiceActor | null;
    sessionId: string | null;
  }
}

export interface RequireSessionDeps {
  readonly getSession: SessionResolver;
  readonly resolveRevocationReason?: ResolveRevocationReason;
}

/** Fastify v5 throws at boot if `decorateRequest` is given a reference-type default — decorate
 *  with `null` here, then assign the real value inside the `onRequest` hook below. */
export function createRequireSession(deps: RequireSessionDeps): FastifyPluginCallback {
  const requireSession: FastifyPluginCallback = (fastify, _opts, done) => {
    fastify.decorateRequest('actor', null);
    fastify.decorateRequest('sessionId', null);

    fastify.addHook('onRequest', async (request, reply) => {
      const fetchHeaders = toFetchHeaders(request.headers);
      let session: Awaited<ReturnType<SessionResolver>>;
      try {
        // T-5-02: bounded so a hung session lookup answers 500 within
        // SESSION_LOOKUP_TIMEOUT_MS instead of holding this request open indefinitely — a
        // timeout rejection falls into the same catch as any other resolution failure below.
        session = await withSessionLookupTimeout(() => deps.getSession(fetchHeaders));
      } catch (err) {
        // D-22: a session-resolution failure (Better Auth's own dependency down, a bug) is a
        // server error, never something the caller's response body may echo — this hook cannot
        // rely on app.ts's not-yet-wired global error handler to redact it.
        request.log.error({ err }, 'session resolution failed');
        await reply.code(500).send(toErrorBody('INTERNAL_ERROR', 'Internal error'));
        return;
      }
      if (!session?.session || !session.user) {
        // D-07/T-09-27: bounded and defensive in the exact same shape as the lookup above — a
        // rejection, a timeout, or no injected resolver at all all fall back to the unchanged
        // plain UNAUTHORIZED body. Only a resolved 'password_changed' changes the response.
        let reason: RevocationReason | null = null;
        const resolveRevocationReason = deps.resolveRevocationReason;
        if (resolveRevocationReason) {
          try {
            reason = await withSessionLookupTimeout(() => resolveRevocationReason(fetchHeaders));
          } catch {
            reason = null;
          }
        }
        if (reason === 'password_changed') {
          await reply
            .code(401)
            .send(toErrorBody('SESSION_REVOKED_PASSWORD_CHANGED', 'Signed out because the password changed'));
          return;
        }
        await reply.code(401).send(toErrorBody('UNAUTHORIZED', 'No active session'));
        return;
      }
      request.actor = { type: 'user', id: session.user.id };
      request.sessionId = session.session.id;
    });

    done();
  };

  return requireSession;
}
