// 22-03: `/api/projects/:projectId/services/:serviceId/domains`. Registered inside the guarded
// scope (api-scope.ts). Each handler calls one domain-services function and maps a failure:
// DOMAIN_INPUT_INVALID is a 422 carrying the validator's code as `reason`; every other code goes
// through mapServiceCodeToStatus (409 DOMAIN_ALREADY_ASSIGNED, 422 DOMAIN_RESERVED/LIMIT_REACHED,
// 503 PROXY_UNAVAILABLE, 502 PROXY_ROUTE_FAILED/SERVER_UNREACHABLE, 429 RATE_LIMITED, 404).
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  createDomain,
  listDomains,
  recheckDomainDns,
  removeDomain,
  updateDomain,
  type DomainFailure,
  type DomainServiceDeps,
} from '../domains/domain-services.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import {
  CreateDomainRouteBodySchema,
  DOMAIN_INPUT_INVALID_STATUS,
  DOMAIN_ROUTE_BODY_LIMIT_BYTES,
  DnsCheckBodySchema,
  DomainInputErrorBodySchema,
  DomainItemParamsSchema,
  DomainListResponseSchema,
  DomainServiceParamsSchema,
  DomainViewSchema,
  UpdateDomainRouteBodySchema,
} from './domain-schemas.js';
import { ErrorBodySchema, mapServiceCodeToStatus, toErrorBody, ValidationErrorBodySchema } from './http-errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    getDomainServices(): Promise<DomainServiceDeps>;
  }
}

function requireActor(actor: ServiceActor | null): ServiceActor {
  if (actor === null) throw new Error('domains route reached with no actor — requireSession guard is not registered');
  return actor;
}

export function domainFailureStatus(code: DomainFailure['code']): number {
  return code === 'DOMAIN_INPUT_INVALID' ? DOMAIN_INPUT_INVALID_STATUS : mapServiceCodeToStatus(code);
}

async function sendFailure(reply: FastifyReply, failure: DomainFailure): Promise<void> {
  const body =
    failure.code === 'DOMAIN_INPUT_INVALID'
      ? { ...toErrorBody(failure.code, failure.message), reason: failure.reason ?? 'DOMAIN_INVALID' }
      : toErrorBody(failure.code, failure.message);
  await reply.code(domainFailureStatus(failure.code)).send(body);
}

const BadRequestSchema = z.union([ValidationErrorBodySchema, ErrorBodySchema]);
const ERRORS = {
  400: BadRequestSchema,
  401: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ErrorBodySchema,
  422: z.union([DomainInputErrorBodySchema, ErrorBodySchema]),
  429: ErrorBodySchema,
  502: ErrorBodySchema,
  503: ErrorBodySchema,
};

const BASE = '/api/projects/:projectId/services/:serviceId/domains';

const domainsRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.route({
    method: 'GET',
    url: BASE,
    schema: { params: DomainServiceParamsSchema, response: { 200: DomainListResponseSchema, ...ERRORS } },
    handler: async (request, reply) => {
      requireActor(request.actor);
      const result = await listDomains(await fastify.getDomainServices(), request.params);
      if (!result.ok) {
        await sendFailure(reply, result);
        return;
      }
      await reply.send({ items: result.items, dnsInstructions: result.dnsInstructions });
    },
  });

  app.route({
    method: 'POST',
    url: BASE,
    bodyLimit: DOMAIN_ROUTE_BODY_LIMIT_BYTES,
    schema: {
      params: DomainServiceParamsSchema,
      body: CreateDomainRouteBodySchema,
      response: { 201: DomainViewSchema, ...ERRORS },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const result = await createDomain(await fastify.getDomainServices(), {
        actor,
        scope: request.params,
        body: request.body,
      });
      if (!result.ok) {
        await sendFailure(reply, result);
        return;
      }
      await reply.code(201).send(result.domain);
    },
  });

  app.route({
    method: 'PATCH',
    url: `${BASE}/:domainId`,
    bodyLimit: DOMAIN_ROUTE_BODY_LIMIT_BYTES,
    schema: {
      params: DomainItemParamsSchema,
      body: UpdateDomainRouteBodySchema,
      response: { 200: DomainViewSchema, ...ERRORS },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const { domainId, ...scope } = request.params;
      const result = await updateDomain(await fastify.getDomainServices(), { actor, scope, domainId, body: request.body });
      if (!result.ok) {
        await sendFailure(reply, result);
        return;
      }
      await reply.send(result.domain);
    },
  });

  app.route({
    method: 'DELETE',
    url: `${BASE}/:domainId`,
    bodyLimit: DOMAIN_ROUTE_BODY_LIMIT_BYTES,
    schema: { params: DomainItemParamsSchema, response: { 204: z.null(), ...ERRORS } },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const { domainId, ...scope } = request.params;
      const result = await removeDomain(await fastify.getDomainServices(), { actor, scope, domainId });
      if (!result.ok) {
        await sendFailure(reply, result);
        return;
      }
      await reply.code(204).send(null);
    },
  });

  app.route({
    method: 'POST',
    url: `${BASE}/:domainId/dns-check`,
    bodyLimit: DOMAIN_ROUTE_BODY_LIMIT_BYTES,
    schema: { params: DomainItemParamsSchema, body: DnsCheckBodySchema, response: { 200: DomainViewSchema, ...ERRORS } },
    handler: async (request, reply) => {
      requireActor(request.actor);
      const { domainId, ...scope } = request.params;
      const result = await recheckDomainDns(await fastify.getDomainServices(), { scope, domainId });
      if (!result.ok) {
        await sendFailure(reply, result);
        return;
      }
      await reply.send(result.domain);
    },
  });

  done();
};

export default domainsRoutes;
