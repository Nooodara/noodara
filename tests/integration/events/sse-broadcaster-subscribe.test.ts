// Regression test for the silently-lost SSE subscription (.planning/debug/sse-lost-event-race.md),
// against a real Redis and the real ioredis subscriber connection -- a fake subscriber cannot
// prove this, the defect lives in how ioredis@5 treats a `SUBSCRIBE` issued before `ready`:
//
//   1. `SUBSCRIBE` carries Redis's `loading` flag, so ioredis writes it to the socket while its
//      own status is still `connect` instead of parking it in the offline queue;
//   2. ioredis's ready check (`INFO`) then runs on a connection already in subscriber mode and
//      fails, so ioredis drops the connection and reconnects;
//   3. `autoResubscribe` only replays subscriptions of a connection that had reached `ready`, so
//      nothing is replayed -- while `subscribe()` itself had already resolved successfully.
//
// `app.ts`'s `onReady` calls `broadcaster.start()` at whatever moment boot reaches it, so the API
// process intermittently ended up with no subscription at all for its whole lifetime. This test
// pins `start()` to exactly that losing moment (the connection's own `connect` event) instead of
// leaving it to timing, then waits on the connection's real `ready` signal -- never a sleep.
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVER_EVENTS_CHANNEL } from '../../../apps/control-plane/src/events/redis-server-event-publisher.js';
import { createSseBroadcaster, type SseStream } from '../../../apps/control-plane/src/events/sse-broadcaster.js';
import { createSubscriberRedisConnection } from '../../../apps/control-plane/src/redis/connections.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';

const noopLogger = { warn: () => undefined };

let redis: RedisFixture | undefined;
const connections: Redis[] = [];

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.disconnect();
  await redis?.stop();
  redis = undefined;

  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  expect(containers.filter((c) => c.Labels['noodara.test'] === 'true')).toHaveLength(0);
});

async function subscriberCount(probe: Redis): Promise<number> {
  const counts = (await probe.call('PUBSUB', 'NUMSUB', SERVER_EVENTS_CHANNEL)) as [string, number];
  return Number(counts[1]);
}

describe('SSE broadcaster subscription against real Redis', () => {
  it('start() called before the subscriber connection is ready still ends with a live subscription that delivers', async () => {
    redis = await startRedis();
    const subscriber = createSubscriberRedisConnection(redis.connectionUrl);
    connections.push(subscriber);
    const broadcaster = createSseBroadcaster({ subscriber, logger: noopLogger as never, maxConnections: 32 });

    let deliver: (frame: string) => void = () => undefined;
    const delivered = new Promise<string>((resolve) => {
      deliver = resolve;
    });
    const stream: SseStream = { write: deliver, end: () => undefined };
    broadcaster.add(stream);

    // A hand-rolled wait, not `events.once()`: that helper rejects on the emitter's own `error`
    // event, and the defect under test surfaces as exactly such an event before ioredis
    // reconnects -- the assertion below must be what fails, not this wait.
    const ready = new Promise<void>((resolve) => {
      subscriber.once('ready', resolve);
    });
    const started = new Promise<void>((resolve, reject) => {
      // Synchronously inside the `connect` event: TCP is up, ioredis's ready check has not run.
      subscriber.once('connect', () => {
        broadcaster.start().then(resolve, reject);
      });
    });
    await ready;
    await started;

    const probe = new Redis(redis.connectionUrl, { commandTimeout: 2000, maxRetriesPerRequest: 1 });
    connections.push(probe);
    expect(await subscriberCount(probe)).toBe(1);

    await probe.publish(SERVER_EVENTS_CHANNEL, JSON.stringify({ type: 'server.deleted', id: 'regression-id' }));
    expect(await delivered).toContain('event: server.deleted');

    await broadcaster.closeAll();
  });
});
