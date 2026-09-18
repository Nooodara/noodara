// D-19: the five `/api/servers` CRUD routes. Every handler does exactly three things — read
// `request.actor`, call exactly one service, and map a `{ ok: false }` result through
// `mapServiceCodeToStatus`/`toErrorBody` — never a hand-written status literal for a service code
// and never any business logic of its own (noodara-domain-model/ARCHITECTURE.md §3). The
// trust-fingerprint/connect/discover routes join this file in Plan 04-08's Task 3.
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { EditServerInput, RegisterServerInput, ServerServices } from '../services/server-services.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import { ErrorBodySchema, mapServiceCodeToStatus, toErrorBody, ValidationErrorBodySchema } from './http-errors.js';
import {
  CreateServerBodySchema,
  type CreateServerBody,
  DeleteServerBodySchema,
  ServerIdParamSchema,
  ServerViewSchema,
  toCredentialInput,
  UpdateServerBodySchema,
  type UpdateServerBody,
} from './server-schemas.js';

declare module 'fastify' {
  interface FastifyInstance {
    getServerServices(): Promise<ServerServices>;
  }
}

// D-19: a service-level 400 (`VALIDATION_FAILED`/`INVALID_CREDENTIAL`, `{ error, message }`) and a
// Zod schema-validation 400 (`{ error: 'VALIDATION_FAILED', message, issues }`, from app.ts's
// global error handler) share this status but not this shape — declaring only `ErrorBodySchema`
// for 400 would make the response serializer silently strip `issues` off the wire. The union
// tries `ValidationErrorBodySchema` first (requires `issues`) and falls back to the plain shape.
const CreateOrEditErrorSchema = z.union([ValidationErrorBodySchema, ErrorBodySchema]);

/** `request.actor` is always non-null by the time a handler runs here — `requireSession`'s
 *  `onRequest` hook (registered on this same guarded scope, `routes/api-scope.ts`) already 401'd
 *  an anonymous caller before any route in this file executes. A `null` actor reaching this point
 *  is a wiring bug, not an expected runtime state — asserted, never silently cast. */
function requireActor(actor: ServiceActor | null): ServiceActor {
  if (actor === null) {
    throw new Error('servers route reached with no actor — requireSession guard is not registered');
  }
  return actor;
}

/**
 * Every service-result failure branch in this file goes through this one function — never a
 * hand-written status literal for a service code. `reply`'s parameter type here is deliberately
 * the bare, non-route-generic `FastifyReply` (not the per-route type `app.route`'s Zod type
 * provider narrows `code()` to): Fastify's own typings constrain `.code()`'s argument to exactly
 * the status literals declared in that specific route's `response` schema, which a
 * runtime-computed status number can never satisfy. The concrete, route-typed `reply` each
 * handler holds is still a structurally valid `FastifyReply`, so passing it here needs no unsafe
 * cast anywhere.
 */
async function sendServiceError(reply: FastifyReply, code: string, message: string): Promise<void> {
  await reply.code(mapServiceCodeToStatus(code)).send(toErrorBody(code, message));
}

function buildRegisterServerInput(actor: ServiceActor, body: CreateServerBody): RegisterServerInput {
  return {
    actor,
    name: body.name,
    host: body.host,
    ...(body.sshPort !== undefined ? { sshPort: body.sshPort } : {}),
    ...(body.sshUser !== undefined ? { sshUser: body.sshUser } : {}),
    credential: toCredentialInput(body.credential),
  };
}

function buildEditServerInput(
  actor: ServiceActor,
  serverId: string,
  body: UpdateServerBody,
): EditServerInput {
  return {
    actor,
    serverId,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.host !== undefined ? { host: body.host } : {}),
    ...(body.sshPort !== undefined ? { sshPort: body.sshPort } : {}),
    ...(body.sshUser !== undefined ? { sshUser: body.sshUser } : {}),
    ...(body.credential !== undefined ? { credential: toCredentialInput(body.credential) } : {}),
  };
}

const ListServersResponseSchema = z.object({ items: z.array(ServerViewSchema) });
const DeleteServerResponseSchema = z.object({ ok: z.literal(true), serverId: z.uuid() });

const serversRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.route({
    method: 'POST',
    url: '/api/servers',
    schema: {
      body: CreateServerBodySchema,
      response: {
        201: ServerViewSchema,
        400: CreateOrEditErrorSchema,
        401: ErrorBodySchema,
        409: ErrorBodySchema,
      },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const services = await fastify.getServerServices();
      const result = await services.registerServer(buildRegisterServerInput(actor, request.body));
      if (!result.ok) {
        await sendServiceError(reply, result.code, result.message);
        return;
      }
      await reply.code(201).send(result.server);
    },
  });

  app.route({
    method: 'GET',
    url: '/api/servers',
    schema: {
      response: {
        200: ListServersResponseSchema,
        401: ErrorBodySchema,
      },
    },
    handler: async (_request, reply) => {
      const services = await fastify.getServerServices();
      const items = await services.listServers();
      await reply.send({ items });
    },
  });

  app.route({
    method: 'GET',
    url: '/api/servers/:id',
    schema: {
      params: ServerIdParamSchema,
      response: {
        200: ServerViewSchema,
        401: ErrorBodySchema,
        404: ErrorBodySchema,
      },
    },
    handler: async (request, reply) => {
      const services = await fastify.getServerServices();
      const server = await services.getServer(request.params.id);
      if (!server) {
        await sendServiceError(reply, 'NOT_FOUND', `Server "${request.params.id}" not found`);
        return;
      }
      await reply.send(server);
    },
  });

  app.route({
    method: 'PATCH',
    url: '/api/servers/:id',
    schema: {
      params: ServerIdParamSchema,
      body: UpdateServerBodySchema,
      response: {
        200: ServerViewSchema,
        400: CreateOrEditErrorSchema,
        401: ErrorBodySchema,
        404: ErrorBodySchema,
        409: ErrorBodySchema,
      },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const services = await fastify.getServerServices();
      const result = await services.editServer(
        buildEditServerInput(actor, request.params.id, request.body),
      );
      if (!result.ok) {
        await sendServiceError(reply, result.code, result.message);
        return;
      }
      await reply.send(result.server);
    },
  });

  app.route({
    method: 'DELETE',
    url: '/api/servers/:id',
    schema: {
      params: ServerIdParamSchema,
      body: DeleteServerBodySchema,
      response: {
        200: DeleteServerResponseSchema,
        401: ErrorBodySchema,
        404: ErrorBodySchema,
        409: ErrorBodySchema,
      },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const services = await fastify.getServerServices();
      const result = await services.deleteServer({
        actor,
        serverId: request.params.id,
        confirmName: request.body.confirmName,
      });
      if (!result.ok) {
        await sendServiceError(reply, result.code, result.message);
        return;
      }
      await reply.send({ ok: true as const, serverId: result.serverId });
    },
  });

  done();
};

export default serversRoutes;
