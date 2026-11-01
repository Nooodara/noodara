import { describe, expect, it } from 'vitest';
import { MAX_SECRET_VALUE_LENGTH } from '@noodara/domain/api-contract';
import {
  CreateSecretRouteBodySchema,
  ReplaceSecretRouteBodySchema,
  SECRET_ROUTE_BODY_LIMIT_BYTES,
  SecretErrorBodySchema,
  SecretListResponseSchema,
  SecretViewSchema,
  ServiceSecretParamsSchema,
} from './secret-schemas.js';

const CANARY = 'canary-91d0-secret';
const VIEW = {
  id: '0190a000-0000-7000-8000-000000000003',
  scope: 'service',
  name: 'api_key',
  version: 1,
  hint: '',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
};

describe('secret route schemas (23-03 A1, H1)', () => {
  it('accepts a name and a string value', () => {
    expect(CreateSecretRouteBodySchema.safeParse({ name: 'api_key', value: CANARY }).success).toBe(true);
    expect(ReplaceSecretRouteBodySchema.safeParse({ value: CANARY }).success).toBe(true);
  });

  it.each<[string, unknown]>([
    ['an extra key', { name: 'api_key', value: CANARY, hint: 'x' }],
    ['a number value', { name: 'api_key', value: 12345 }],
    ['an array value', { name: 'api_key', value: [CANARY] }],
    ['an object value', { name: 'api_key', value: { raw: CANARY } }],
    ['a value over the cap', { name: 'api_key', value: 'a'.repeat(MAX_SECRET_VALUE_LENGTH + 1) }],
    ['a missing value', { name: 'api_key' }],
    ['a name over the cap', { name: 'a'.repeat(65), value: CANARY }],
  ])('create rejects %s', (_label, body) => {
    expect(CreateSecretRouteBodySchema.safeParse(body).success).toBe(false);
  });

  it('replace rejects a name or any extra key', () => {
    expect(ReplaceSecretRouteBodySchema.safeParse({ value: CANARY, name: 'api_key' }).success).toBe(false);
    expect(ReplaceSecretRouteBodySchema.safeParse({ value: 1 }).success).toBe(false);
  });

  it('caps the body to a value written fully as JSON escapes', () => {
    expect(SECRET_ROUTE_BODY_LIMIT_BYTES).toBeGreaterThanOrEqual(MAX_SECRET_VALUE_LENGTH * 6);
    expect(SECRET_ROUTE_BODY_LIMIT_BYTES).toBeLessThan(MAX_SECRET_VALUE_LENGTH * 7);
  });

  it('views are strict and value-free', () => {
    expect(SecretViewSchema.safeParse(VIEW).success).toBe(true);
    expect(SecretViewSchema.safeParse({ ...VIEW, value: CANARY }).success).toBe(false);
    expect(SecretListResponseSchema.safeParse({ items: [{ ...VIEW, encryptedValue: 'x' }] }).success).toBe(false);
  });

  it('the in-use error lists scope and key only', () => {
    const body = { error: 'SECRET_IN_USE', message: 'm', usedBy: [{ scope: 'project', key: 'DB' }] };
    expect(SecretErrorBodySchema.safeParse(body).success).toBe(true);
    expect(SecretErrorBodySchema.safeParse({ ...body, usedBy: [{ scope: 'project', key: 'DB', value: CANARY }] }).success).toBe(
      false,
    );
  });

  it('item params need uuids', () => {
    expect(ServiceSecretParamsSchema.safeParse({ projectId: VIEW.id, serviceId: VIEW.id, secretId: 'x' }).success).toBe(false);
  });
});
