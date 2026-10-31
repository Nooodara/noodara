// 22-02 (A1-A3): the proxy's request side, used by the routes and by deleteServer.
// - requestProxyInstall: NOT_INSTALLED | RUNNING | FAILED -> INSTALLING, then one collapsing job
//   (`proxy-install-<serverId>`). A request while INSTALLING joins the pending job. The ACME email
//   is the body's, else the server's stored one, else the admin's.
// - setProxyAcmeEmail (PATCH): stores the address; a RUNNING proxy is re-installed so the static
//   config is re-rendered with it.
// - removeServerProxy: 409 PROXY_IN_USE while a domain exists on the server; otherwise rm + purge,
//   bounded, then NOT_INSTALLED.
// Failures are closed codes with fixed messages; nothing remote reaches a response.
import { PROXY_ERROR_MESSAGES, renderStaticConfig, type ProxyStatus } from '@noodara/domain';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { servers } from '../db/schema/servers.js';
import { publishServerEvent, type ServerEventPublisher } from '../events/server-event-publisher.js';
import type { ProxyInstallJobPayload } from '../queue/proxy-job-payload.js';
import { jobIdForProxyInstall } from '../queue/proxy-job-payload.js';
import type { ProxyEnqueueResult } from '../queue/proxy-queue.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import type { ServerView } from '../services/server-view.js';
import type { ProxyRemoveResult } from './proxy-runtime.js';
import {
  countServerDomains,
  loadAdminEmail,
  loadServerView,
  recordProxyRemoved,
  writeProxyStatus,
} from './proxy-store.js';

/** Connects to the server and removes the proxy (container + files); never throws. */
export type ProxyRemover = (serverId: string) => Promise<ProxyRemoveResult>;

export interface ProxyServiceDeps {
  readonly db: Database;
  readonly now: () => Date;
  readonly events: ServerEventPublisher;
  readonly enqueue: (payload: ProxyInstallJobPayload) => Promise<ProxyEnqueueResult>;
  /** Only used to validate the ACME email with the same renderer the job uses. */
  readonly acmeCaUrl: string;
  readonly remove: ProxyRemover;
  /** Bound on a synchronous removal. */
  readonly removeTimeoutMs: number;
}

export type ProxyFailureCode =
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'SERVER_BUSY'
  | 'QUEUE_UNAVAILABLE'
  | 'PROXY_IN_USE'
  | 'PROXY_UNAVAILABLE';

export interface ProxyServiceFailure {
  readonly ok: false;
  readonly code: ProxyFailureCode;
  readonly message: string;
}

export type ProxyServiceResult = { readonly ok: true; readonly server: ServerView } | ProxyServiceFailure;

type PreparedInstall =
  | { readonly ok: true; readonly email: string; readonly previous: ProxyStatus }
  | ProxyServiceFailure;

const NOT_FOUND = (serverId: string): ProxyServiceFailure => ({
  ok: false,
  code: 'NOT_FOUND',
  message: `Server "${serverId}" not found`,
});
const INVALID_EMAIL: ProxyServiceFailure = {
  ok: false,
  code: 'VALIDATION_FAILED',
  message: 'ACME email must be a plain address such as ops@example.com',
};
const NO_EMAIL: ProxyServiceFailure = {
  ok: false,
  code: 'VALIDATION_FAILED',
  message: 'Set an ACME email for this server before installing the proxy',
};
const INSTALLING: ProxyServiceFailure = {
  ok: false,
  code: 'SERVER_BUSY',
  message: 'A proxy install is in progress on this server',
};

/** Same check the job's renderer applies, so a stored address always renders. */
export function isValidAcmeEmail(email: string, acmeCaUrl: string): boolean {
  return renderStaticConfig({ email, caUrl: acmeCaUrl }).ok;
}

async function publishView(deps: ProxyServiceDeps, serverId: string): Promise<ServerView | null> {
  const view = await loadServerView(deps.db, serverId);
  if (view !== null) await publishServerEvent(deps.events, { type: 'server.updated', server: view });
  return view;
}

