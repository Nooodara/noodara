import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';

// Fixed at build time; this route exists primarily as the compile-time proof that the pinned
// type provider (docs/adr/0001-fastify-zod-type-provider.md) infers Zod 4 schemas end to end.
const CONTROL_PLANE_VERSION = '0.0.0';

const healthRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  fastify.withTypeProvider<ZodTypeProvider>().route({
    method: 'GET',
    url: '/health',
    schema: {
      response: {
        200: z.object({
          status: z.literal('ok'),
          version: z.string(),
        }),
      },
    },
    handler: (_request, reply) => {
      reply.send({ status: 'ok' as const, version: CONTROL_PLANE_VERSION });
    },
  });
  done();
};

export default healthRoutes;
