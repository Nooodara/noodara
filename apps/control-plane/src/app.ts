import type { FastifyError, FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  serializerCompiler,
  validatorCompiler,
} from '@fastify/type-provider-zod';
import Fastify from 'fastify';
import type { Redis } from 'ioredis';
import { appRedactor } from './activity/redaction.js';
import { decodeMasterKey, logMasterKeyWarning } from './boot/master-key.js';
import { env } from './env.js';
import { createLogger } from './logger.js';
import { createConnectServerQueue, type ConnectServerQueue } from './queue/connect-server-queue.js';
import { createQueueRedisConnection } from './redis/connections.js';
import apiScope from './routes/api-scope.js';
import authRoutes from './routes/auth.js';
import healthRoutes from './routes/health.js';
import { toErrorBody, toValidationErrorBody } from './routes/http-errors.js';
import setupRoutes from './routes/setup.js';
import { resolveServerServicesDeps } from './services/server-service-deps.js';
import { createServerServices, type ServerServices } from './services/server-services.js';

export interface BuildAppDeps {
  logger?: FastifyInstance['log'];
  serverServices?: ServerServices;
  queue?: ConnectServerQueue;
}

/**
 * Builds the per-`buildApp()`-call resolver `fastify.getServerServices` decorates onto the
 * instance — a closure holding its own memoised promise, never a module-level singleton, so two
 * apps built in the same test process (or the API and worker, if either ever shared this module)
 * never share state. Deps are resolved lazily, on first call, not at `buildApp()` time: resolving
 * them eagerly would open a Postgres pool merely by building the app, even for a test that never
 * calls a `/api/servers` route.
 */
function createServerServicesResolver(deps: BuildAppDeps): () => Promise<ServerServices> {
  let cached: Promise<ServerServices> | undefined;
  return () => {
    if (deps.serverServices !== undefined) {
      return Promise.resolve(deps.serverServices);
    }
    return (cached ??= resolveServerServicesDeps().then(createServerServices));
  };
}

/**
 * Builds `fastify.getQueue` the same per-instance-memoised way as `getServerServices` above, and
 * its matching `closeOwnedResources()` for the `onClose` hook below. A queue the caller injected
 * via `deps.queue` (every test in this phase) is never closed here — the caller owns that
 * instance's lifetime; only a queue this resolver built itself (its own `ioredis` connection
 * included, per `connect-server-queue.ts`'s own "the caller owns the connection" contract) is
 * closed on shutdown.
 */
function createQueueResolver(deps: BuildAppDeps): {
  getQueue: () => Promise<ConnectServerQueue>;
  closeOwnedResources: () => Promise<void>;
} {
  let cached: Promise<ConnectServerQueue> | undefined;
  let ownedConnection: Redis | undefined;

  const getQueue = (): Promise<ConnectServerQueue> => {
    if (deps.queue !== undefined) {
      return Promise.resolve(deps.queue);
    }
    return (cached ??= Promise.resolve().then(() => {
      const connection = createQueueRedisConnection(env.REDIS_URL);
      ownedConnection = connection;
      return createConnectServerQueue({ connection });
    }));
  };

  const closeOwnedResources = async (): Promise<void> => {
    if (deps.queue !== undefined || cached === undefined) {
      return;
    }
    const queue = await cached;
    await queue.close();
    ownedConnection?.disconnect();
  };

  return { getQueue, closeOwnedResources };
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

  // Plan 04-08: `routes/servers.ts` calls `await fastify.getServerServices()` once per request —
  // never at module load, which would open a Postgres pool merely by importing the route file.
  app.decorate('getServerServices', createServerServicesResolver(deps));

  // Plan 04-08 (Task 3): the connect/discover routes' queue producer. A queue has no open
  // streaming response, so `onClose` (not `preClose`, which Plan 04-09's SSE streams need) is the
  // right shutdown hook for it.
  const { getQueue, closeOwnedResources } = createQueueResolver(deps);
  app.decorate('getQueue', getQueue);
  app.addHook('onClose', async () => {
    await closeOwnedResources();
  });

  // D-17: `healthRoutes`/`authRoutes`/`setupRoutes` stay siblings of `apiScope`, never inside it —
  // that sibling relationship is what keeps `/health`, `/api/auth/*`, `/api/setup` and
  // `/api/recovery` unguarded with no allowlist/denylist branch anywhere.
  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(setupRoutes);
  app.register(apiScope);

  return app;
}
