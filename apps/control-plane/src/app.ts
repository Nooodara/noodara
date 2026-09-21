import type { FastifyBaseLogger, FastifyError, FastifyInstance } from 'fastify';
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
import { createRedisServerEventPublisher } from './events/redis-server-event-publisher.js';
import type { ServerEventPublisher } from './events/server-event-publisher.js';
import { createSseBroadcaster, type SseBroadcaster } from './events/sse-broadcaster.js';
import { createLogger } from './logger.js';
import { createConnectServerQueue, type ConnectServerQueue } from './queue/connect-server-queue.js';
import {
  createHealthRedisConnection,
  createPublisherRedisConnection,
  createQueueRedisConnection,
  createSubscriberRedisConnection,
} from './redis/connections.js';
import apiScope from './routes/api-scope.js';
import authRoutes from './routes/auth.js';
import healthRoutes from './routes/health.js';
import { toErrorBody, toValidationErrorBody } from './routes/http-errors.js';
import setupRoutes from './routes/setup.js';
import { resolveServerServicesDeps, type ServiceLogger } from './services/server-service-deps.js';
import { createServerServices, type ServerServices } from './services/server-services.js';

export interface BuildAppDeps {
  logger?: FastifyInstance['log'];
  serverServices?: ServerServices;
  queue?: ConnectServerQueue;
  broadcaster?: SseBroadcaster;
  eventPublisher?: ServerEventPublisher;
  healthRedis?: Redis;
  sseHeartbeatMs?: number;
}

/**
 * Builds the per-`buildApp()`-call resolver `fastify.getServerServices` decorates onto the
 * instance — a closure holding its own memoised promise, never a module-level singleton, so two
 * apps built in the same test process (or the API and worker, if either ever shared this module)
 * never share state. Deps are resolved lazily, on first call, not at `buildApp()` time: resolving
 * them eagerly would open a Postgres pool merely by building the app, even for a test that never
 * calls a `/api/servers` route.
 */
