// 27-04: the unified logs of a service, inside the guarded scope (api-scope.ts). Read only.
// - GET /api/projects/:projectId/services/:serviceId/logs/entries          one page, newest first
// - GET /api/projects/:projectId/services/:serviceId/logs/entries/follow   NDJSON stream of new entries
// Sources: build and deploy (stored chunks), runtime (bounded docker.logs_window over SSH, on
// demand) and activity. Every entry is redacted with the service's secret values before any filter
// or search sees it. A malformed query or cursor is a 422 LOG_QUERY_INVALID; a runtime read that
// fails marks only `runtime` unavailable; when every requested source is unavailable the answer is
// a 502 LOG_SOURCE_UNAVAILABLE. The older runtime-only routes (`.../logs`, `.../logs/follow`) stay
// in services.ts.
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import {
  LOG_WINDOW_MAX_MS,
  parseLogFilter,
  type LogFilter,
} from '@noodara/domain';
import { LOG_PAGE_MAX_ENTRIES, V05_ERROR_MESSAGES } from '@noodara/domain/api-contract';
import { createSsh2Adapter } from '@noodara/ssh';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import { getDb as defaultGetDb, type Database } from '../db/client.js';
import { createDeployConnect, loadDeployServerFromDb } from '../deploy/deploy-connect.js';
import { env } from '../env.js';
import { decodeLogCursor, deriveLogCursorKey, encodeLogCursor } from '../observability/logs/log-cursor.js';
import {
  createFollowRegistry,
  DEFAULT_FOLLOW_LIMITS,
  runFollow,
  type FollowFrame,
  type FollowLimits,
} from '../observability/logs/log-follow.js';
import { queryServiceLogs, tryServiceRedactor } from '../observability/logs/log-query.js';
import { findLogService, openRuntimeSession, type LogConnect } from '../observability/logs/log-sources.js';
import type { MasterKeys } from '../services/server-service-deps.js';
import { masterKeysFromEnvironment } from '../services/service-credentials.js';
import { exceedsBackpressureBudget } from './events.js';
import { ErrorBodySchema, toErrorBody } from './http-errors.js';
import {
  LOG_FOLLOW_LIMIT_MESSAGE,
  LOG_QUERY_INVALID,
  LOG_SOURCE_UNAVAILABLE,
  LogsFollowQuerySchema,
  LogsParamsSchema,
  LogsQuerySchema,
  LogsResponseSchema,
  RUNTIME_LOG_FOLLOW_LIMIT_REACHED,
  type LogsQuery,
} from './logs-schemas.js';

export interface LogsRouteLimits {
  /** Bound of the whole runtime read of one page (connect + fetch). */
  readonly runtimeTimeoutMs: number;
  /** Cap on the summed UTF-8 length of a page's texts. */
  readonly pageMaxBytes: number;
  readonly defaultLimit: number;
  readonly follow: FollowLimits;
}

export const DEFAULT_LOGS_ROUTE_LIMITS: LogsRouteLimits = Object.freeze({
  runtimeTimeoutMs: 30_000,
  pageMaxBytes: 2 * 1024 * 1024,
  defaultLimit: 200,
  follow: DEFAULT_FOLLOW_LIMITS,
});

export interface LogsRoutesDeps {
  readonly connect: LogConnect;
  readonly masterKeys: () => Promise<MasterKeys>;
  /** HMAC key of the pagination cursor (deriveLogCursorKey). */
  readonly cursorKey: Buffer;
  readonly getDb?: () => Promise<Database>;
  readonly limits?: Partial<Omit<LogsRouteLimits, 'follow'>> & { readonly follow?: Partial<FollowLimits> };
}

const ERRORS = {
  401: ErrorBodySchema,
  404: ErrorBodySchema,
  422: ErrorBodySchema,
  429: ErrorBodySchema,
  502: ErrorBodySchema,
};

const LIMIT_PATTERN = /^[1-9][0-9]{0,3}$/;

interface ParsedQuery {
  readonly filter: LogFilter;
  readonly windowClamped: boolean;
  readonly sinceGiven: boolean;
}

/** One value per key except `sources`; a repeated scalar is invalid. */
function scalar(value: string | string[] | undefined): string | undefined | null {
  if (Array.isArray(value)) return null;
  return value;
}

