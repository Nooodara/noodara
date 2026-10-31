// 22-02: the proxy's persistence. Every status change goes through transitionProxyStatus and is a
// conditional UPDATE on the status it was computed from, so a sweep and a job never both win.
// Activity rows are written in the same transaction as the status they describe (H3: metadata
// is the closed allowlist of activity-event.ts; no email, path or remote output).
import { transitionProxyStatus, validateResourceId, type ProxyStatus, type ResourceId } from '@noodara/domain';
import type { ServerProxyErrorCode } from '@noodara/domain/api-contract';
import { and, asc, eq, inArray, lt } from 'drizzle-orm';
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
 * H1 (pure): an INSTALLING row is stale when it is older than the budget cutoff, or when its job is
 * no longer pending. `isPending` is only asked for rows still inside the budget.
 */
export async function pickStaleInstalls(
  rows: readonly { readonly id: string; readonly updatedAt: Date }[],
  cutoff: Date,
  isPending: (serverId: string) => Promise<boolean>,
): Promise<string[]> {
  const stale: string[] = [];
  for (const row of rows) {
    if (row.updatedAt.getTime() >= cutoff.getTime() && (await isPending(row.id))) continue;
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
    .select({ id: servers.id, updatedAt: servers.updatedAt })
    .from(servers)
    .where(eq(servers.proxyStatus, 'INSTALLING'));
  const stale = await pickStaleInstalls(installing, cutoff, input.isPending);
  if (stale.length === 0) return [];
  return db.transaction(async (tx) => {
    const failed = await tx
      .update(servers)
      .set({ proxyStatus: transitionProxyStatus('INSTALLING', 'FAILED'), proxyErrorCode: 'PROXY_INSTALL_FAILED', updatedAt: at })
      .where(and(inArray(servers.id, stale), eq(servers.proxyStatus, 'INSTALLING'), lt(servers.updatedAt, at)))
      .returning({ id: servers.id });
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
