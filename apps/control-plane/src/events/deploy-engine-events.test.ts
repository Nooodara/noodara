// 12-05 A2/A3: the deploy engine's four SSE event types (D22) and the bounded
// `deployment.log_chunk` payload.
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  buildDeploymentLogChunkEvent,
  DEPLOY_ENGINE_EVENT_TYPES,
  type DeploymentLogChunkEvent,
  isWellFormedLogChunkMessage,
  MAX_LOG_CHUNK_EVENT_MESSAGE_BYTES,
  MAX_LOG_CHUNK_EVENT_TEXT_BYTES,
} from './deploy-engine-events.js';
import { SSE_EVENT_TYPES, type ServerEvent } from './server-event-publisher.js';

const DEPLOYMENT_ID = '3f0e1c2a-8d1b-4b5e-9a7c-1d2e3f4a5b6c';

describe('SSE event surface (D22, A2)', () => {
  it('DEPLOY_ENGINE_EVENT_TYPES is exactly the four D22 types', () => {
    expect([...DEPLOY_ENGINE_EVENT_TYPES]).toEqual([
      'service.updated',
      'service.deleted',
      'deployment.updated',
      'deployment.log_chunk',
    ]);
  });

  it('SSE_EVENT_TYPES is the three server events plus the four deploy engine events, nothing else', () => {
    expect([...SSE_EVENT_TYPES].sort()).toEqual(
      [
        'server.updated',
        'server.deleted',
        'server.discovery_progress',
        'service.updated',
        'service.deleted',
        'deployment.updated',
        'deployment.log_chunk',
      ].sort(),
    );
  });

  it('has no project.* or environment.* event (clients refetch)', () => {
    for (const type of SSE_EVENT_TYPES) {
      expect(type).not.toMatch(/^(project|environment)\./);
    }
  });

  it('SSE_EVENT_TYPES and the ServerEvent union name the same types', () => {
    expectTypeOf<(typeof SSE_EVENT_TYPES)[number]>().toEqualTypeOf<ServerEvent['type']>();
  });
});

describe('buildDeploymentLogChunkEvent (A3)', () => {
  it('carries deploymentId, phase, seq and the text', () => {
    expect(buildDeploymentLogChunkEvent({ deploymentId: DEPLOYMENT_ID, phase: 'build', seq: 7, text: 'Step 1/4\n' })).toEqual({
      type: 'deployment.log_chunk',
      deploymentId: DEPLOYMENT_ID,
      phase: 'build',
      seq: 7,
      text: 'Step 1/4\n',
      truncated: false,
    });
  });

  it('is the only way to obtain a DeploymentLogChunkEvent (branded type)', () => {
    // @ts-expect-error a hand-written literal bypasses the bound and must not type-check
    const literal: DeploymentLogChunkEvent = {
      type: 'deployment.log_chunk',
      deploymentId: DEPLOYMENT_ID,
      phase: 'build',
      seq: 0,
      text: 'x',
      truncated: false,
    };
    expect(literal.type).toBe('deployment.log_chunk');
  });

  it('keeps text of exactly the byte bound untouched', () => {
    const text = 'a'.repeat(MAX_LOG_CHUNK_EVENT_TEXT_BYTES);
    const event = buildDeploymentLogChunkEvent({ deploymentId: DEPLOYMENT_ID, phase: 'build', seq: 0, text });
    expect(event.text).toBe(text);
    expect(event.truncated).toBe(false);
  });

  it('truncates text over the byte bound and flags it', () => {
    const text = 'a'.repeat(MAX_LOG_CHUNK_EVENT_TEXT_BYTES + 10);
    const event = buildDeploymentLogChunkEvent({ deploymentId: DEPLOYMENT_ID, phase: 'build', seq: 0, text });
    expect(Buffer.byteLength(event.text, 'utf8')).toBeLessThanOrEqual(MAX_LOG_CHUNK_EVENT_TEXT_BYTES);
    expect(event.truncated).toBe(true);
  });

  it('never splits a multi-byte UTF-8 character when truncating', () => {
    // '€' is 3 bytes and the bound (65536) is not a multiple of 3, so it lands mid-character.
    const text = '€'.repeat(MAX_LOG_CHUNK_EVENT_TEXT_BYTES);
    const event = buildDeploymentLogChunkEvent({ deploymentId: DEPLOYMENT_ID, phase: 'deploy', seq: 1, text });
    expect(event.truncated).toBe(true);
    expect(event.text).not.toContain('\uFFFD');
    expect(event.text).toBe('€'.repeat(Math.floor(MAX_LOG_CHUNK_EVENT_TEXT_BYTES / 3)));
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects seq %s', (seq) => {
    expect(() => buildDeploymentLogChunkEvent({ deploymentId: DEPLOYMENT_ID, phase: 'build', seq, text: '' })).toThrow(
      RangeError,
    );
  });

  it('rejects an unknown phase', () => {
    expect(() =>
      buildDeploymentLogChunkEvent({ deploymentId: DEPLOYMENT_ID, phase: 'runtime' as never, seq: 0, text: '' }),
    ).toThrow(RangeError);
  });

  it('rejects a deploymentId outside the id charset', () => {
    expect(() => buildDeploymentLogChunkEvent({ deploymentId: '', phase: 'build', seq: 0, text: '' })).toThrow(RangeError);
    expect(() => buildDeploymentLogChunkEvent({ deploymentId: 'a b\n', phase: 'build', seq: 0, text: '' })).toThrow(
      RangeError,
    );
  });

  it('a worst-case serialized chunk (every byte JSON-escaped) stays within the message bound', () => {
    const text = '\u0001'.repeat(MAX_LOG_CHUNK_EVENT_TEXT_BYTES);
    const event = buildDeploymentLogChunkEvent({ deploymentId: DEPLOYMENT_ID, phase: 'prepare', seq: Number.MAX_SAFE_INTEGER, text });
    const message = JSON.stringify({ ...event, at: new Date(0).toISOString() });
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(MAX_LOG_CHUNK_EVENT_MESSAGE_BYTES);
  });
});

describe('isWellFormedLogChunkMessage (A3)', () => {
  const good = { type: 'deployment.log_chunk', deploymentId: DEPLOYMENT_ID, phase: 'build', seq: 3, text: 'x', truncated: false };

  it('accepts a message built by buildDeploymentLogChunkEvent', () => {
    expect(isWellFormedLogChunkMessage(good, 200)).toBe(true);
  });

  it('rejects a message over the byte bound', () => {
    expect(isWellFormedLogChunkMessage(good, MAX_LOG_CHUNK_EVENT_MESSAGE_BYTES + 1)).toBe(false);
  });

  it.each([
    ['missing deploymentId', { ...good, deploymentId: undefined }],
    ['bad deploymentId', { ...good, deploymentId: 'a b' }],
    ['unknown phase', { ...good, phase: 'runtime' }],
    ['negative seq', { ...good, seq: -1 }],
    ['fractional seq', { ...good, seq: 0.5 }],
    ['string seq', { ...good, seq: '3' }],
    ['non-string text', { ...good, text: 42 }],
    ['text over the bound', { ...good, text: 'a'.repeat(MAX_LOG_CHUNK_EVENT_TEXT_BYTES + 1) }],
    ['non-object', 'deployment.log_chunk'],
    ['null', null],
  ])('rejects %s', (_label, parsed) => {
    expect(isWellFormedLogChunkMessage(parsed, 200)).toBe(false);
  });
});
