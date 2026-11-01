// 22-02 (A1-A3): the proxy's request side, used by the routes and by deleteServer.
// - requestProxyInstall: NOT_INSTALLED | RUNNING | FAILED -> INSTALLING, then one collapsing job
//   (`proxy-install-<serverId>`). A request while INSTALLING joins the pending job unless it
//   carries a different ACME email (409: the pending job would render the old one). The ACME
//   email is the body's, else the server's stored one, else the admin's.
// - setProxyAcmeEmail (PATCH): stores the address; a RUNNING proxy is re-installed so the static
//   config is re-rendered with it; 409 while INSTALLING.
// - removeServerProxy: 409 PROXY_IN_USE while a domain exists on the server, 409 SERVER_BUSY while
//   INSTALLING; otherwise rm + purge, bounded, then NOT_INSTALLED (conditional: SERVER_BUSY when
//   the row moved).
// 22-07 (A5/A6): every change runs under the server's proxy advisory lock (PROXY_LOCK_CLASS), so
// install, email change, removal and server deletion never interleave; a held lock is 409.
// Failures are closed codes with fixed messages; nothing remote reaches a response.
import { PROXY_ERROR_MESSAGES, renderStaticConfig, type ProxyStatus } from '@noodara/domain';
import type { Database } from '../db/client.js';
import { publishServerEvent, type ServerEventPublisher } from '../events/server-event-publisher.js';
import type { ProxyInstallJobPayload } from '../queue/proxy-job-payload.js';
import { jobIdForProxyInstall } from '../queue/proxy-job-payload.js';
import type { ProxyEnqueueResult } from '../queue/proxy-queue.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import type { ServerView } from '../services/server-view.js';
import type { ProxyRemoveResult } from './proxy-runtime.js';
import {
  createDrizzleProxyServiceStore,
  type ProxyLockedStore,
  type ProxyServerState,
  type ProxyServiceStore,
} from './proxy-store.js';

/** Connects to the server and removes the proxy (container + files); never throws. */
export type ProxyRemover = (serverId: string) => Promise<ProxyRemoveResult>;

interface ProxyServiceBaseDeps {
  readonly now: () => Date;
  readonly events: ServerEventPublisher;
  readonly enqueue: (payload: ProxyInstallJobPayload) => Promise<ProxyEnqueueResult>;
  /** Only used to validate the ACME email with the same renderer the job uses. */
  readonly acmeCaUrl: string;
  readonly remove: ProxyRemover;
  /** Bound on a synchronous removal. */
  readonly removeTimeoutMs: number;
}

/** Production passes `db` (Drizzle store); unit tests pass a `store` fake. */
export type ProxyServiceDeps = ProxyServiceBaseDeps & ({ readonly db: Database } | { readonly store: ProxyServiceStore });

