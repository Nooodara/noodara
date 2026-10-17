import { describe, expect, it } from 'vitest';
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
