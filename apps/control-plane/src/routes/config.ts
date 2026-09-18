// D-21: `GET /api/config` — guarded, read-only, exposes only the master key's truncated SHA-256
// fingerprint. No `PUT`/`PATCH`, no `settings` table — editable configuration is explicitly out
// of scope for v0.1.
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { decodeMasterKey, masterKeyFingerprint } from '../boot/master-key.js';
import { CONTROL_PLANE_VERSION } from '../config-version.js';
import { env } from '../env.js';
import { ErrorBodySchema } from './http-errors.js';

const ConfigResponseSchema = z.object({
  version: z.string(),
  publicUrl: z.string(),
  masterKeyFingerprint: z.string(),
  sshTimeouts: z.object({
    connectMs: z.number().int(),
    commandMs: z.number().int(),
    discoveryMs: z.number().int(),
  }),
  workerConcurrency: z.number().int(),
});

const configRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  fastify.withTypeProvider<ZodTypeProvider>().route({
    method: 'GET',
    url: '/api/config',
    schema: {
      response: {
        200: ConfigResponseSchema,
        401: ErrorBodySchema,
      },
    },
    handler: (_request, reply) => {
      // T-4-12: only the truncated SHA-256 fingerprint ever leaves this handler — the same value
      // Phase 1's boot warning already logs, never the decoded key bytes or the base64 form.
      reply.send({
        version: CONTROL_PLANE_VERSION,
        publicUrl: env.NOODARA_PUBLIC_URL,
        masterKeyFingerprint: masterKeyFingerprint(decodeMasterKey(env.NOODARA_MASTER_KEY)),
        sshTimeouts: {
          connectMs: env.NOODARA_SSH_CONNECT_TIMEOUT_MS,
          commandMs: env.NOODARA_SSH_COMMAND_TIMEOUT_MS,
          discoveryMs: env.NOODARA_SSH_DISCOVERY_TIMEOUT_MS,
        },
        workerConcurrency: env.NOODARA_WORKER_CONCURRENCY,
      });
    },
  });

  done();
};

export default configRoutes;
