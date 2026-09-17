import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { CONTROL_PLANE_VERSION } from '../config-version.js';

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
