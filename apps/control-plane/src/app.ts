import type { FastifyBaseLogger, FastifyError, FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  serializerCompiler,
  validatorCompiler,
} from '@fastify/type-provider-zod';
import Fastify from 'fastify';
import { createRedactor } from '@noodara/domain/security';
import { createSsh2Adapter } from '@noodara/ssh';
import type { Redis } from 'ioredis';
import { appRedactor } from './activity/redaction.js';
import { createDnsChecker, type DnsChecker } from './auth/dns-checker.js';
import { decodeMasterKey, logMasterKeyWarning } from './boot/master-key.js';
import { getDb } from './db/client.js';
import { createCancelDeployment, type CancelDeployment } from './deploy/cancel-deployment.js';
import { cancelFlagRedisFrom, createDeployCancelFlags } from './deploy/cancel-flag.js';
import { createDeployConnect, loadDeployServerFromDb } from './deploy/deploy-connect.js';
import { createDeploymentStore } from './deploy/deployment-store.js';
import {
  createServiceRemoteCleanup,
  DEFAULT_SERVICE_OPS_LIMITS,
  SERVICE_OPS_MESSAGES,
  type ServiceRemoteCleanup,
} from './deploy/service-ops.js';
import { createServiceOperationQueue, type ServiceOperationQueue } from './deploy/service-ops-job.js';
import { env } from './env.js';
import { createRedisServerEventPublisher } from './events/redis-server-event-publisher.js';
import type { ServerEventPublisher } from './events/server-event-publisher.js';
import { createSseBroadcaster, type SseBroadcaster } from './events/sse-broadcaster.js';
import { createLogger } from './logger.js';
import { createConnectServerQueue, type ConnectServerQueue } from './queue/connect-server-queue.js';
import { computeDeployCancelKeyTtlMs } from './queue/deploy-job-budget.js';
import { createDeployQueue, type DeployQueue } from './queue/deploy-queue.js';
import {
  createHealthRedisConnection,
  createPublisherRedisConnection,
  createQueueRedisConnection,
  createSubscriberRedisConnection,
} from './redis/connections.js';
import apiScope from './routes/api-scope.js';
import authRoutes from './routes/auth.js';
import healthRoutes from './routes/health.js';
import { toClientRequestError, toErrorBody, toValidationErrorBody } from './routes/http-errors.js';
import setupRoutes from './routes/setup.js';
import {
  createContainerLogs,
  DEFAULT_CONTAINER_LOGS_LIMITS,
  type ContainerLogs,
  type ContainerLogsDeps,
} from './services/container-logs.js';
import { resolveServerServicesDeps, type ServiceLogger } from './services/server-service-deps.js';
import { createProjectServices, type ProjectServices } from './services/project-services.js';
import { createServerServices, type ServerServices } from './services/server-services.js';
import { createDeploymentServices, type DeploymentServices } from './services/deployment-services.js';
import { masterKeysFromEnvironment } from './services/service-credentials.js';
import { createServiceServices, panelPortsFromEnv, type ServiceServices } from './services/service-services.js';

