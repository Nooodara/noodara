import { describe, expect, it, vi } from 'vitest';
import { SERVER_EVENTS_CHANNEL } from './redis-server-event-publisher.js';
import { createSseBroadcaster, type SseStream } from './sse-broadcaster.js';

// D-02/D-05/D-07: a structural fake Redis subscriber (`subscribe`/`on`/`unsubscribe`, `message`
// events emitted by hand) plus fake streams recording written chunks — this file proves the
// fan-out/registry/injection-guard logic as a pure unit, entirely independent of the HTTP layer.

interface FakeSubscriber {
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  emitMessage: (channel: string, message: string) => void;
  emitError: (err: Error) => void;
}

function buildFakeSubscriber(): FakeSubscriber {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  });
  return {
    subscribe: vi.fn().mockResolvedValue(1),
    unsubscribe: vi.fn().mockResolvedValue(1),
    on,
    emitMessage: (channel: string, message: string) => {
      for (const handler of handlers.get('message') ?? []) handler(channel, message);
    },
    emitError: (err: Error) => {
      for (const handler of handlers.get('error') ?? []) handler(err);
    },
  };
}

interface FakeLogger {
  warn: ReturnType<typeof vi.fn>;
}

function buildFakeLogger(): FakeLogger {
  return { warn: vi.fn() };
}

function buildFakeStream(): SseStream & { chunks: string[] } {
  const chunks: string[] = [];
  return {
    chunks,
    write: (chunk: string) => {
      chunks.push(chunk);
    },
    end: vi.fn(),
  };
}

