import type { FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import Fastify from 'fastify';
import authRoutes from './routes/auth.js';
import healthRoutes from './routes/health.js';
import sessionsRoutes from './routes/sessions.js';
import setupRoutes from './routes/setup.js';

export interface BuildAppDeps {
  logger?: FastifyInstance['log'] | boolean;
}

// Builds a fully configured Fastify instance that never starts a network server, so integration
// tests can exercise it with `app.inject()`. Only `src/server.ts` puts the app on a socket.
export function buildApp(deps: BuildAppDeps = {}): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? true });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(setupRoutes);
  app.register(sessionsRoutes);

  return app;
}
