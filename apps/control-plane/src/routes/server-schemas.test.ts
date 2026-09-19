import { describe, expect, it } from 'vitest';
import { SERVER_VIEW_KEYS } from '../services/server-view.js';
import {
  assertDiscoveryCheckSchemaLiteralsMatch,
  assertServerViewSchemaKeysMatch,
  CreateServerBodySchema,
  DeleteServerBodySchema,
  DiscoveryCheckSchema,
  DiscoveryReadResponseSchema,
  ServerIdParamSchema,
  ServerViewSchema,
  toCredentialInput,
  UpdateServerBodySchema,
  WireCredentialSchema,
} from './server-schemas.js';

describe('toCredentialInput (D-19)', () => {
  it('maps a private-key wire credential without a passphrase', () => {
    const result = toCredentialInput({ type: 'ssh_private_key', privateKey: 'PRIVATE_KEY_CONTENT' });
    expect(result).toEqual({ kind: 'private_key', privateKey: 'PRIVATE_KEY_CONTENT' });
  });

  it('maps a private-key wire credential with a passphrase', () => {
    const result = toCredentialInput({
      type: 'ssh_private_key',
      privateKey: 'PRIVATE_KEY_CONTENT',
      passphrase: 'shh',
    });
    expect(result).toEqual({ kind: 'private_key', privateKey: 'PRIVATE_KEY_CONTENT', passphrase: 'shh' });
  });

  it('maps a password wire credential', () => {
    const result = toCredentialInput({ type: 'ssh_password', password: 'hunter2' });
    expect(result).toEqual({ kind: 'password', password: 'hunter2' });
  });
});

describe('WireCredentialSchema (D-19)', () => {
  it('accepts a valid private-key credential', () => {
    const result = WireCredentialSchema.safeParse({ type: 'ssh_private_key', privateKey: 'x' });
    expect(result.success).toBe(true);
  });

  it('accepts a valid password credential', () => {
    const result = WireCredentialSchema.safeParse({ type: 'ssh_password', password: 'x' });
    expect(result.success).toBe(true);
  });

  it('rejects a private-key credential carrying an extra unknown key', () => {
    const result = WireCredentialSchema.safeParse({
      type: 'ssh_private_key',
      privateKey: 'x',
      extra: 'nope',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a password credential missing its password', () => {
    const result = WireCredentialSchema.safeParse({ type: 'ssh_password' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown discriminant value', () => {
    const result = WireCredentialSchema.safeParse({ type: 'ssh_key_pair', privateKey: 'x' });
    expect(result.success).toBe(false);
  });
});

describe('CreateServerBodySchema (D-19)', () => {
  it('accepts a minimal valid body', () => {
    const result = CreateServerBodySchema.safeParse({
      name: 'srv-1',
      host: 'example.test',
      credential: { type: 'ssh_password', password: 'x' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a body missing credential', () => {
    const result = CreateServerBodySchema.safeParse({ name: 'srv-1', host: 'example.test' });
    expect(result.success).toBe(false);
  });

  it('rejects a body with an unknown top-level key', () => {
    const result = CreateServerBodySchema.safeParse({
      name: 'srv-1',
      host: 'example.test',
      credential: { type: 'ssh_password', password: 'x' },
      extra: true,
    });
    expect(result.success).toBe(false);
  });
});

describe('UpdateServerBodySchema (D-19)', () => {
  it('accepts an empty body (no fields changed)', () => {
    const result = UpdateServerBodySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts a body with only name', () => {
    const result = UpdateServerBodySchema.safeParse({ name: 'srv-2' });
    expect(result.success).toBe(true);
  });

  it('rejects a body with an unknown top-level key', () => {
    const result = UpdateServerBodySchema.safeParse({ extra: true });
    expect(result.success).toBe(false);
  });
});

describe('ServerIdParamSchema / DeleteServerBodySchema (D-19)', () => {
  it('rejects a non-uuid id', () => {
    const result = ServerIdParamSchema.safeParse({ id: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('accepts a valid uuid id', () => {
    const result = ServerIdParamSchema.safeParse({ id: '00000000-0000-7000-8000-000000000000' });
    expect(result.success).toBe(true);
  });

  it('rejects an empty confirmName', () => {
    const result = DeleteServerBodySchema.safeParse({ confirmName: '' });
    expect(result.success).toBe(false);
  });
});

describe('ServerViewSchema (D-19)', () => {
  it('has exactly the SERVER_VIEW_KEYS field set — a drift guard for both directions', () => {
    expect(assertServerViewSchemaKeysMatch()).toBe(true);
    expect(Object.keys(ServerViewSchema.shape).sort()).toEqual([...SERVER_VIEW_KEYS].sort());
  });
});

describe('DiscoveryCheckSchema (D-05, DISC-02)', () => {
  it('accepts a well-formed check', () => {
    const result = DiscoveryCheckSchema.safeParse({
      id: 'hostname',
      status: 'pass',
      detail: 'ok',
      durationMs: 12,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown id', () => {
    const result = DiscoveryCheckSchema.safeParse({
      id: 'not_a_real_check',
      status: 'pass',
      detail: 'ok',
      durationMs: 12,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown status', () => {
    const result = DiscoveryCheckSchema.safeParse({
      id: 'hostname',
      status: 'errored',
      detail: 'ok',
      durationMs: 12,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing detail', () => {
    const result = DiscoveryCheckSchema.safeParse({ id: 'hostname', status: 'pass', durationMs: 12 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-numeric durationMs', () => {
    const result = DiscoveryCheckSchema.safeParse({
      id: 'hostname',
      status: 'pass',
      detail: 'ok',
      durationMs: '12',
    });
    expect(result.success).toBe(false);
  });

  it('has exactly the DISCOVERY_CHECK_IDS/DISCOVERY_CHECK_STATUSES literal sets — a drift guard', () => {
    expect(assertDiscoveryCheckSchemaLiteralsMatch()).toBe(true);
  });
});

describe('DiscoveryReadResponseSchema (D-05, DISC-02)', () => {
  it('accepts the empty shape', () => {
    const result = DiscoveryReadResponseSchema.safeParse({
      collectedAt: null,
      outcome: null,
      checks: [],
      warnings: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a populated shape', () => {
    const result = DiscoveryReadResponseSchema.safeParse({
      collectedAt: new Date(),
      outcome: 'ok',
      checks: [{ id: 'hostname', status: 'pass', detail: 'ok', durationMs: 12 }],
      warnings: ['UNSUPPORTED_OS'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an object carrying an extra key such as facts', () => {
    const result = DiscoveryReadResponseSchema.safeParse({
      collectedAt: null,
      outcome: null,
      checks: [],
      warnings: [],
      facts: {},
    });
    expect(result.success).toBe(false);
  });
});
