// D-02/D-04: RED for `ServerEvent`, `noopServerEventPublisher` and `publishServerEvent`. These are
// the producer-side primitives every Phase 3 service publishes through (Task 2/3 of this plan) —
// this file only proves the port itself: the noop default does nothing observable, and
// `publishServerEvent` never lets a misbehaving publisher turn a committed state change into a
// failed service call (D-04's "a publisher that rejects or throws never fails the caller").
import { describe, expect, it, vi } from 'vitest';
import {
  noopServerEventPublisher,
  publishServerEvent,
  type ServerEvent,
  type ServerEventPublisher,
} from './server-event-publisher.js';

describe('noopServerEventPublisher', () => {
  it('resolves and does nothing observable for a server.deleted event', async () => {
    await expect(noopServerEventPublisher.publish({ type: 'server.deleted', id: 'x' })).resolves.toBeUndefined();
  });
});

describe('publishServerEvent', () => {
  const event: ServerEvent = { type: 'server.deleted', id: 'server-1' };

  it('resolves even when publisher.publish rejects', async () => {
    const rejecting: ServerEventPublisher = { publish: () => Promise.reject(new Error('boom')) };

    await expect(publishServerEvent(rejecting, event)).resolves.toBeUndefined();
  });

  it('resolves even when publisher.publish throws synchronously', async () => {
    const throwing: ServerEventPublisher = {
      publish: () => {
        throw new Error('sync boom');
      },
    };

    await expect(publishServerEvent(throwing, event)).resolves.toBeUndefined();
  });

  it('forwards the exact event object it was given, unmodified', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const recording: ServerEventPublisher = { publish };

    await publishServerEvent(recording, event);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(event);
  });
});