function createServerServicesResolver(
  deps: BuildAppDeps,
  eventPublisher: ServerEventPublisher,
  logger: ServiceLogger,
): () => Promise<ServerServices> {
  let cached: Promise<ServerServices> | undefined;
  return () => {
    if (deps.serverServices !== undefined) {
      return Promise.resolve(deps.serverServices);
    }
    // D-04: a `registerServer`/`editServer`/... issued through the API publishes through the same
    // Redis-backed adapter the worker uses — `resolveServerServicesDeps`'s own `events` default
    // (`noopServerEventPublisher`) would otherwise silently swallow every HTTP-triggered event.
    // GR-03: the same Fastify pino instance every request already logs through, so a swallowed
    // `connectAndDiscover` recovery failure surfaces through the API's own log stream.
    return (cached ??= resolveServerServicesDeps({ events: eventPublisher, logger }).then(
      createServerServices,
    ));
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

/**
 * Resolves the SSE broadcaster (and its owned subscriber connection, if any) the same
 * caller-owns-what-it-injects way as `createQueueResolver` above. Unlike the queue/service
 * resolvers, this one is *not* deferred to first request — `routes/api-scope.ts` needs a real
 * `SseBroadcaster` instance at `buildApp()` time to pass into `createEventsRoutes`, and
 * `onReady`'s `broadcaster.start()` call (below) must run regardless of whether any request ever
 * arrives, so every open SSE stream can be fed as soon as one connects.
 */
function resolveBroadcaster(
  deps: BuildAppDeps,
  logger: FastifyBaseLogger,
): { broadcaster: SseBroadcaster; closeOwnedConnection: () => void } {
  if (deps.broadcaster !== undefined) {
    return { broadcaster: deps.broadcaster, closeOwnedConnection: () => undefined };
  }
  const subscriberConnection = createSubscriberRedisConnection(env.REDIS_URL);
  const broadcaster = createSseBroadcaster({
    subscriber: subscriberConnection,
    logger,
    maxConnections: env.NOODARA_SSE_MAX_CONNECTIONS,
  });
  return {
    broadcaster,
    closeOwnedConnection: () => {
      subscriberConnection.disconnect();
    },
  };
}

/** Same caller-owns-what-it-injects shape as `resolveBroadcaster`, for the publisher side of the
 *  bridge every Phase 3 service's `deps.events` call ends up going through. */
function resolveEventPublisher(
  deps: BuildAppDeps,
  logger: FastifyBaseLogger,
): { eventPublisher: ServerEventPublisher; closeOwnedConnection: () => void } {
  if (deps.eventPublisher !== undefined) {
    return { eventPublisher: deps.eventPublisher, closeOwnedConnection: () => undefined };
  }
  const publisherConnection = createPublisherRedisConnection(env.REDIS_URL);
  const eventPublisher = createRedisServerEventPublisher(publisherConnection, logger);
  return {
    eventPublisher,
    closeOwnedConnection: () => {
      publisherConnection.disconnect();
    },
  };
}

/**
 * Same caller-owns-what-it-injects shape as `resolveBroadcaster`/`resolveEventPublisher`, for
 * `/health`'s own Redis connection (Plan 04-10) — built lazily on first health check, memoised
 * per `buildApp()` instance, and never rebuilt per request.
 */
function createHealthRedisResolver(deps: BuildAppDeps): {
  getHealthRedis: () => Redis;
  closeOwnedConnection: () => void;
} {
  if (deps.healthRedis !== undefined) {
    const injected = deps.healthRedis;
    return { getHealthRedis: () => injected, closeOwnedConnection: () => undefined };
  }
  let connection: Redis | undefined;
  return {
    getHealthRedis: () => (connection ??= createHealthRedisConnection(env.REDIS_URL)),
    closeOwnedConnection: () => {
      connection?.disconnect();
    },
  };
}

// D-27: an unreachable Redis must never hold up the API's own readiness — `onReady` bounds the
// initial subscribe attempt so `app.listen`/`app.ready()`/`app.inject()` never hangs waiting on a
// dead connection's offline command queue. ioredis's own `autoResubscribe` (default `true`)
// finishes the job once Redis actually comes back, with no further code needed here.
const BROADCASTER_STARTUP_TIMEOUT_MS = 2000;

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

  // Plan 04-09: the publisher half of the SSE bridge, built before `getServerServices` so its
  // resolver can inject it as `deps.events` on every HTTP-triggered service call.
  const { eventPublisher, closeOwnedConnection: closeEventPublisherConnection } = resolveEventPublisher(
    deps,
    app.log,
  );

  // Plan 04-08: `routes/servers.ts` calls `await fastify.getServerServices()` once per request —
  // never at module load, which would open a Postgres pool merely by importing the route file.
  app.decorate('getServerServices', createServerServicesResolver(deps, eventPublisher, app.log));

  // Plan 04-08 (Task 3): the connect/discover routes' queue producer. A queue has no open
  // streaming response, so `onClose` (not `preClose`, which Plan 04-09's SSE streams need) is the
  // right shutdown hook for it.
  const { getQueue, closeOwnedResources } = createQueueResolver(deps);
  app.decorate('getQueue', getQueue);

  // Plan 04-10: `/health`'s own Postgres/Redis/worker checks reuse one memoised connection,
  // never opening a fresh one per request.
  const { getHealthRedis, closeOwnedConnection: closeHealthRedisConnection } = createHealthRedisResolver(deps);
  app.decorate('getHealthRedis', getHealthRedis);

  // Plan 04-09: the subscriber half of the SSE bridge — built eagerly (unlike `getQueue`/
  // `getServerServices`, which defer to first request) because `apiScope`/`createEventsRoutes`
  // need a real `SseBroadcaster` instance to register `GET /api/events` against, and the
  // subscription itself must be live before the first SSE client ever connects, not lazily
  // started by that client's own request.
  const { broadcaster, closeOwnedConnection: closeBroadcasterConnection } = resolveBroadcaster(deps, app.log);

  app.addHook('onReady', async () => {
    try {
      await Promise.race([
        broadcaster.start(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error('sse broadcaster subscribe timed out'));
          }, BROADCASTER_STARTUP_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      // D-27: Redis being unreachable at boot must never stop the API from becoming ready —
      // `GET /api/events` still accepts connections and heartbeats; only the fan-out is missing
      // until ioredis's own `autoResubscribe` restores it on reconnect.
      app.log.warn({ err }, 'sse broadcaster failed to start within the boot window');
    }
  });

  // RESEARCH.md Anti-Patterns / Pitfall 3: streams are ended in `preClose`, not `onClose` —
  // Fastify's shutdown sequence drains in-flight connections *before* running `onClose` hooks, and
  // an SSE stream never ends on its own, so ending it only in `onClose` would deadlock
  // `app.close()` forever waiting for a drain step that can never complete.
  app.addHook('preClose', async () => {
    await broadcaster.closeAll();
  });

  app.addHook('onClose', async () => {
    await closeOwnedResources();
    // Closed here, after `preClose` has already ended every stream — never before, and never a
    // connection this instance did not itself open (`deps.broadcaster`/`deps.eventPublisher`
    // overrides keep ownership with whoever injected them, same as `getQueue` above).
    closeBroadcasterConnection();
    closeEventPublisherConnection();
    closeHealthRedisConnection();
  });

  // D-17: `healthRoutes`/`authRoutes`/`setupRoutes` stay siblings of `apiScope`, never inside it —
  // that sibling relationship is what keeps `/health`, `/api/auth/*`, `/api/setup` and
  // `/api/recovery` unguarded with no allowlist/denylist branch anywhere.
  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(setupRoutes);
  app.register(apiScope, {
    broadcaster,
    ...(deps.sseHeartbeatMs !== undefined ? { sseHeartbeatMs: deps.sseHeartbeatMs } : {}),
  });

  return app;
}
