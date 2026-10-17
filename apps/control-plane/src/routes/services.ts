// 12-08: `/api/projects/:projectId/services`. Same contract as `projects.ts`: each handler reads
// `request.actor`, calls one service and maps a `{ ok: false }` result through
// `mapServiceCodeToStatus`. Registered inside the guarded scope in `api-scope.ts`. Every id comes
// from the path or is checked against the path's project by the service (A4).
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import { revealSecret } from '@noodara/domain/security';
import { getDb } from '../db/client.js';
import { services } from '../db/schema/services.js';
import { webhookDeliveries } from '../db/schema/webhook-deliveries.js';
import { SERVICE_OPERATIONS } from '../deploy/service-ops.js';
import { env } from '../env.js';
import type { ContainerLogLine, ContainerLogs } from '../services/container-logs.js';
import { masterKeysFromEnvironment, type ServiceCredentialsResult } from '../services/service-credentials.js';
import type { ServiceServices } from '../services/service-services.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import {
  disableWebhook,
  enableWebhook,
  getWebhookConfig,
  rotateWebhookSecret,
  webhookPublicOrigin,
  type WebhookConfigDeps,
  type WebhookSecretResult,
} from '../services/webhook-config.js';
import { DeploymentViewSchema } from './deployment-schemas.js';
import { parseIdempotencyKeyHeader } from './deployments.js';
import { exceedsBackpressureBudget } from './events.js';
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
  RuntimeLogsQuerySchema,
  RuntimeLogsResponseSchema,
  SERVICE_ROUTE_BODY_LIMIT_BYTES,
  ServiceCredentialErrorBodySchema,
  ServiceCredentialsResponseSchema,
  ServiceInputErrorBodySchema,
  ServiceParamsSchema,
  ServiceViewSchema,
  UpdateServiceBodySchema,
  UpdateServiceResponseSchema,
  WEBHOOK_ERROR_STATUS,
  WEBHOOK_ROUTE_BODY_LIMIT_BYTES,
  WebhookActionBodySchema,
  WebhookSecretResponseSchema,
  WebhookViewSchema,
} from './service-schemas.js';

declare module 'fastify' {
  interface FastifyInstance {
    getServiceServices(): Promise<ServiceServices>;
    getContainerLogs(): ContainerLogs;
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

// ---------------------------------------------------------------------------------------------
// Recent deliveries (19-03): keyset pagination over (received_at, id) newest first. The cursor is
// opaque base64url JSON, validated before it reaches a query; a malformed one is a 400. The
// payload and the signature are never stored, so no response can carry them.
// ---------------------------------------------------------------------------------------------

export const WEBHOOK_DELIVERIES_DEFAULT_LIMIT = 20;
export const WEBHOOK_DELIVERIES_MAX_LIMIT = 50;
const MAX_CURSOR_LENGTH = 128;

export const WebhookDeliveriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(WEBHOOK_DELIVERIES_MAX_LIMIT).default(WEBHOOK_DELIVERIES_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
});

const CursorSchema = z.strictObject({ t: z.iso.datetime({ offset: true }), id: z.uuid() });

export function encodeDeliveriesCursor(receivedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: receivedAt.toISOString(), id })).toString('base64url');
}

/** Null for anything that is not a cursor this module issued. */
export function decodeDeliveriesCursor(cursor: string): { readonly receivedAt: Date; readonly id: string } | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  try {
    const parsed = CursorSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return parsed.success ? { receivedAt: new Date(parsed.data.t), id: parsed.data.id } : null;
  } catch {
    return null;
  }
}