function storeOf(deps: ProxyServiceDeps): ProxyServiceStore {
  return 'store' in deps ? deps.store : createDrizzleProxyServiceStore(deps.db);
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
const CHANGING: ProxyServiceFailure = {
  ok: false,
  code: 'SERVER_BUSY',
  message: 'The proxy on this server is being changed. Try again in a moment',
};
const EMAIL_WHILE_INSTALLING: ProxyServiceFailure = {
  ok: false,
  code: 'SERVER_BUSY',
  message: 'A proxy install is in progress on this server. Change the ACME email when it finishes',
};
const IN_USE: ProxyServiceFailure = { ok: false, code: 'PROXY_IN_USE', message: PROXY_ERROR_MESSAGES.PROXY_IN_USE };
const UNAVAILABLE: ProxyServiceFailure = {
  ok: false,
  code: 'PROXY_UNAVAILABLE',
  message: PROXY_ERROR_MESSAGES.PROXY_UNAVAILABLE,
};

/** Same check the job's renderer applies, so a stored address always renders. */
export function isValidAcmeEmail(email: string, acmeCaUrl: string): boolean {
  return renderStaticConfig({ email, caUrl: acmeCaUrl }).ok;
}

async function publishView(deps: ProxyServiceDeps, store: ProxyServiceStore, serverId: string): Promise<ProxyServiceResult> {
  const view = await store.loadView(serverId);
  if (view === null) return NOT_FOUND(serverId);
  await publishServerEvent(deps.events, { type: 'server.updated', server: view });
  return { ok: true, server: view };
}

/** Inside the lock: resolves the email and moves the row to INSTALLING (or joins a pending job). */
async function prepareInstall(
  deps: ProxyServiceDeps,
  locked: ProxyLockedStore,
  state: ProxyServerState,
  acmeEmail: string | undefined,
): Promise<PreparedInstall> {
  if (state.status === 'INSTALLING' && acmeEmail !== undefined && acmeEmail !== state.acmeEmail) {
    // A6: the pending job carries the email it was queued with; never let the row diverge from it.
    return EMAIL_WHILE_INSTALLING;
  }
  const email = acmeEmail ?? state.acmeEmail ?? (await locked.adminEmail());
  if (email === null) return NO_EMAIL;
  if (!isValidAcmeEmail(email, deps.acmeCaUrl)) return acmeEmail === undefined && state.acmeEmail === null ? NO_EMAIL : INVALID_EMAIL;
  if (state.status !== 'INSTALLING') {
    const moved = await locked.transition(state.status, 'INSTALLING', {
      errorCode: null,
      at: deps.now(),
      ...(acmeEmail === undefined ? {} : { acmeEmail }),
    });
    if (!moved) return CHANGING;
  }
  return { ok: true, email, previous: state.status };
}

async function enqueuePrepared(
  deps: ProxyServiceDeps,
  store: ProxyServiceStore,
  serverId: string,
  prepared: { readonly email: string; readonly previous: ProxyStatus },
): Promise<ProxyServiceResult> {
  const enqueued = await deps.enqueue({ serverId, acmeEmail: prepared.email, jobId: jobIdForProxyInstall(serverId) });
  if (!enqueued.ok) {
    if (prepared.previous !== 'INSTALLING') {
      // Nothing will run: the row ends FAILED so a retry is offered (never stuck INSTALLING).
      await store.transition(serverId, 'INSTALLING', 'FAILED', { errorCode: 'PROXY_INSTALL_FAILED', at: deps.now() });
      await publishView(deps, store, serverId);
    }
    return { ok: false, code: 'QUEUE_UNAVAILABLE', message: enqueued.message };
  }
  return publishView(deps, store, serverId);
}

export async function requestProxyInstall(
  deps: ProxyServiceDeps,
  input: { readonly actor: ServiceActor; readonly serverId: string; readonly acmeEmail?: string },
): Promise<ProxyServiceResult> {
  if (input.acmeEmail !== undefined && !isValidAcmeEmail(input.acmeEmail, deps.acmeCaUrl)) return INVALID_EMAIL;
  const store = storeOf(deps);
  const locked = await store.withServerLock(input.serverId, { rowLock: true }, (tx, state) =>
    prepareInstall(deps, tx, state, input.acmeEmail),
  );
  if (locked.kind === 'missing') return NOT_FOUND(input.serverId);
  if (locked.kind === 'busy') return CHANGING;
  if (!locked.value.ok) return locked.value;
  return enqueuePrepared(deps, store, input.serverId, locked.value);
}

type EmailChange = { readonly ok: true; readonly install: PreparedInstall | null } | ProxyServiceFailure;

export async function setProxyAcmeEmail(
  deps: ProxyServiceDeps,
  input: { readonly actor: ServiceActor; readonly serverId: string; readonly acmeEmail: string },
): Promise<ProxyServiceResult> {
  if (!isValidAcmeEmail(input.acmeEmail, deps.acmeCaUrl)) return INVALID_EMAIL;
  const store = storeOf(deps);
  const locked = await store.withServerLock(input.serverId, { rowLock: true }, async (tx, state): Promise<EmailChange> => {
    if (state.status === 'INSTALLING') return EMAIL_WHILE_INSTALLING;
    // A RUNNING proxy carries the address in its static config: re-render it (A2).
    if (state.status === 'RUNNING' && state.acmeEmail !== input.acmeEmail) {
      return { ok: true, install: await prepareInstall(deps, tx, state, input.acmeEmail) };
    }
    await tx.setAcmeEmail(input.acmeEmail, deps.now());
    return { ok: true, install: null };
  });
  if (locked.kind === 'missing') return NOT_FOUND(input.serverId);
  if (locked.kind === 'busy') return CHANGING;
  const change = locked.value;
  if (!change.ok) return change;
  if (change.install === null) return publishView(deps, store, input.serverId);
  if (!change.install.ok) return change.install;
  return enqueuePrepared(deps, store, input.serverId, change.install);
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
  const store = storeOf(deps);
  // A5: under the proxy lock but without a row lock, so the bounded SSH removal never holds the
  // server row; an install request meanwhile gets SERVER_BUSY instead of racing the rm.
  const locked = await store.withServerLock(
    input.serverId,
    { rowLock: false },
    async (tx, state): Promise<ProxyServiceFailure | null> => {
      if ((await tx.countDomains()) > 0) return IN_USE;
      if (state.status === 'INSTALLING') return INSTALLING;
      if (state.status === 'NOT_INSTALLED') return null;
      const removed = await removeWithin(deps.remove, input.serverId, deps.removeTimeoutMs);
      const at = deps.now();
      await tx.recordRemoved(at, { actor: input.actor, ok: removed.ok, durationMs: removed.durationMs, trigger: 'request' });
      if (!removed.ok) return UNAVAILABLE;
      const moved = await tx.transition(state.status, 'NOT_INSTALLED', { errorCode: null, installedAt: null, at });
      return moved ? null : CHANGING;
    },
  );
  if (locked.kind === 'missing') return NOT_FOUND(input.serverId);
  if (locked.kind === 'busy') return CHANGING;
  if (locked.value !== null) return locked.value;
  return publishView(deps, store, input.serverId);
}
