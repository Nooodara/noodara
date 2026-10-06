// 12-10: deploy a service and read its deployments. Registered inside the guarded scope in
// `api-scope.ts`. The deploy answers as soon as the QUEUED row exists and its job is enqueued;
// the worker does the rest. A deployment read under the wrong service is a 404 (H2).
// 12-12: `GET /api/deployments/:id/logs` reads persisted build-log chunks after a cursor, the
// resync path for a client that missed `deployment.log_chunk` events (no replay of older chunks).
// 12-13: `POST /api/deployments/:id/cancel` ends a QUEUED deployment or flags a running one for its
// worker (202 either way); a terminal deployment is a named 409.
// 13-03: the three GET views carry `steps[]` (clone|pull, build, start, verify).
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import type { CancelDeployment } from '../deploy/cancel-deployment.js';
import {
  attachDeploymentSteps,
  attachDeploymentStepsTo,
  readDeploymentStepStamps,
  type DeploymentStepStampReader,
} from '../deploy/deployment-steps-view.js';
import { readDeploymentLogs, type DeploymentLogReader } from '../deploy/log-sink.js';
import type { DeploymentServices } from '../services/deployment-services.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import { decodeActivityCursor } from './activity-cursor.js';
import {
  DEPLOYMENT_ROUTE_BODY_LIMIT_BYTES,
  DeployBodySchema,
  DeploymentIdParamSchema,
  DeploymentListQuerySchema,
  DeploymentListResponseSchema,
  DeploymentLogsQuerySchema,
  DeploymentLogsResponseSchema,
  DeploymentViewSchema,
  DeploymentWithStepsViewSchema,
  ServiceDeploymentParamsSchema,
  ServiceIdParamSchema,
  unknownDeployFields,
} from './deployment-schemas.js';
import {
  ErrorBodySchema,
  mapServiceCodeToStatus,
  toErrorBody,
  toValidationErrorBody,
  ValidationErrorBodySchema,
} from './http-errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    getDeploymentServices(): Promise<DeploymentServices>;
    getCancelDeployment(): Promise<CancelDeployment>;
  }
}

const BadRequestSchema = z.union([ValidationErrorBodySchema, ErrorBodySchema]);

function requireActor(actor: ServiceActor | null): ServiceActor {
  if (actor === null) {
    throw new Error('deployments route reached with no actor — requireSession guard is not registered');
  }
  return actor;
}

async function sendFailure(reply: FastifyReply, failure: { readonly code: string; readonly message: string }): Promise<void> {
  await reply.code(mapServiceCodeToStatus(failure.code)).send(toErrorBody(failure.code, failure.message));
}

const READ_ERRORS = { 400: BadRequestSchema, 401: ErrorBodySchema, 404: ErrorBodySchema };

export interface DeploymentsRoutesOptions {
  /** Injectable for route tests; defaults to the Postgres reader. */
  readonly readLogs?: DeploymentLogReader;
  /** Injectable for route tests; defaults to `fastify.getCancelDeployment()` from `app.ts`. */
  readonly cancelDeployment?: CancelDeployment;
  /** Injectable for route tests; defaults to the Postgres step-boundary reader. */
  readonly readStepStamps?: DeploymentStepStampReader;
}

const readStepStampsFromDb: DeploymentStepStampReader = async (deploymentIds) =>
  readDeploymentStepStamps(await getDb(), deploymentIds);

const readLogsFromDb: DeploymentLogReader = async (deploymentId, query) =>
  readDeploymentLogs(await getDb(), deploymentId, query);

