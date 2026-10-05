// 12-07: the `/api/projects` and `/api/projects/:projectId/environments` routes. Same contract as
// `servers.ts`: each handler reads `request.actor`, calls one service and maps a `{ ok: false }`
// result through `mapServiceCodeToStatus`/`toErrorBody`. Registered inside the guarded scope in
// `api-scope.ts`, so the origin guard and `requireSession` run before any handler here, and an
// anonymous caller gets its 401 before any id is looked up.
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ProjectServices } from '../services/project-services.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import { ErrorBodySchema, mapServiceCodeToStatus, toErrorBody, ValidationErrorBodySchema } from './http-errors.js';
import {
  CreateEnvironmentBodySchema,
  CreateProjectBodySchema,
  DeleteProjectBodySchema,
  DeleteProjectResponseSchema,
  EnvironmentParamsSchema,
  EnvironmentViewSchema,
  ListEnvironmentsResponseSchema,
  ListProjectsResponseSchema,
  PROJECT_ROUTE_BODY_LIMIT_BYTES,
  ProjectIdParamSchema,
  ProjectViewSchema,
  UpdateEnvironmentBodySchema,
  UpdateProjectBodySchema,
} from './project-schemas.js';

declare module 'fastify' {
  interface FastifyInstance {
    getProjectServices(): Promise<ProjectServices>;
  }
}

// A schema-validation 400 carries `issues`; a service or parser 400 does not. The union keeps the
// serializer from stripping `issues` (see servers.ts).
const BadRequestSchema = z.union([ValidationErrorBodySchema, ErrorBodySchema]);

function requireActor(actor: ServiceActor | null): ServiceActor {
  if (actor === null) {
    throw new Error('projects route reached with no actor — requireSession guard is not registered');
  }
  return actor;
}

/** The only place a service code becomes a status in this file (see servers.ts for the typing). */
async function sendServiceError(reply: FastifyReply, code: string, message: string): Promise<void> {
  await reply.code(mapServiceCodeToStatus(code)).send(toErrorBody(code, message));
}

function projectNotFoundMessage(projectId: string): string {
  return `Project "${projectId}" not found`;
}

const projectsRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // -------------------------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------------------------

  app.route({
    method: 'POST',
    url: '/api/projects',
    bodyLimit: PROJECT_ROUTE_BODY_LIMIT_BYTES,
    schema: {
      body: CreateProjectBodySchema,
      response: { 201: ProjectViewSchema, 400: BadRequestSchema, 401: ErrorBodySchema, 409: ErrorBodySchema },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const services = await fastify.getProjectServices();
      const result = await services.createProject({
        actor,
        name: request.body.name,
        ...(request.body.description !== undefined ? { description: request.body.description } : {}),
      });
      if (!result.ok) {
        await sendServiceError(reply, result.code, result.message);
        return;
      }
      await reply.code(201).send(result.project);
    },
  });

  app.route({
    method: 'GET',
    url: '/api/projects',
    schema: { response: { 200: ListProjectsResponseSchema, 401: ErrorBodySchema } },
    handler: async (_request, reply) => {
      const services = await fastify.getProjectServices();
      await reply.send({ items: await services.listProjects() });
    },
  });

  app.route({
    method: 'GET',
    url: '/api/projects/:projectId',
    schema: {
      params: ProjectIdParamSchema,
      response: { 200: ProjectViewSchema, 400: BadRequestSchema, 401: ErrorBodySchema, 404: ErrorBodySchema },
    },
    handler: async (request, reply) => {
      const services = await fastify.getProjectServices();
      const project = await services.getProject(request.params.projectId);
      if (!project) {
        await sendServiceError(reply, 'NOT_FOUND', projectNotFoundMessage(request.params.projectId));
        return;
      }
      await reply.send(project);
    },
  });

  app.route({
    method: 'PATCH',
    url: '/api/projects/:projectId',
    bodyLimit: PROJECT_ROUTE_BODY_LIMIT_BYTES,
    schema: {
      params: ProjectIdParamSchema,
      body: UpdateProjectBodySchema,
      response: {
        200: ProjectViewSchema,
        400: BadRequestSchema,
        401: ErrorBodySchema,
        404: ErrorBodySchema,
        409: ErrorBodySchema,
      },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const services = await fastify.getProjectServices();
      const result = await services.updateProject({
        actor,
        projectId: request.params.projectId,
        ...(request.body.name !== undefined ? { name: request.body.name } : {}),
        ...(request.body.description !== undefined ? { description: request.body.description } : {}),
      });
      if (!result.ok) {
        await sendServiceError(reply, result.code, result.message);
        return;
      }
      await reply.send(result.project);
    },
  });

  for (const [suffix, archived] of [
    ['archive', true],
    ['unarchive', false],
  ] as const) {
    app.route({
      method: 'POST',
      url: `/api/projects/:projectId/${suffix}`,
      bodyLimit: PROJECT_ROUTE_BODY_LIMIT_BYTES,
      schema: {
        params: ProjectIdParamSchema,
        response: { 200: ProjectViewSchema, 400: BadRequestSchema, 401: ErrorBodySchema, 404: ErrorBodySchema },
      },
      handler: async (request, reply) => {
        const actor = requireActor(request.actor);
        const services = await fastify.getProjectServices();
        const result = await services.setProjectArchived({ actor, projectId: request.params.projectId, archived });
        if (!result.ok) {
          await sendServiceError(reply, result.code, result.message);
          return;
        }
        await reply.send(result.project);
      },
    });
  }

  app.route({
    method: 'DELETE',
    url: '/api/projects/:projectId',
    bodyLimit: PROJECT_ROUTE_BODY_LIMIT_BYTES,
    schema: {
      params: ProjectIdParamSchema,
      body: DeleteProjectBodySchema,
      response: {
        200: DeleteProjectResponseSchema,
        400: BadRequestSchema,
        401: ErrorBodySchema,
        404: ErrorBodySchema,
        // 12-14: a running deployment or Docker down (409); an unreachable server or a failed
        // remote cleanup (502). The project is kept in each case.
        409: ErrorBodySchema,
        422: ErrorBodySchema,
        502: ErrorBodySchema,
      },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const services = await fastify.getProjectServices();
      const result = await services.deleteProject({
        actor,
        projectId: request.params.projectId,
        confirmName: request.body.confirmName,
      });
      if (!result.ok) {
        await sendServiceError(reply, result.code, result.message);
        return;
      }
      await reply.send({ ok: true as const, projectId: result.projectId });
    },
  });

  // -------------------------------------------------------------------------------------------
  // Environments (always scoped by both ids: another project's environment reads as missing)
  // -------------------------------------------------------------------------------------------

  app.route({
    method: 'POST',
    url: '/api/projects/:projectId/environments',
    bodyLimit: PROJECT_ROUTE_BODY_LIMIT_BYTES,
    schema: {
      params: ProjectIdParamSchema,
      body: CreateEnvironmentBodySchema,
      response: {
        201: EnvironmentViewSchema,
        400: BadRequestSchema,
        401: ErrorBodySchema,
        404: ErrorBodySchema,
        409: ErrorBodySchema,
      },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const services = await fastify.getProjectServices();
      const result = await services.createEnvironment({
        actor,
        projectId: request.params.projectId,
        name: request.body.name,
        ...(request.body.kind !== undefined ? { kind: request.body.kind } : {}),
      });
      if (!result.ok) {
        await sendServiceError(reply, result.code, result.message);
        return;
      }
      await reply.code(201).send(result.environment);
    },
  });

  app.route({
    method: 'GET',
    url: '/api/projects/:projectId/environments',
    schema: {
      params: ProjectIdParamSchema,
      response: {
        200: ListEnvironmentsResponseSchema,
        400: BadRequestSchema,
        401: ErrorBodySchema,
        404: ErrorBodySchema,
      },
    },
    handler: async (request, reply) => {
      const services = await fastify.getProjectServices();
      const items = await services.listEnvironments(request.params.projectId);
      if (items === null) {
        await sendServiceError(reply, 'NOT_FOUND', projectNotFoundMessage(request.params.projectId));
        return;
      }
      await reply.send({ items });
    },
  });

  app.route({
    method: 'GET',
    url: '/api/projects/:projectId/environments/:environmentId',
    schema: {
      params: EnvironmentParamsSchema,
      response: { 200: EnvironmentViewSchema, 400: BadRequestSchema, 401: ErrorBodySchema, 404: ErrorBodySchema },
    },
    handler: async (request, reply) => {
      const services = await fastify.getProjectServices();
      const environment = await services.getEnvironment(request.params.projectId, request.params.environmentId);
      if (!environment) {
        await sendServiceError(reply, 'NOT_FOUND', `Environment "${request.params.environmentId}" not found`);
        return;
      }
      await reply.send(environment);
    },
  });

  app.route({
    method: 'PATCH',
    url: '/api/projects/:projectId/environments/:environmentId',
    bodyLimit: PROJECT_ROUTE_BODY_LIMIT_BYTES,
    schema: {
      params: EnvironmentParamsSchema,
      body: UpdateEnvironmentBodySchema,
      response: {
        200: EnvironmentViewSchema,
        400: BadRequestSchema,
        401: ErrorBodySchema,
        404: ErrorBodySchema,
        409: ErrorBodySchema,
      },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const services = await fastify.getProjectServices();
      const result = await services.updateEnvironment({
        actor,
        projectId: request.params.projectId,
        environmentId: request.params.environmentId,
        ...(request.body.name !== undefined ? { name: request.body.name } : {}),
        ...(request.body.kind !== undefined ? { kind: request.body.kind } : {}),
      });
      if (!result.ok) {
        await sendServiceError(reply, result.code, result.message);
        return;
      }
      await reply.send(result.environment);
    },
  });

  done();
};

export default projectsRoutes;
