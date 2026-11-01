// 23-02: the variables API, registered inside the guarded scope (api-scope.ts).
//   /api/projects/:projectId/env
//   /api/projects/:projectId/environments/:environmentId/env
//   /api/projects/:projectId/services/:serviceId/env
// each with GET (list) and POST, plus PATCH and DELETE on /:variableId, and
//   GET /api/projects/:projectId/services/:serviceId/env/effective
// ENV_INPUT_INVALID (422) carries the validator's code as `reason`; SECRET_NOT_FOUND (422) names
// the reference. No error body, log line or activity row ever carries a variable's value.
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  createVariable,
  effectiveVariables,
  listVariables,
  removeVariable,
  updateVariable,
  type EnvServiceDeps,
  type EnvServiceFailure,
} from '../env/env-services.js';
import type { EnvOwner } from '../env/env-store.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import {
  CreateVariableRouteBodySchema,
  EffectiveEnvResponseSchema,
  ENV_INPUT_INVALID_STATUS,
  ENV_ROUTE_BODY_LIMIT_BYTES,
  EnvErrorBodySchema,
  EnvironmentEnvParamsSchema,
  EnvironmentVariableParamsSchema,
  ProjectEnvParamsSchema,
  ProjectVariableParamsSchema,
  ServiceEnvParamsSchema,
  ServiceVariableParamsSchema,
  UpdateVariableRouteBodySchema,
  VariableListResponseSchema,
  VariableViewSchema,
} from './env-schemas.js';
import { ErrorBodySchema, mapServiceCodeToStatus, toErrorBody, ValidationErrorBodySchema } from './http-errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    getEnvServices(): Promise<EnvServiceDeps>;
  }
}

function requireActor(actor: ServiceActor | null): ServiceActor {
  if (actor === null) throw new Error('env route reached with no actor — requireSession guard is not registered');
  return actor;
}

export function envFailureStatus(code: EnvServiceFailure['code']): number {
  return code === 'ENV_INPUT_INVALID' ? ENV_INPUT_INVALID_STATUS : mapServiceCodeToStatus(code);
}

async function sendFailure(reply: FastifyReply, failure: EnvServiceFailure): Promise<void> {
  const body = {
    ...toErrorBody(failure.code, failure.message),
    ...(failure.reason === undefined ? {} : { reason: failure.reason }),
    ...(failure.reference === undefined ? {} : { reference: failure.reference }),
  };
  await reply.code(envFailureStatus(failure.code)).send(body);
}

const ERRORS = {
  400: z.union([ValidationErrorBodySchema, ErrorBodySchema]),
  401: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ErrorBodySchema,
  413: ErrorBodySchema,
  422: z.union([EnvErrorBodySchema, ErrorBodySchema]),
};

/** Route params after zod validation: uuid strings only. */
type IdParams = Readonly<Record<string, string>>;

interface ScopeRoutes {
  readonly base: string;
  readonly params: z.ZodType<IdParams>;
  readonly itemParams: z.ZodType<IdParams>;
  readonly owner: (params: IdParams) => EnvOwner;
}

function param(params: IdParams, name: string): string {
  const value = params[name];
  if (value === undefined) throw new Error(`env route reached without the ${name} param`);
  return value;
}

function registerScope(fastify: Parameters<FastifyPluginCallback>[0], scope: ScopeRoutes): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const itemOwner = (params: IdParams): { owner: EnvOwner; variableId: string } => ({
    owner: scope.owner(params),
    variableId: param(params, 'variableId'),
  });

  app.route({
    method: 'GET',
    url: scope.base,
    schema: { params: scope.params, response: { 200: VariableListResponseSchema, ...ERRORS } },
    handler: async (request, reply) => {
      requireActor(request.actor);
      const result = await listVariables(await fastify.getEnvServices(), scope.owner(request.params));
      if (!result.ok) return sendFailure(reply, result);
      await reply.send({ items: result.items });
    },
  });

  app.route({
    method: 'POST',
    url: scope.base,
    bodyLimit: ENV_ROUTE_BODY_LIMIT_BYTES,
    schema: {
      params: scope.params,
      body: CreateVariableRouteBodySchema,
      response: { 201: VariableViewSchema, ...ERRORS },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const result = await createVariable(await fastify.getEnvServices(), {
        actor,
        owner: scope.owner(request.params),
        body: request.body,
      });
      if (!result.ok) return sendFailure(reply, result);
      await reply.code(201).send(result.variable);
    },
  });

  app.route({
    method: 'PATCH',
    url: `${scope.base}/:variableId`,
    bodyLimit: ENV_ROUTE_BODY_LIMIT_BYTES,
    schema: {
      params: scope.itemParams,
      body: UpdateVariableRouteBodySchema,
      response: { 200: VariableViewSchema, ...ERRORS },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const { owner, variableId } = itemOwner(request.params);
      const result = await updateVariable(await fastify.getEnvServices(), { actor, owner, variableId, body: request.body });
      if (!result.ok) return sendFailure(reply, result);
      await reply.send(result.variable);
    },
  });

  app.route({
    method: 'DELETE',
    url: `${scope.base}/:variableId`,
    bodyLimit: ENV_ROUTE_BODY_LIMIT_BYTES,
    schema: { params: scope.itemParams, response: { 204: z.null(), ...ERRORS } },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const { owner, variableId } = itemOwner(request.params);
      const result = await removeVariable(await fastify.getEnvServices(), { actor, owner, variableId });
      if (!result.ok) return sendFailure(reply, result);
      await reply.code(204).send(null);
    },
  });
}

const envRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  registerScope(fastify, {
    base: '/api/projects/:projectId/env',
    params: ProjectEnvParamsSchema,
    itemParams: ProjectVariableParamsSchema,
    owner: (p) => ({ scope: 'project', projectId: param(p, 'projectId') }),
  });
  registerScope(fastify, {
    base: '/api/projects/:projectId/environments/:environmentId/env',
    params: EnvironmentEnvParamsSchema,
    itemParams: EnvironmentVariableParamsSchema,
    owner: (p) => ({ scope: 'environment', projectId: param(p, 'projectId'), environmentId: param(p, 'environmentId') }),
  });
  registerScope(fastify, {
    base: '/api/projects/:projectId/services/:serviceId/env',
    params: ServiceEnvParamsSchema,
    itemParams: ServiceVariableParamsSchema,
    owner: (p) => ({ scope: 'service', projectId: param(p, 'projectId'), serviceId: param(p, 'serviceId') }),
  });

  fastify.withTypeProvider<ZodTypeProvider>().route({
    method: 'GET',
    url: '/api/projects/:projectId/services/:serviceId/env/effective',
    schema: { params: ServiceEnvParamsSchema, response: { 200: EffectiveEnvResponseSchema, ...ERRORS } },
    handler: async (request, reply) => {
      requireActor(request.actor);
      const result = await effectiveVariables(await fastify.getEnvServices(), request.params);
      if (!result.ok) return sendFailure(reply, result);
      await reply.send({ items: result.items, differsFromRunning: result.differsFromRunning });
    },
  });

  done();
};

export default envRoutes;
