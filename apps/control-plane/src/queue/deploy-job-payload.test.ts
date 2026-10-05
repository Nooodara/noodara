import { describe, expect, it } from 'vitest';
import { DeployServiceJobPayloadSchema, parseDeployServiceJobPayload } from './deploy-job-payload.js';

const DEPLOYMENT_ID = '0192f1a4-7b3c-7d2e-8f00-000000000001';
const SERVICE_ID = '0192f1a4-7b3c-7d2e-8f00-000000000002';
const USER_ID = '0192f1a4-7b3c-7d2e-8f00-000000000003';

function valid(): Record<string, unknown> {
  return {
    deploymentId: DEPLOYMENT_ID,
    serviceId: SERVICE_ID,
    actor: { type: 'user', id: USER_ID },
    requestedAt: '2026-10-04T12:00:00.000Z',
  };
}

describe('parseDeployServiceJobPayload', () => {
  it('accepts a payload of ids only (user actor)', () => {
    const result = parseDeployServiceJobPayload(valid());
    expect(result).toEqual({ ok: true, payload: valid() });
  });

  it('accepts a system actor', () => {
    const result = parseDeployServiceJobPayload({ ...valid(), actor: { type: 'system' } });
    expect(result.ok).toBe(true);
  });

  it.each([
    ['source', { repositoryUrl: 'https://example.test/a.git' }],
    ['token', 'ghp_should_never_be_here'],
    ['password', 'hunter2'],
    ['host', '10.0.0.1'],
  ])('rejects an extra top-level field (%s): the payload carries ids only', (field, value) => {
    const result = parseDeployServiceJobPayload({ ...valid(), [field]: value });
    expect(result.ok).toBe(false);
  });

  it('rejects an extra field on the actor', () => {
    const result = parseDeployServiceJobPayload({ ...valid(), actor: { type: 'system', id: USER_ID } });
    expect(result.ok).toBe(false);
  });

  it.each(['deploymentId', 'serviceId', 'actor', 'requestedAt'])('rejects a payload missing %s', (field) => {
    const payload = valid();
    Reflect.deleteProperty(payload, field);
    expect(parseDeployServiceJobPayload(payload).ok).toBe(false);
  });

  it('rejects non-uuid ids and a non-ISO timestamp', () => {
    expect(parseDeployServiceJobPayload({ ...valid(), deploymentId: '../etc' }).ok).toBe(false);
    expect(parseDeployServiceJobPayload({ ...valid(), serviceId: 'x' }).ok).toBe(false);
    expect(parseDeployServiceJobPayload({ ...valid(), requestedAt: 'yesterday' }).ok).toBe(false);
  });

  it('never echoes the received value in the failure message, only field paths', () => {
    const result = parseDeployServiceJobPayload({ ...valid(), deploymentId: 'SECRET-CANARY-123' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('deploymentId');
    expect(result.message).not.toContain('SECRET-CANARY-123');
  });

  it('never throws on garbage input', () => {
    for (const garbage of [null, undefined, 42, 'str', [], { actor: null }]) {
      expect(() => parseDeployServiceJobPayload(garbage)).not.toThrow();
      expect(parseDeployServiceJobPayload(garbage).ok).toBe(false);
    }
  });

  it('exposes a strict schema', () => {
    expect(DeployServiceJobPayloadSchema.safeParse({ ...valid(), extra: 1 }).success).toBe(false);
  });
});
