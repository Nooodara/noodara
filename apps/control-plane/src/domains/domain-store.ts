// 22-03: the domains' persistence. Every read is scoped by (projectId, serviceId[, domainId]), so a
// foreign project id finds nothing (404, no existence leak). The insert locks the service row, so
// the per-service limit holds under concurrent POSTs; the global hostname uniqueness is the unique
// index's (mapUniqueViolation -> DOMAIN_ALREADY_ASSIGNED, H1). The row and its activity event are
// written in one transaction (A1).
import {
  domainAdmissionRejection,
  initialDomainCertState,
  retryCertStatus,
  type CertFailureCause,
  type CertStatus,
  validateHostname,
  type DomainAdmissionRejection,
  type DomainCreateInput,
  type ProxyRouteDomain,
  type ProxyStatus,
} from '@noodara/domain';
import { mapUniqueViolation, type DomainApplyStatus } from '@noodara/domain/api-contract';
import type { DomainAction } from '@noodara/domain/activity';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { writeDomainActivityEvent, writeServiceDomainsChangedEvent } from '../activity/domain-events.js';
import { writeProxyActivityEvent } from '../activity/proxy-events.js';
import type { Database } from '../db/client.js';
import { deployments } from '../db/schema/deployments.js';
import { domains } from '../db/schema/domains.js';
import { servers } from '../db/schema/servers.js';
import { services } from '../db/schema/services.js';
import { loadServerView, writeProxyStatus } from '../proxy/proxy-store.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import type { ServerView } from '../services/server-view.js';
import { toServiceView, type ServiceView } from '../services/service-view.js';
import { nextUpdatedAt, nextUpdatedAtSql } from '../services/updated-at.js';

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

/**
 * 22-04 (A2): a FAILED certificate returns to PENDING (its cause cleared) on a resolving DNS check
 * or a PATCH; any other status is kept. The transition is the domain's (`retryCertStatus`); the
 * literals are closed constants, never input.
 */
const RETRY_FROM: CertStatus = 'FAILED';
const RETRY_COLUMNS = {
  certStatus: sql.raw(
    `CASE WHEN "domains"."cert_status" = '${RETRY_FROM}' THEN '${retryCertStatus(RETRY_FROM)}' ELSE "domains"."cert_status" END`,
  ) as unknown as CertStatus,
  certErrorCode: sql.raw(`CASE WHEN "domains"."cert_status" = '${RETRY_FROM}' THEN NULL ELSE "domains"."cert_error_code" END`) as unknown as
    | string
    | null,
};

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
      .set({ httpsRedirect: input.httpsRedirect, applyStatus: 'PENDING', ...RETRY_COLUMNS, updatedAt: input.at })
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
    .set({
      dnsStatus: result.status,
      dnsCheckedAt: result.at,
      ...(result.status === 'RESOLVES' ? RETRY_COLUMNS : {}),
      updatedAt: result.at,
    })
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

/** 22-04: one domain the certificate reconciler probes (never NONE; the server's proxy installed). */
export interface CertCandidate {
  readonly id: string;
  readonly serviceId: string;
  readonly serverId: string;
  readonly hostname: string;
  readonly certStatus: CertStatus;
  readonly certNotAfter: Date | null;
  readonly certErrorCode: string | null;
  readonly dnsStatus: DomainRow['dnsStatus'];
  readonly applyStatus: string;
  readonly updatedAt: Date;
  readonly proxyStatus: ProxyStatus;
}

export function listCertCandidates(db: Handle): Promise<CertCandidate[]> {
  return db
    .select({
      id: domains.id,
      serviceId: domains.serviceId,
      serverId: services.serverId,
      hostname: domains.hostname,
      certStatus: domains.certStatus,
      certNotAfter: domains.certNotAfter,
      certErrorCode: domains.certErrorCode,
      dnsStatus: domains.dnsStatus,
      applyStatus: domains.applyStatus,
      updatedAt: domains.updatedAt,
      proxyStatus: servers.proxyStatus,
    })
    .from(domains)
    .innerJoin(services, eq(services.id, domains.serviceId))
    .innerJoin(servers, eq(servers.id, services.serverId))
    .where(and(ne(domains.certStatus, 'NONE'), inArray(servers.proxyStatus, ['RUNNING', 'FAILED'])))
    .orderBy(asc(services.serverId), asc(domains.createdAt), asc(domains.id));
}

