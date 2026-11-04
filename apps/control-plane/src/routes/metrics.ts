// 27-03: metrics and service status, inside the guarded scope (api-scope.ts). Read only.
// - GET /api/servers/:id/metrics                                 CPU, RAM, disk series + uptime, connection state
// - GET /api/projects/:projectId/services/:serviceId/metrics     CPU, memory, restarts series
// - GET /api/projects/:projectId/services/:serviceId/status      container, healthcheck, last deployment, flags
// A service is looked up by project id and service id together, so another project's id is a 404.
// A malformed range, or one beyond the retention, is a 400 METRICS_QUERY_INVALID with field issues.
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { env } from '../env.js';
import { parseMetricRange, type MetricRange, type MetricRangeQuery } from '../observability/metric-range.js';
import {
  findServer,
  findServiceInProject,
  readServerMetrics,
  readServiceMetrics,
  readServiceStatus,
} from '../observability/metrics-read.js';
import { ErrorBodySchema, toErrorBody, toValidationErrorBody, ValidationErrorBodySchema } from './http-errors.js';
import {
  METRICS_QUERY_INVALID,
  METRICS_QUERY_INVALID_STATUS,
  MetricsQueryErrorBodySchema,
  MetricsQuerySchema,
  ServerMetricsParamsSchema,
  ServerMetricsResponseSchema,
  ServiceMetricsParamsSchema,
  ServiceMetricsResponseSchema,
  ServiceStatusResponseSchema,
} from './metrics-schemas.js';

const HOUR_MS = 3_600_000;

const ERRORS = {
  400: z.union([MetricsQueryErrorBodySchema, ValidationErrorBodySchema]),
  401: ErrorBodySchema,
  404: ErrorBodySchema,
};

async function sendNotFound(reply: FastifyReply, what: string, id: string): Promise<void> {
  await reply.code(404).send(toErrorBody('NOT_FOUND', `${what} "${id}" not found`));
}

/** The parsed range, or null after a 400 was sent. */
async function rangeOrReply(reply: FastifyReply, query: MetricRangeQuery): Promise<MetricRange | null> {
  const result = parseMetricRange(query, {
    nowMs: Date.now(),
    retentionMs: env.NOODARA_METRICS_RETENTION_HOURS * HOUR_MS,
  });
  if (result.ok) return result.range;
  await reply.code(METRICS_QUERY_INVALID_STATUS).send(toValidationErrorBody(
      result.issues.map((issue) => ({ path: [issue.path], message: issue.message })),
      METRICS_QUERY_INVALID,
    ));
  return null;
}

const metricsRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.route({
    method: 'GET',
    url: '/api/servers/:id/metrics',
    schema: {
      params: ServerMetricsParamsSchema,
      querystring: MetricsQuerySchema,
      response: { 200: ServerMetricsResponseSchema, ...ERRORS },
    },
    handler: async (request, reply) => {
      const range = await rangeOrReply(reply, request.query);
      if (range === null) return;
      const db = await getDb();
      const server = await findServer(db, request.params.id);
      if (server === null) {
        await sendNotFound(reply, 'Server', request.params.id);
        return;
      }
      await reply.send(await readServerMetrics(db, server, range));
    },
  });

  app.route({
    method: 'GET',
    url: '/api/projects/:projectId/services/:serviceId/metrics',
    schema: {
      params: ServiceMetricsParamsSchema,
      querystring: MetricsQuerySchema,
      response: { 200: ServiceMetricsResponseSchema, ...ERRORS },
    },
    handler: async (request, reply) => {
      const range = await rangeOrReply(reply, request.query);
      if (range === null) return;
      const db = await getDb();
      const service = await findServiceInProject(db, request.params.projectId, request.params.serviceId);
      if (service === null) {
        await sendNotFound(reply, 'Service', request.params.serviceId);
        return;
      }
      await reply.send({ series: await readServiceMetrics(db, service, range) });
    },
  });

  app.route({
    method: 'GET',
    url: '/api/projects/:projectId/services/:serviceId/status',
    schema: {
      params: ServiceMetricsParamsSchema,
      response: { 200: ServiceStatusResponseSchema, ...ERRORS },
    },
    handler: async (request, reply) => {
      const db = await getDb();
      const service = await findServiceInProject(db, request.params.projectId, request.params.serviceId);
      if (service === null) {
        await sendNotFound(reply, 'Service', request.params.serviceId);
        return;
      }
      await reply.send(
        await readServiceStatus(db, service, { nowMs: Date.now(), intervalMs: env.NOODARA_METRICS_INTERVAL_MS }),
      );
    },
  });

  done();
};

export default metricsRoutes;
