// D-17/D-29: the one encapsulated Fastify scope that guards `/api/sessions` today, and every
// later route this phase adds (`serversRoutes` — Plan 04-08, `eventsRoutes` — Plan 04-09,
// `activityRoutes`/`configRoutes` — Plan 04-10). `/health`, `/api/auth/*`, `/api/setup` and
// `/api/recovery` stay registered as siblings of this scope in `app.ts`, outside it — that
// sibling relationship (not an allowlist/denylist branch) is what keeps them unguarded.
//
// `createRequireSession(deps)` is invoked *directly* against this scope's own `fastify` instance
// rather than through `fastify.register(...)` — Plan 04-02's own test file discovered that a
// plain, non-`fastify-plugin`-wrapped plugin registered the normal way gets its own child
// encapsulation context, so a sibling route registered on the outer instance would never see its
// `onRequest` hook at all. This file is also where the real Better Auth binding happens
// (`auth.api.getSession`), keeping `require-session.ts` itself free of any import from
// `auth/auth.ts`.
import type { FastifyPluginCallback } from 'fastify';
import { auth } from '../auth/auth.js';
import { createOriginGuard } from '../auth/origin-guard.js';
import { createRequireSession } from '../auth/require-session.js';
import { env } from '../env.js';
import type { SseBroadcaster } from '../events/sse-broadcaster.js';
import activityRoutes from './activity.js';
import configRoutes from './config.js';
import createEventsRoutes from './events.js';
import serversRoutes from './servers.js';
import sessionsRoutes from './sessions.js';

export interface ApiScopeOptions {
  readonly broadcaster: SseBroadcaster;
  readonly sseHeartbeatMs?: number;
}

const apiScope: FastifyPluginCallback<ApiScopeOptions> = (fastify, opts, done) => {
  // D-29: the CSRF-lite Origin check runs before session resolution — it needs no session state
  // and rejecting a cross-origin mutation before spending an auth lookup on it is the cheaper,
  // safer order. `GET`/`HEAD`/`OPTIONS` and an absent `Origin` are always exempt (origin-guard.ts).
  fastify.addHook('onRequest', createOriginGuard({ publicUrl: env.NOODARA_PUBLIC_URL }));

  const requireSession = createRequireSession({
    getSession: (headers) => auth.api.getSession({ headers }),
  });

  requireSession(fastify, {}, () => {
    fastify.register(sessionsRoutes);
    fastify.register(serversRoutes);
    fastify.register(
      createEventsRoutes({
        broadcaster: opts.broadcaster,
        getSession: (headers) => auth.api.getSession({ headers }),
        ...(opts.sseHeartbeatMs !== undefined ? { heartbeatMs: opts.sseHeartbeatMs } : {}),
        maxConnections: env.NOODARA_SSE_MAX_CONNECTIONS,
      }),
    );

    fastify.register(activityRoutes);
    fastify.register(configRoutes);

    done();
  });
};

export default apiScope;
