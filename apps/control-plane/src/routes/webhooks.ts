// 18-02 (HOOK-02): `POST /webhooks/github/:hookId`. Registered in app.ts as a sibling of
// `apiScope`, so neither the session guard nor the origin guard applies: GitHub carries no session
// and the HMAC signature is the authentication (A1).
//
// This encapsulated scope replaces every body parser with one `application/json` parser that keeps
// the raw bytes (the signature covers them exactly as sent), capped at 1 MiB: anything bigger is a
// 413 and any other content type a 415 (Fastify's own errors, mapped by the global handler). The
// rate limit runs in `onRequest`, before the body is read.
//
// Error bodies are fixed strings with no ids (A5). Every signature failure, an unknown hook id and
// a disabled webhook share one 401 body (A2). Nothing here logs the body or the signature header.
import type { FastifyPluginCallback } from 'fastify';
import { toErrorBody } from './http-errors.js';
import {
  WEBHOOK_BODY_LIMIT_BYTES,
  type WebhookIngest,
  type WebhookIngestResult,
  type WebhookRateLimiter,
} from '../services/webhook-ingest.js';

export interface WebhookRoutesOptions {
  /** Resolved per request, so registering the route opens no database pool. */
  readonly getIngest: () => Promise<WebhookIngest>;
  readonly rateLimiter: WebhookRateLimiter;
}

export const WEBHOOK_UNAUTHORIZED_BODY = Object.freeze(toErrorBody('UNAUTHORIZED', 'Webhook signature verification failed'));
export const WEBHOOK_RATE_LIMITED_BODY = Object.freeze(toErrorBody('RATE_LIMITED', 'Too many webhook deliveries; slow down'));
const QUEUE_UNAVAILABLE_BODY = Object.freeze(
  toErrorBody('QUEUE_UNAVAILABLE', 'The deployment could not be queued; redeliver the webhook or deploy manually'),
);
const REJECTED_MESSAGE = 'The delivery was recorded but cannot be deployed';
const RATE_LIMIT_RETRY_AFTER_SECONDS = '60';

/** A repeated header is ambiguous, so it counts as missing. */
function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function responseBody(result: Extract<WebhookIngestResult, { kind: 'recorded' }>): Record<string, unknown> {
  if (result.status === 422) {
    return { ...toErrorBody('WEBHOOK_DELIVERY_REJECTED', REJECTED_MESSAGE), outcome: result.outcome };
  }
  return {
    outcome: result.outcome,
    ...(result.deploymentId !== null ? { deploymentId: result.deploymentId } : {}),
    ...(result.duplicate ? { duplicate: true } : {}),
  };
}

export function createWebhookRoutes(options: WebhookRoutesOptions): FastifyPluginCallback {
  const webhookRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
    fastify.removeAllContentTypeParsers();
    fastify.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT_BYTES }, (_request, body, parsed) => {
      parsed(null, body);
    });

    fastify.post<{ Params: { hookId: string } }>(
      '/webhooks/github/:hookId',
      {
        bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
        onRequest: (request, reply, next) => {
          if (options.rateLimiter.allow(request.params.hookId, request.ip)) {
            next();
            return;
          }
          void reply.code(429).header('retry-after', RATE_LIMIT_RETRY_AFTER_SECONDS).send(WEBHOOK_RATE_LIMITED_BODY);
        },
      },
      async (request, reply) => {
        const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        const ingest = await options.getIngest();
        const result = await ingest.ingest({
          hookId: request.params.hookId,
          signature: singleHeader(request.headers['x-hub-signature-256']),
          deliveryId: singleHeader(request.headers['x-github-delivery']),
          event: singleHeader(request.headers['x-github-event']),
          rawBody,
        });
        void reply.header('cache-control', 'no-store');
        switch (result.kind) {
          case 'unauthorized':
            return reply.code(401).send(WEBHOOK_UNAUTHORIZED_BODY);
          case 'bad_request':
            return reply.code(400).send(toErrorBody('VALIDATION_FAILED', result.message));
          case 'queue_unavailable':
            return reply.code(503).send(QUEUE_UNAVAILABLE_BODY);
          case 'recorded':
            return reply.code(result.status).send(responseBody(result));
        }
      },
    );
    done();
  };
  return webhookRoutes;
}
