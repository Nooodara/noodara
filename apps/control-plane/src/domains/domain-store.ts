// 22-03: the domains' persistence. Every read is scoped by (projectId, serviceId[, domainId]), so a
// foreign project id finds nothing (404, no existence leak). The insert locks the service row, so
// the per-service limit holds under concurrent POSTs; the global hostname uniqueness is the unique
// index's (mapUniqueViolation -> DOMAIN_ALREADY_ASSIGNED, H1). The row and its activity event are
// written in one transaction (A1).
import {
  domainAdmissionRejection,
  initialDomainCertState,
  validateHostname,
  type DomainAdmissionRejection,
  type DomainCreateInput,
  type ProxyRouteDomain,
  type ProxyStatus,
} from '@noodara/domain';
import { mapUniqueViolation, type DomainApplyStatus } from '@noodara/domain/api-contract';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { writeServiceDomainsChangedEvent } from '../activity/domain-events.js';
import type { Database } from '../db/client.js';
import { domains } from '../db/schema/domains.js';
import { servers } from '../db/schema/servers.js';
import { services } from '../db/schema/services.js';
import type { ServiceActor } from '../services/server-service-deps.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Handle = Database | Tx;

export type DomainRow = typeof domains.$inferSelect;

export interface DomainServiceTarget {
  readonly serviceId: string;
  readonly projectId: string;
  readonly internalPort: number;
  readonly serverId: string;
  readonly serverHost: string;
  readonly proxyStatus: ProxyStatus;
}

const TARGET_COLUMNS = {
  serviceId: services.id,
  projectId: services.projectId,
  internalPort: services.internalPort,
  serverId: services.serverId,
  serverHost: servers.host,
  proxyStatus: servers.proxyStatus,
};

export async function loadServiceTarget(db: Handle, projectId: string, serviceId: string): Promise<DomainServiceTarget | null> {
  const [row] = await db
    .select(TARGET_COLUMNS)
    .from(services)
    .innerJoin(servers, eq(servers.id, services.serverId))
    .where(and(eq(services.id, serviceId), eq(services.projectId, projectId)))
    .limit(1);
  return row ?? null;
}

/** The service's target by id only: the apply path, after the request was already scoped. */
export async function loadServiceTargetById(db: Handle, serviceId: string): Promise<DomainServiceTarget | null> {
  const [row] = await db
    .select(TARGET_COLUMNS)
    .from(services)
    .innerJoin(servers, eq(servers.id, services.serverId))
    .where(eq(services.id, serviceId))
    .limit(1);
  return row ?? null;
}

export function listServiceDomains(db: Handle, serviceId: string): Promise<DomainRow[]> {
  return db.select().from(domains).where(eq(domains.serviceId, serviceId)).orderBy(asc(domains.createdAt), asc(domains.id));
}

export async function loadDomain(db: Handle, scope: { projectId: string; serviceId: string; domainId: string }): Promise<DomainRow | null> {
  const [row] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.id, scope.domainId), eq(domains.serviceId, scope.serviceId), eq(domains.projectId, scope.projectId)))
    .limit(1);
  return row ?? null;
}

/** Rows as the renderer needs them; a stored hostname that no longer validates is skipped. */
export function toRouteDomains(rows: readonly DomainRow[]): ProxyRouteDomain[] {
  const out: ProxyRouteDomain[] = [];
  for (const row of rows) {
    const hostname = validateHostname(row.hostname);
    if (hostname.ok) out.push({ id: row.id, hostname: hostname.value, httpsRedirect: row.httpsRedirect });
  }
  return out;
}

async function recordDomainsChanged(tx: Tx, actor: ServiceActor, serviceId: string, at: Date): Promise<void> {
  await writeServiceDomainsChangedEvent(tx, { actor, serviceId }, at);
}

export type InsertDomainResult =
  | { readonly ok: true; readonly row: DomainRow }
  | { readonly ok: false; readonly code: 'NOT_FOUND' | 'DOMAIN_ALREADY_ASSIGNED' | DomainAdmissionRejection };

