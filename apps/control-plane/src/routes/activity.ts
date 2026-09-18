// D-20/T-4-11/T-4-39/T-4-40: `GET /api/activity` — the reverse-chronological, keyset-paginated
// activity log. No filters, no search (REQUIREMENTS Out of Scope): the querystring schema is
// `.strict()`, so an unknown key like `?action=` is a 400, never a silently-ignored no-op filter.
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { decodeActivityCursor } from './activity-cursor.js';
import { ErrorBodySchema, toValidationErrorBody, ValidationErrorBodySchema } from './http-errors.js';

const ActivityQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).optional(),
  })
  .strict();

// D-20: exactly the ten documented fields — never `createdAt`, and metadata is passed through as
// `listActivityEvents` already returns it (already redacted on write).
const ActivityItemSchema = z.object({
  id: z.uuid(),
  occurredAt: z.date(),
  actorType: z.enum(['user', 'system']),
  actorId: z.uuid().nullable(),
  entityType: z.string(),
  entityId: z.uuid().nullable(),
  action: z.string(),
  outcome: z.enum(['success', 'failure']),
  errorCode: z.string().nullable(),
  metadata: z.unknown(),
});

const ActivityResponseSchema = z.object({
  items: z.array(ActivityItemSchema),
  nextCursor: z.string().nullable(),
});

// A service-level 400 never occurs on this route (there is no service-result failure branch
// here), but the cursor-decode failure below reuses `toValidationErrorBody` — declaring the union
// keeps this route's `response` schema honest about both possible 400 shapes, same reasoning as
// `servers.ts`'s `CreateOrEditErrorSchema`.
const ActivityErrorSchema = z.union([ValidationErrorBodySchema, ErrorBodySchema]);

const activityRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.route({
    method: 'GET',
    url: '/api/activity',
    schema: {
      querystring: ActivityQuerySchema,
      response: {
        200: ActivityResponseSchema,
        400: ActivityErrorSchema,
        401: ErrorBodySchema,
      },
    },
    handler: async (request, reply) => {
      let cursor: { occurredAt: Date; id: string } | undefined;
      if (request.query.cursor !== undefined) {
        const decoded = decodeActivityCursor(request.query.cursor);
        if (!decoded.ok) {
          // T-4-39: a tampered/malformed cursor is 400, never a 500 and never a silently
          // unfiltered first page — reusing the same body shape a schema-validation failure uses
          // so the client sees one consistent 400 vocabulary.
          await reply.code(400).send(toValidationErrorBody([{ path: 'cursor', message: 'Invalid cursor' }]));
          return;
        }
        cursor = decoded.cursor;
      }

      const services = await fastify.getServerServices();
      const result = await services.listActivity({
        limit: request.query.limit,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      await reply.send(result);
    },
  });

  done();
};

export default activityRoutes;
