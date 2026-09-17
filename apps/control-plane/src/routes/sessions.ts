import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import {
  listSessions,
  revokeOtherSessions,
  revokeSession,
  SessionNotFoundError,
  toFetchHeaders,
  UnauthorizedError,
} from '../services/session-service.js';
import { ErrorBodySchema, toErrorBody } from './http-errors.js';

// D-06: session listing/revocation. Routes only authenticate, call the service, and map its
// errors to status codes (noodara-domain-model/ARCHITECTURE.md §3 — no business logic here, and
// `session-service.ts` is the only writer of `auth.session_revoked` activity events).
//
// D-17/D-18: this plugin now lives inside `routes/api-scope.ts`'s guarded scope, so
// `requireSession`'s `onRequest` hook 401s an anonymous caller before any handler here runs and
// decorates `request.actor`. The service calls below still pass `toFetchHeaders(request.headers)`
// (never `request.actor`) — their queries are keyed on the caller's *own* session row, not on the
// actor id, and `requireCurrentSession`'s own `UnauthorizedError` throw stays as a defensive
// second line even though it should now be unreachable in production.

const SessionItemSchema = z.object({
  id: z.string(),
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  expiresAt: z.string(),
  isCurrent: z.boolean(),
});

const RevokedSchema = z.object({ revoked: z.literal(true) });
const RevokedCountSchema = z.object({ revokedCount: z.number() });
const SessionIdParamSchema = z.object({ id: z.string() });

const sessionsRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.route({
    method: 'GET',
    url: '/api/sessions',
    schema: {
      response: {
        200: z.array(SessionItemSchema),
        401: ErrorBodySchema,
      },
    },
    handler: async (request, reply) => {
      try {
        const items = await listSessions(toFetchHeaders(request.headers));
        await reply.send(items);
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          await reply.code(401).send(toErrorBody('UNAUTHORIZED', 'No active session'));
          return;
        }
        throw error;
      }
    },
  });

  app.route({
    method: 'DELETE',
    url: '/api/sessions/:id',
    schema: {
      params: SessionIdParamSchema,
      response: {
        200: RevokedSchema,
        401: ErrorBodySchema,
        404: ErrorBodySchema,
      },
    },
    handler: async (request, reply) => {
      try {
        await revokeSession(toFetchHeaders(request.headers), request.params.id);
        await reply.send({ revoked: true as const });
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          await reply.code(401).send(toErrorBody('UNAUTHORIZED', 'No active session'));
          return;
        }
        if (error instanceof SessionNotFoundError) {
          await reply.code(404).send(toErrorBody('NOT_FOUND', 'Session not found'));
          return;
        }
        throw error;
      }
    },
  });

  app.route({
    method: 'DELETE',
    url: '/api/sessions',
    schema: {
      response: {
        200: RevokedCountSchema,
        401: ErrorBodySchema,
      },
    },
    handler: async (request, reply) => {
      try {
        const revokedCount = await revokeOtherSessions(toFetchHeaders(request.headers));
        await reply.send({ revokedCount });
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          await reply.code(401).send(toErrorBody('UNAUTHORIZED', 'No active session'));
          return;
        }
        throw error;
      }
    },
  });

  done();
};

export default sessionsRoutes;