export interface CertStatusWrite {
  readonly domainId: string;
  readonly serviceId: string;
  /** The row's `updated_at` the decision was made on: a concurrent change wins (no write). */
  readonly expectedUpdatedAt: Date;
  readonly status: CertStatus;
  readonly notAfter: Date | null;
  readonly errorCode: CertFailureCause | null;
  readonly at: Date;
  readonly activity?: { readonly action: Exclude<DomainAction, 'domain.route_restored'>; readonly previousStatus: CertStatus };
}

async function serviceUpdated(tx: Tx, serviceId: string, at: Date): Promise<ServiceView | null> {
  const [service] = await tx
    .update(services)
    .set({ updatedAt: nextUpdatedAtSql(services.updatedAt, at) })
    .where(eq(services.id, serviceId))
    .returning();
  if (!service) return null;
  const [latest] = await tx
    .select({ status: deployments.status })
    .from(deployments)
    .where(eq(deployments.serviceId, serviceId))
    .orderBy(desc(deployments.createdAt), desc(deployments.id))
    .limit(1);
  return toServiceView(service, latest ?? null);
}

/**
 * 22-04 (A1, A3): the certificate decision, the service's `updated_at` bump (so `service.updated`
 * orders) and its activity event in one transaction. Only the status, `notAfter` and the cause
 * are stored: never an issuer or a certificate body (H1). `null` when the row changed meanwhile.
 */
export function writeCertStatus(
  db: Database,
  write: CertStatusWrite,
): Promise<{ readonly view: ServiceView; readonly updatedAt: Date } | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(domains)
      .set({
        certStatus: write.status,
        certNotAfter: write.notAfter,
        certErrorCode: write.errorCode,
        updatedAt: nextUpdatedAt(write.expectedUpdatedAt, write.at),
      })
      .where(and(eq(domains.id, write.domainId), eq(domains.updatedAt, write.expectedUpdatedAt)))
      .returning({ serviceId: domains.serviceId, updatedAt: domains.updatedAt });
    if (!row) return null;
    const view = await serviceUpdated(tx, row.serviceId, write.at);
    if (write.activity !== undefined) {
      const { action, previousStatus } = write.activity;
      await writeDomainActivityEvent(
        tx,
        {
          actorType: 'system',
          entityType: 'domain',
          entityId: write.domainId,
          action,
          outcome: action === 'domain.certificate_issued' ? 'success' : 'failure',
          ...(write.errorCode === null ? {} : { errorCode: write.errorCode }),
          metadata: { serviceId: row.serviceId, previousStatus },
        },
        write.at,
      );
    }
    return view === null ? null : { view, updatedAt: row.updatedAt };
  });
}

/** 22-04 (H4): a routed service's dynamic file was restored on the host. */
export async function recordRouteRestored(
  db: Database,
  input: { readonly serviceId: string; readonly durationMs: number; readonly at: Date },
): Promise<ServiceView | null> {
  return db.transaction(async (tx) => {
    await writeDomainActivityEvent(
      tx,
      {
        actorType: 'system',
        entityType: 'service',
        entityId: input.serviceId,
        action: 'domain.route_restored',
        outcome: 'success',
        metadata: { serviceId: input.serviceId, durationMs: Math.max(0, Math.round(input.durationMs)) },
      },
      input.at,
    );
    return serviceUpdated(tx, input.serviceId, input.at);
  });
}

/**
 * 22-04 (H2): the certificate cycle found no running proxy container on a server marked RUNNING.
 * A conditional RUNNING -> FAILED move, so `server.proxy_failed` is recorded once: a later cycle
 * finds the row already FAILED and writes nothing. `null` when the row was not RUNNING.
 */
export function markProxyUnavailable(db: Database, serverId: string, at: Date): Promise<ServerView | null> {
  return db.transaction(async (tx) => {
    const moved = await writeProxyStatus(tx, serverId, 'RUNNING', 'FAILED', { errorCode: 'PROXY_UNAVAILABLE', at });
    if (!moved) return null;
    await writeProxyActivityEvent(
      tx,
      {
        actorType: 'system',
        actorId: null,
        entityType: 'server',
        entityId: serverId,
        action: 'server.proxy_failed',
        outcome: 'failure',
        errorCode: 'PROXY_UNAVAILABLE',
        metadata: { step: 'status', trigger: 'cert_check' },
      },
      at,
    );
    return loadServerView(tx, serverId);
  });
}
