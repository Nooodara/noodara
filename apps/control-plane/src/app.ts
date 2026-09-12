import type { FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import Fastify from 'fastify';
import { decodeMasterKey, logMasterKeyWarning } from './boot/master-key.js';
import { env } from './env.js';
import { createLogger } from './logger.js';
import authRoutes from './routes/auth.js';
import healthRoutes from './routes/health.js';
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

  // D-12: every boot logs the fixed backup warning with the master key's fingerprint, never the
  // key material itself.
  logMasterKeyWarning(app.log, decodeMasterKey(env.NOODARA_MASTER_KEY));

  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(setupRoutes);
  app.register(sessionsRoutes);

  return app;
}
