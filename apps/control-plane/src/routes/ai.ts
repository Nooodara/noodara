// 28-05: AI conversations, registered inside the guarded scope (api-scope.ts).
//   POST   /api/ai/conversations               -> creates one (server-minted UUID v7 id)
//   GET    /api/ai/conversations               -> the caller's conversations, newest first
//   GET    /api/ai/conversations/:id           -> the conversation with its messages and tool calls
//   DELETE /api/ai/conversations/:id           -> aborts a running ask, deletes messages and tool calls
//   POST   /api/ai/conversations/:id/messages  -> asks; answers with an SSE stream
// Another user's conversation is a 404. Stream events: start, text, tool_call (name and scope only),
// answer, error, done; a `: ping` comment every heartbeat interval keeps proxies from closing it.
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { ReadToolBackend } from '@noodara/ai';
import { createSsh2Adapter } from '@noodara/ssh';
import { AI_QUESTION_MAX_LENGTH } from '@noodara/domain/api-contract';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import { z } from 'zod';
import { appRedactor } from '../activity/redaction.js';
import { createAiAskRuntime, type AiAskRuntime } from '../ai/conversations/ask-runtime.js';
import {
  askQuestion,
  DEFAULT_AI_ASK_LIMITS,
  defaultCreateProvider,
  type AiAskLimits,
  type AskServiceDeps,
  type AskSink,
} from '../ai/conversations/ask-service.js';
import {
  createConversation,
  deleteConversation,
  findOwnedConversation,
  getConversationDetail,
  listConversations,
} from '../ai/conversations/conversation-store.js';
import { createReadToolBackend } from '../ai/tools/read-tool-backend.js';
import { createDeployConnect, loadDeployServerFromDb } from '../deploy/deploy-connect.js';
import { getDb as defaultGetDb, type Database } from '../db/client.js';
import { env } from '../env.js';
import type { LogConnect } from '../observability/logs/log-sources.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import { masterKeysFromEnvironment } from '../services/service-credentials.js';
import {
  AI_ASK_BODY_LIMIT_BYTES,
  AI_CONVERSATION_BODY_LIMIT_BYTES,
  AI_CONVERSATION_ERRORS,
  AiConversationDetailSchema,
  AiConversationViewSchema,
  AskRouteBodySchema,
  ConversationParamsSchema,
  CreateAiConversationBodySchema,
  ListAiConversationsResponseSchema,
  type AiConversationErrorCode,
} from './ai-schemas.js';
import { ErrorBodySchema, mapServiceCodeToStatus, toErrorBody, toV05ErrorBody, ValidationErrorBodySchema } from './http-errors.js';

export const DEFAULT_AI_HEARTBEAT_MS = 15_000;

export interface AiRoutesOptions {
  /** Owned by app.ts, whose preClose aborts every open ask. */
  readonly runtime?: AiAskRuntime;
  /** Test seam: replaces the provider built from the stored settings. */
  readonly createProvider?: AskServiceDeps['createProvider'];
  /** Test seam: replaces the production read-tool backend. */
  readonly backend?: ReadToolBackend;
  readonly limits?: Partial<AiAskLimits>;
  readonly heartbeatMs?: number;
}

function requireUser(actor: ServiceActor | null): string {
  if (actor?.type !== 'user') throw new Error('ai route reached with no user actor — requireSession guard is not registered');
  return actor.id;
}

function sendNamed(reply: FastifyReply, code: AiConversationErrorCode): FastifyReply {
  const named = AI_CONVERSATION_ERRORS[code];
  return reply.code(named.status).send(toErrorBody(code, named.message));
}

function productionConnect(): LogConnect {
  let cached: Promise<LogConnect> | undefined;
  const resolve = (): Promise<LogConnect> =>
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
  return async (serverId, redactor, signal) => (await resolve())(serverId, redactor, signal);
}

function productionBackend(db: Database): ReadToolBackend {
  return createReadToolBackend({
    db,
    connect: productionConnect(),
    masterKeys: masterKeysFromEnvironment(),
    metricsIntervalMs: env.NOODARA_METRICS_INTERVAL_MS,
    metricsRetentionMs: env.NOODARA_METRICS_RETENTION_HOURS * 3_600_000,
  });
}

const ERRORS = {
  400: z.union([ValidationErrorBodySchema, ErrorBodySchema]),
  401: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ErrorBodySchema,
  413: ErrorBodySchema,
  422: ErrorBodySchema,
  429: ErrorBodySchema,
  503: ErrorBodySchema,
};

/** Opens the SSE response on a hijacked reply; writes after the client left are dropped. */
function openStream(reply: FastifyReply, heartbeatMs: number): AskSink & { end(): void } {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const write = (chunk: string): void => {
    if (raw.writableEnded || raw.destroyed) return;
    try {
      raw.write(chunk);
    } catch {
      raw.destroy();
    }
  };
  const heartbeat = setInterval(() => {
    write(': ping\n\n');
  }, heartbeatMs);
  heartbeat.unref();
  raw.once('close', () => {
    clearInterval(heartbeat);
  });
  return {
    send: (event) => {
      write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    },
    end: () => {
      clearInterval(heartbeat);
      if (!raw.writableEnded && !raw.destroyed) raw.end();
    },
  };
}