const deploymentsRoutes: FastifyPluginCallback<DeploymentsRoutesOptions> = (fastify, opts, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const readLogs = opts.readLogs ?? readLogsFromDb;
  const readStepStamps = opts.readStepStamps ?? readStepStampsFromDb;
  const resolveCancel = (): Promise<CancelDeployment> =>
    opts.cancelDeployment !== undefined ? Promise.resolve(opts.cancelDeployment) : fastify.getCancelDeployment();

  app.route({
    method: 'POST',
    url: '/api/services/:serviceId/deploy',
    bodyLimit: DEPLOYMENT_ROUTE_BODY_LIMIT_BYTES,
    schema: {
      params: ServiceIdParamSchema,
      body: DeployBodySchema,
      response: {
        201: DeploymentViewSchema,
        ...READ_ERRORS,
        409: ErrorBodySchema,
        422: ErrorBodySchema,
        503: ErrorBodySchema,
      },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      // H3: the deploy takes its source from the service; any field is a named 422, never ignored.
      if (unknownDeployFields(request.body).length > 0) {
        await sendFailure(reply, { code: 'DEPLOYMENT_INPUT_INVALID', message: 'The deploy request accepts no fields' });
        return;
      }
      const deploymentServices = await fastify.getDeploymentServices();
      const result = await deploymentServices.triggerDeploy({ actor, serviceId: request.params.serviceId });
      if (!result.ok) {
        await sendFailure(reply, result);
        return;
      }
      await reply.code(201).send(result.deployment);
    },
  });

  app.route({
    method: 'GET',
    url: '/api/services/:serviceId/deployments',
    schema: {
      params: ServiceIdParamSchema,
      querystring: DeploymentListQuerySchema,
      response: { 200: DeploymentListResponseSchema, ...READ_ERRORS },
    },
    handler: async (request, reply) => {
      let cursor: { occurredAt: Date; id: string } | undefined;
      if (request.query.cursor !== undefined) {
        const decoded = decodeActivityCursor(request.query.cursor);
        if (!decoded.ok) {
          // A tampered cursor is a 400, never a 500 and never a silent first page.
          await reply.code(400).send(toValidationErrorBody([{ path: 'cursor', message: 'Invalid cursor' }]));
          return;
        }
        cursor = decoded.cursor;
      }
      const deploymentServices = await fastify.getDeploymentServices();
      const page = await deploymentServices.listDeployments(request.params.serviceId, {
        limit: request.query.limit,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      if (page === null) {
        await sendFailure(reply, { code: 'NOT_FOUND', message: `Service "${request.params.serviceId}" not found` });
        return;
      }
      await reply.send({ items: await attachDeploymentSteps(readStepStamps, page.items), nextCursor: page.nextCursor });
    },
  });

  app.route({
    method: 'GET',
    url: '/api/services/:serviceId/deployments/:deploymentId',
    schema: {
      params: ServiceDeploymentParamsSchema,
      response: { 200: DeploymentWithStepsViewSchema, ...READ_ERRORS },
    },
    handler: async (request, reply) => {
      const deploymentServices = await fastify.getDeploymentServices();
      const deployment = await deploymentServices.getServiceDeployment(request.params.serviceId, request.params.deploymentId);
      if (!deployment) {
        await sendFailure(reply, { code: 'NOT_FOUND', message: `Deployment "${request.params.deploymentId}" not found` });
        return;
      }
      await reply.send(await attachDeploymentStepsTo(readStepStamps, deployment));
    },
  });

  app.route({
    method: 'GET',
    url: '/api/deployments/:deploymentId',
    schema: {
      params: DeploymentIdParamSchema,
      response: { 200: DeploymentWithStepsViewSchema, ...READ_ERRORS },
    },
    handler: async (request, reply) => {
      const deploymentServices = await fastify.getDeploymentServices();
      const deployment = await deploymentServices.getDeployment(request.params.deploymentId);
      if (!deployment) {
        await sendFailure(reply, { code: 'NOT_FOUND', message: `Deployment "${request.params.deploymentId}" not found` });
        return;
      }
      await reply.send(await attachDeploymentStepsTo(readStepStamps, deployment));
    },
  });

  app.route({
    method: 'POST',
    url: '/api/deployments/:deploymentId/cancel',
    bodyLimit: DEPLOYMENT_ROUTE_BODY_LIMIT_BYTES,
    schema: {
      params: DeploymentIdParamSchema,
      body: DeployBodySchema,
      response: {
        202: DeploymentViewSchema,
        ...READ_ERRORS,
        409: ErrorBodySchema,
        422: ErrorBodySchema,
        503: ErrorBodySchema,
      },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      // 12-10 H3: same body contract as deploy; any field is a named 422, never ignored.
      if (unknownDeployFields(request.body).length > 0) {
        await sendFailure(reply, { code: 'DEPLOYMENT_INPUT_INVALID', message: 'The cancel request accepts no fields' });
        return;
      }
      const cancelDeployment = await resolveCancel();
      const result = await cancelDeployment(request.params.deploymentId, actor);
      if (!result.ok) {
        await sendFailure(reply, result);
        return;
      }
      await reply.code(202).send(result.deployment);
    },
  });

  app.route({
    method: 'GET',
    url: '/api/deployments/:deploymentId/logs',
    schema: {
      params: DeploymentIdParamSchema,
      querystring: DeploymentLogsQuerySchema,
      response: { 200: DeploymentLogsResponseSchema, ...READ_ERRORS },
    },
    handler: async (request, reply) => {
      const { phase, since, limit } = request.query;
      const page = await readLogs(request.params.deploymentId, { phase, since, limit });
      if (page === null) {
        await sendFailure(reply, { code: 'NOT_FOUND', message: `Deployment "${request.params.deploymentId}" not found` });
        return;
      }
      await reply.send({ items: [...page.items], hasMore: page.hasMore });
    },
  });

  done();
};

export default deploymentsRoutes;
