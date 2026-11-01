// 22-02: the proxy's persistence. Every status change goes through transitionProxyStatus and is a
// conditional UPDATE on the status it was computed from, so a sweep and a job never both win.
// Activity rows are written in the same transaction as the status they describe (H3: metadata
// is the closed allowlist of activity-event.ts; no email, path or remote output).
import { transitionProxyStatus, validateResourceId, type ProxyStatus, type ResourceId } from '@noodara/domain';
import type { ServerProxyErrorCode } from '@noodara/domain/api-contract';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { writeProxyActivityEvent } from '../activity/proxy-events.js';
import type { Database } from '../db/client.js';
import { users } from '../db/schema/auth.js';
import { credentials } from '../db/schema/credentials.js';
import { domains } from '../db/schema/domains.js';
import { servers } from '../db/schema/servers.js';
import { services } from '../db/schema/services.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import { toServerCredentialType, toServerView, type ServerView } from '../services/server-view.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Handle = Database | Tx;

export type ProxyTrigger = 'install' | 'request' | 'server_deleted' | 'sweep';

export interface ProxyInstallTarget {
  readonly status: ProxyStatus;
  readonly installedAt: Date | null;
  readonly routedServiceIds: readonly ResourceId[];
}

export type ProxyInstallOutcome =
  | { readonly ok: true; readonly durationMs: number }
  | {
      readonly ok: false;
      readonly code: ServerProxyErrorCode;
      readonly step: string;
      readonly listener: { readonly port: number; readonly process: string | null } | null;
      readonly durationMs: number;
    };

function actorFields(actor: ServiceActor): { actorType: 'user' | 'system'; actorId: string | null } {
  return actor.type === 'user' ? { actorType: 'user', actorId: actor.id } : { actorType: 'system', actorId: null };
}

export async function loadServerView(db: Handle, serverId: string): Promise<ServerView | null> {
  const [row] = await db
    .select({ server: servers, credentialType: credentials.type })
    .from(servers)
    .innerJoin(credentials, eq(credentials.id, servers.credentialId))
    .where(eq(servers.id, serverId))
    .limit(1);
  return row ? toServerView(row.server, toServerCredentialType(row.credentialType)) : null;
}

/** The admin's address: the first account created (setup creates exactly one). */
export async function loadAdminEmail(db: Handle): Promise<string | null> {
  const [row] = await db.select({ email: users.email }).from(users).orderBy(asc(users.createdAt)).limit(1);
  return row?.email ?? null;
}

/** Services on the server that have at least one domain: the proxy joins their networks. */
export async function loadRoutedServiceIds(db: Handle, serverId: string): Promise<ResourceId[]> {
  const rows = await db
    .selectDistinct({ id: services.id })
    .from(services)
    .innerJoin(domains, eq(domains.serviceId, services.id))
    .where(eq(services.serverId, serverId))
    .orderBy(asc(services.id));
  const ids: ResourceId[] = [];
  for (const row of rows) {
    const id = validateResourceId(row.id);
    if (id.ok) ids.push(id.value);
  }
  return ids;
}

export async function countServerDomains(db: Handle, serverId: string): Promise<number> {
  const rows = await db
    .select({ id: domains.id })
    .from(domains)
    .innerJoin(services, eq(services.id, domains.serviceId))
    .where(eq(services.serverId, serverId))
    .limit(1);
  return rows.length;
}

export async function loadInstallTarget(db: Database, serverId: string): Promise<ProxyInstallTarget | null> {
  const [row] = await db
    .select({ status: servers.proxyStatus, installedAt: servers.proxyInstalledAt })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (!row) return null;
  return { status: row.status, installedAt: row.installedAt, routedServiceIds: await loadRoutedServiceIds(db, serverId) };
}

/** Conditional status write; `false` when the row moved meanwhile (or is gone). */
export async function writeProxyStatus(
  db: Handle,
  serverId: string,
  from: ProxyStatus,
  to: ProxyStatus,
  fields: { errorCode: ServerProxyErrorCode | null; installedAt?: Date | null; acmeEmail?: string; at: Date },
): Promise<boolean> {
  const next = transitionProxyStatus(from, to);
  const updated = await db
    .update(servers)
    .set({
      proxyStatus: next,
      proxyErrorCode: fields.errorCode,
      ...(fields.installedAt === undefined ? {} : { proxyInstalledAt: fields.installedAt }),
      ...(fields.acmeEmail === undefined ? {} : { proxyAcmeEmail: fields.acmeEmail }),
      // A2: install staleness keys on this, never on updatedAt (discovery/connect bump that).
      ...(next === 'INSTALLING' ? { proxyInstallStartedAt: fields.at } : {}),
      updatedAt: fields.at,
    })
    .where(and(eq(servers.id, serverId), eq(servers.proxyStatus, from)))
    .returning({ id: servers.id });
  return updated.length === 1;
}

