// 22-05 H3: the one entry point that writes a service's dynamic file. Every caller (domain POST /
// PATCH / DELETE, the reconcile re-apply, a deploy's port re-apply) goes through `applyRoutes`
// under a per-serviceId lock: in-process first (one queue per service), then a Postgres advisory
// transaction lock so the API and the worker never interleave writes for the same service. The
// desired rows are read inside the lock, so the last apply always renders the latest state.
import { sql } from 'drizzle-orm';
import { validateResourceId, type ResourceId } from '@noodara/domain';
import type { Redactor } from '@noodara/domain/security';
import type { SshDeploySession } from '@noodara/ssh';
import type { Database } from '../db/client.js';
import type { ConnectResult } from '../deploy/deploy-worker.js';
import {
  applyServiceDomains,
  createServiceLock,
  type DomainApplyLimits,
  type DomainApplyResult,
  type DomainRenderer,
} from './domain-apply.js';
import { listServiceDomains, loadServiceTargetById, setApplyStatus, toRouteDomains, type DomainRow } from './domain-store.js';

export type ApplyFailureCode = 'PROXY_UNAVAILABLE' | 'PROXY_ROUTE_FAILED' | 'SERVER_UNREACHABLE';
export type ApplyOutcome = { readonly ok: true } | { readonly ok: false; readonly code: ApplyFailureCode };
export type RouteApplyStatus = 'APPLIED' | 'FAILED' | 'PENDING';

export type RouteLock = <T>(serviceId: string, task: () => Promise<T>) => Promise<T>;

/** The slice of a Drizzle client the cross-process lock needs. */
export interface RouteLockDb {
  transaction<T>(task: (tx: { execute(query: ReturnType<typeof sql>): Promise<unknown> }) => Promise<T>): Promise<T>;
}

/**
 * Two-int advisory key space (class, hashtext(serviceId)); distinct from setup-service's single
 * bigint key. No other code may lock with this class.
 */
export const ROUTE_LOCK_CLASS = 78_321_002;
/**
 * Route applies holding a pooled connection at once, per process. Each holds its transaction for
 * the whole apply; the bound keeps the rest of the pool (default 10) free for the queries the
 * apply itself runs, so a burst of applies can never starve the pool into a deadlock.
 */
export const ROUTE_LOCK_PERMITS = 4;

function createPermits(size: number): <T>(task: () => Promise<T>) => Promise<T> {
  let free = size;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (free > 0) free -= 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next === undefined) free += 1;
      else next();
    }
  };
}

const processPermits = createPermits(ROUTE_LOCK_PERMITS);

/** Per-serviceId lock; `null` keeps it in-process only (unit tests, no database). */
export function createRouteLock(db: RouteLockDb | null): RouteLock {
  const local = createServiceLock();
  if (db === null) return local;
  return <T>(serviceId: string, task: () => Promise<T>): Promise<T> =>
    local(serviceId, () =>
      processPermits(() =>
        // The transaction ends (commit or rollback) when the task settles: the lock is released on
        // every path, a throw included.
        db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(${ROUTE_LOCK_CLASS}::int4, hashtext(${serviceId}))`);
          return task();
        }),
      ),
    );
}

export interface RouteDesired {
  readonly serverId: string;
  readonly serviceId: ResourceId;
  readonly internalPort: number;
  readonly rows: readonly DomainRow[];
}

export type RouteSession =
  | { readonly ok: true; readonly session: SshDeploySession; readonly close?: () => Promise<void> }
  | { readonly ok: false };

export interface ApplyRoutesPorts {
  /** Read inside the lock. `null`: the service is gone, nothing to apply. */
  loadDesired(serviceId: string): Promise<RouteDesired | null>;
  open(desired: RouteDesired): Promise<RouteSession>;
  record(ids: readonly string[], status: RouteApplyStatus): Promise<void>;
}

export interface ApplyRoutesOptions {
  readonly lock: RouteLock;
  readonly limits: DomainApplyLimits;
  readonly render?: DomainRenderer;
  /** The deploy's port (H2) instead of the service row's. */
  readonly internalPort?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function statusFor(result: DomainApplyResult): RouteApplyStatus {
  if (result.ok) return 'APPLIED';
  return result.code === 'PROXY_ROUTE_FAILED' ? 'FAILED' : 'PENDING';
}

export function applyRoutes(serviceId: string, ports: ApplyRoutesPorts, options: ApplyRoutesOptions): Promise<ApplyOutcome> {
  return options.lock(serviceId, async (): Promise<ApplyOutcome> => {
    const desired = await ports.loadDesired(serviceId);
    if (desired === null) return { ok: true };
    let close: (() => Promise<void>) | undefined;
    let result: DomainApplyResult;
    try {
      const opened = await ports.open(desired);
      if (!opened.ok) {
        result = { ok: false, code: 'SERVER_UNREACHABLE', restored: false };
      } else {
        close = opened.close;
        result = await applyServiceDomains({
          session: opened.session,
          service: { id: desired.serviceId, internalPort: options.internalPort ?? desired.internalPort },
          domains: toRouteDomains(desired.rows),
          limits: options.limits,
          ...(options.render === undefined ? {} : { render: options.render }),
          ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        });
      }
    } catch {
      // A thrown connect is a lost server, never a 500 (22-03 H3).
      result = { ok: false, code: 'SERVER_UNREACHABLE', restored: false };
    } finally {
      if (close !== undefined) {
        try {
          await close();
        } catch {
          // A failed close never changes the outcome.
        }
      }
    }
    await ports.record(
      desired.rows.map((row) => row.id),
      statusFor(result),
    );
    return result.ok ? { ok: true } : { ok: false, code: result.code };
  });
}

/** The rows of one service as the database holds them now. */
export async function loadRouteDesired(db: Database, serviceId: string): Promise<RouteDesired | null> {
  const id = validateResourceId(serviceId);
  if (!id.ok) return null;
  const target = await loadServiceTargetById(db, serviceId);
  if (target === null) return null;
  const rows = await listServiceDomains(db, serviceId);
  return { serverId: target.serverId, serviceId: id.value, internalPort: target.internalPort, rows };
}

export interface DbRoutePortsDeps {
  readonly db: Database;
  readonly connect: (serverId: string, redactor: Redactor, signal: AbortSignal | undefined) => Promise<ConnectResult>;
  readonly createRedactor: () => Redactor;
  readonly now?: () => Date;
}

/** Ports over the database and a fresh SSH session per apply (the API and reconcile path). */
export function dbRoutePorts(deps: DbRoutePortsDeps): ApplyRoutesPorts {
  const now = deps.now ?? (() => new Date());
  return {
    loadDesired: (serviceId) => loadRouteDesired(deps.db, serviceId),
    open: async (desired) => {
      const connected = await deps.connect(desired.serverId, deps.createRedactor(), undefined);
      return connected.ok ? { ok: true, session: connected.session, close: connected.close } : { ok: false };
    },
    record: (ids, status) => setApplyStatus(deps.db, ids, status, now()),
  };
}

/** Ports over the database and a session the caller owns (a deploy's re-apply, H2): never closed here. */
export function sessionRoutePorts(db: Database, session: SshDeploySession, now: () => Date = () => new Date()): ApplyRoutesPorts {
  return {
    loadDesired: (serviceId) => loadRouteDesired(db, serviceId),
    open: () => Promise.resolve({ ok: true, session }),
    record: (ids, status) => setApplyStatus(db, ids, status, now()),
  };
}
