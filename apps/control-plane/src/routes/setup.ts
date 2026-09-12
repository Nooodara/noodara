import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { adminExists, redeemRecoveryToken, redeemSetupToken } from '../services/setup-service.js';

// AUTH-01/D-02: `POST /api/setup` is the only way the first admin is ever created, and it
// disappears (404, never 403 — T-1-36) the moment one exists. The route only authenticates the
// "does an admin already exist" gate and maps the service's failure codes to status codes; every
// decision about the token's validity and the admin's creation lives in `setup-service.ts`.

const SetupBodySchema = z.object({
  token: z.string().min(1),
  email: z.string(),
  password: z.string(),
});

const SetupSuccessSchema = z.object({ success: z.literal(true) });
const SetupErrorSchema = z.object({ error: z.string() });
const NotFoundSchema = z.object({ error: z.literal('not_found') });

// D-03: mirrors POST /api/setup but redeems a `recovery`-purpose token instead of a `setup` one —
// purpose is checked at the repository layer (findUsableByHash), never inferred from which route
// received the request, so a setup token can never be redeemed here and vice versa.
const RecoveryBodySchema = z.object({
  token: z.string().min(1),
  newPassword: z.string(),
});

const setupRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.route({
    method: 'POST',
    url: '/api/setup',
    schema: {
      body: SetupBodySchema,
      response: {
        200: SetupSuccessSchema,
        400: SetupErrorSchema,
        404: NotFoundSchema,
      },
    },
    handler: async (request, reply) => {
      const db = await getDb();

      // Checked before the token is ever looked at (D-02): once an admin exists, this route's
      // very existence is no longer confirmed to a caller, regardless of what they submit.
      if (await adminExists(db)) {
        await reply.code(404).send({ error: 'not_found' as const });
        return;
      }

      const result = await redeemSetupToken({
        token: request.body.token,
        email: request.body.email,
        password: request.body.password,
      });

      if (!result.ok) {
        await reply.code(400).send({ error: result.code });
        return;
      }

      await reply.send({ success: true as const });
    },
  });

  // D-03: unlike /api/setup, this endpoint is never gated by adminExists()'s door-closing 404 —
  // an admin necessarily already exists for a recovery token to ever have been issued, and the
  // service's own token lookup (by hash *and* purpose) is what rejects everything else.
  app.route({
    method: 'POST',
    url: '/api/recovery',
    schema: {
      body: RecoveryBodySchema,
      response: {
        200: SetupSuccessSchema,
        400: SetupErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const result = await redeemRecoveryToken({
        token: request.body.token,
        newPassword: request.body.newPassword,
      });

      if (!result.ok) {
        await reply.code(400).send({ error: result.code });
        return;
      }

      await reply.send({ success: true as const });
    },
  });

  done();
};

export default setupRoutes;