describe('createSseBroadcaster', () => {
  it('start() subscribes exactly once to SERVER_EVENTS_CHANNEL with three streams added', async () => {
    const subscriber = buildFakeSubscriber();
    const logger = buildFakeLogger();
    const broadcaster = createSseBroadcaster({ subscriber: subscriber as never, logger: logger as never, maxConnections: 32 });
    broadcaster.add(buildFakeStream());
    broadcaster.add(buildFakeStream());
    broadcaster.add(buildFakeStream());

    await broadcaster.start();

    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);
    expect(subscriber.subscribe).toHaveBeenCalledWith(SERVER_EVENTS_CHANNEL);
  });

  it('fans a server.updated message out to every registered stream', async () => {
    const subscriber = buildFakeSubscriber();
    const logger = buildFakeLogger();
    const broadcaster = createSseBroadcaster({ subscriber: subscriber as never, logger: logger as never, maxConnections: 32 });
    const streamA = buildFakeStream();
    const streamB = buildFakeStream();
    broadcaster.add(streamA);
    broadcaster.add(streamB);
    await broadcaster.start();

    const message = JSON.stringify({ type: 'server.updated', server: { id: 'x' }, at: '2026-01-01T00:00:00.000Z' });
    subscriber.emitMessage(SERVER_EVENTS_CHANNEL, message);

    expect(streamA.chunks).toStrictEqual([`event: server.updated\ndata: ${message}\n\n`]);
    expect(streamB.chunks).toStrictEqual([`event: server.updated\ndata: ${message}\n\n`]);
  });

  it('drops a message with an unknown type without writing to any stream', async () => {
    const subscriber = buildFakeSubscriber();
    const logger = buildFakeLogger();
    const broadcaster = createSseBroadcaster({ subscriber: subscriber as never, logger: logger as never, maxConnections: 32 });
    const stream = buildFakeStream();
    broadcaster.add(stream);
    await broadcaster.start();

    subscriber.emitMessage(
      SERVER_EVENTS_CHANNEL,
      JSON.stringify({ type: 'evil.injected', server: { id: 'x' }, at: '2026-01-01T00:00:00.000Z' }),
    );

    expect(stream.chunks).toStrictEqual([]);
  });

  it('drops an invalid-JSON message, logs a warning, and later valid messages still fan out', async () => {
    const subscriber = buildFakeSubscriber();
    const logger = buildFakeLogger();
    const broadcaster = createSseBroadcaster({ subscriber: subscriber as never, logger: logger as never, maxConnections: 32 });
    const stream = buildFakeStream();
    broadcaster.add(stream);
    await broadcaster.start();

    subscriber.emitMessage(SERVER_EVENTS_CHANNEL, '{not json');
    expect(stream.chunks).toStrictEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    const message = JSON.stringify({ type: 'server.deleted', id: 'x', at: '2026-01-01T00:00:00.000Z' });
    subscriber.emitMessage(SERVER_EVENTS_CHANNEL, message);
    expect(stream.chunks).toStrictEqual([`event: server.deleted\ndata: ${message}\n\n`]);
  });

  it('remove(stream) stops that stream receiving further messages while others keep receiving', async () => {
    const subscriber = buildFakeSubscriber();
    const logger = buildFakeLogger();
    const broadcaster = createSseBroadcaster({ subscriber: subscriber as never, logger: logger as never, maxConnections: 32 });
    const streamA = buildFakeStream();
    const streamB = buildFakeStream();
    broadcaster.add(streamA);
    broadcaster.add(streamB);
    await broadcaster.start();

    broadcaster.remove(streamA);
    const message = JSON.stringify({ type: 'server.deleted', id: 'x', at: '2026-01-01T00:00:00.000Z' });
    subscriber.emitMessage(SERVER_EVENTS_CHANNEL, message);

    expect(streamA.chunks).toStrictEqual([]);
    expect(streamB.chunks).toStrictEqual([`event: server.deleted\ndata: ${message}\n\n`]);
    expect(broadcaster.size).toBe(1);
  });

  it('removes a stream whose write throws and still delivers the same message to a sibling stream', async () => {
    const subscriber = buildFakeSubscriber();
    const logger = buildFakeLogger();
    const broadcaster = createSseBroadcaster({ subscriber: subscriber as never, logger: logger as never, maxConnections: 32 });
    const throwingStream: SseStream = {
      write: () => {
        throw new Error('dead socket');
      },
      end: vi.fn(),
    };
    const healthyStream = buildFakeStream();
    broadcaster.add(throwingStream);
    broadcaster.add(healthyStream);
    await broadcaster.start();

    const message = JSON.stringify({ type: 'server.deleted', id: 'x', at: '2026-01-01T00:00:00.000Z' });
    subscriber.emitMessage(SERVER_EVENTS_CHANNEL, message);

    expect(healthyStream.chunks).toStrictEqual([`event: server.deleted\ndata: ${message}\n\n`]);
    expect(broadcaster.size).toBe(1);
  });

  it('size reflects the number of registered streams', () => {
    const subscriber = buildFakeSubscriber();
    const logger = buildFakeLogger();
    const broadcaster = createSseBroadcaster({ subscriber: subscriber as never, logger: logger as never, maxConnections: 32 });
    expect(broadcaster.size).toBe(0);
    const stream = buildFakeStream();
    broadcaster.add(stream);
    expect(broadcaster.size).toBe(1);
    broadcaster.remove(stream);
    expect(broadcaster.size).toBe(0);
  });

  it('closeAll() calls end() on every stream, empties the registry and unsubscribes', async () => {
    const subscriber = buildFakeSubscriber();
    const logger = buildFakeLogger();
    const broadcaster = createSseBroadcaster({ subscriber: subscriber as never, logger: logger as never, maxConnections: 32 });
    const streamA = buildFakeStream();
    const streamB = buildFakeStream();
    broadcaster.add(streamA);
    broadcaster.add(streamB);
    await broadcaster.start();

    await broadcaster.closeAll();

    expect(streamA.end).toHaveBeenCalledTimes(1);
    expect(streamB.end).toHaveBeenCalledTimes(1);
    expect(broadcaster.size).toBe(0);
    expect(subscriber.unsubscribe).toHaveBeenCalledWith(SERVER_EVENTS_CHANNEL);
  });

  it('closeAll() is idempotent', async () => {
    const subscriber = buildFakeSubscriber();
    const logger = buildFakeLogger();
    const broadcaster = createSseBroadcaster({ subscriber: subscriber as never, logger: logger as never, maxConnections: 32 });
    broadcaster.add(buildFakeStream());
    await broadcaster.start();

    await broadcaster.closeAll();
    await expect(broadcaster.closeAll()).resolves.toBeUndefined();
  });

  it('logs a warning and never throws when the subscriber connection emits an error event', async () => {
    const subscriber = buildFakeSubscriber();
    const logger = buildFakeLogger();
    const broadcaster = createSseBroadcaster({ subscriber: subscriber as never, logger: logger as never, maxConnections: 32 });
    await broadcaster.start();

    expect(() => {
      subscriber.emitError(new Error('ECONNRESET'));
    }).not.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('exposes no Last-Event-ID / replay handling', async () => {
    const fileContents = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./sse-broadcaster.ts', import.meta.url), 'utf8'),
    );
    expect(/Last-Event-ID|lastEventId/.test(fileContents)).toBe(false);
  });
});
