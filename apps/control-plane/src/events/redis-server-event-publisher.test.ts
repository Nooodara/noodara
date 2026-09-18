import { describe, expect, it, vi } from 'vitest';
import type { ServerView } from '../services/server-view.js';
import { createRedisServerEventPublisher, SERVER_EVENTS_CHANNEL } from './redis-server-event-publisher.js';

// D-03/D-04/T-4-38: a structural fake Redis (`{ publish: vi.fn() }`) and a capturing logger — this
// adapter is exercised as a pure unit, never against a real connection. The `publish` contract it
// implements (`ServerEventPublisher`) must never reject; this file proves that guarantee for the
// concrete Redis-backed implementation specifically (never trusting `publishServerEvent`'s
// try/catch wrapper alone to hide a bug here).

function buildServerView(overrides: Partial<ServerView> = {}): ServerView {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'srv-1',
    host: 'srv-1.example.test',
    sshPort: 22,
    sshUser: 'deployer',
    status: 'CONNECTED',
    hostFingerprint: 'SHA256:abc',
    hostFingerprintCapturedAt: new Date('2026-01-01T00:00:00.000Z'),
    pendingFingerprint: null,
    pendingFingerprintSeenAt: null,
    hostname: 'srv-1-hostname',
    osDistribution: 'ubuntu',
    osVersion: '24.04',
    arch: 'x86_64',
    cpuCores: 4,
    ramMb: 8192,
    diskTotalMb: 100000,
    diskUsedMb: 20000,
    uptimeSeconds: 12345,
    dockerInstalled: true,
    dockerVersion: '27.0.0',
    dockerComposeVersion: '2.29.0',
    lastSeenAt: new Date('2026-01-02T00:00:00.000Z'),
    lastErrorCode: null,
    createdAt: new Date('2025-12-31T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    credentialType: 'ssh_password',
    ...overrides,
  };
}

interface FakeRedis {
  publish: ReturnType<typeof vi.fn>;
}

function buildFakeRedis(): FakeRedis {
  return { publish: vi.fn().mockResolvedValue(1) };
}

interface FakeLogger {
  warn: ReturnType<typeof vi.fn>;
}

function buildFakeLogger(): FakeLogger {
  return { warn: vi.fn() };
}

describe('createRedisServerEventPublisher', () => {
  it('publishes server.updated to SERVER_EVENTS_CHANNEL with { type, server, at }', async () => {
    const redis = buildFakeRedis();
    const logger = buildFakeLogger();
    const publisher = createRedisServerEventPublisher(redis as never, logger as never);
    const server = buildServerView();

    await publisher.publish({ type: 'server.updated', server });

    expect(redis.publish).toHaveBeenCalledTimes(1);
    const [channel, rawMessage] = redis.publish.mock.calls[0] as [string, string];
    expect(channel).toBe(SERVER_EVENTS_CHANNEL);
    expect(SERVER_EVENTS_CHANNEL).toBe('noodara:server-events');

    const parsed = JSON.parse(rawMessage) as { type: string; server: unknown; at: string };
    expect(Object.keys(parsed).sort()).toStrictEqual(['at', 'server', 'type']);
    expect(parsed.type).toBe('server.updated');
    expect(() => new Date(parsed.at).toISOString()).not.toThrow();
    expect(new Date(parsed.at).toISOString()).toBe(parsed.at);
  });

  it('publishes server.deleted to SERVER_EVENTS_CHANNEL with { type, id, at } and no server key', async () => {
    const redis = buildFakeRedis();
    const logger = buildFakeLogger();
    const publisher = createRedisServerEventPublisher(redis as never, logger as never);

    await publisher.publish({ type: 'server.deleted', id: 'deleted-id' });

    const [, rawMessage] = redis.publish.mock.calls[0] as [string, string];
    const parsed = JSON.parse(rawMessage) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toStrictEqual(['at', 'id', 'type']);
    expect(parsed.id).toBe('deleted-id');
    expect(parsed.server).toBeUndefined();
  });

  it('serialises Date fields inside server to ISO-8601 strings', async () => {
    const redis = buildFakeRedis();
    const logger = buildFakeLogger();
    const publisher = createRedisServerEventPublisher(redis as never, logger as never);
    const server = buildServerView();

    await publisher.publish({ type: 'server.updated', server });

    const [, rawMessage] = redis.publish.mock.calls[0] as [string, string];
    const parsed = JSON.parse(rawMessage) as { server: Record<string, unknown> };
    expect(parsed.server.createdAt).toBe(server.createdAt.toISOString());
    expect(parsed.server.updatedAt).toBe(server.updatedAt.toISOString());
    expect(parsed.server.hostFingerprintCapturedAt).toBe(server.hostFingerprintCapturedAt?.toISOString());
    expect(parsed.server.lastSeenAt).toBe(server.lastSeenAt?.toISOString());
  });

  it('resolves publish and logs exactly one warn record when redis.publish rejects', async () => {
    const redis = buildFakeRedis();
    redis.publish.mockRejectedValueOnce(new Error('ECONNREFUSED 10.0.0.5:6379'));
    const logger = buildFakeLogger();
    const publisher = createRedisServerEventPublisher(redis as never, logger as never);

    await expect(
      publisher.publish({ type: 'server.deleted', id: 'x' }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('never includes a Redis URL, host or port in the warn record — fixed message, err serializer only', async () => {
    const redis = buildFakeRedis();
    const failure = new Error('connect ECONNREFUSED 10.0.0.5:6379');
    redis.publish.mockRejectedValueOnce(failure);
    const logger = buildFakeLogger();
    const publisher = createRedisServerEventPublisher(redis as never, logger as never);

    await publisher.publish({ type: 'server.deleted', id: 'x' });

    const [payload, message] = logger.warn.mock.calls[0] as [{ err?: unknown }, string];
    expect(message).toBe('failed to publish server event');
    expect(payload.err).toBe(failure);
    // The fixed message string itself never carries the failing error's text (no interpolation).
    expect(message).not.toContain('ECONNREFUSED');
    expect(message).not.toContain('10.0.0.5');
  });
});