export interface BuildAppDeps {
  logger?: FastifyInstance['log'];
  serverServices?: ServerServices;
  /** 12-07: `/api/projects` services; built lazily from `getDb()` when not injected. */
  projectServices?: ProjectServices;
  /** 12-08: `/api/projects/:projectId/services` services; built lazily from `getDb()`. */
  serviceServices?: ServiceServices;
  /** 12-10: deploy/read deployments; built lazily from `getDb()` and the deploy queue. */
  deploymentServices?: DeploymentServices;
  queue?: ConnectServerQueue;
  /** 12-10: the `deployments` queue producer; a caller-injected queue is never closed here. */
  deployQueue?: DeployQueue;
  /** 12-14: the stop/restart/remove producer; built on the deploy queue's Redis connection. */
  serviceOperationQueue?: ServiceOperationQueue;
  /** 12-14: remote cleanup on service/project delete; defaults to SSH via the deploy connect. */
  serviceRemoteCleanup?: ServiceRemoteCleanup;
  /** 12-16: runtime container logs (tail and follow); defaults to SSH via the deploy connect. */
  containerLogs?: ContainerLogs;
  /** 12-13: `POST /api/deployments/:id/cancel`; built lazily from `getDb()`, the deploy queue and
   *  its Redis connection when not injected. */
  cancelDeployment?: CancelDeployment;
  broadcaster?: SseBroadcaster;
  eventPublisher?: ServerEventPublisher;
  healthRedis?: Redis;
  sseHeartbeatMs?: number;
  /** 09-06: `PATCH /api/account/profile`'s email-domain checker — defaults to a real
   *  `createDnsChecker()` (a bounded, real `node:dns/promises` lookup); a test substitutes a
   *  hand-built fake (ADR 0004). */
  dnsChecker?: DnsChecker;
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

/** Same lazy, per-instance memoised shape as `createServerServicesResolver`, for `/api/projects`.
 *  A failed first resolution is not cached, so a later request retries the database. */
function createProjectServicesResolver(
  deps: BuildAppDeps,
  eventPublisher: ServerEventPublisher,
  remoteCleanup: ServiceRemoteCleanup,
): () => Promise<ProjectServices> {
  let cached: Promise<ProjectServices> | undefined;
  return () => {
    if (deps.projectServices !== undefined) {
      return Promise.resolve(deps.projectServices);
    }
    cached ??= getDb()
      .then((db) => createProjectServices({ db, now: () => new Date(), events: eventPublisher, remoteCleanup }))
      .catch((error: unknown) => {
        cached = undefined;
        throw error;
      });
    return cached;
  };
}

/** 12-08: same lazy shape for services; they publish `service.updated` through the app's
 *  publisher and refuse the panel's own ports (API and public URL) as published ports. */
function createServiceServicesResolver(
  deps: BuildAppDeps,
  eventPublisher: ServerEventPublisher,
  operations: { getOperationQueue: () => ServiceOperationQueue; remoteCleanup: ServiceRemoteCleanup },
): () => Promise<ServiceServices> {
  let cached: Promise<ServiceServices> | undefined;
  return () => {
    if (deps.serviceServices !== undefined) {
      return Promise.resolve(deps.serviceServices);
    }
    cached ??= getDb()
      .then((db) =>
        createServiceServices({
          db,
          now: () => new Date(),
          events: eventPublisher,
          panelPorts: panelPortsFromEnv({ apiPort: env.PORT, publicUrl: env.NOODARA_PUBLIC_URL }),
          operationQueue: { enqueue: (payload) => operations.getOperationQueue().enqueue(payload), close: () => Promise.resolve() },
          remoteCleanup: operations.remoteCleanup,
        }),
      )
      .catch((error: unknown) => {
        cached = undefined;
        throw error;
      });
    return cached;
  };
}

/** 12-14: the default remote cleanup, SSH through the deploy connect. Everything is resolved on
 *  first use, so building the app opens nothing. Never rejects (a setup failure is unreachable). */
function createRemoteCleanupResolver(deps: BuildAppDeps): ServiceRemoteCleanup {
  if (deps.serviceRemoteCleanup !== undefined) return deps.serviceRemoteCleanup;
  let cached: Promise<ServiceRemoteCleanup> | undefined;
  const resolve = (): Promise<ServiceRemoteCleanup> =>
    (cached ??= getDb()
      .then((db) =>
        createServiceRemoteCleanup({
          connect: createDeployConnect({
            loadServer: loadDeployServerFromDb(db),
            ssh: createSsh2Adapter(),
            timeouts: {
              connectMs: env.NOODARA_SSH_CONNECT_TIMEOUT_MS,
              commandMs: env.NOODARA_SSH_COMMAND_TIMEOUT_MS,
              discoveryMs: env.NOODARA_SSH_DISCOVERY_TIMEOUT_MS,
            },
            masterKeys: masterKeysFromEnvironment(),
          }),
          createRedactor,
          limits: DEFAULT_SERVICE_OPS_LIMITS,
        }),
      )
      .catch((error: unknown) => {
        cached = undefined;
        throw error;
      }));
  return async (request) => {
    try {
      return await (await resolve())(request);
    } catch {
      return { ok: false, code: 'SERVER_UNREACHABLE', message: SERVICE_OPS_MESSAGES.SERVER_UNREACHABLE };
    }
  };
}

/** 12-16: the default runtime-log reader. The deploy connect is resolved on first use, so
 *  building the app opens nothing; a setup failure reads as an unreachable server. */
function createContainerLogsResolver(deps: BuildAppDeps, logger: FastifyBaseLogger): ContainerLogs {
  if (deps.containerLogs !== undefined) return deps.containerLogs;
  let cached: Promise<ContainerLogsDeps['connect']> | undefined;
  const resolveConnect = (): Promise<ContainerLogsDeps['connect']> =>
    (cached ??= getDb()
      .then((db) =>
        createDeployConnect({
          loadServer: loadDeployServerFromDb(db),
          ssh: createSsh2Adapter(),
          timeouts: {
            connectMs: env.NOODARA_SSH_CONNECT_TIMEOUT_MS,
            commandMs: env.NOODARA_SSH_COMMAND_TIMEOUT_MS,
            discoveryMs: env.NOODARA_SSH_DISCOVERY_TIMEOUT_MS,
          },
          masterKeys: masterKeysFromEnvironment(),
        }),
      )
      .catch((error: unknown) => {
        cached = undefined;
        throw error;
      }));
  return createContainerLogs({
    // A rejection here is mapped to SERVER_UNREACHABLE by createContainerLogs.
    connect: async (serverId, redactor, signal) => (await resolveConnect())(serverId, redactor, signal),
    createRedactor,
    limits: {
      ...DEFAULT_CONTAINER_LOGS_LIMITS,
      defaultTail: env.NOODARA_RUNTIME_LOG_TAIL,
      followMaxMs: env.NOODARA_RUNTIME_LOG_FOLLOW_MAX_MS,
    },
    logger,
  });
}

/** 12-10: the deploy queue producer, owned and closed by this instance unless injected.
 *  12-13: its Redis connection also carries the cancel flags, so cancel opens nothing new. */
function createDeployQueueResolver(deps: BuildAppDeps): {
  getDeployQueue: () => DeployQueue;
  getDeployRedis: () => Redis;
  /** 12-14: the service-operation producer, on the same `deployments` queue and connection. */
  getOperationQueue: () => ServiceOperationQueue;
  closeOwnedDeployQueue: () => Promise<void>;
} {
  let connection: Redis | undefined;
  let ownedQueue: DeployQueue | undefined;
  let ownedOperationQueue: ServiceOperationQueue | undefined;
  const getDeployRedis = (): Redis => (connection ??= createQueueRedisConnection(env.REDIS_URL));
  const getDeployQueue = (): DeployQueue => {
    if (deps.deployQueue !== undefined) return deps.deployQueue;
    return (ownedQueue ??= createDeployQueue({ connection: getDeployRedis() }));
  };
  const getOperationQueue = (): ServiceOperationQueue => {
    if (deps.serviceOperationQueue !== undefined) return deps.serviceOperationQueue;
    return (ownedOperationQueue ??= createServiceOperationQueue({ connection: getDeployRedis() }));
  };
  const closeOwnedDeployQueue = async (): Promise<void> => {
    const queue = ownedQueue;
    const operationQueue = ownedOperationQueue;
    const owned = connection;
    ownedQueue = undefined;
    ownedOperationQueue = undefined;
    connection = undefined;
    if (queue !== undefined) await queue.close();
    if (operationQueue !== undefined) await operationQueue.close();
    owned?.disconnect();
  };
  return { getDeployQueue, getDeployRedis, getOperationQueue, closeOwnedDeployQueue };
}

/** 12-13: the cancel service, built on first cancel from the deploy queue resolver's connection. */
function createCancelDeploymentResolver(
  deps: BuildAppDeps,
  eventPublisher: ServerEventPublisher,
  queue: { getDeployQueue: () => DeployQueue; getDeployRedis: () => Redis },
  logger: FastifyBaseLogger,
): () => Promise<CancelDeployment> {
  let cached: Promise<CancelDeployment> | undefined;
  return () => {
    if (deps.cancelDeployment !== undefined) {
      return Promise.resolve(deps.cancelDeployment);
    }
    cached ??= getDb()
      .then((db) =>
        createCancelDeployment({
          store: createDeploymentStore({ db, now: () => new Date(), events: eventPublisher }),
          flags: createDeployCancelFlags({
            redis: cancelFlagRedisFrom(queue.getDeployRedis()),
            ttlMs: computeDeployCancelKeyTtlMs(env.NOODARA_DEPLOY_MAX_MS),
          }),
          queue: { removeJob: (deploymentId) => queue.getDeployQueue().removeJob(deploymentId) },
          logger,
        }),
      )
      .catch((error: unknown) => {
        cached = undefined;
        throw error;
      });
    return cached;
  };
}

/** 12-10: same lazy shape; the queue itself is resolved on the first enqueue, not at boot. */
function createDeploymentServicesResolver(
  deps: BuildAppDeps,
  eventPublisher: ServerEventPublisher,
  getDeployQueue: () => DeployQueue,
  logger: FastifyBaseLogger,
): () => Promise<DeploymentServices> {
  let cached: Promise<DeploymentServices> | undefined;
  return () => {
    if (deps.deploymentServices !== undefined) {
      return Promise.resolve(deps.deploymentServices);
    }
    cached ??= getDb()
      .then((db) =>
        createDeploymentServices({
          db,
          now: () => new Date(),
          events: eventPublisher,
          queue: { enqueue: (payload) => getDeployQueue().enqueue(payload) },
          logger,
        }),
      )
      .catch((error: unknown) => {
        cached = undefined;
        throw error;
      });
    return cached;
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
    // 12-07: a Fastify-owned request error (malformed JSON, oversized body, unsupported content
    // type) is the caller's fault and keeps its 4xx, with a fixed body. Only the code and status
    // are logged: the parser message can quote the submitted body.
    const clientError = toClientRequestError(error);
    if (clientError !== null) {
      request.log.info({ code: error.code, statusCode: clientError.status }, 'request rejected by parser');
      reply.code(clientError.status).send(clientError.body);
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

  // 12-07: `routes/projects.ts` resolves its services per request, the same deferred way.
  const { getDeployQueue, getDeployRedis, getOperationQueue, closeOwnedDeployQueue } = createDeployQueueResolver(deps);
  const remoteCleanup = createRemoteCleanupResolver(deps);
  app.decorate('getProjectServices', createProjectServicesResolver(deps, eventPublisher, remoteCleanup));
  app.decorate('getServiceServices', createServiceServicesResolver(deps, eventPublisher, { getOperationQueue, remoteCleanup }));
  app.decorate('getDeploymentServices', createDeploymentServicesResolver(deps, eventPublisher, getDeployQueue, app.log));
  const containerLogs = createContainerLogsResolver(deps, app.log);
  app.decorate('getContainerLogs', () => containerLogs);
  app.decorate(
    'getCancelDeployment',
    createCancelDeploymentResolver(deps, eventPublisher, { getDeployQueue, getDeployRedis }, app.log),
  );

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
    // 12-16: open log follows end first (remote docker logs killed), so the drain can complete.
    await Promise.all([broadcaster.closeAll(), containerLogs.closeAll()]);
  });

  app.addHook('onClose', async () => {
    await closeOwnedResources();
    await closeOwnedDeployQueue();
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
    dnsChecker: deps.dnsChecker ?? createDnsChecker(),
    ...(deps.sseHeartbeatMs !== undefined ? { sseHeartbeatMs: deps.sseHeartbeatMs } : {}),
  });

  return app;
}