/** Records the install job's outcome on an INSTALLING row; `null` when the row is no longer INSTALLING. */
export async function finishInstall(
  db: Database,
  now: () => Date,
  serverId: string,
  outcome: ProxyInstallOutcome,
  reinstalled: boolean,
): Promise<ServerView | null> {
  return db.transaction(async (tx) => {
    const at = now();
    const moved = outcome.ok
      ? await writeProxyStatus(tx, serverId, 'INSTALLING', 'RUNNING', { errorCode: null, installedAt: at, at })
      : await writeProxyStatus(tx, serverId, 'INSTALLING', 'FAILED', { errorCode: outcome.code, at });
    if (!moved) return null;
    await writeProxyActivityEvent(
      tx,
      outcome.ok
        ? {
            actorType: 'system',
            actorId: null,
            entityType: 'server',
            entityId: serverId,
            action: 'server.proxy_installed',
            outcome: 'success',
            metadata: { durationMs: outcome.durationMs, reinstalled, trigger: 'install' },
          }
        : {
            actorType: 'system',
            actorId: null,
            entityType: 'server',
            entityId: serverId,
            action: 'server.proxy_failed',
            outcome: 'failure',
            errorCode: outcome.code,
            metadata: {
              durationMs: outcome.durationMs,
              step: outcome.step,
              trigger: 'install',
              ...(outcome.listener === null
                ? {}
                : {
                    port: outcome.listener.port,
                    ...(outcome.listener.process === null ? {} : { listener: outcome.listener.process }),
                  }),
            },
          },
      at,
    );
    return loadServerView(tx, serverId);
  });
}

export async function recordProxyRemoved(
  db: Handle,
  at: Date,
  input: { serverId: string; actor: ServiceActor; ok: boolean; durationMs: number; trigger: ProxyTrigger },
): Promise<void> {
  await writeProxyActivityEvent(
    db,
    {
      ...actorFields(input.actor),
      entityType: 'server',
      entityId: input.serverId,
      action: 'server.proxy_removed',
      outcome: input.ok ? 'success' : 'failure',
      ...(input.ok ? {} : { errorCode: 'PROXY_UNAVAILABLE' }),
      metadata: { durationMs: input.durationMs, trigger: input.trigger },
    },
    at,
  );
}

/**
 * H1 (pure): an INSTALLING row is stale when its install started before the budget cutoff (or has
 * no start time), or when its job is no longer pending. `isPending` is only asked for rows still
 * inside the budget.
 */
export async function pickStaleInstalls(
  rows: readonly { readonly id: string; readonly installStartedAt: Date | null }[],
  cutoff: Date,
  isPending: (serverId: string) => Promise<boolean>,
): Promise<string[]> {
  const stale: string[] = [];
  for (const row of rows) {
    if (row.installStartedAt !== null && row.installStartedAt.getTime() >= cutoff.getTime() && (await isPending(row.id))) {
      continue;
    }
    stale.push(row.id);
  }
  return stale;
}

/** H1: INSTALLING rows whose job is gone, or older than the budget, end FAILED/PROXY_INSTALL_FAILED. */
export async function failStaleInstalls(
  db: Database,
  now: () => Date,
  input: { budgetMs: number; isPending: (serverId: string) => Promise<boolean> },
): Promise<string[]> {
  const at = now();
  const cutoff = new Date(at.getTime() - input.budgetMs);
  const installing = await db
    .select({ id: servers.id, installStartedAt: servers.proxyInstallStartedAt })
    .from(servers)
    .where(eq(servers.proxyStatus, 'INSTALLING'));
  const staleIds = new Set(await pickStaleInstalls(installing, cutoff, input.isPending));
  const stale = installing.filter((row) => staleIds.has(row.id));
  if (stale.length === 0) return [];
  return db.transaction(async (tx) => {
    // Per row, conditional on the install start that was judged: a re-install that began after
    // the read (new start time) is not failed by this sweep.
    const failed: { id: string }[] = [];
    for (const row of stale) {
      const moved = await tx
        .update(servers)
        .set({ proxyStatus: transitionProxyStatus('INSTALLING', 'FAILED'), proxyErrorCode: 'PROXY_INSTALL_FAILED', updatedAt: at })
        .where(
          and(
            eq(servers.id, row.id),
            eq(servers.proxyStatus, 'INSTALLING'),
            row.installStartedAt === null
              ? isNull(servers.proxyInstallStartedAt)
              : eq(servers.proxyInstallStartedAt, row.installStartedAt),
          ),
        )
        .returning({ id: servers.id });
      failed.push(...moved);
    }
    for (const { id } of failed) {
      await writeProxyActivityEvent(
        tx,
        {
          actorType: 'system',
          actorId: null,
          entityType: 'server',
          entityId: id,
          action: 'server.proxy_failed',
          outcome: 'failure',
          errorCode: 'PROXY_INSTALL_FAILED',
          metadata: { durationMs: input.budgetMs, step: 'sweep', trigger: 'sweep' },
        },
        at,
      );
    }
    return failed.map(({ id }) => id);
  });
}

