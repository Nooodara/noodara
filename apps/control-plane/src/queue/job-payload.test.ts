import { describe, expect, it } from 'vitest';
import { ConnectServerJobPayloadSchema, parseConnectServerJobPayload } from './job-payload.js';

// D-11: this contract is what keeps host/user/credential detail out of Redis. Every behaviour
// here is a security control, not a convenience — a payload the schema accepts is a payload the
// worker will trust.

const VALID_USER_PAYLOAD = {
  serverId: '11111111-1111-4111-8111-111111111111',
  actor: { type: 'user', id: '22222222-2222-4222-8222-222222222222' },
  requestedAt: '2026-09-17T12:00:00.000Z',
  trigger: 'connect',
};

describe('ConnectServerJobPayloadSchema', () => {
  it('parses a valid user-actor connect payload', () => {
    const result = ConnectServerJobPayloadSchema.safeParse(VALID_USER_PAYLOAD);

    expect(result.success).toBe(true);
  });

  it('parses trigger "discover"', () => {
    const result = ConnectServerJobPayloadSchema.safeParse({ ...VALID_USER_PAYLOAD, trigger: 'discover' });

    expect(result.success).toBe(true);
  });

  it('rejects trigger "reboot"', () => {
    const result = ConnectServerJobPayloadSchema.safeParse({ ...VALID_USER_PAYLOAD, trigger: 'reboot' });

    expect(result.success).toBe(false);
  });

  it('parses a system actor with no id', () => {
    const result = ConnectServerJobPayloadSchema.safeParse({ ...VALID_USER_PAYLOAD, actor: { type: 'system' } });

    expect(result.success).toBe(true);
  });

  it('rejects a user actor with no id', () => {
    const result = ConnectServerJobPayloadSchema.safeParse({ ...VALID_USER_PAYLOAD, actor: { type: 'user' } });

    expect(result.success).toBe(false);
  });

  it('rejects a payload carrying an extra privateKey key (strict, D-11)', () => {
    const result = ConnectServerJobPayloadSchema.safeParse({ ...VALID_USER_PAYLOAD, privateKey: 'not-allowed' });

    expect(result.success).toBe(false);
  });

  it('rejects a payload carrying an extra host key (strict, D-11)', () => {
    const result = ConnectServerJobPayloadSchema.safeParse({ ...VALID_USER_PAYLOAD, host: '10.0.0.1' });

    expect(result.success).toBe(false);
  });

  it('rejects a payload carrying an extra password key (strict, D-11)', () => {
    const result = ConnectServerJobPayloadSchema.safeParse({ ...VALID_USER_PAYLOAD, password: 'hunter2' });

    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO requestedAt', () => {
    const result = ConnectServerJobPayloadSchema.safeParse({ ...VALID_USER_PAYLOAD, requestedAt: 'not-a-date' });

    expect(result.success).toBe(false);
  });

  it('rejects a missing serverId', () => {
    const { serverId: _serverId, ...withoutServerId } = VALID_USER_PAYLOAD;

    const result = ConnectServerJobPayloadSchema.safeParse(withoutServerId);

    expect(result.success).toBe(false);
  });
});

describe('parseConnectServerJobPayload', () => {
  it('returns { ok: true, payload } for a valid payload', () => {
    const result = parseConnectServerJobPayload(VALID_USER_PAYLOAD);

    expect(result).toEqual({ ok: true, payload: VALID_USER_PAYLOAD });
  });

  it('never throws and returns { ok: false } for null', () => {
    expect(() => parseConnectServerJobPayload(null)).not.toThrow();
    const result = parseConnectServerJobPayload(null);

    expect(result.ok).toBe(false);
  });

  it('never throws and returns { ok: false } for undefined', () => {
    expect(() => parseConnectServerJobPayload(undefined)).not.toThrow();
    const result = parseConnectServerJobPayload(undefined);

    expect(result.ok).toBe(false);
  });

  it('never throws and returns { ok: false } for a string', () => {
    expect(() => parseConnectServerJobPayload('tampered')).not.toThrow();
    const result = parseConnectServerJobPayload('tampered');

    expect(result.ok).toBe(false);
  });

  it('names only failing field paths, never the received value, in the failure message', () => {
    const tampered = { ...VALID_USER_PAYLOAD, serverId: 'super-secret-not-a-uuid-canary' };

    const result = parseConnectServerJobPayload(tampered);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.message).not.toContain('super-secret-not-a-uuid-canary');
    expect(result.message).toContain('serverId');
  });
});