export async function insertDomain(
  db: Database,
  input: {
    readonly actor: ServiceActor;
    readonly projectId: string;
    readonly serviceId: string;
    readonly domain: DomainCreateInput;
    readonly publicUrlHost: string | null;
    readonly at: Date;
  },
): Promise<InsertDomainResult> {
  try {
    return await db.transaction(async (tx): Promise<InsertDomainResult> => {
      const [service] = await tx
        .select({ id: services.id })
        .from(services)
        .where(and(eq(services.id, input.serviceId), eq(services.projectId, input.projectId)))
        .for('update');
      if (!service) return { ok: false, code: 'NOT_FOUND' };
      const [counted] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(domains)
        .where(eq(domains.serviceId, service.id));
      const rejection = domainAdmissionRejection({
        hostname: input.domain.hostname,
        publicUrlHost: input.publicUrlHost,
        existingDomainCount: counted?.count ?? 0,
      });
      if (rejection !== null) return { ok: false, code: rejection };
      const [row] = await tx
        .insert(domains)
        .values({
          projectId: input.projectId,
          serviceId: service.id,
          hostname: input.domain.hostname,
          httpsRedirect: input.domain.httpsRedirect,
          ...initialDomainCertState(),
          applyStatus: 'PENDING',
          createdAt: input.at,
          updatedAt: input.at,
        })
        .returning();
      if (!row) throw new Error('domain insert returned no row');
      await recordDomainsChanged(tx, input.actor, service.id, input.at);
      return { ok: true, row };
    });
  } catch (error) {
    if (mapUniqueViolation(error) === 'DOMAIN_ALREADY_ASSIGNED') return { ok: false, code: 'DOMAIN_ALREADY_ASSIGNED' };
    throw error;
  }
}

export async function updateDomainRedirect(
  db: Database,
  input: {
    readonly actor: ServiceActor;
    readonly scope: { projectId: string; serviceId: string; domainId: string };
    readonly httpsRedirect: boolean;
    readonly at: Date;
  },
): Promise<DomainRow | null> {
  return db.transaction(async (tx) => {
    const { scope } = input;
    const [row] = await tx
      .update(domains)
      .set({ httpsRedirect: input.httpsRedirect, applyStatus: 'PENDING', updatedAt: input.at })
      .where(and(eq(domains.id, scope.domainId), eq(domains.serviceId, scope.serviceId), eq(domains.projectId, scope.projectId)))
      .returning();
    if (!row) return null;
    await recordDomainsChanged(tx, input.actor, row.serviceId, input.at);
    return row;
  });
}

export async function deleteDomain(
  db: Database,
  input: { readonly actor: ServiceActor; readonly scope: { projectId: string; serviceId: string; domainId: string }; readonly at: Date },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const { scope } = input;
    const [row] = await tx
      .delete(domains)
      .where(and(eq(domains.id, scope.domainId), eq(domains.serviceId, scope.serviceId), eq(domains.projectId, scope.projectId)))
      .returning({ serviceId: domains.serviceId });
    if (!row) return false;
    await recordDomainsChanged(tx, input.actor, row.serviceId, input.at);
    return true;
  });
}

export async function setApplyStatus(db: Handle, ids: readonly string[], status: DomainApplyStatus, at: Date): Promise<void> {
  if (ids.length === 0) return;
  await db.update(domains).set({ applyStatus: status, updatedAt: at }).where(inArray(domains.id, [...ids]));
}

export async function setDnsResult(
  db: Handle,
  domainId: string,
  result: { readonly status: NonNullable<DomainRow['dnsStatus']>; readonly at: Date },
): Promise<DomainRow | null> {
  const [row] = await db
    .update(domains)
    .set({ dnsStatus: result.status, dnsCheckedAt: result.at, updatedAt: result.at })
    .where(eq(domains.id, domainId))
    .returning();
  return row ?? null;
}

/** H3: services with a PENDING route on a RUNNING proxy; the reconcile cycle re-applies them. */
export async function listPendingDomainServices(db: Handle, limit: number): Promise<string[]> {
  const rows = await db
    .selectDistinct({ serviceId: domains.serviceId })
    .from(domains)
    .innerJoin(services, eq(services.id, domains.serviceId))
    .innerJoin(servers, eq(servers.id, services.serverId))
    .where(and(eq(domains.applyStatus, 'PENDING'), eq(servers.proxyStatus, 'RUNNING')))
    .limit(limit);
  return rows.map((row) => row.serviceId);
}
