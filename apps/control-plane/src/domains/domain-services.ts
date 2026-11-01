// 22-03: the domains' request side (routes) and the apply path (routes and reconcile).
// - create: validate + normalise, insert row + activity in one transaction, then ensure the proxy
//   (NOT_INSTALLED | FAILED -> install job; INSTALLING -> the row waits PENDING) or, on a RUNNING
//   proxy, apply the service's routes under the per-service lock.
// - A failed apply keeps the row: PROXY_UNAVAILABLE / SERVER_UNREACHABLE leave it PENDING (the
//   reconcile cycle re-applies it, H3), PROXY_ROUTE_FAILED marks it FAILED (`.prev` is live).
// - delete / patch re-render through the same verify-and-restore path (A2, A4).
// Responses carry the DomainView allowlist only: no server credential, no ACME internals (H2).
import { PROXY_ERROR_MESSAGES, validateDomainCreateInput, validateDomainEditInput, validateResourceId } from '@noodara/domain';
import type { DnsInstructionsView, DomainView } from '@noodara/domain/api-contract';
import type { Redactor } from '@noodara/domain/security';
import type { Database } from '../db/client.js';
import type { ConnectResult } from '../deploy/deploy-worker.js';
import type { ProxyServiceDeps } from '../proxy/proxy-service.js';
import { requestProxyInstall } from '../proxy/proxy-service.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import {
  applyServiceDomains,
  createServiceLock,
  type DomainApplyLimits,
  type DomainApplyResult,
  type DomainRenderer,
} from './domain-apply.js';
import { checkDomainDns, instructionsFor, type DnsCheckLimiter, type DnsResolverLike } from './domain-dns.js';
import {
  deleteDomain,
  insertDomain,
  listPendingDomainServices,
  listServiceDomains,
  loadDomain,
  loadServiceTarget,
  loadServiceTargetById,
  setApplyStatus,
  setDnsResult,
  toRouteDomains,
  updateDomainRedirect,
  type DomainRow,
} from './domain-store.js';

export type ApplyFailureCode = 'PROXY_UNAVAILABLE' | 'PROXY_ROUTE_FAILED' | 'SERVER_UNREACHABLE';
export type ApplyOutcome = { readonly ok: true } | { readonly ok: false; readonly code: ApplyFailureCode };

/** Applies the current rows of one service on its proxy and records each row's apply status. */
export type DomainApplier = (serviceId: string) => Promise<ApplyOutcome>;

export interface DomainApplierDeps {
  readonly db: Database;
  readonly connect: (serverId: string, redactor: Redactor, signal: AbortSignal | undefined) => Promise<ConnectResult>;
  readonly createRedactor: () => Redactor;
  readonly limits: DomainApplyLimits;
  readonly now?: () => Date;
  /** Test seam (A5: a forced invalid write). */
  readonly render?: DomainRenderer;
  readonly lock?: <T>(serviceId: string, task: () => Promise<T>) => Promise<T>;
}

export const SERVER_UNREACHABLE_MESSAGE = 'The server could not be reached over SSH. Check that it is online, then try again.';
export const PROXY_ROUTE_FAILED_MESSAGE =
  'The proxy rejected the new routes; the previous routes were restored. Try again, or remove the domain.';

export const APPLY_FAILURE_MESSAGES: Readonly<Record<ApplyFailureCode, string>> = Object.freeze({
  PROXY_UNAVAILABLE: PROXY_ERROR_MESSAGES.PROXY_UNAVAILABLE,
  PROXY_ROUTE_FAILED: PROXY_ROUTE_FAILED_MESSAGE,
  SERVER_UNREACHABLE: SERVER_UNREACHABLE_MESSAGE,
});

function failedOutcome(result: DomainApplyResult): ApplyOutcome {
  return result.ok ? { ok: true } : { ok: false, code: result.code };
}

