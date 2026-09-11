import type { FastifyPluginCallback } from 'fastify';
import * as authNode from 'better-auth/node';
import { auth } from '../auth/auth.js';
import { env } from '../env.js';

// Plan 01-10: Better Auth mounted in Fastify via its generic Node handler (RESEARCH Pattern 1).
const authRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  // D-08: relaxing `Secure` requires the explicit `NOODARA_COOKIE_INSECURE` flag (auth.ts derives
  // `useSecureCookies` from it, never from NODE_ENV) — surfaced here as a boot-time warning so it
  // can never go unnoticed in a real deployment.
  if (env.NOODARA_COOKIE_INSECURE) {
    fastify.log.warn(
      { flag: 'NOODARA_COOKIE_INSECURE' },
      'NOODARA_COOKIE_INSECURE is set: session cookies are sent without the Secure attribute',
    );
  }

  fastify.all('/api/auth/*', async (request, reply) => {
    // Never log `request`/`reply` here: the sign-in body carries the plaintext password until
    // Better Auth hashes it (RESEARCH Anti-Patterns). pino's `redact.paths` (logger.ts) is a
    // second layer, not a reason to log these objects directly.
    reply.hijack();
    try {
      // Better Auth's Node handler (`better-call/node`) reconstructs a Fetch API `Request` from
      // `request.raw`. By the time this handler runs, Fastify's own default JSON parser has
      // already consumed `request.raw`'s stream to produce `request.body` on the *FastifyRequest*
      // wrapper — `request.raw` itself has no `.body` and its stream is already ended, so the
      // Node-handler's own already-consumed fallback (which reads `.body` off the same object it
      // was given) never finds it without this bridge. This mirrors Express's `req.body`
      // convention, which is why that fallback exists at all — Fastify just keeps parsed output
      // on a separate wrapper object instead of the raw stream (confirmed via `better-call`'s
      // installed `getRequest()` source).
      Object.assign(request.raw, { body: request.body });
      await authNode.toNodeHandler(auth.handler)(request.raw, reply.raw);
    } catch (error) {
      // `reply.hijack()` means Fastify will not finalize this response on our behalf — an
      // uncaught rejection here would otherwise leave the raw response (and the caller) hanging
      // forever instead of failing loudly (CLAUDE.md §2.2: no infrastructure failure hangs the
      // API). Never include `error` itself in the body: it may carry request context.
      fastify.log.error(
        { message: error instanceof Error ? error.message : String(error) },
        'better-auth handler threw',
      );
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
      }
      reply.raw.end(JSON.stringify({ error: 'internal_error' }));
    }
  });

  done();
};

export default authRoutes;
