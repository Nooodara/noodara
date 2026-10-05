// 12-10: schemas for the deployment routes. The deploy body accepts no field at all; it is parsed
// loosely so the handler can answer a named 422 (DEPLOYMENT_INPUT_INVALID) instead of a generic
// 400. Response schemas strip unknown keys on serialization, so a view never leaks extra fields.
import {
  DEPLOYMENT_ERROR_CODES,
  DEPLOYMENT_LOG_PHASES,
  DEPLOYMENT_STATUSES,
  DEPLOYMENT_TRIGGERS,
} from '@noodara/domain/deployment';
import { z } from 'zod';

/** A deploy request carries nothing; 1 KiB is plenty for `{}` and rejects anything larger (413). */
export const DEPLOYMENT_ROUTE_BODY_LIMIT_BYTES = 1024;

export const DEPLOYMENT_LIST_DEFAULT_LIMIT = 20;
export const DEPLOYMENT_LIST_MAX_LIMIT = 100;
const MAX_CURSOR_LENGTH = 512;

export const ServiceIdParamSchema = z.object({ serviceId: z.uuid() });
export const ServiceDeploymentParamsSchema = z.object({ serviceId: z.uuid(), deploymentId: z.uuid() });
export const DeploymentIdParamSchema = z.object({ deploymentId: z.uuid() });

/** Fastify hands a body-less POST to validation as `null`, so both null and undefined mean "no body". */
export const DeployBodySchema = z.looseObject({}).nullish();
export type DeployBody = z.infer<typeof DeployBodySchema>;

/** Every key the deploy body carries is unknown: the deploy takes its source from the service. */
export function unknownDeployFields(body: DeployBody): string[] {
  return body === undefined || body === null ? [] : Object.keys(body);
}

export const DeploymentListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(DEPLOYMENT_LIST_MAX_LIMIT).default(DEPLOYMENT_LIST_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
  })
  .strict();

export const DeploymentSourceViewSchema = z.object({
  sourceType: z.enum(['git', 'image']),
  repositoryUrl: z.string().nullable(),
  branch: z.string().nullable(),
  buildContext: z.string().nullable(),
  dockerfilePath: z.string().nullable(),
  buildTarget: z.string().nullable(),
  imageRef: z.string().nullable(),
  internalPort: z.number().int(),
  publishedPort: z.number().int().nullable(),
});

export const DeploymentViewSchema = z.object({
  id: z.uuid(),
  serviceId: z.uuid(),
  status: z.enum(DEPLOYMENT_STATUSES),
  trigger: z.enum(DEPLOYMENT_TRIGGERS),
  triggeredBy: z.string().nullable(),
  source: DeploymentSourceViewSchema,
  commitSha: z.string().nullable(),
  previousDeploymentId: z.uuid().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  errorCode: z.enum(DEPLOYMENT_ERROR_CODES).nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const DeploymentListResponseSchema = z.object({
  items: z.array(DeploymentViewSchema),
  nextCursor: z.string().nullable(),
});

// 12-12 (H2): `GET /api/deployments/:id/logs`. The cursor is (`phase`, `since`): chunks strictly
// after it, in phase order then seq. `since` is a plain non-negative decimal integer (no sign,
// exponent or blank), at most the Postgres `integer` range. A page holds at most
// `DEPLOYMENT_LOGS_MAX_LIMIT` chunks of at most 16 KB each.
export const DEPLOYMENT_LOGS_DEFAULT_LIMIT = 50;
export const DEPLOYMENT_LOGS_MAX_LIMIT = 100;
const MAX_LOG_SEQ = 2_147_483_647;

export const DeploymentLogsQuerySchema = z
  .object({
    phase: z.enum(DEPLOYMENT_LOG_PHASES).default('prepare'),
    since: z
      .string()
      .regex(/^\d{1,10}$/, 'since must be a non-negative integer')
      .transform(Number)
      .pipe(z.number().int().min(0).max(MAX_LOG_SEQ))
      .default(0),
    limit: z.coerce.number().int().min(1).max(DEPLOYMENT_LOGS_MAX_LIMIT).default(DEPLOYMENT_LOGS_DEFAULT_LIMIT),
  })
  .strict();

export const DeploymentLogChunkViewSchema = z.object({
  phase: z.enum(DEPLOYMENT_LOG_PHASES),
  seq: z.number().int(),
  text: z.string(),
  byteLength: z.number().int(),
  createdAt: z.string(),
});

export const DeploymentLogsResponseSchema = z.object({
  items: z.array(DeploymentLogChunkViewSchema),
  hasMore: z.boolean(),
});