export function createDomainApplier(deps: DomainApplierDeps): DomainApplier {
  const now = deps.now ?? (() => new Date());
  const lock = deps.lock ?? createServiceLock();
  return (serviceId) =>
    lock(serviceId, async (): Promise<ApplyOutcome> => {
      const target = await loadServiceTargetById(deps.db, serviceId);
      const id = validateResourceId(serviceId);
      if (target === null || !id.ok) return { ok: true };
      const rows = await listServiceDomains(deps.db, serviceId);
      const ids = rows.map((row) => row.id);
      let close: (() => Promise<void>) | null = null;
      let result: DomainApplyResult;
      try {
        const connected = await deps.connect(target.serverId, deps.createRedactor(), undefined);
        if (!connected.ok) {
          result = { ok: false, code: 'SERVER_UNREACHABLE', restored: false };
        } else {
          close = connected.close;
          result = await applyServiceDomains({
            session: connected.session,
            service: { id: id.value, internalPort: target.internalPort },
            domains: toRouteDomains(rows),
            limits: deps.limits,
            ...(deps.render === undefined ? {} : { render: deps.render }),
          });
        }
      } catch {
        // A thrown connect is a lost server, never a 500 (H3).
        result = { ok: false, code: 'SERVER_UNREACHABLE', restored: false };
      } finally {
        if (close !== null) {
          try {
            await close();
          } catch {
            // A failed close never changes the outcome.
          }
        }
      }
      const status = result.ok ? 'APPLIED' : result.code === 'PROXY_ROUTE_FAILED' ? 'FAILED' : 'PENDING';
      await setApplyStatus(deps.db, ids, status, now());
      return failedOutcome(result);
    });
}

export interface DomainServiceDeps {
  readonly db: Database;
  readonly now: () => Date;
  /** The NOODARA_PUBLIC_URL host (DOMAIN_RESERVED); null when it has none. */
  readonly publicUrlHost: string | null;
  readonly getProxyService: () => Promise<ProxyServiceDeps>;
  readonly apply: DomainApplier;
  readonly resolver: DnsResolverLike;
  readonly dnsLimiter: DnsCheckLimiter;
}

export interface DomainScope {
  readonly projectId: string;
  readonly serviceId: string;
}

export type DomainFailureCode =
  | 'NOT_FOUND'
  | 'DOMAIN_INPUT_INVALID'
  | 'DOMAIN_ALREADY_ASSIGNED'
  | 'DOMAIN_RESERVED'
  | 'DOMAIN_LIMIT_REACHED'
  | 'RATE_LIMITED'
  | ApplyFailureCode;

export interface DomainFailure {
  readonly ok: false;
  readonly code: DomainFailureCode;
  readonly message: string;
  /** DOMAIN_INPUT_INVALID: the validator's closed code (HOSTNAME_*, DOMAIN_UNSUPPORTED_FIELD, ...). */
  readonly reason?: string;
}

export type DomainResult = { readonly ok: true; readonly domain: DomainView } | DomainFailure;
export type DomainListResult =
  | { readonly ok: true; readonly items: DomainView[]; readonly dnsInstructions: DnsInstructionsView[] }
  | DomainFailure;
export type DomainDeleteResult = { readonly ok: true } | DomainFailure;

const ADMISSION_MESSAGES = Object.freeze({
  DOMAIN_ALREADY_ASSIGNED: 'This domain is already assigned to a service.',
  DOMAIN_RESERVED: 'This domain serves the Noodara panel and cannot be assigned to a service.',
  DOMAIN_LIMIT_REACHED: 'This service already has the maximum number of domains.',
});

function notFound(what: string, id: string): DomainFailure {
  return { ok: false, code: 'NOT_FOUND', message: `${what} "${id}" not found` };
}

