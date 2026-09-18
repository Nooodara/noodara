// D-19/SERV-06/DISC-05: the eight `/api/servers` routes. Every handler does exactly three
// things — read `request.actor`, call exactly one service, and map a `{ ok: false }` result
// through `mapServiceCodeToStatus`/`toErrorBody` — never a hand-written status literal for a
// service code and never any business logic of its own (noodara-domain-model/ARCHITECTURE.md §3).
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ConnectServerQueue } from '../queue/connect-server-queue.js';
import type { EditServerInput, RegisterServerInput, ServerServices } from '../services/server-services.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import type { ServerView } from '../services/server-view.js';
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
    getQueue(): Promise<ConnectServerQueue>;
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
const ConnectResponseSchema = z.object({ server: ServerViewSchema, jobId: z.string() });

/**
 * D-10: the one enqueue code path both `/connect` and `/discover` drive — the only behavioural
 * difference between them is the `trigger === 'discover'` precondition below. `jobId` exists for
 * logs, tests and correlation only — the progress this responds to arrives over SSE (Plan 04-09),
 * never by polling this id.
 */
async function enqueueConnect(
  services: ServerServices,
  queue: ConnectServerQueue,
  fastify: FastifyInstance,
  input: { readonly serverId: string; readonly actor: ServiceActor; readonly trigger: 'connect' | 'discover' },
): Promise<
  | { readonly ok: true; readonly server: ServerView; readonly jobId: string }
  | { readonly ok: false; readonly code: string; readonly message: string }
> {
  const server = await services.getServer(input.serverId);
  if (!server) {
    return { ok: false, code: 'NOT_FOUND', message: `Server "${input.serverId}" not found` };
  }
  if (server.status === 'CONNECTING') {
    return { ok: false, code: 'ALREADY_CONNECTING', message: 'A connection attempt is already in flight' };
  }
  if (input.trigger === 'discover' && server.status !== 'CONNECTED') {
    return { ok: false, code: 'SERVER_NOT_CONNECTED', message: 'Server is not connected' };
  }

  const enqueueResult = await queue.enqueue({
    serverId: input.serverId,
    actor: input.actor,
    requestedAt: new Date().toISOString(),
    trigger: input.trigger,
  });
  if (!enqueueResult.ok) {
    return enqueueResult;
  }

  // D-13: enqueueing writes no activity event — server.connection_attempted/discovery_completed
  // already tell the story once the worker acts. This is the one log line the route itself owns.
  fastify.log.info(
    { serverId: input.serverId, jobId: enqueueResult.jobId, trigger: input.trigger },
    'connect-server job enqueued',
  );

  return { ok: true, server, jobId: enqueueResult.jobId };
}

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

  app.route({
    method: 'POST',
    url: '/api/servers/:id/trust-fingerprint',
    schema: {
      params: ServerIdParamSchema,
      response: {
        200: ServerViewSchema,
        401: ErrorBodySchema,
        404: ErrorBodySchema,
        409: ErrorBodySchema,
      },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const services = await fastify.getServerServices();
      const result = await services.trustFingerprint({ actor, serverId: request.params.id });
      if (!result.ok) {
        await sendServiceError(reply, result.code, result.message);
        return;
      }
      await reply.send(result.server);
    },
  });

  app.route({
    method: 'POST',
    url: '/api/servers/:id/connect',
    schema: {
      params: ServerIdParamSchema,
      response: {
        202: ConnectResponseSchema,
        401: ErrorBodySchema,
        404: ErrorBodySchema,
        409: ErrorBodySchema,
        503: ErrorBodySchema,
      },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const services = await fastify.getServerServices();
      const queue = await fastify.getQueue();
      const result = await enqueueConnect(services, queue, fastify, {
        serverId: request.params.id,
        actor,
        trigger: 'connect',
      });
      if (!result.ok) {
        await sendServiceError(reply, result.code, result.message);
        return;
      }
      // jobId is for logs/correlation only — progress arrives over SSE (Plan 04-09), never by
      // polling this id.
      await reply.code(202).send({ server: result.server, jobId: result.jobId });
    },
  });

  app.route({
    method: 'POST',
    url: '/api/servers/:id/discover',
    schema: {
      params: ServerIdParamSchema,
      response: {
        202: ConnectResponseSchema,
        401: ErrorBodySchema,
        404: ErrorBodySchema,
        409: ErrorBodySchema,
        503: ErrorBodySchema,
      },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const services = await fastify.getServerServices();
      const queue = await fastify.getQueue();
      const result = await enqueueConnect(services, queue, fastify, {
        serverId: request.params.id,
        actor,
        trigger: 'discover',
      });
      if (!result.ok) {
        await sendServiceError(reply, result.code, result.message);
        return;
      }
      await reply.code(202).send({ server: result.server, jobId: result.jobId });
    },
  });

  done();
};

export default serversRoutes;