const WebhookDeliveriesResponseSchema = z.object({
  deliveries: z.array(
    z.object({
      id: z.string(),
      deliveryId: z.string(),
      event: z.string(),
      outcome: z.string(),
      pushedSha: z.string().nullable(),
      deploymentId: z.string().nullable(),
      receivedAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

const servicesRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // 18-01 H3: the webhook payload URL comes from the configured public origin only, checked here
  // so a bad NOODARA_PUBLIC_URL fails the boot rather than the first enable.
  let publicOrigin: string;
  try {
    publicOrigin = webhookPublicOrigin(env.NOODARA_PUBLIC_URL);
  } catch (error) {
    done(error as Error);
    return;
  }

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
      // 18-05: checked before any read, so a malformed key never creates a deployment.
      const header = parseIdempotencyKeyHeader(request.headers);
      if (!header.ok) {
        await sendFailure(reply, header);
        return;
      }
      // Scoped to the path's project first: another project's service reads as missing (A4).
      const service = await (await fastify.getServiceServices()).getService(request.params.projectId, request.params.serviceId);
      if (!service) {
        await sendFailure(reply, { code: 'NOT_FOUND', message: `Service "${request.params.serviceId}" not found` });
        return;
      }
      const result = await (await fastify.getDeploymentServices()).triggerDeploy({
        actor,
        serviceId: service.id,
        action: 'redeploy',
        ...(header.key === undefined ? {} : { idempotencyKey: header.key }),
      });
      if (!result.ok) {
        await sendFailure(reply, result);
        return;
      }
      if (result.replayed) void reply.header('idempotency-replayed', 'true');
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
  // Runtime logs (12-16): read on demand from the server, never stored. Tail is one JSON
  // response; follow is a dedicated bounded NDJSON stream (not a global SSE type) that ends at
  // the configured max duration or when the client leaves, killing the remote docker logs.
  // -------------------------------------------------------------------------------------------

  const LOG_ERRORS = {
    400: BadRequestSchema,
    401: ErrorBodySchema,
    404: ErrorBodySchema,
    409: ErrorBodySchema,
    422: ErrorBodySchema,
    429: ErrorBodySchema,
    502: ErrorBodySchema,
    503: ErrorBodySchema,
    504: ErrorBodySchema,
  };
  const logsUrl = '/api/projects/:projectId/services/:serviceId/logs';

  async function findService(reply: FastifyReply, projectId: string, serviceId: string): Promise<string | null> {
    // Scoped to the path's project first: another project's service reads as missing (A4).
    const service = await (await fastify.getServiceServices()).getService(projectId, serviceId);
    if (!service) {
      await sendFailure(reply, { code: 'NOT_FOUND', message: `Service "${serviceId}" not found` });
      return null;
    }
    return service.serverId;
  }

  app.route({
    method: 'GET',
    url: logsUrl,
    schema: {
      params: ServiceParamsSchema,
      querystring: RuntimeLogsQuerySchema,
      response: { 200: RuntimeLogsResponseSchema, ...LOG_ERRORS },
    },
    handler: async (request, reply) => {
      requireActor(request.actor);
      const logs = fastify.getContainerLogs();
      const tail = logs.resolveTail(request.query.tail);
      if (!tail.ok) {
        await sendFailure(reply, tail);
        return;
      }
      const serverId = await findService(reply, request.params.projectId, request.params.serviceId);
      if (serverId === null) return;
      const result = await logs.tail({ serverId, serviceId: request.params.serviceId, tail: tail.value });
      if (!result.ok) {
        await sendFailure(reply, result);
        return;
      }
      await reply.send({ lines: result.lines, truncated: result.truncated });
    },
  });

  app.route({
    method: 'GET',
    url: `${logsUrl}/follow`,
    schema: {
      params: ServiceParamsSchema,
      querystring: RuntimeLogsQuerySchema,
      response: LOG_ERRORS,
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const logs = fastify.getContainerLogs();
      const tail = logs.resolveTail(request.query.tail);
      if (!tail.ok) {
        await sendFailure(reply, tail);
        return;
      }
      const serverId = await findService(reply, request.params.projectId, request.params.serviceId);
      if (serverId === null) return;

      // The response's close fires when the client leaves (or after our own end): either way the
      // stream must stop. Registered before opening, so a client gone mid-open still aborts.
      const clientGone = new AbortController();
      const abort = (): void => {
        clientGone.abort();
      };
      reply.raw.on('close', abort);
      if (request.raw.destroyed || request.raw.socket.destroyed) abort();

      const opened = await logs.openFollow({
        serverId,
        serviceId: request.params.serviceId,
        // The per-user cap key; a system actor never reaches a session-guarded route.
        userId: actor.type === 'user' ? actor.id : 'system',
        tail: tail.value,
        signal: clientGone.signal,
      });
      if (!opened.ok) {
        reply.raw.off('close', abort);
        if (clientGone.signal.aborted) return;
        await sendFailure(reply, opened);
        return;
      }

      reply.hijack();
      const raw = reply.raw;
      // A peer that stops reading must not grow our buffer: drop it like a disconnect.
      const evict = (): void => {
        abort();
        if (!raw.destroyed) raw.destroy();
      };
      raw.on('error', evict);
      const writeFrame = (frame: Record<string, unknown>): void => {
        if (raw.writableEnded || raw.destroyed) return;
        if (exceedsBackpressureBudget(raw.writableLength)) {
          evict();
          return;
        }
        try {
          raw.write(`${JSON.stringify(frame)}\n`);
        } catch {
          evict();
        }
      };
      if (!clientGone.signal.aborted) {
        raw.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
        });
      }

      const end = await opened.stream.pump((line: ContainerLogLine) => {
        writeFrame({ type: 'line', ...line });
      });
      writeFrame({ type: 'end', reason: end.reason });
      raw.off('close', abort);
      if (!raw.writableEnded && !raw.destroyed) raw.end();
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

  // -------------------------------------------------------------------------------------------
  // Push webhook (18-01): the secret is in the enable and rotate responses only (no-store), never
  // in a read, a log line or an activity event. Errors carry a code and a fixed message.
  // -------------------------------------------------------------------------------------------

  const webhookUrl = '/api/projects/:projectId/services/:serviceId/webhook';
  const webhookMasterKeys = masterKeysFromEnvironment();
  const WEBHOOK_ERRORS = { ...MUTATION_ERRORS, 422: ErrorBodySchema };

  async function webhookDeps(): Promise<WebhookConfigDeps> {
    return { db: await getDb(), now: () => new Date(), masterKeys: webhookMasterKeys, publicOrigin };
  }

  async function sendWebhookFailure(reply: FastifyReply, failure: { readonly code: string; readonly message: string }): Promise<void> {
    const table: Readonly<Record<string, number>> = WEBHOOK_ERROR_STATUS;
    const status = table[failure.code] ?? mapServiceCodeToStatus(failure.code);
    await reply.code(status).send(toErrorBody(failure.code, failure.message));
  }

  async function sendWebhookSecret(reply: FastifyReply, result: WebhookSecretResult): Promise<void> {
    if (!result.ok) {
      await sendWebhookFailure(reply, result);
      return;
    }
    const { payloadUrl, secret } = result.webhook;
    await reply.header('cache-control', 'no-store').send({ enabled: true, payloadUrl, secret: revealSecret(secret) });
  }

  app.route({
    method: 'GET',
    url: webhookUrl,
    schema: {
      params: ServiceParamsSchema,
      response: { 200: WebhookViewSchema, 400: BadRequestSchema, 401: ErrorBodySchema, 404: ErrorBodySchema },
    },
    handler: async (request, reply) => {
      const view = await getWebhookConfig(await webhookDeps(), request.params.projectId, request.params.serviceId);
      if (!view) {
        await sendWebhookFailure(reply, { code: 'NOT_FOUND', message: `Service "${request.params.serviceId}" not found` });
        return;
      }
      await reply.send(view);
    },
  });

  app.route({
    method: 'POST',
    url: webhookUrl,
    bodyLimit: WEBHOOK_ROUTE_BODY_LIMIT_BYTES,
    schema: {
      params: ServiceParamsSchema,
      body: WebhookActionBodySchema,
      response: { 200: WebhookSecretResponseSchema, ...WEBHOOK_ERRORS },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const result = await enableWebhook(await webhookDeps(), {
        actor,
        projectId: request.params.projectId,
        serviceId: request.params.serviceId,
      });
      await sendWebhookSecret(reply, result);
    },
  });

  app.route({
    method: 'POST',
    url: `${webhookUrl}/rotate`,
    bodyLimit: WEBHOOK_ROUTE_BODY_LIMIT_BYTES,
    schema: {
      params: ServiceParamsSchema,
      body: WebhookActionBodySchema,
      response: { 200: WebhookSecretResponseSchema, ...WEBHOOK_ERRORS },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const result = await rotateWebhookSecret(await webhookDeps(), {
        actor,
        projectId: request.params.projectId,
        serviceId: request.params.serviceId,
      });
      await sendWebhookSecret(reply, result);
    },
  });

  app.route({
    method: 'DELETE',
    url: webhookUrl,
    bodyLimit: WEBHOOK_ROUTE_BODY_LIMIT_BYTES,
    schema: {
      params: ServiceParamsSchema,
      body: WebhookActionBodySchema,
      response: { 200: WebhookViewSchema, ...WEBHOOK_ERRORS },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const result = await disableWebhook(await webhookDeps(), {
        actor,
        projectId: request.params.projectId,
        serviceId: request.params.serviceId,
      });
      if (!result.ok) {
        await sendWebhookFailure(reply, result);
        return;
      }
      await reply.send(result.webhook);
    },
  });

  app.route({
    method: 'GET',
    url: `${webhookUrl}/deliveries`,
    schema: {
      params: ServiceParamsSchema,
      querystring: WebhookDeliveriesQuerySchema,
      response: { 200: WebhookDeliveriesResponseSchema, 400: BadRequestSchema, 401: ErrorBodySchema, 404: ErrorBodySchema },
    },
    handler: async (request, reply) => {
      const { projectId, serviceId } = request.params;
      const { limit, cursor } = request.query;
      const after = cursor === undefined ? null : decodeDeliveriesCursor(cursor);
      if (cursor !== undefined && after === null) {
        await reply.code(400).send(toErrorBody('VALIDATION_FAILED', 'The cursor is not valid'));
        return;
      }
      const db = await getDb();
      const [owner] = await db
        .select({ id: services.id })
        .from(services)
        .where(and(eq(services.id, serviceId), eq(services.projectId, projectId)))
        .limit(1);
      if (!owner) {
        await sendWebhookFailure(reply, { code: 'NOT_FOUND', message: `Service "${serviceId}" not found` });
        return;
      }
      const scope = eq(webhookDeliveries.serviceId, serviceId);
      const rows = await db
        .select({
          id: webhookDeliveries.id,
          deliveryId: webhookDeliveries.deliveryId,
          event: webhookDeliveries.event,
          outcome: webhookDeliveries.outcome,
          pushedSha: webhookDeliveries.pushedSha,
          deploymentId: webhookDeliveries.deploymentId,
          receivedAt: webhookDeliveries.receivedAt,
        })
        .from(webhookDeliveries)
        .where(
          after === null
            ? scope
            : and(
                scope,
                or(
                  lt(webhookDeliveries.receivedAt, after.receivedAt),
                  and(eq(webhookDeliveries.receivedAt, after.receivedAt), lt(webhookDeliveries.id, after.id)),
                ),
              ),
        )
        .orderBy(desc(webhookDeliveries.receivedAt), desc(webhookDeliveries.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      await reply.send({
        deliveries: page.map((row) => ({ ...row, receivedAt: row.receivedAt.toISOString() })),
        nextCursor: rows.length > limit && last ? encodeDeliveriesCursor(last.receivedAt, last.id) : null,
      });
    },
  });

  done();
};

export default servicesRoutes;