export async function requestProxyInstall(
  deps: ProxyServiceDeps,
  input: { readonly actor: ServiceActor; readonly serverId: string; readonly acmeEmail?: string },
): Promise<ProxyServiceResult> {
  if (input.acmeEmail !== undefined && !isValidAcmeEmail(input.acmeEmail, deps.acmeCaUrl)) return INVALID_EMAIL;

  const prepared = await deps.db.transaction(async (tx): Promise<PreparedInstall> => {
    const [row] = await tx.select().from(servers).where(eq(servers.id, input.serverId)).for('update');
    if (!row) return NOT_FOUND(input.serverId);
    const email = input.acmeEmail ?? row.proxyAcmeEmail ?? (await loadAdminEmail(tx));
    if (email === null) return NO_EMAIL;
    if (!isValidAcmeEmail(email, deps.acmeCaUrl)) return input.acmeEmail === undefined && row.proxyAcmeEmail === null ? NO_EMAIL : INVALID_EMAIL;
    const at = deps.now();
    if (row.proxyStatus === 'INSTALLING') {
      // Joins the pending job (or re-creates one the sweep has not failed yet).
      if (input.acmeEmail !== undefined) {
        await tx.update(servers).set({ proxyAcmeEmail: input.acmeEmail, updatedAt: at }).where(eq(servers.id, row.id));
      }
    } else {
      await writeProxyStatus(tx, row.id, row.proxyStatus, 'INSTALLING', {
        errorCode: null,
        at,
        ...(input.acmeEmail === undefined ? {} : { acmeEmail: input.acmeEmail }),
      });
    }
    return { ok: true, email, previous: row.proxyStatus };
  });
  if (!prepared.ok) return prepared;

  const enqueued = await deps.enqueue({
    serverId: input.serverId,
    acmeEmail: prepared.email,
    jobId: jobIdForProxyInstall(input.serverId),
  });
  if (!enqueued.ok) {
    if (prepared.previous !== 'INSTALLING') {
      // Nothing will run: the row ends FAILED so a retry is offered (never stuck INSTALLING).
      await writeProxyStatus(deps.db, input.serverId, 'INSTALLING', 'FAILED', {
        errorCode: 'PROXY_INSTALL_FAILED',
        at: deps.now(),
      });
      await publishView(deps, input.serverId);
    }
    return { ok: false, code: 'QUEUE_UNAVAILABLE', message: enqueued.message };
  }
  const view = await publishView(deps, input.serverId);
  return view === null ? NOT_FOUND(input.serverId) : { ok: true, server: view };
}

export async function setProxyAcmeEmail(
  deps: ProxyServiceDeps,
  input: { readonly actor: ServiceActor; readonly serverId: string; readonly acmeEmail: string },
): Promise<ProxyServiceResult> {
  if (!isValidAcmeEmail(input.acmeEmail, deps.acmeCaUrl)) return INVALID_EMAIL;
  const [row] = await deps.db
    .select({ status: servers.proxyStatus, email: servers.proxyAcmeEmail })
    .from(servers)
    .where(eq(servers.id, input.serverId))
    .limit(1);
  if (!row) return NOT_FOUND(input.serverId);
  if (row.status === 'INSTALLING') return INSTALLING;
  // A RUNNING proxy carries the address in its static config: re-render it (A2).
  if (row.status === 'RUNNING' && row.email !== input.acmeEmail) return requestProxyInstall(deps, input);
  await deps.db
    .update(servers)
    .set({ proxyAcmeEmail: input.acmeEmail, updatedAt: deps.now() })
    .where(eq(servers.id, input.serverId));
  const view = await publishView(deps, input.serverId);
  return view === null ? NOT_FOUND(input.serverId) : { ok: true, server: view };
}

/** Bounds a remover that might hang; a timeout is a failed removal. */
export async function removeWithin(remove: ProxyRemover, serverId: string, timeoutMs: number, now: () => number = Date.now): Promise<ProxyRemoveResult> {
  const startedAt = now();
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ProxyRemoveResult>((resolve) => {
    handle = setTimeout(() => {
      resolve({ ok: false, code: 'PROXY_UNAVAILABLE', durationMs: Math.max(0, now() - startedAt) });
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      remove(serverId).catch((): ProxyRemoveResult => ({ ok: false, code: 'PROXY_UNAVAILABLE', durationMs: Math.max(0, now() - startedAt) })),
      timedOut,
    ]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

export async function removeServerProxy(
  deps: ProxyServiceDeps,
  input: { readonly actor: ServiceActor; readonly serverId: string },
): Promise<ProxyServiceResult> {
  const [row] = await deps.db
    .select({ status: servers.proxyStatus })
    .from(servers)
    .where(eq(servers.id, input.serverId))
    .limit(1);
  if (!row) return NOT_FOUND(input.serverId);
  if ((await countServerDomains(deps.db, input.serverId)) > 0) {
    return { ok: false, code: 'PROXY_IN_USE', message: PROXY_ERROR_MESSAGES.PROXY_IN_USE };
  }
  if (row.status === 'INSTALLING') return INSTALLING;
  if (row.status !== 'NOT_INSTALLED') {
    const removed = await removeWithin(deps.remove, input.serverId, deps.removeTimeoutMs);
    const at = deps.now();
    await deps.db.transaction(async (tx) => {
      await recordProxyRemoved(tx, at, {
        serverId: input.serverId,
        actor: input.actor,
        ok: removed.ok,
        durationMs: removed.durationMs,
        trigger: 'request',
      });
      if (removed.ok) {
        await writeProxyStatus(tx, input.serverId, row.status, 'NOT_INSTALLED', { errorCode: null, installedAt: null, at });
      }
    });
    if (!removed.ok) return { ok: false, code: 'PROXY_UNAVAILABLE', message: PROXY_ERROR_MESSAGES.PROXY_UNAVAILABLE };
  }
  const view = await publishView(deps, input.serverId);
  return view === null ? NOT_FOUND(input.serverId) : { ok: true, server: view };
}