/** A window wider than 24 h is clamped to its newest 24 h and flagged, never refused. */
function parseQuery(query: Pick<LogsQuery, 'sources' | 'since' | 'until' | 'level' | 'search'>, nowMs: number): ParsedQuery | null {
  const fields = {
    since: scalar(query.since),
    until: scalar(query.until),
    level: scalar(query.level),
    search: scalar(query.search),
  };
  if (Object.values(fields).some((value) => value === null)) return null;
  const input: Record<string, unknown> = { sources: query.sources };
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) input[key] = value;
  const first = parseLogFilter(input, nowMs);
  if (first.ok) return { filter: first.value, windowClamped: false, sinceGiven: fields.since !== undefined };
  if (first.code !== 'LOG_RANGE_TOO_WIDE') return null;
  const withoutSince = parseLogFilter({ ...input, since: undefined }, nowMs);
  if (!withoutSince.ok) return null;
  const clamped = parseLogFilter(
    { ...input, since: new Date(withoutSince.value.untilMs - LOG_WINDOW_MAX_MS).toISOString() },
    nowMs,
  );
  return clamped.ok ? { filter: clamped.value, windowClamped: true, sinceGiven: true } : null;
}

async function sendInvalid(reply: FastifyReply): Promise<void> {
  await reply.code(422).send(toErrorBody(LOG_QUERY_INVALID, V05_ERROR_MESSAGES.LOG_QUERY_INVALID));
}

async function sendUnavailable(reply: FastifyReply): Promise<void> {
  await reply.code(502).send(toErrorBody(LOG_SOURCE_UNAVAILABLE, V05_ERROR_MESSAGES.LOG_SOURCE_UNAVAILABLE));
}

async function sendNotFound(reply: FastifyReply, serviceId: string): Promise<void> {
  await reply.code(404).send(toErrorBody('NOT_FOUND', `Service "${serviceId}" not found`));
}

