import { describe, expect, it } from 'vitest';
import {
  CreateDomainRouteBodySchema,
  DOMAIN_ROUTE_BODY_LIMIT_BYTES,
  DnsCheckBodySchema,
  DomainListResponseSchema,
  DomainViewSchema,
} from './domain-schemas.js';

const ID = '01900000-0000-7000-8000-000000000001';
const VIEW = {
  id: ID,
  projectId: ID,
  serviceId: ID,
  hostname: 'app.example.com',
  httpsRedirect: true,
  certStatus: 'PENDING',
  certNotAfter: null,
  certErrorCode: null,
  dnsStatus: null,
  dnsCheckedAt: null,
  applyStatus: 'PENDING',
  createdAt: '2026-10-31T00:00:00.000Z',
  updatedAt: '2026-10-31T00:00:00.000Z',
};

describe('domain route schemas (22-03 H2)', () => {
  it('caps the body and the hostname length', () => {
    expect(DOMAIN_ROUTE_BODY_LIMIT_BYTES).toBeLessThanOrEqual(4096);
    expect(CreateDomainRouteBodySchema.safeParse({ hostname: 'a'.repeat(254) }).success).toBe(false);
    expect(CreateDomainRouteBodySchema.safeParse({ hostname: 'app.example.com' }).success).toBe(true);
  });

  it('takes no input on the DNS check', () => {
    expect(DnsCheckBodySchema.safeParse(undefined).success).toBe(true);
    expect(DnsCheckBodySchema.safeParse({}).success).toBe(true);
    expect(DnsCheckBodySchema.safeParse({ resolver: '8.8.8.8' }).success).toBe(false);
  });

  it('serialises the view allowlist only: credentials and ACME internals are refused', () => {
    expect(DomainViewSchema.safeParse(VIEW).success).toBe(true);
    for (const extra of [{ privateKey: 'x' }, { acmeEmail: 'ops@example.com' }, { acmeAccountKey: 'x' }, { credentialId: ID }]) {
      expect(DomainViewSchema.safeParse({ ...VIEW, ...extra }).success).toBe(false);
    }
    expect(DomainListResponseSchema.safeParse({ items: [VIEW], dnsInstructions: [] }).success).toBe(true);
    expect(DomainListResponseSchema.safeParse({ items: [VIEW], dnsInstructions: [], server: {} }).success).toBe(false);
  });
});
