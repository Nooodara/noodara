import { describe, expect, it } from 'vitest';
import { MAX_ENV_VALUE_BYTES } from '@noodara/domain';
import {
  CreateVariableRouteBodySchema,
  EffectiveEnvResponseSchema,
  ENV_ROUTE_BODY_LIMIT_BYTES,
  UpdateVariableRouteBodySchema,
  VariableListResponseSchema,
} from './env-schemas.js';

describe('env route schemas (23-02 A1, H1, H2)', () => {
  it('create is strict: key and value only', () => {
    expect(CreateVariableRouteBodySchema.safeParse({ key: 'A', value: 'x' }).success).toBe(true);
    expect(CreateVariableRouteBodySchema.safeParse({ key: 'A', value: 'x', scope: 'project' }).success).toBe(false);
    expect(CreateVariableRouteBodySchema.safeParse({ key: 'A' }).success).toBe(false);
  });

  it('update takes a value and an optional key, nothing else', () => {
    expect(UpdateVariableRouteBodySchema.safeParse({ value: 'x' }).success).toBe(true);
    expect(UpdateVariableRouteBodySchema.safeParse({ key: 'A', value: 'x' }).success).toBe(true);
    expect(UpdateVariableRouteBodySchema.safeParse({ value: 'x', id: 'y' }).success).toBe(false);
  });

  it('caps the value length and the body', () => {
    expect(CreateVariableRouteBodySchema.safeParse({ key: 'A', value: 'x'.repeat(MAX_ENV_VALUE_BYTES + 1) }).success).toBe(false);
    expect(ENV_ROUTE_BODY_LIMIT_BYTES).toBeGreaterThanOrEqual(MAX_ENV_VALUE_BYTES * 6);
    expect(ENV_ROUTE_BODY_LIMIT_BYTES).toBeLessThan(256 * 1024);
  });

  it('responses are strict allowlists', () => {
    const variable = {
      id: '0190a000-0000-7000-8000-000000000000',
      scope: 'project',
      key: 'A',
      value: 'x',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    };
    expect(VariableListResponseSchema.safeParse({ items: [variable] }).success).toBe(true);
    expect(VariableListResponseSchema.safeParse({ items: [{ ...variable, secretValue: 'x' }] }).success).toBe(false);
    const effective = { key: 'A', origin: 'service', value: { kind: 'secret_ref', name: 'db' }, shadowed: [] };
    expect(EffectiveEnvResponseSchema.safeParse({ items: [effective], differsFromRunning: false }).success).toBe(true);
    expect(EffectiveEnvResponseSchema.safeParse({ items: [effective] }).success).toBe(false);
    expect(
      EffectiveEnvResponseSchema.safeParse({
        items: [{ ...effective, value: { kind: 'secret_ref', name: 'db', value: 'leak' } }],
        differsFromRunning: false,
      }).success,
    ).toBe(false);
  });
});