export function createAiRoutes(opts: AiRoutesOptions = {}): FastifyPluginCallback {
  return (fastify, _opts, done) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();
    const runtime = opts.runtime ?? createAiAskRuntime();
    const limits: AiAskLimits = { ...DEFAULT_AI_ASK_LIMITS, ...opts.limits };
    const heartbeatMs = opts.heartbeatMs ?? DEFAULT_AI_HEARTBEAT_MS;
    let backend: ReadToolBackend | undefined = opts.backend;
    const masterKeys = masterKeysFromEnvironment();

    async function askDeps(): Promise<AskServiceDeps> {
      const db = await defaultGetDb();
      backend ??= productionBackend(db);
      return {
        db,
        redactor: appRedactor,
        masterKeys: await masterKeys(),
        runtime,
        backend,
        createProvider: opts.createProvider ?? defaultCreateProvider,
        limits,
        now: () => new Date(),
        log: fastify.log,
      };
    }

    app.route({
      method: 'POST',
      url: '/api/ai/conversations',
      bodyLimit: AI_CONVERSATION_BODY_LIMIT_BYTES,
      schema: { body: CreateAiConversationBodySchema, response: { 201: AiConversationViewSchema, ...ERRORS } },
      handler: async (request, reply) => {
        const userId = requireUser(request.actor);
        const view = await createConversation(await defaultGetDb(), appRedactor, {
          userId,
          title: request.body?.title,
          now: new Date(),
        });
        await reply.code(201).send(view);
      },
    });

    app.route({
      method: 'GET',
      url: '/api/ai/conversations',
      schema: { response: { 200: ListAiConversationsResponseSchema, ...ERRORS } },
      handler: async (request, reply) => {
        const userId = requireUser(request.actor);
        await reply.send({ items: await listConversations(await defaultGetDb(), userId) });
      },
    });

    app.route({
      method: 'GET',
      url: '/api/ai/conversations/:id',
      schema: { params: ConversationParamsSchema, response: { 200: AiConversationDetailSchema, ...ERRORS } },
      handler: async (request, reply) => {
        const userId = requireUser(request.actor);
        const detail = await getConversationDetail(await defaultGetDb(), userId, request.params.id);
        if (detail === null) return sendNamed(reply, 'AI_CONVERSATION_NOT_FOUND');
        await reply.send(detail);
      },
    });

    app.route({
      method: 'DELETE',
      url: '/api/ai/conversations/:id',
      schema: { params: ConversationParamsSchema, response: { 204: z.null(), ...ERRORS } },
      handler: async (request, reply) => {
        const userId = requireUser(request.actor);
        const db = await defaultGetDb();
        const owned = await findOwnedConversation(db, userId, request.params.id);
        if (owned === null) return sendNamed(reply, 'AI_CONVERSATION_NOT_FOUND');
        // A running ask is aborted (and its provider call with it) before the rows go.
        await runtime.abortConversation(owned.id, 'deleted');
        if (!(await deleteConversation(db, userId, owned.id))) return sendNamed(reply, 'AI_CONVERSATION_NOT_FOUND');
        await reply.code(204).send(null);
      },
    });

    app.route({
      method: 'POST',
      url: '/api/ai/conversations/:id/messages',
      bodyLimit: AI_ASK_BODY_LIMIT_BYTES,
      schema: { params: ConversationParamsSchema, body: AskRouteBodySchema, response: ERRORS },
      handler: async (request, reply) => {
        const userId = requireUser(request.actor);
        const question = request.body.question.trim();
        if (question === '') return sendNamed(reply, 'AI_QUESTION_EMPTY');
        if (question.length > AI_QUESTION_MAX_LENGTH) return sendNamed(reply, 'AI_QUESTION_TOO_LONG');

        // ServerResponse 'close' fires when the client goes away (or once the response ended).
        const clientGone = new AbortController();
        const onClose = (): void => {
          if (!reply.raw.writableFinished) clientGone.abort();
        };
        reply.raw.on('close', onClose);

        // A holder, not a `let`: the stream is opened inside a callback, so flow narrowing must not pin it to null.
        const sse: { stream: (AskSink & { end(): void }) | null } = { stream: null };
        let result: Awaited<ReturnType<typeof askQuestion>>;
        try {
          result = await askQuestion(await askDeps(), {
            userId,
            conversationId: request.params.id,
            question,
            clientGone: clientGone.signal,
            open: () => (sse.stream = openStream(reply, heartbeatMs)),
          });
        } finally {
          sse.stream?.end();
          reply.raw.off('close', onClose);
        }
        if (result.streamed || sse.stream !== null) return;
        switch (result.code) {
          case 'RATE_LIMITED':
            void reply.header('Retry-After', Math.max(1, Math.ceil(result.retryAfterMs / 1000)).toString());
            return sendNamed(reply, 'RATE_LIMITED');
          case 'AI_CONVERSATION_NOT_FOUND':
          case 'AI_CONVERSATION_BUSY':
            return sendNamed(reply, result.code);
          default:
            return reply.code(mapServiceCodeToStatus(result.code) as 409 | 503).send(toV05ErrorBody(result.code));
        }
      },
    });

    done();
  };
}

const aiRoutes: FastifyPluginCallback<AiRoutesOptions> = (fastify, opts, done) => {
  createAiRoutes(opts)(fastify, opts, done);
};

export default aiRoutes;
