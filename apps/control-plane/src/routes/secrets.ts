// 23-03: the secrets API, registered inside the guarded scope (api-scope.ts).
//   /api/projects/:projectId/secrets
//   /api/projects/:projectId/environments/:environmentId/secrets
//   /api/projects/:projectId/services/:serviceId/secrets
// each with GET (list) and POST, plus GET, PUT (replace the value) and DELETE on /:secretId.
// No route returns a value: views carry the hint only and there is no reveal endpoint (A1).
// ENV_INPUT_INVALID (422) carries the validator's code as `reason`; SECRET_IN_USE (409) lists the
// referencing variables by scope and key (A2). No error body or log line carries a value (H1).
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { EnvOwner } from '../env/env-store.js';
import {
  createSecretForOwner,
  getSecret,
  listSecrets,
  removeSecret,
  replaceSecretValue,
  type SecretServiceDeps,
  type SecretServiceFailure,
} from '../secrets/secret-services.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import { ErrorBodySchema, mapServiceCodeToStatus, toErrorBody, ValidationErrorBodySchema } from './http-errors.js';
import {
  CreateSecretRouteBodySchema,
  EnvironmentSecretParamsSchema,
  EnvironmentSecretsParamsSchema,
  ProjectSecretParamsSchema,
  ProjectSecretsParamsSchema,
  ReplaceSecretRouteBodySchema,
  SECRET_INPUT_INVALID_STATUS,
  SECRET_ROUTE_BODY_LIMIT_BYTES,
  SecretErrorBodySchema,
  SecretListResponseSchema,
  SecretViewSchema,
  ServiceSecretParamsSchema,
  ServiceSecretsParamsSchema,
} from './secret-schemas.js';

declare module 'fastify' {
  interface FastifyInstance {
    getSecretServices(): Promise<SecretServiceDeps>;
  }
}

function requireActor(actor: ServiceActor | null): ServiceActor {
  if (actor === null) throw new Error('secrets route reached with no actor — requireSession guard is not registered');
  return actor;
}

export function secretFailureStatus(code: SecretServiceFailure['code']): number {
  return code === 'ENV_INPUT_INVALID' ? SECRET_INPUT_INVALID_STATUS : mapServiceCodeToStatus(code);
}

async function sendFailure(reply: FastifyReply, failure: SecretServiceFailure): Promise<void> {
  const body = {
    ...toErrorBody(failure.code, failure.message),
    ...(failure.reason === undefined ? {} : { reason: failure.reason }),
    ...(failure.usedBy === undefined ? {} : { usedBy: failure.usedBy.map(({ scope, key }) => ({ scope, key })) }),
  };
  await reply.code(secretFailureStatus(failure.code)).send(body);
}

const ERRORS = {
  400: z.union([ValidationErrorBodySchema, ErrorBodySchema]),
  401: ErrorBodySchema,
  404: ErrorBodySchema,
  409: z.union([SecretErrorBodySchema, ErrorBodySchema]),
  413: ErrorBodySchema,
  422: z.union([SecretErrorBodySchema, ErrorBodySchema]),
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
  if (value === undefined) throw new Error(`secrets route reached without the ${name} param`);
  return value;
}

function registerScope(fastify: Parameters<FastifyPluginCallback>[0], scope: ScopeRoutes): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const item = (params: IdParams): { owner: EnvOwner; secretId: string } => ({
    owner: scope.owner(params),
    secretId: param(params, 'secretId'),
  });

  app.route({
    method: 'GET',
    url: scope.base,
    schema: { params: scope.params, response: { 200: SecretListResponseSchema, ...ERRORS } },
    handler: async (request, reply) => {
      requireActor(request.actor);
      const result = await listSecrets(await fastify.getSecretServices(), scope.owner(request.params));
      if (!result.ok) return sendFailure(reply, result);
      await reply.send({ items: result.items });
    },
  });

  app.route({
    method: 'POST',
    url: scope.base,
    bodyLimit: SECRET_ROUTE_BODY_LIMIT_BYTES,
    schema: { params: scope.params, body: CreateSecretRouteBodySchema, response: { 201: SecretViewSchema, ...ERRORS } },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const result = await createSecretForOwner(await fastify.getSecretServices(), {
        actor,
        owner: scope.owner(request.params),
        body: request.body,
      });
      if (!result.ok) return sendFailure(reply, result);
      await reply.code(201).send(result.secret);
    },
  });

  app.route({
    method: 'GET',
    url: `${scope.base}/:secretId`,
    schema: { params: scope.itemParams, response: { 200: SecretViewSchema, ...ERRORS } },
    handler: async (request, reply) => {
      requireActor(request.actor);
      const { owner, secretId } = item(request.params);
      const result = await getSecret(await fastify.getSecretServices(), owner, secretId);
      if (!result.ok) return sendFailure(reply, result);
      await reply.send(result.secret);
    },
  });

  app.route({
    method: 'PUT',
    url: `${scope.base}/:secretId`,
    bodyLimit: SECRET_ROUTE_BODY_LIMIT_BYTES,
    schema: { params: scope.itemParams, body: ReplaceSecretRouteBodySchema, response: { 200: SecretViewSchema, ...ERRORS } },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const { owner, secretId } = item(request.params);
      const result = await replaceSecretValue(await fastify.getSecretServices(), { actor, owner, secretId, body: request.body });
      if (!result.ok) return sendFailure(reply, result);
      await reply.send(result.secret);
    },
  });

  app.route({
    method: 'DELETE',
    url: `${scope.base}/:secretId`,
    bodyLimit: SECRET_ROUTE_BODY_LIMIT_BYTES,
    schema: { params: scope.itemParams, response: { 204: z.null(), ...ERRORS } },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const { owner, secretId } = item(request.params);
      const result = await removeSecret(await fastify.getSecretServices(), { actor, owner, secretId });
      if (!result.ok) return sendFailure(reply, result);
      await reply.code(204).send(null);
    },
  });
}

const secretsRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  registerScope(fastify, {
    base: '/api/projects/:projectId/secrets',
    params: ProjectSecretsParamsSchema,
    itemParams: ProjectSecretParamsSchema,
    owner: (p) => ({ scope: 'project', projectId: param(p, 'projectId') }),
  });
  registerScope(fastify, {
    base: '/api/projects/:projectId/environments/:environmentId/secrets',
    params: EnvironmentSecretsParamsSchema,
    itemParams: EnvironmentSecretParamsSchema,
    owner: (p) => ({ scope: 'environment', projectId: param(p, 'projectId'), environmentId: param(p, 'environmentId') }),
  });
  registerScope(fastify, {
    base: '/api/projects/:projectId/services/:serviceId/secrets',
    params: ServiceSecretsParamsSchema,
    itemParams: ServiceSecretParamsSchema,
    owner: (p) => ({ scope: 'service', projectId: param(p, 'projectId'), serviceId: param(p, 'serviceId') }),
  });
  done();
};

export default secretsRoutes;
