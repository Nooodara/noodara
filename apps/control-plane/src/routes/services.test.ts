import { describe, expect, it } from 'vitest';
import { CreateServiceBodySchema, UpdateServiceBodySchema } from '@noodara/domain/api-contract';
import {
  WEBHOOK_DELIVERIES_DEFAULT_LIMIT,
  WEBHOOK_DELIVERIES_MAX_LIMIT,
  WebhookDeliveriesQuerySchema,
  decodeDeliveriesCursor,
  encodeDeliveriesCursor,
} from './services.js';

const ID = '01900000-0000-7000-8000-000000000001';

describe('webhook deliveries query (19-03 H3)', () => {
  it('defaults and caps the page size', () => {
    expect(WebhookDeliveriesQuerySchema.parse({}).limit).toBe(WEBHOOK_DELIVERIES_DEFAULT_LIMIT);
    expect(WebhookDeliveriesQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(WebhookDeliveriesQuerySchema.safeParse({ limit: String(WEBHOOK_DELIVERIES_MAX_LIMIT + 1) }).success).toBe(false);
    expect(WebhookDeliveriesQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(WebhookDeliveriesQuerySchema.safeParse({ limit: 'abc' }).success).toBe(false);
    expect(WebhookDeliveriesQuerySchema.safeParse({ limit: '1.5' }).success).toBe(false);
  });

  it('bounds the cursor length', () => {
    expect(WebhookDeliveriesQuerySchema.safeParse({ cursor: 'a'.repeat(129) }).success).toBe(false);
    expect(WebhookDeliveriesQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
  });

  it('round-trips a cursor and rejects malformed ones', () => {
    const at = new Date('2026-10-16T12:00:00.000Z');
    expect(decodeDeliveriesCursor(encodeDeliveriesCursor(at, ID))).toEqual({ receivedAt: at, id: ID });
    const forged = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const bad of [
      'not base64 !!',
      'AAAA',
      forged({ t: 'yesterday', id: ID }),
      forged({ t: at.toISOString(), id: "1' OR 1=1" }),
      forged({ t: at.toISOString(), id: ID, extra: 1 }),
      forged([1, 2]),
    ]) {
      expect(decodeDeliveriesCursor(bad)).toBeNull();
    }
  });
});

describe('service bodies: healthcheck and autoRollback (19-07 A1)', () => {
  const timing = { probeTimeoutS: 3, intervalS: 5, retries: 3, startPeriodS: 0 };
  const ENV = { environmentId: ID };

  it('accepts a valid healthcheck, null and a boolean autoRollback on create and edit', () => {
    const tcp = { type: 'tcp', port: 80, ...timing };
    expect(CreateServiceBodySchema.safeParse({ ...ENV, healthcheck: tcp, autoRollback: false }).success).toBe(true);
    expect(UpdateServiceBodySchema.safeParse({ healthcheck: null }).success).toBe(true);
    expect(UpdateServiceBodySchema.safeParse({ autoRollback: true }).success).toBe(true);
  });

  it('rejects an invalid healthcheck with the domain validator message', () => {
    const result = UpdateServiceBodySchema.safeParse({ healthcheck: { type: 'tcp', port: 0, ...timing } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Healthcheck port must be an integer from 1 to 65535');
    expect(CreateServiceBodySchema.safeParse({ ...ENV, healthcheck: { type: 'udp' } }).success).toBe(false);
  });

  it('rejects a non-boolean autoRollback', () => {
    expect(UpdateServiceBodySchema.safeParse({ autoRollback: 'yes' }).success).toBe(false);
  });
});
