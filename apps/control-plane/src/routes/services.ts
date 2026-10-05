// 12-08: `/api/projects/:projectId/services`. Same contract as `projects.ts`: each handler reads
// `request.actor`, calls one service and maps a `{ ok: false }` result through
// `mapServiceCodeToStatus`. Registered inside the guarded scope in `api-scope.ts`. Every id comes
// from the path or is checked against the path's project by the service (A4).
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import { z } from 'zod';
import { SERVICE_OPERATIONS } from '../deploy/service-ops.js';
import type { ServiceCredentialsResult } from '../services/service-credentials.js';
import type { ServiceServices } from '../services/service-services.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import { DeploymentViewSchema } from './deployment-schemas.js';
import {
  ErrorBodySchema,
  FieldErrorBodySchema,
  mapServiceCodeToStatus,
  toErrorBody,
  toValidationErrorBody,
  ValidationErrorBodySchema,
} from './http-errors.js';
import { ProjectIdParamSchema } from './project-schemas.js';
import {
  CreateServiceBodySchema,
  ListServicesResponseSchema,
  RegistryCredentialBodySchema,
  RepositoryCredentialBodySchema,
  SERVICE_ROUTE_BODY_LIMIT_BYTES,
  ServiceCredentialErrorBodySchema,
  ServiceCredentialsResponseSchema,
  ServiceInputErrorBodySchema,
  ServiceParamsSchema,
  ServiceViewSchema,
  UpdateServiceBodySchema,
  UpdateServiceResponseSchema,
} from './service-schemas.js';

declare module 'fastify' {
  interface FastifyInstance {
    getServiceServices(): Promise<ServiceServices>;
  }
}

const BadRequestSchema = z.union([ValidationErrorBodySchema, ErrorBodySchema]);

function requireActor(actor: ServiceActor | null): ServiceActor {
  if (actor === null) {
    throw new Error('services route reached with no actor — requireSession guard is not registered');
  }
  return actor;
}

async function sendFailure(
  reply: FastifyReply,
  failure: { readonly code: string; readonly message: string; readonly reason?: string },
): Promise<void> {
  const body =
    failure.reason !== undefined
      ? { ...toErrorBody(failure.code, failure.message), reason: failure.reason }
      : toErrorBody(failure.code, failure.message);
  await reply.code(mapServiceCodeToStatus(failure.code)).send(body);
}

const MUTATION_ERRORS = {
  400: BadRequestSchema,
  401: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ErrorBodySchema,
  422: ServiceInputErrorBodySchema,
};

// 12-14: operation and delete bodies are parsed in the handler, so a bad body is a named 422
// SERVICE_OPERATION_INVALID (issues carry field paths, never values), not the global 400.
/** Same raw cap as the project routes' names (project-schemas.ts). */
const MAX_CONFIRM_NAME_LENGTH = 1024;
const EmptyBodySchema = z.strictObject({});
const DeleteServiceBodySchema = z.strictObject({ confirmName: z.string().max(MAX_CONFIRM_NAME_LENGTH) });

type ParsedBody<T> = { ok: true; value: T } | { ok: false };

async function parseOperationBody<T>(reply: FastifyReply, schema: z.ZodType<T>, body: unknown): Promise<ParsedBody<T>> {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return { ok: true, value: parsed.data };
  const code = 'SERVICE_OPERATION_INVALID';
  await reply.code(mapServiceCodeToStatus(code)).send(toValidationErrorBody(parsed.error.issues, code));
  return { ok: false };
}

const OPERATION_ERRORS = {
  400: BadRequestSchema,
  401: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ErrorBodySchema,
  422: z.union([FieldErrorBodySchema, ErrorBodySchema]),
  502: ErrorBodySchema,
  503: ErrorBodySchema,
};

const servicesRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.route({
    method: 'POST',
    url: '/api/projects/:projectId/services',
    bodyLimit: SERVICE_ROUTE_BODY_LIMIT_BYTES,
    schema: {
      params: ProjectIdParamSchema,
      body: CreateServiceBodySchema,
      response: { 201: ServiceViewSchema, ...MUTATION_ERRORS },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const { environmentId, ...fields } = request.body;
      const services = await fastify.getServiceServices();
      const result = await services.createService({
        actor,
        projectId: request.params.projectId,
        environmentId,
        fields,
      });
      if (!result.ok) {
        await sendFailure(reply, result);
        return;
      }
      await reply.code(201).send(result.service);
    },
  });

  app.route({
    method: 'GET',
    url: '/api/projects/:projectId/services',
    schema: {
      params: ProjectIdParamSchema,
      response: { 200: ListServicesResponseSchema, 400: BadRequestSchema, 401: ErrorBodySchema, 404: ErrorBodySchema },
    },
    handler: async (request, reply) => {
      const services = await fastify.getServiceServices();
      const items = await services.listServices(request.params.projectId);
      if (items === null) {
        await sendFailure(reply, { code: 'NOT_FOUND', message: `Project "${request.params.projectId}" not found` });
        return;
      }
      await reply.send({ items });
    },
  });

  app.route({
    method: 'GET',
    url: '/api/projects/:projectId/services/:serviceId',
    schema: {
      params: ServiceParamsSchema,
      response: { 200: ServiceViewSchema, 400: BadRequestSchema, 401: ErrorBodySchema, 404: ErrorBodySchema },
    },
    handler: async (request, reply) => {
      const services = await fastify.getServiceServices();
      const service = await services.getService(request.params.projectId, request.params.serviceId);
      if (!service) {
        await sendFailure(reply, { code: 'NOT_FOUND', message: `Service "${request.params.serviceId}" not found` });
        return;
      }
      await reply.send(service);
    },
  });

  app.route({
    method: 'PATCH',
    url: '/api/projects/:projectId/services/:serviceId',
    bodyLimit: SERVICE_ROUTE_BODY_LIMIT_BYTES,
    schema: {
      params: ServiceParamsSchema,
      body: UpdateServiceBodySchema,
      response: { 200: UpdateServiceResponseSchema, ...MUTATION_ERRORS },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const services = await fastify.getServiceServices();
      const result = await services.updateService({
        actor,
        projectId: request.params.projectId,
        serviceId: request.params.serviceId,
        fields: request.body,
      });
      if (!result.ok) {
        await sendFailure(reply, result);
        return;
      }
      await reply.send({
        service: result.service,
        requiresRedeploy: result.requiresRedeploy,
        changedFields: [...result.changedFields],
      });
    },
  });

  // -------------------------------------------------------------------------------------------
  // Operations and delete (12-14). Stop / restart / remove are queued (202); the job records the
  // outcome as activity and a `service.updated` event.
  // -------------------------------------------------------------------------------------------

  for (const operation of SERVICE_OPERATIONS) {
    app.route({
      method: 'POST',
      url: `/api/projects/:projectId/services/:serviceId/${operation}`,
      bodyLimit: SERVICE_ROUTE_BODY_LIMIT_BYTES,
      schema: {
        params: ServiceParamsSchema,
        response: { 202: z.object({ service: ServiceViewSchema }), ...OPERATION_ERRORS },
      },
      handler: async (request, reply) => {
        const actor = requireActor(request.actor);
        if (!(await parseOperationBody(reply, EmptyBodySchema, request.body)).ok) return;
        const services = await fastify.getServiceServices();
        const result = await services.requestServiceOperation({
          actor,
          projectId: request.params.projectId,
          serviceId: request.params.serviceId,
          operation,
        });
        if (!result.ok) {
          await sendFailure(reply, result);
          return;
        }
        await reply.code(202).send({ service: result.service });
      },
    });
  }

  app.route({
    method: 'POST',
    url: '/api/projects/:projectId/services/:serviceId/redeploy',
    bodyLimit: SERVICE_ROUTE_BODY_LIMIT_BYTES,
    schema: {
      params: ServiceParamsSchema,
      response: { 201: DeploymentViewSchema, ...OPERATION_ERRORS },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      if (!(await parseOperationBody(reply, EmptyBodySchema, request.body)).ok) return;
      // Scoped to the path's project first: another project's service reads as missing (A4).
      const service = await (await fastify.getServiceServices()).getService(request.params.projectId, request.params.serviceId);
      if (!service) {
        await sendFailure(reply, { code: 'NOT_FOUND', message: `Service "${request.params.serviceId}" not found` });
        return;
      }
      const result = await (await fastify.getDeploymentServices()).triggerDeploy({ actor, serviceId: service.id });
      if (!result.ok) {
        await sendFailure(reply, result);
        return;
      }
      await reply.code(201).send(result.deployment);
    },
  });

  app.route({
    method: 'DELETE',
    url: '/api/projects/:projectId/services/:serviceId',
    bodyLimit: SERVICE_ROUTE_BODY_LIMIT_BYTES,
    schema: {
      params: ServiceParamsSchema,
      response: { 200: z.object({ ok: z.literal(true), serviceId: z.string() }), ...OPERATION_ERRORS },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const body = await parseOperationBody(reply, DeleteServiceBodySchema, request.body);
      if (!body.ok) return;
      const services = await fastify.getServiceServices();
      const result = await services.deleteService({
        actor,
        projectId: request.params.projectId,
        serviceId: request.params.serviceId,
        confirmName: body.value.confirmName,
      });
      if (!result.ok) {
        await sendFailure(reply, result);
        return;
      }
      await reply.send({ ok: true as const, serviceId: result.serviceId });
    },
  });

  // -------------------------------------------------------------------------------------------
  // Credentials (12-09): write-only. Responses carry presence, type and a deploy key's public
  // half only; the submitted token or password is never echoed, logged or put in an event.
  // -------------------------------------------------------------------------------------------

  const CREDENTIAL_ERRORS = { ...MUTATION_ERRORS, 422: ServiceCredentialErrorBodySchema };
  const credentialsUrl = '/api/projects/:projectId/services/:serviceId/credentials';

  async function sendCredentials(reply: FastifyReply, result: ServiceCredentialsResult): Promise<void> {
    if (!result.ok) {
      await sendFailure(reply, result);
      return;
    }
    await reply.send(result.credentials);
  }

  app.route({
    method: 'GET',
    url: credentialsUrl,
    schema: {
      params: ServiceParamsSchema,
      response: { 200: ServiceCredentialsResponseSchema, 400: BadRequestSchema, 401: ErrorBodySchema, 404: ErrorBodySchema },
    },
    handler: async (request, reply) => {
      const services = await fastify.getServiceServices();
      const view = await services.getServiceCredentials(request.params.projectId, request.params.serviceId);
      if (!view) {
        await sendFailure(reply, { code: 'NOT_FOUND', message: `Service "${request.params.serviceId}" not found` });
        return;
      }
      await reply.send(view);
    },
  });

  app.route({
    method: 'PUT',
    url: `${credentialsUrl}/repository`,
    bodyLimit: SERVICE_ROUTE_BODY_LIMIT_BYTES,
    schema: {
      params: ServiceParamsSchema,
      body: RepositoryCredentialBodySchema,
      response: { 200: ServiceCredentialsResponseSchema, ...CREDENTIAL_ERRORS },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const services = await fastify.getServiceServices();
      const result = await services.setRepositoryCredential({
        actor,
        projectId: request.params.projectId,
        serviceId: request.params.serviceId,
        input: request.body,
      });
      await sendCredentials(reply, result);
    },
  });

  app.route({
    method: 'PUT',
    url: `${credentialsUrl}/registry`,
    bodyLimit: SERVICE_ROUTE_BODY_LIMIT_BYTES,
    schema: {
      params: ServiceParamsSchema,
      body: RegistryCredentialBodySchema,
      response: { 200: ServiceCredentialsResponseSchema, ...CREDENTIAL_ERRORS },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const services = await fastify.getServiceServices();
      const result = await services.setRegistryCredential({
        actor,
        projectId: request.params.projectId,
        serviceId: request.params.serviceId,
        input: request.body,
      });
      await sendCredentials(reply, result);
    },
  });

  for (const slot of ['repository', 'registry'] as const) {
    app.route({
      method: 'DELETE',
      url: `${credentialsUrl}/${slot}`,
      schema: {
        params: ServiceParamsSchema,
        response: { 200: ServiceCredentialsResponseSchema, ...CREDENTIAL_ERRORS },
      },
      handler: async (request, reply) => {
        const actor = requireActor(request.actor);
        const services = await fastify.getServiceServices();
        const result = await services.removeServiceCredential({
          actor,
          projectId: request.params.projectId,
          serviceId: request.params.serviceId,
          slot,
        });
        await sendCredentials(reply, result);
      },
    });
  }

  done();
};

export default servicesRoutes;
