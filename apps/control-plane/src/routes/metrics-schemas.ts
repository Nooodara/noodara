// 27-03: request and response schemas of the metrics and service status routes. Output views are
// the strict v0.5 contract schemas (26-04); the server view adds the connection state and uptime.
// Query values are taken as bounded strings here and validated by parseMetricRange, which
// answers with a named 400 (METRICS_QUERY_INVALID) instead of the generic schema error.
import {
  MetricSeriesResponseSchema,
  ServiceParamsSchema,
  ServiceStatusSummarySchema,
} from '@noodara/domain/api-contract';
import { SERVER_STATUSES } from '@noodara/domain/server';
import { z } from 'zod';

export const METRICS_QUERY_INVALID = 'METRICS_QUERY_INVALID';
export const METRICS_QUERY_INVALID_STATUS = 400;

const QueryValue = z.string().max(64).optional();

export const MetricsQuerySchema = z.strictObject({ from: QueryValue, to: QueryValue, points: QueryValue });
export const ServerMetricsParamsSchema = z.object({ id: z.uuid() });
export const ServiceMetricsParamsSchema = ServiceParamsSchema;

const Timestamp = z.iso.datetime({ offset: true });

export const ServerMetricsResponseSchema = MetricSeriesResponseSchema.extend({
  server: z.strictObject({
    serverId: z.uuid(),
    connectionState: z.enum(SERVER_STATUSES),
    /** The last time a collector tick reached the server. */
    lastSeenAt: Timestamp.nullable(),
    /** From the latest host sample, as of `sampledAt`; null before the first sample. */
    uptimeSeconds: z.number().int().nonnegative().nullable(),
    sampledAt: Timestamp.nullable(),
  }),
});

export const ServiceMetricsResponseSchema = MetricSeriesResponseSchema;
export const ServiceStatusResponseSchema = ServiceStatusSummarySchema;

export const MetricsQueryErrorBodySchema = z.strictObject({
  error: z.literal(METRICS_QUERY_INVALID),
  message: z.string(),
  issues: z.array(z.strictObject({ path: z.string(), message: z.string() })).max(8),
});