function applyFailure(code: ApplyFailureCode): DomainFailure {
  return { ok: false, code, message: APPLY_FAILURE_MESSAGES[code] };
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function toDomainView(row: DomainRow): DomainView {
  return {
    id: row.id,
    projectId: row.projectId,
    serviceId: row.serviceId,
    hostname: row.hostname,
    httpsRedirect: row.httpsRedirect,
    certStatus: row.certStatus,
    certNotAfter: iso(row.certNotAfter),
    certErrorCode: (row.certErrorCode ?? null) as DomainView['certErrorCode'],
    dnsStatus: row.dnsStatus ?? null,
    dnsCheckedAt: iso(row.dnsCheckedAt),
    applyStatus: row.applyStatus as DomainView['applyStatus'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Routes the service's rows when the proxy is RUNNING; otherwise makes sure one gets installed. */
async function ensureRoutes(
  deps: DomainServiceDeps,
  actor: ServiceActor,
  target: { readonly serviceId: string; readonly serverId: string; readonly proxyStatus: string },
  installIfMissing: boolean,
): Promise<ApplyOutcome> {
  if (target.proxyStatus === 'RUNNING') return deps.apply(target.serviceId);
  if (installIfMissing && (target.proxyStatus === 'NOT_INSTALLED' || target.proxyStatus === 'FAILED')) {
    // The install job's outcome lands on the server row; the domain stays PENDING until the
    // reconcile cycle sees the proxy RUNNING and applies it.
    await requestProxyInstall(await deps.getProxyService(), { actor, serverId: target.serverId });
  }
  return { ok: true };
}

async function reloadView(deps: DomainServiceDeps, scope: DomainScope, domainId: string): Promise<DomainView | null> {
  const row = await loadDomain(deps.db, { ...scope, domainId });
  return row === null ? null : toDomainView(row);
}

export async function listDomains(deps: DomainServiceDeps, scope: DomainScope): Promise<DomainListResult> {
  const target = await loadServiceTarget(deps.db, scope.projectId, scope.serviceId);
  if (target === null) return notFound('Service', scope.serviceId);
  const rows = await listServiceDomains(deps.db, target.serviceId);
  const instructions = rows.flatMap((row) => {
    const built = instructionsFor(row.hostname, target.serverHost);
    return built === null ? [] : [built];
  });
  return { ok: true, items: rows.map(toDomainView), dnsInstructions: instructions };
}

export async function createDomain(
  deps: DomainServiceDeps,
  input: { readonly actor: ServiceActor; readonly scope: DomainScope; readonly body: unknown },
): Promise<DomainResult> {
  const validated = validateDomainCreateInput(input.body);
  if (!validated.ok) {
    return { ok: false, code: 'DOMAIN_INPUT_INVALID', message: validated.message, reason: validated.code };
  }
  const target = await loadServiceTarget(deps.db, input.scope.projectId, input.scope.serviceId);
  if (target === null) return notFound('Service', input.scope.serviceId);
  const inserted = await insertDomain(deps.db, {
    actor: input.actor,
    projectId: target.projectId,
    serviceId: target.serviceId,
    domain: validated.value,
    publicUrlHost: deps.publicUrlHost,
    at: deps.now(),
  });
  if (!inserted.ok) {
    if (inserted.code === 'NOT_FOUND') return notFound('Service', input.scope.serviceId);
    return { ok: false, code: inserted.code, message: ADMISSION_MESSAGES[inserted.code] };
  }
  const applied = await ensureRoutes(deps, input.actor, target, true);
  if (!applied.ok) return applyFailure(applied.code);
  const view = await reloadView(deps, input.scope, inserted.row.id);
  return view === null ? notFound('Domain', inserted.row.id) : { ok: true, domain: view };
}

export async function updateDomain(
  deps: DomainServiceDeps,
  input: { readonly actor: ServiceActor; readonly scope: DomainScope; readonly domainId: string; readonly body: unknown },
): Promise<DomainResult> {
  const validated = validateDomainEditInput(input.body);
  if (!validated.ok) {
    return { ok: false, code: 'DOMAIN_INPUT_INVALID', message: validated.message, reason: validated.code };
  }
  const target = await loadServiceTarget(deps.db, input.scope.projectId, input.scope.serviceId);
  if (target === null) return notFound('Domain', input.domainId);
  const row = await updateDomainRedirect(deps.db, {
    actor: input.actor,
    scope: { ...input.scope, domainId: input.domainId },
    httpsRedirect: validated.value.httpsRedirect,
    at: deps.now(),
  });
  if (row === null) return notFound('Domain', input.domainId);
  const applied = await ensureRoutes(deps, input.actor, target, false);
  if (!applied.ok) return applyFailure(applied.code);
  const view = await reloadView(deps, input.scope, row.id);
  return view === null ? notFound('Domain', row.id) : { ok: true, domain: view };
}

export async function removeDomain(
  deps: DomainServiceDeps,
  input: { readonly actor: ServiceActor; readonly scope: DomainScope; readonly domainId: string },
): Promise<DomainDeleteResult> {
  const target = await loadServiceTarget(deps.db, input.scope.projectId, input.scope.serviceId);
  if (target === null) return notFound('Domain', input.domainId);
  const deleted = await deleteDomain(deps.db, { actor: input.actor, scope: { ...input.scope, domainId: input.domainId }, at: deps.now() });
  if (!deleted) return notFound('Domain', input.domainId);
  // The row is gone either way; a failed re-render leaves the remaining rows PENDING/FAILED.
  await ensureRoutes(deps, input.actor, target, false);
  return { ok: true };
}

export async function recheckDomainDns(
  deps: DomainServiceDeps,
  input: { readonly scope: DomainScope; readonly domainId: string },
): Promise<DomainResult> {
  const target = await loadServiceTarget(deps.db, input.scope.projectId, input.scope.serviceId);
  if (target === null) return notFound('Domain', input.domainId);
  const row = await loadDomain(deps.db, { ...input.scope, domainId: input.domainId });
  if (row === null) return notFound('Domain', input.domainId);
  if (!deps.dnsLimiter.take(row.id)) {
    return { ok: false, code: 'RATE_LIMITED', message: 'DNS was checked a moment ago. Try again in a few seconds.' };
  }
  const status = await checkDomainDns(deps.resolver, row.hostname, target.serverHost);
  const updated = await setDnsResult(deps.db, row.id, { status, at: deps.now() });
  return updated === null ? notFound('Domain', row.id) : { ok: true, domain: toDomainView(updated) };
}

/** Services re-applied per reconcile tick (H3); the rest wait for the next tick. */
export const DOMAIN_REAPPLY_BATCH = 50;

export interface DomainReapplyLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

/**
 * H3: re-applies every service whose domains wait PENDING on a RUNNING proxy (an earlier apply
 * met a lost server or a stopped proxy). One service failing never stops the others; never rejects.
 */
export async function reapplyPendingDomains(input: {
  readonly db: Database;
  readonly apply: DomainApplier;
  readonly logger: DomainReapplyLogger;
  readonly limit?: number;
}): Promise<{ readonly applied: number; readonly failed: number }> {
  let serviceIds: string[];
  try {
    serviceIds = await listPendingDomainServices(input.db, input.limit ?? DOMAIN_REAPPLY_BATCH);
  } catch (error) {
    input.logger.warn({ errorKind: error instanceof Error ? error.name : typeof error }, 'pending domain lookup failed');
    return { applied: 0, failed: 0 };
  }
  let applied = 0;
  let failed = 0;
  for (const serviceId of serviceIds) {
    try {
      const outcome = await input.apply(serviceId);
      if (outcome.ok) applied += 1;
      else {
        failed += 1;
        input.logger.warn({ serviceId, code: outcome.code }, 'domain route re-apply failed');
      }
    } catch (error) {
      failed += 1;
      input.logger.warn({ serviceId, errorKind: error instanceof Error ? error.name : typeof error }, 'domain route re-apply failed');
    }
  }
  return { applied, failed };
}
