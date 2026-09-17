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

export type SessionResolver = (
  headers: Headers,
) => Promise<{ session?: { id: string } | null; user?: { id: string } | null } | null>;

declare module 'fastify' {
  interface FastifyRequest {
    actor: ServiceActor | null;
  }
}

export interface RequireSessionDeps {
  readonly getSession: SessionResolver;
}

/** Fastify v5 throws at boot if `decorateRequest` is given a reference-type default — decorate
 *  with `null` here, then assign the real value inside the `onRequest` hook below. */
export function createRequireSession(deps: RequireSessionDeps): FastifyPluginCallback {
  const requireSession: FastifyPluginCallback = (fastify, _opts, done) => {
    fastify.decorateRequest('actor', null);

    fastify.addHook('onRequest', async (request, reply) => {
      let session: Awaited<ReturnType<SessionResolver>>;
      try {
        session = await deps.getSession(toFetchHeaders(request.headers));
      } catch (err) {
        // D-22: a session-resolution failure (Better Auth's own dependency down, a bug) is a
        // server error, never something the caller's response body may echo — this hook cannot
        // rely on app.ts's not-yet-wired global error handler to redact it.
        request.log.error({ err }, 'session resolution failed');
        await reply.code(500).send(toErrorBody('INTERNAL_ERROR', 'Internal error'));
        return;
      }
      if (!session?.session || !session.user) {
        await reply.code(401).send(toErrorBody('UNAUTHORIZED', 'No active session'));
        return;
      }
      request.actor = { type: 'user', id: session.user.id };
    });

    done();
  };

  return requireSession;
}
