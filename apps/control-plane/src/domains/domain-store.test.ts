// 22-04: the certificate columns' writes. A fake pg client records every statement drizzle sends,
// so these tests pin the SQL (the FAILED -> PENDING retry, the compare-and-set on updated_at) and
// the order of writes in one transaction without a database.
import { getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import * as schema from '../db/schema/index.js';
import { services } from '../db/schema/services.js';
import {
  listCertCandidates,
  markProxyUnavailable,
  recordRouteRestored,
  setDnsResult,
  updateDomainRedirect,
  writeCertStatus,
} from './domain-store.js';

interface Query {
  readonly text: string;
  readonly values: readonly unknown[];
}

type Responder = (query: Query) => unknown[][] | Record<string, unknown>[];

function fakeDb(respond: Responder = () => []): { db: Database; queries: Query[] } {
  const queries: Query[] = [];
  const client = {
    query: (input: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
      const query = typeof input === 'string' ? { text: input, values: values ?? [] } : { text: input.text, values: input.values ?? values ?? [] };
      queries.push(query);
      const rows = respond(query);
      return Promise.resolve({ rows, rowCount: rows.length, fields: [] });
    },
  };
  return { db: drizzle(client as never, { schema, casing: 'snake_case' }), queries };
}

function rowFor(table: typeof services, record: Record<string, unknown>): unknown[] {
  return Object.keys(getTableColumns(table)).map((key) => record[key] ?? null);
}

const AT = new Date('2026-10-31T10:00:00.000Z');
const BEFORE = new Date('2026-10-31T09:59:00.000Z');
const DOMAIN_ID = '0192f1a4-7b3c-7d2e-8f00-00000000d001';
const SERVICE_ID = '0192f1a4-7b3c-7d2e-8f00-00000000bbbb';
const SCOPE = { projectId: '0192f1a4-7b3c-7d2e-8f00-00000000aaa1', serviceId: SERVICE_ID, domainId: DOMAIN_ID };

const SERVICE_RECORD = {
  id: SERVICE_ID,
  projectId: SCOPE.projectId,
  environmentId: '0192f1a4-7b3c-7d2e-8f00-00000000aaa2',
  serverId: '0192f1a4-7b3c-7d2e-8f00-00000000aaa3',
  name: 'api',
  sourceType: 'git',
  status: 'RUNNING',
  internalPort: 3000,
  autoRollback: true,
  imageRetention: 3,
  createdAt: BEFORE,
  updatedAt: AT,
};

const updates = (queries: Query[], table: string) => queries.filter((q) => q.text.startsWith(`update "${table}"`));

describe('setDnsResult (22-04 A2)', () => {
  it('a resolving DNS check returns a FAILED certificate to PENDING and clears its cause', async () => {
    const { db, queries } = fakeDb();
    await setDnsResult(db, DOMAIN_ID, { status: 'RESOLVES', at: AT });
    const [update] = updates(queries, 'domains');
    expect(update?.text).toMatch(/"cert_status" = CASE WHEN "domains"\."cert_status" = 'FAILED' THEN 'PENDING'/);
    expect(update?.text).toMatch(/"cert_error_code" = CASE WHEN "domains"\."cert_status" = 'FAILED' THEN NULL/);
  });

  it.each(['MISMATCH', 'UNRESOLVED', 'UNAVAILABLE'] as const)('a %s DNS check leaves the certificate alone', async (status) => {
    const { db, queries } = fakeDb();
    await setDnsResult(db, DOMAIN_ID, { status, at: AT });
    const [update] = updates(queries, 'domains');
    expect(update?.text.split(' where ')[0]).not.toContain('cert_status');
  });
});

describe('updateDomainRedirect (22-04 A2)', () => {
  it('a PATCH returns a FAILED certificate to PENDING', async () => {
    const { db, queries } = fakeDb();
    await updateDomainRedirect(db, { actor: { type: 'system' }, scope: SCOPE, httpsRedirect: false, at: AT });
    const [update] = updates(queries, 'domains');
    expect(update?.text).toMatch(/"cert_status" = CASE WHEN "domains"\."cert_status" = 'FAILED' THEN 'PENDING'/);
  });
});

describe('listCertCandidates (22-04 A1)', () => {
  it('reads domains with a certificate lifecycle on servers whose proxy is RUNNING or FAILED', async () => {
    const { db, queries } = fakeDb();
    await listCertCandidates(db);
    const [select] = queries;
    expect(select?.text).toContain('"domains"."cert_status" <> $');
    expect(select?.values).toContain('NONE');
    expect(select?.values).toEqual(expect.arrayContaining(['RUNNING', 'FAILED']));
  });
});

describe('writeCertStatus (22-04 A1, A3, H1)', () => {
  const write = {
    domainId: DOMAIN_ID,
    serviceId: SERVICE_ID,
    expectedUpdatedAt: BEFORE,
    status: 'ISSUED' as const,
    notAfter: new Date('2027-01-29T10:00:00.000Z'),
    errorCode: null,
    at: AT,
  };

  it('is a compare-and-set on (id, updated_at): a concurrent change writes nothing else', async () => {
    const { db, queries } = fakeDb();
    const result = await writeCertStatus(db, { ...write, activity: { action: 'domain.certificate_issued', previousStatus: 'PENDING' } });
    expect(result).toBeNull();
    const [update] = updates(queries, 'domains');
    expect(update?.text).toMatch(/where \("domains"\."id" = \$\d+ and "domains"\."updated_at" = \$\d+\)/);
    expect(update?.values).toContain(BEFORE.toISOString());
    expect(queries.some((q) => q.text.startsWith('insert into "activity_events"'))).toBe(false);
    expect(updates(queries, 'services')).toHaveLength(0);
  });

  it('writes the status, bumps the service, records the activity event and returns the service view', async () => {
    const { db, queries } = fakeDb((query) => {
      if (query.text.startsWith('update "domains"')) return [[SERVICE_ID, AT]];
      if (query.text.startsWith('update "services"')) return [rowFor(services, SERVICE_RECORD)];
      if (query.text.startsWith('insert into "activity_events"')) return [['0192f1a4-7b3c-7d2e-8f00-00000000eeee']];
      return [];
    });
    const result = await writeCertStatus(db, { ...write, activity: { action: 'domain.certificate_issued', previousStatus: 'PENDING' } });
    expect(result?.updatedAt).toEqual(AT);
    expect(result?.view.id).toBe(SERVICE_ID);
    const [update] = updates(queries, 'domains');
    expect(update?.values).toEqual(expect.arrayContaining(['ISSUED', write.notAfter.toISOString()]));
    const insert = queries.find((q) => q.text.startsWith('insert into "activity_events"'));
    expect(insert?.values).toEqual(expect.arrayContaining(['domain', DOMAIN_ID, 'domain.certificate_issued']));
    expect(JSON.stringify(insert?.values)).not.toContain('BEGIN CERTIFICATE');
    expect(queries[0]?.text).toBe('begin');
    expect(queries.at(-1)?.text).toBe('commit');
  });

  it('writes no activity event when the change has none (e.g. a proxy-unavailable annotation)', async () => {
    const { db, queries } = fakeDb((query) => {
      if (query.text.startsWith('update "domains"')) return [[SERVICE_ID, AT]];
      if (query.text.startsWith('update "services"')) return [rowFor(services, SERVICE_RECORD)];
      return [];
    });
    const result = await writeCertStatus(db, { ...write, status: 'PENDING', notAfter: null, errorCode: 'CERT_PROXY_UNAVAILABLE' });
    expect(result).not.toBeNull();
    expect(queries.some((q) => q.text.startsWith('insert into "activity_events"'))).toBe(false);
  });
});

describe('markProxyUnavailable (22-04 H2)', () => {
  const SERVER_ID = SERVICE_RECORD.serverId;

  it('moves RUNNING -> FAILED/PROXY_UNAVAILABLE and records server.proxy_failed in the same transaction', async () => {
    const { db, queries } = fakeDb((query) => {
      if (query.text.startsWith('update "servers"')) return [[SERVER_ID]];
      if (query.text.startsWith('insert into "activity_events"')) return [['0192f1a4-7b3c-7d2e-8f00-00000000eeee']];
      return [];
    });
    await markProxyUnavailable(db, SERVER_ID, AT);
    const [update] = updates(queries, 'servers');
    expect(update?.values).toEqual(expect.arrayContaining(['FAILED', 'PROXY_UNAVAILABLE', SERVER_ID, 'RUNNING']));
    expect(update?.text).toMatch(/"servers"\."proxy_status" = \$\d+/);
    const insert = queries.find((q) => q.text.startsWith('insert into "activity_events"'));
    expect(insert?.values).toEqual(expect.arrayContaining(['server', SERVER_ID, 'server.proxy_failed', 'failure', 'PROXY_UNAVAILABLE']));
    expect(JSON.stringify(insert?.values)).toContain('cert_check');
    expect(queries[0]?.text).toBe('begin');
    expect(queries.at(-1)?.text).toBe('commit');
  });

  it('writes no activity event when the row is no longer RUNNING (recorded once, not every cycle)', async () => {
    const { db, queries } = fakeDb();
    const result = await markProxyUnavailable(db, SERVER_ID, AT);
    expect(result).toBeNull();
    expect(queries.some((q) => q.text.startsWith('insert into "activity_events"'))).toBe(false);
  });
});

describe('recordRouteRestored (22-08 A9)', () => {
  const INPUT = { serviceId: SERVICE_ID, durationMs: 120.4, at: AT };

  it('is a compare-and-set on the service still having an APPLIED domain: none left writes no event', async () => {
    const { db, queries } = fakeDb();
    expect(await recordRouteRestored(db, INPUT)).toBeNull();
    const [update] = updates(queries, 'services');
    expect(update?.text).toMatch(/exists \(select 1 from "domains" where "domains"\."service_id" = "services"\."id" and "domains"\."apply_status" = 'APPLIED'\)/);
    expect(queries.some((q) => q.text.startsWith('insert into "activity_events"'))).toBe(false);
  });

  it('bumps the service first, then records domain.route_restored in the same transaction', async () => {
    const { db, queries } = fakeDb((query) => {
      if (query.text.startsWith('update "services"')) return [rowFor(services, SERVICE_RECORD)];
      if (query.text.startsWith('insert into "activity_events"')) return [['0192f1a4-7b3c-7d2e-8f00-00000000eeee']];
      return [];
    });
    const view = await recordRouteRestored(db, INPUT);
    expect(view?.id).toBe(SERVICE_ID);
    const texts = queries.map((q) => q.text);
    const bump = texts.findIndex((t) => t.startsWith('update "services"'));
    const event = texts.findIndex((t) => t.startsWith('insert into "activity_events"'));
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(event).toBeGreaterThan(bump);
    expect(texts[0]).toBe('begin');
  });
});
