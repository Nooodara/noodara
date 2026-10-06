// 12-05 A2/A3: the deploy engine's four SSE event types (D22) and the bounded
// `deployment.log_chunk` payload.
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  buildDeploymentLogChunkEvent,
  buildDeploymentUpdatedEvent,
  buildServiceUpdatedEvent,
  DEPLOY_ENGINE_EVENT_TYPES,
  type DeploymentEventView,
  type DeploymentLogChunkEvent,
  isWellFormedLogChunkMessage,
  MAX_LOG_CHUNK_EVENT_MESSAGE_BYTES,
  MAX_LOG_CHUNK_EVENT_TEXT_BYTES,
} from './deploy-engine-events.js';
import { SSE_EVENT_TYPES, type ServerEvent } from './server-event-publisher.js';
import { SERVICE_VIEW_FIELDS, type ServiceView } from '../services/service-view.js';

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

describe('service.updated / deployment.updated carry updatedAt (13-02 A1, A2, H1)', () => {
  const UPDATED_AT = '2026-10-05T10:01:00.123Z';
  const serviceView = (overrides: Partial<ServiceView> = {}): ServiceView => ({
    id: 's-1',
    projectId: 'p-1',
    environmentId: 'e-1',
    serverId: 'v-1',
    name: 'api',
    sourceType: 'git',
    repositoryUrl: 'https://github.com/acme/api.git',
    branch: 'main',
    buildContext: '.',
    dockerfilePath: 'Dockerfile',
    buildTarget: null,
    imageRef: null,
    internalPort: 3000,
    publishedPort: 8080,
    status: 'RUNNING',
    createdAt: '2026-10-05T10:00:00.000Z',
    updatedAt: UPDATED_AT,
    ...overrides,
  });
  const deploymentView = (overrides: Partial<DeploymentEventView> = {}): DeploymentEventView => ({
    id: DEPLOYMENT_ID,
    serviceId: 's-1',
    status: 'BUILDING',
    errorCode: null,
    updatedAt: UPDATED_AT,
    ...overrides,
  });

  it('service.updated carries the view, updatedAt included, in the allowlisted wire order', () => {
    const event = buildServiceUpdatedEvent(serviceView());
    expect(event.type).toBe('service.updated');
    expect(Object.keys(event.service)).toEqual([...SERVICE_VIEW_FIELDS]);
    expect(event.service.updatedAt).toBe(UPDATED_AT);
  });

  it('deployment.updated carries id, serviceId, status, errorCode and updatedAt only', () => {
    const event = buildDeploymentUpdatedEvent(deploymentView({ status: 'FAILED', errorCode: 'BUILD_FAILED' }));
    expect(event).toEqual({
      type: 'deployment.updated',
      deployment: { id: DEPLOYMENT_ID, serviceId: 's-1', status: 'FAILED', errorCode: 'BUILD_FAILED', updatedAt: UPDATED_AT },
    });
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['a Date object', new Date(UPDATED_AT)],
    ['not ISO', 'yesterday'],
    ['an offset instead of Z', '2026-10-05T10:01:00.123+00:00'],
    ['an impossible instant', '2026-13-45T10:01:00.123Z'],
  ])('rejects an event built without a valid updatedAt (%s)', (_label, updatedAt) => {
    expect(() => buildServiceUpdatedEvent(serviceView({ updatedAt: updatedAt as unknown as string }))).toThrow(RangeError);
    expect(() => buildDeploymentUpdatedEvent(deploymentView({ updatedAt: updatedAt as unknown as string }))).toThrow(RangeError);
  });

  it('rejects an unknown status', () => {
    expect(() => buildServiceUpdatedEvent(serviceView({ status: 'BOGUS' as never }))).toThrow(RangeError);
    expect(() => buildDeploymentUpdatedEvent(deploymentView({ status: 'BOGUS' as never }))).toThrow(RangeError);
  });

  it('H1: never copies a field beyond the allowlist (credential ids, raw error text, the source snapshot)', () => {
    const leakyService = {
      ...serviceView(),
      repositoryCredentialId: 'cred-1',
      registryCredentialId: 'cred-2',
      token: 'ghp_secret',
    } as ServiceView;
    const leakyDeployment = {
      ...deploymentView({ status: 'FAILED', errorCode: 'BUILD_FAILED' }),
      errorMessage: 'fatal: Authentication failed for https://user:ghp_secret@github.com',
      source: { repositoryUrl: 'https://github.com/acme/api.git' },
      commitSha: 'a'.repeat(40),
    } as DeploymentEventView;

    const service = JSON.stringify(buildServiceUpdatedEvent(leakyService));
    const deployment = JSON.stringify(buildDeploymentUpdatedEvent(leakyDeployment));

    for (const text of [service, deployment]) {
      expect(text).not.toMatch(/ghp_secret|cred-|CredentialId|errorMessage|Authentication|"source"|commitSha/);
    }
  });

  it('A2: the event types only come from the builders (an unbuilt literal does not type-check)', () => {
    const literal = { type: 'deployment.updated', deployment: deploymentView() } as const;
    expectTypeOf(literal).not.toExtend<ServerEvent>();
    expectTypeOf(buildDeploymentUpdatedEvent(deploymentView())).toExtend<ServerEvent>();
    expectTypeOf(buildServiceUpdatedEvent(serviceView())).toExtend<ServerEvent>();
  });
});