/**
 * 22-07 (A5/A6): two-int advisory key (class, hashtext(serverId)) that serialises every proxy
 * change request on one server: install, ACME email change, removal and server deletion. Distinct
 * from ROUTE_LOCK_CLASS (per service) and the setup lock.
 */
export const PROXY_LOCK_CLASS = 78_321_003;

/** `pg_try_advisory_xact_lock` on the server's proxy key; released when `tx` ends. */
export async function tryProxyLock(tx: Tx, serverId: string): Promise<boolean> {
  const result = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(${PROXY_LOCK_CLASS}::int4, hashtext(${serverId})) as locked`,
  );
  return result.rows[0]?.locked === true;
}

export interface ProxyServerState {
  readonly status: ProxyStatus;
  readonly acmeEmail: string | null;
}

export interface ProxyStatusFields {
  readonly errorCode: ServerProxyErrorCode | null;
  readonly installedAt?: Date | null;
  readonly acmeEmail?: string;
  readonly at: Date;
}

/** What the service may do inside one locked transaction on one server. */
export interface ProxyLockedStore {
  adminEmail(): Promise<string | null>;
  countDomains(): Promise<number>;
  transition(from: ProxyStatus, to: ProxyStatus, fields: ProxyStatusFields): Promise<boolean>;
  setAcmeEmail(email: string, at: Date): Promise<void>;
  recordRemoved(at: Date, input: { actor: ServiceActor; ok: boolean; durationMs: number; trigger: ProxyTrigger }): Promise<void>;
}

export type ProxyLockResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'missing' }
  | { readonly kind: 'busy' };

/** The proxy service's persistence port (Drizzle in production, a fake in unit tests). */
export interface ProxyServiceStore {
  /**
   * Runs `fn` in one transaction holding the server's proxy lock (try-lock: `busy` when another
   * change holds it). `rowLock` also takes FOR UPDATE on the server row first; a removal passes
   * false so no row lock is held while the server is reached over SSH.
   */
  withServerLock<T>(
    serverId: string,
    options: { readonly rowLock: boolean },
    fn: (store: ProxyLockedStore, state: ProxyServerState) => Promise<T>,
  ): Promise<ProxyLockResult<T>>;
  transition(serverId: string, from: ProxyStatus, to: ProxyStatus, fields: ProxyStatusFields): Promise<boolean>;
  loadView(serverId: string): Promise<ServerView | null>;
}

export function createDrizzleProxyServiceStore(db: Database): ProxyServiceStore {
  return {
    withServerLock: (serverId, options, fn) =>
      db.transaction(async (tx) => {
        const query = tx
          .select({ status: servers.proxyStatus, acmeEmail: servers.proxyAcmeEmail })
          .from(servers)
          .where(eq(servers.id, serverId));
        const [row] = options.rowLock ? await query.for('update') : await query.limit(1);
        if (!row) return { kind: 'missing' } as const;
        if (!(await tryProxyLock(tx, serverId))) return { kind: 'busy' } as const;
        const locked: ProxyLockedStore = {
          adminEmail: () => loadAdminEmail(tx),
          countDomains: () => countServerDomains(tx, serverId),
          transition: (from, to, fields) => writeProxyStatus(tx, serverId, from, to, fields),
          setAcmeEmail: async (email, at) => {
            await tx.update(servers).set({ proxyAcmeEmail: email, updatedAt: at }).where(eq(servers.id, serverId));
          },
          recordRemoved: (at, input) => recordProxyRemoved(tx, at, { ...input, serverId }),
        };
        return { kind: 'ok', value: await fn(locked, row) } as const;
      }),
    transition: (serverId, from, to, fields) => writeProxyStatus(db, serverId, from, to, fields),
    loadView: (serverId) => loadServerView(db, serverId),
  };
}