export function createLogsRoutes(deps: LogsRoutesDeps): FastifyPluginCallback {
  const limits: LogsRouteLimits = {
    ...DEFAULT_LOGS_ROUTE_LIMITS,
    ...deps.limits,
    follow: { ...DEFAULT_FOLLOW_LIMITS, ...deps.limits?.follow },
  };
  const getDb = deps.getDb ?? defaultGetDb;
  const follows = createFollowRegistry(limits.follow);

  return (fastify, _opts, done) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();
    const url = '/api/projects/:projectId/services/:serviceId/logs/entries';

    fastify.addHook('preClose', async () => {
      await follows.closeAll();
    });

    app.route({
      method: 'GET',
      url,
      schema: {
        params: LogsParamsSchema,
        querystring: LogsQuerySchema,
        response: { 200: LogsResponseSchema, ...ERRORS },
      },
      handler: async (request, reply) => {
        const { projectId, serviceId } = request.params;
        const parsed = parseQuery(request.query, Date.now());
        const rawCursor = scalar(request.query.cursor);
        const rawLimit = scalar(request.query.limit);
        if (parsed === null || rawCursor === null || rawLimit === null) {
          await sendInvalid(reply);
          return;
        }
        if (rawLimit !== undefined && (!LIMIT_PATTERN.test(rawLimit) || Number(rawLimit) > LOG_PAGE_MAX_ENTRIES)) {
          await sendInvalid(reply);
          return;
        }
        // H1: a cursor is valid only for the service it was issued for.
        const cursor = rawCursor === undefined ? null : decodeLogCursor(rawCursor, serviceId, deps.cursorKey);
        if (rawCursor !== undefined && cursor === null) {
          await sendInvalid(reply);
          return;
        }
        const db = await getDb();
        const service = await findLogService(db, projectId, serviceId);
        if (service === null) {
          await sendNotFound(reply, serviceId);
          return;
        }
        const result = await queryServiceLogs(
          {
            db,
            connect: deps.connect,
            masterKeys: deps.masterKeys,
            runtimeTimeoutMs: limits.runtimeTimeoutMs,
            pageMaxBytes: limits.pageMaxBytes,
          },
          service,
          {
            filter: parsed.filter,
            cursor,
            limit: rawLimit === undefined ? limits.defaultLimit : Number(rawLimit),
            windowClamped: parsed.windowClamped,
          },
        );
        if (!result.ok) {
          await sendUnavailable(reply);
          return;
        }
        const { page } = result;
        await reply.send({
          entries: page.entries,
          since: new Date(parsed.filter.sinceMs).toISOString(),
          until: new Date(parsed.filter.untilMs).toISOString(),
          nextUntil: page.next?.timestamp ?? null,
          unavailableSources: [...result.unavailable],
          nextCursor: page.next === null ? null : encodeLogCursor(page.next, serviceId, deps.cursorKey),
          truncated: page.truncated,
        });
      },
    });

    app.route({
      method: 'GET',
      url: `${url}/follow`,
      schema: {
        params: LogsParamsSchema,
        querystring: LogsFollowQuerySchema,
        response: ERRORS,
      },
      handler: async (request, reply) => {
        const { projectId, serviceId } = request.params;
        const nowMs = Date.now();
        const parsed = parseQuery(request.query, nowMs);
        if (parsed === null) {
          await sendInvalid(reply);
          return;
        }
        const db = await getDb();
        const service = await findLogService(db, projectId, serviceId);
        if (service === null) {
          await sendNotFound(reply, serviceId);
          return;
        }
        const actor = request.actor;
        const userId = actor?.type === 'user' ? actor.id : 'system';
        const slot = follows.acquire(userId, serviceId);
        if (slot === null) {
          await reply.code(429).send(toErrorBody(RUNTIME_LOG_FOLLOW_LIMIT_REACHED, LOG_FOLLOW_LIMIT_MESSAGE));
          return;
        }

        // Registered before anything slow, so a client gone mid-open still aborts.
        const clientGone = new AbortController();
        const abort = (): void => {
          clientGone.abort();
        };
        reply.raw.on('close', abort);
        if (request.raw.destroyed || request.raw.socket.destroyed) abort();

        const opened = await tryServiceRedactor({ db, masterKeys: deps.masterKeys }, service);
        if (opened === null) {
          reply.raw.off('close', abort);
          slot.release();
          await sendUnavailable(reply);
          return;
        }
        const { filter } = parsed;
        try {
          const wantsRuntime = filter.sources.includes('runtime');
          const runtime = wantsRuntime
            ? await openRuntimeSession(deps.connect, service.serverId, opened.redactor, limits.follow.runtimeTimeoutMs, clientGone.signal)
            : null;
          if (clientGone.signal.aborted) {
            await runtime?.close();
            return;
          }
          if (wantsRuntime && runtime === null && filter.sources.length === 1) {
            await sendUnavailable(reply);
            return;
          }

          reply.hijack();
          const raw = reply.raw;
          // A peer that stops reading must not grow our buffer: drop it like a disconnect.
          const evict = (): void => {
            abort();
            if (!raw.destroyed) raw.destroy();
          };
          raw.on('error', evict);
          const write = (frame: FollowFrame): void => {
            if (raw.writableEnded || raw.destroyed) return;
            if (exceedsBackpressureBudget(raw.writableLength)) {
              evict();
              return;
            }
            try {
              raw.write(`${JSON.stringify(frame)}\n`);
            } catch {
              evict();
            }
          };
          raw.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
          });
          // Send the headers now: a quiet stream must not leave the client waiting for its first frame.
          raw.flushHeaders();
          if (wantsRuntime && runtime === null) {
            write({ type: 'unavailable', source: 'runtime', error: LOG_SOURCE_UNAVAILABLE });
          }
          const reason = await runFollow({
            db,
            service,
            filter,
            startMs: parsed.sinceGiven ? filter.sinceMs : nowMs,
            redactor: opened.redactor,
            runtime,
            limits: limits.follow,
            signal: clientGone.signal,
            shutdown: slot.shutdown,
            emit: write,
          });
          write({ type: 'end', reason });
          if (!raw.writableEnded && !raw.destroyed) raw.end();
        } finally {
          reply.raw.off('close', abort);
          opened.release();
          slot.release();
        }
      },
    });

    done();
  };
}

/** The production wiring: the same lazy SSH connect app.ts builds for runtime container logs. */
const logsRoutes: FastifyPluginCallback = (fastify, opts, done) => {
  let cached: Promise<LogConnect> | undefined;
  const resolveConnect = (): Promise<LogConnect> =>
    (cached ??= defaultGetDb()
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
  createLogsRoutes({
    // A rejection here is an unreachable server: openRuntimeSession maps it to unavailable.
    connect: async (serverId, redactor, signal) => (await resolveConnect())(serverId, redactor, signal),
    masterKeys: masterKeysFromEnvironment(),
    cursorKey: deriveLogCursorKey(env.BETTER_AUTH_SECRET),
  })(fastify, opts, done);
};

export default logsRoutes;
