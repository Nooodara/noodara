// D-02/D-03/D-05/D-07/T-4-36: the subscriber half of the SSE bridge. One dedicated Redis
// connection (`createSubscriberRedisConnection`, `app.ts`) subscribes once and fans every message
// out to every open SSE reply this API process holds — this file owns none of the HTTP layer
// itself, which is what keeps it unit-testable with plain fake streams (RESEARCH.md Pattern 2).
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { SERVER_EVENTS_CHANNEL } from './redis-server-event-publisher.js';

/**
 * The narrow structural surface the broadcaster writes SSE frames to. Deliberately not Fastify's
 * `FastifyReply` or Node's `ServerResponse` — that is what makes this file unit-testable with
 * plain objects, independent of the HTTP layer `routes/events.ts` (Task 3) adapts `reply.raw` to.
 */
export interface SseStream {
  write: (chunk: string) => void;
  end: () => void;
}

export interface SseBroadcaster {
  readonly size: number;
  add(stream: SseStream): void;
  remove(stream: SseStream): void;
  /** Subscribes to `SERVER_EVENTS_CHANNEL` exactly once, regardless of how many streams are
   *  already registered or added afterwards. Safe to call once per broadcaster instance. */
  start(): Promise<void>;
  /** Ends every registered stream, empties the registry and unsubscribes. Idempotent. */
  closeAll(): Promise<void>;
}

export interface CreateSseBroadcasterOptions {
  readonly subscriber: Redis;
  readonly logger: FastifyBaseLogger | Logger;
  readonly maxConnections: number;
}

// D-02: the only two event types this phase ever forwards. A message whose `type` is anything
// else — including a foreign publisher's message on a shared Redis instance — is dropped before
// ever reaching a stream's `write` (T-4-36).
const KNOWN_EVENT_TYPES = new Set(['server.updated', 'server.deleted']);

// D-27/T-4-37: an `UNSUBSCRIBE` issued on a connection that has never actually reached Redis (or
// is stuck retrying against an unreachable one) sits in ioredis's offline command queue forever —
// it never rejects, it just never settles. `closeAll()` is called from `app.ts`'s `preClose` hook,
// which `app.close()` itself waits on; an unbounded `unsubscribe()` here would silently reproduce
// the exact shutdown deadlock `preClose` (over `onClose`) exists to prevent in the first place.
const UNSUBSCRIBE_TIMEOUT_MS = 2000;

interface ParsedMessageEnvelope {
  readonly type: unknown;
}

/**
 * `options.maxConnections` is accepted for interface symmetry with the plan's produced shape and
 * documents the caller's own responsibility: the broadcaster only ever exposes `size` — the route
 * (`routes/events.ts`, Task 3) is the one that compares it against the limit and answers 503
 * before ever calling `add`.
 */
export function createSseBroadcaster(options: CreateSseBroadcasterOptions): SseBroadcaster {
  const streams = new Set<SseStream>();
  let started = false;
  let closed = false;

  function handleMessage(_channel: string, message: string): void {
    let parsed: ParsedMessageEnvelope;
    try {
      parsed = JSON.parse(message) as ParsedMessageEnvelope;
    } catch (err) {
      options.logger.warn({ err }, 'sse broadcaster received a non-JSON message');
      return;
    }

    if (typeof parsed.type !== 'string' || !KNOWN_EVENT_TYPES.has(parsed.type)) {
      // T-4-36: a foreign or malformed `type` never reaches a stream's `write` — this is the
      // control that keeps a shared Redis instance from letting an unrelated writer inject
      // arbitrary SSE frames into an admin's browser.
      return;
    }

    const frame = `event: ${parsed.type}\ndata: ${message}\n\n`;
    for (const stream of streams) {
      try {
        stream.write(frame);
      } catch {
        // One dead socket must never stop the others from receiving the same message.
        streams.delete(stream);
      }
    }
  }

  function add(stream: SseStream): void {
    streams.add(stream);
  }

  function remove(stream: SseStream): void {
    streams.delete(stream);
  }

  async function start(): Promise<void> {
    if (started) return;
    started = true;

    options.subscriber.on('message', handleMessage);
    // D-27: a subscriber connection error must never throw unhandled — ioredis's own
    // `autoResubscribe` (default `true`) re-subscribes on reconnect with no code here needed.
    options.subscriber.on('error', (err: Error) => {
      options.logger.warn({ err }, 'sse broadcaster subscriber redis error');
    });

    await options.subscriber.subscribe(SERVER_EVENTS_CHANNEL);
  }

  async function closeAll(): Promise<void> {
    if (closed) return;
    closed = true;

    for (const stream of streams) {
      stream.end();
    }
    streams.clear();

    await Promise.race([
      options.subscriber.unsubscribe(SERVER_EVENTS_CHANNEL).catch(() => undefined),
      new Promise<void>((resolve) => {
        setTimeout(resolve, UNSUBSCRIBE_TIMEOUT_MS);
      }),
    ]);
  }

  return {
    get size() {
      return streams.size;
    },
    add,
    remove,
    start,
    closeAll,
  };
}
