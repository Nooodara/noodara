import type { FastifyError, FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  serializerCompiler,
  validatorCompiler,
} from '@fastify/type-provider-zod';
import Fastify from 'fastify';
import { appRedactor } from './activity/redaction.js';
import { decodeMasterKey, logMasterKeyWarning } from './boot/master-key.js';
import { env } from './env.js';
import { createLogger } from './logger.js';
import authRoutes from './routes/auth.js';
import healthRoutes from './routes/health.js';
import { toErrorBody, toValidationErrorBody } from './routes/http-errors.js';
import sessionsRoutes from './routes/sessions.js';
import setupRoutes from './routes/setup.js';

export interface BuildAppDeps {
  logger?: FastifyInstance['log'];
}

// Builds a fully configured Fastify instance that never starts a network server, so integration
// tests can exercise it with `app.inject()`. Only `src/server.ts` puts the app on a socket.
export function buildApp(deps: BuildAppDeps = {}): FastifyInstance {
  // Fastify v5 takes a pre-built pino instance via `loggerInstance`, not `logger` (which only
  // accepts a plain options object or boolean). `trustProxy` gates whether Fastify's own
  // `request.ip` honours `X-Forwarded-For` (T-1-40, D-07) — `false` by default, so the header is
  // ignored unless `NOODARA_TRUST_PROXY` is explicitly set.
  const app = Fastify({ loggerInstance: deps.logger ?? createLogger(), trustProxy: env.NOODARA_TRUST_PROXY });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // D-22: single global error handler, in this exact branch order. No route (existing or future)
  // may set its own `setErrorHandler` — an unhandled exception must always end here, and always
  // become an opaque, redacted 500 with the process left alive (roadmap criterion 4).
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      reply.code(400).send(toValidationErrorBody(error.validation));
      return;
    }
    if (isResponseSerializationError(error)) {
      // A response schema mismatch is always a server bug (the route promised a shape it did not
      // deliver), never something to blame on the caller — never a 4xx.
      request.log.error({ err: error }, 'response failed schema validation');
      reply.code(500).send(toErrorBody('INTERNAL_ERROR', 'Internal error'));
      return;
    }
    // T-4-04: the raw `error.message` never reaches the client and is only ever logged through
    // `appRedactor.redact`, never as the unredacted original — this is what makes the D-22 canary
    // (and `security:scan-leaks`) pass for every route, not just the ones that remember to do it.
    request.log.error({ message: appRedactor.redact(error.message), requestId: request.id }, 'unhandled error');
    reply.code(500).send(toErrorBody('INTERNAL_ERROR', 'Internal error'));
  });

  // D-12: every boot logs the fixed backup warning with the master key's fingerprint, never the
  // key material itself.
  logMasterKeyWarning(app.log, decodeMasterKey(env.NOODARA_MASTER_KEY));

  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(setupRoutes);
  app.register(sessionsRoutes);

  return app;
}
