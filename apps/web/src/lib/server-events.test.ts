// 05-12-PLAN.md Task 1: the five documented behaviours of the pure SSE frame parsing/reducer
// module -- server-events.ts's client-side second allowlist over the three ServerEvent variants
// (T-5-50). Runs in Vitest's `apps` project (plain node environment, no DOM needed).
import { describe, expect, it } from 'vitest';
import { isKnownEventType, KNOWN_EVENT_TYPES, parseServerEventFrame } from './server-events';

describe('isKnownEventType', () => {
  it('accepts exactly the three allowlisted event types', () => {
    expect(isKnownEventType('server.updated')).toBe(true);
    expect(isKnownEventType('server.deleted')).toBe(true);
    expect(isKnownEventType('server.discovery_progress')).toBe(true);
    expect(KNOWN_EVENT_TYPES.size).toBe(3);
  });

  it('rejects a near-miss type string and an empty string', () => {
    expect(isKnownEventType('server.updatedX')).toBe(false);
    expect(isKnownEventType('server.update')).toBe(false);
    expect(isKnownEventType('server')).toBe(false);
    expect(isKnownEventType('')).toBe(false);
  });
});

describe('parseServerEventFrame', () => {
  it('decodes a well-formed server.updated frame into a typed event', () => {
    const server = { id: 'srv_1', name: 'db-1', status: 'CONNECTED' };
    const result = parseServerEventFrame('server.updated', JSON.stringify({ type: 'server.updated', server }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event).toEqual({ type: 'server.updated', server });
    }
  });

  it('rejects a payload whose type disagrees with the listener event name', () => {
    const result = parseServerEventFrame(
      'server.updated',
      JSON.stringify({ type: 'server.deleted', id: 'srv_1' }),
    );

    expect(result).toEqual({ ok: false });
  });

  it('rejects malformed JSON instead of throwing', () => {
    expect(() => parseServerEventFrame('server.updated', '{not valid json')).not.toThrow();
    expect(parseServerEventFrame('server.updated', '{not valid json')).toEqual({ ok: false });
  });

  it('rejects a server.discovery_progress payload missing check, and one with an unknown check.id', () => {
    const missingCheck = parseServerEventFrame(
      'server.discovery_progress',
      JSON.stringify({ type: 'server.discovery_progress', serverId: 'srv_1' }),
    );
    expect(missingCheck).toEqual({ ok: false });

    const unknownCheckId = parseServerEventFrame(
      'server.discovery_progress',
      JSON.stringify({
        type: 'server.discovery_progress',
        serverId: 'srv_1',
        check: { id: 'not_a_real_check', status: 'pass', detail: '', durationMs: 1 },
      }),
    );
    expect(unknownCheckId).toEqual({ ok: false });

    const valid = parseServerEventFrame(
      'server.discovery_progress',
      JSON.stringify({
        type: 'server.discovery_progress',
        serverId: 'srv_1',
        check: { id: 'hostname', status: 'pass', detail: 'db-1', durationMs: 12 },
      }),
    );
    expect(valid.ok).toBe(true);
  });

  it('rejects a server.deleted payload with no id', () => {
    const result = parseServerEventFrame('server.deleted', JSON.stringify({ type: 'server.deleted' }));
    expect(result).toEqual({ ok: false });
  });
});
