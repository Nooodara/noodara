// 05-12-PLAN.md Task 1: the five documented behaviours of the pure SSE frame parsing/reducer
// module -- server-events.ts's client-side second allowlist over the three ServerEvent variants
// (T-5-50). Runs in Vitest's `apps` project (plain node environment, no DOM needed).
import { describe, expect, it } from 'vitest';
import { isKnownEventType, isServerEvent, isValidUpdatedAt, KNOWN_EVENT_TYPES, parseServerEventFrame } from './server-events';

describe('isKnownEventType', () => {
  it('accepts exactly the seven allowlisted event types (three server, four deploy-engine)', () => {
    expect(isKnownEventType('server.updated')).toBe(true);
    expect(isKnownEventType('server.deleted')).toBe(true);
    expect(isKnownEventType('server.discovery_progress')).toBe(true);
    expect(isKnownEventType('service.updated')).toBe(true);
    expect(isKnownEventType('service.deleted')).toBe(true);
    expect(isKnownEventType('deployment.updated')).toBe(true);
    expect(isKnownEventType('deployment.log_chunk')).toBe(true);
    expect(KNOWN_EVENT_TYPES.size).toBe(7);
  });

  it('never matches a deploy-engine prefix or a type the control plane does not send', () => {
    expect(isKnownEventType('service')).toBe(false);
    expect(isKnownEventType('deployment.')).toBe(false);
    expect(isKnownEventType('project.updated')).toBe(false);
    expect(isKnownEventType('environment.deleted')).toBe(false);
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

const UPDATED_AT = '2026-10-06T10:00:00.000Z';
const SERVICE_ID = '7a1d5a2e-2a49-4d0e-9f0e-6f3c3d1f2a10';
const DEPLOYMENT_ID = '2b7c1e44-6a0f-4a52-8d43-2f8e6a1c9b07';

function frame(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ type, ...payload });
}

const SERVICE = {
  id: SERVICE_ID,
  projectId: 'p1',
  environmentId: 'e1',
  serverId: 's1',
  name: 'api',
  status: 'RUNNING',
  updatedAt: UPDATED_AT,
};

const DEPLOYMENT = {
  id: DEPLOYMENT_ID,
  serviceId: SERVICE_ID,
  status: 'BUILDING',
  errorCode: null,
  updatedAt: UPDATED_AT,
};

const CHUNK = { deploymentId: DEPLOYMENT_ID, phase: 'build', seq: 3, text: 'Step 1/4\n', truncated: false };

describe('parseServerEventFrame: deploy-engine events (13-08 A1)', () => {
  it('decodes a well-formed frame of each of the four deploy-engine types', () => {
    expect(parseServerEventFrame('service.updated', frame('service.updated', { service: SERVICE }))).toEqual({
      ok: true,
      event: { type: 'service.updated', service: SERVICE },
    });
    expect(parseServerEventFrame('service.deleted', frame('service.deleted', { id: SERVICE_ID }))).toEqual({
      ok: true,
      event: { type: 'service.deleted', id: SERVICE_ID },
    });
    expect(
      parseServerEventFrame('deployment.updated', frame('deployment.updated', { deployment: DEPLOYMENT })),
    ).toEqual({ ok: true, event: { type: 'deployment.updated', deployment: DEPLOYMENT } });
    expect(parseServerEventFrame('deployment.log_chunk', frame('deployment.log_chunk', CHUNK))).toEqual({
      ok: true,
      event: { type: 'deployment.log_chunk', ...CHUNK },
    });
  });

  it('copies only the allowlisted deployment fields, never errorMessage', () => {
    const result = parseServerEventFrame(
      'deployment.updated',
      frame('deployment.updated', { deployment: { ...DEPLOYMENT, errorMessage: 'secret-ish' } }),
    );
    expect(result.ok && result.event.type === 'deployment.updated' && 'errorMessage' in result.event.deployment).toBe(
      false,
    );
  });

  it('rejects a deploy-engine payload whose type disagrees with the listener, and malformed JSON', () => {
    expect(parseServerEventFrame('service.updated', frame('service.deleted', { id: SERVICE_ID })).ok).toBe(false);
    expect(parseServerEventFrame('deployment.log_chunk', '{"type":"deployment.log_chunk"').ok).toBe(false);
    expect(parseServerEventFrame('service.deleted', 'null').ok).toBe(false);
  });

  it.each([
    ['service missing', {}],
    ['service not an object', { service: 'api' }],
    ['service without id', { service: { ...SERVICE, id: undefined } }],
    ['service id with a slash', { service: { ...SERVICE, id: '../x' } }],
    ['service without name', { service: { ...SERVICE, name: 1 } }],
    ['service with unknown status', { service: { ...SERVICE, status: 'exploded' } }],
    ['service without updatedAt', { service: { ...SERVICE, updatedAt: undefined } }],
    ['service with invalid updatedAt', { service: { ...SERVICE, updatedAt: 'yesterday' } }],
  ])('rejects service.updated with %s', (_label, payload) => {
    expect(parseServerEventFrame('service.updated', frame('service.updated', payload)).ok).toBe(false);
  });

  it('rejects service.deleted with no id or a malformed id', () => {
    expect(parseServerEventFrame('service.deleted', frame('service.deleted', {})).ok).toBe(false);
    expect(parseServerEventFrame('service.deleted', frame('service.deleted', { id: '' })).ok).toBe(false);
    expect(parseServerEventFrame('service.deleted', frame('service.deleted', { id: 'a/b' })).ok).toBe(false);
  });

  it.each([
    ['deployment missing', {}],
    ['no serviceId', { deployment: { ...DEPLOYMENT, serviceId: undefined } }],
    ['unknown status', { deployment: { ...DEPLOYMENT, status: 'flying' } }],
    ['unknown errorCode', { deployment: { ...DEPLOYMENT, errorCode: 'NOPE' } }],
    ['missing updatedAt', { deployment: { ...DEPLOYMENT, updatedAt: undefined } }],
    ['invalid updatedAt', { deployment: { ...DEPLOYMENT, updatedAt: '2026-13-45' } }],
  ])('rejects deployment.updated with %s', (_label, payload) => {
    expect(parseServerEventFrame('deployment.updated', frame('deployment.updated', payload)).ok).toBe(false);
  });

  it('accepts a deployment.updated with a known errorCode', () => {
    const result = parseServerEventFrame(
      'deployment.updated',
      frame('deployment.updated', { deployment: { ...DEPLOYMENT, status: 'FAILED', errorCode: 'BUILD_FAILED' } }),
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    ['bad deploymentId', { ...CHUNK, deploymentId: '../../etc' }],
    ['unknown phase', { ...CHUNK, phase: 'teardown' }],
    ['negative seq', { ...CHUNK, seq: -1 }],
    ['fractional seq', { ...CHUNK, seq: 1.5 }],
    ['text not a string', { ...CHUNK, text: 42 }],
    ['oversized text', { ...CHUNK, text: 'x'.repeat(64 * 1024 + 1) }],
    ['missing truncated flag', { ...CHUNK, truncated: undefined }],
  ])('rejects deployment.log_chunk with %s', (_label, payload) => {
    expect(parseServerEventFrame('deployment.log_chunk', frame('deployment.log_chunk', payload)).ok).toBe(false);
  });

  it('isServerEvent separates the server events from the deploy-engine ones', () => {
    expect(isServerEvent({ type: 'server.deleted', id: 'x' })).toBe(true);
    expect(isServerEvent({ type: 'service.deleted', id: 'x' })).toBe(false);
  });

  it('isValidUpdatedAt accepts an ISO instant and nothing unorderable', () => {
    expect(isValidUpdatedAt(UPDATED_AT)).toBe(true);
    expect(isValidUpdatedAt('')).toBe(false);
    expect(isValidUpdatedAt('soon')).toBe(false);
    expect(isValidUpdatedAt(null)).toBe(false);
  });
});
