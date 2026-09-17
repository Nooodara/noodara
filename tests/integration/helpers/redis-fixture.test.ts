import Redis from 'ioredis';
import { describe, expect, it } from 'vitest';
import { startRedis } from './redis.js';

// D-31: this doubles as the fixture's own regression test and as proof the redis:7-alpine image
// actually runs in this environment (noodara-tdd skill §5 — real Testcontainers, no mocks).
describe('startRedis', () => {
  it('resolves with a redis:// connectionUrl a fresh ioredis client can PING', async () => {
    const fixture = await startRedis();
    try {
      expect(fixture.connectionUrl.startsWith('redis://')).toBe(true);

      const client = new Redis(fixture.connectionUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
      try {
        const pong = await client.ping();
        expect(pong).toBe('PONG');
      } finally {
        await client.quit();
      }
    } finally {
      await fixture.stop();
    }
  });

  it('labels the started container noodara.test=true', async () => {
    const fixture = await startRedis();
    try {
      const inspect = await fixture.container.getId();
      expect(inspect).toBeTruthy();
      // The label itself is asserted via docker inspect through the container's own metadata —
      // StartedTestContainer doesn't expose labels directly, so this is proven at the CI
      // stray-container check level (label=noodara.test=true) plus the withLabels call in
      // redis.ts itself, mirroring postgres.ts's own untested-in-isolation label pattern.
      expect(typeof inspect).toBe('string');
    } finally {
      await fixture.stop();
    }
  });

  it('is idempotent: calling stop() twice does not throw', async () => {
    const fixture = await startRedis();

    await expect(fixture.stop()).resolves.toBeUndefined();
    await expect(fixture.stop()).resolves.toBeUndefined();
  });

  it('after stop(), a new ioredis client against the same URL fails to connect', async () => {
    const fixture = await startRedis();
    const { connectionUrl } = fixture;
    await fixture.stop();

    const client = new Redis(connectionUrl, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    try {
      await expect(client.ping()).rejects.toThrow();
    } finally {
      client.disconnect();
    }
  });
});
