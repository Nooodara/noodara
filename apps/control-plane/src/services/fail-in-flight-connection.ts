// D-12/ACT-01: guarantees "a server never stays in CONNECTING forever". The worker (Plan 04-07)
// calls this from its `stalled` listener and from its startup sweep — it is the only code path
// that resolves an in-flight connection whose worker died. It never reconnects over SSH: a
// crashed worker must produce a recorded failure, not a permanently spinning status pill.
import { eq } from 'drizzle-orm';
import { transition, type ServerStatus } from '@noodara/domain/server';
import { writeActivityEvent } from '../activity/write-activity-event.js';
import { credentials } from '../db/schema/credentials.js';
import { servers } from '../db/schema/servers.js';
import { publishServerEvent } from '../events/server-event-publisher.js';
import type { ServerServicesDeps, ServiceActor } from './server-service-deps.js';
import { toServerView, type ServerView } from './server-view.js';

export interface FailInFlightConnectionInput {
  readonly actor: ServiceActor;
  readonly serverId: string;
  readonly reason: 'worker_stalled' | 'worker_startup_sweep';
}

export type FailInFlightConnectionResult =
  | { readonly ok: true; readonly skipped: false; readonly server: ServerView }
  | { readonly ok: true; readonly skipped: true }
  | { readonly ok: false; readonly code: 'NOT_FOUND'; readonly message: string };

/**
 * Locks the row, and — only when it is still `CONNECTING` — transitions it to `ERROR` with
 * `last_error_code = CONNECTION_LOST`, writes one `server.connection_attempted` failure event
 * and publishes `server.updated` after the transaction commits. Any other starting status means
 * the real job already resolved (a `CONNECTED`/`ERROR`/etc. result landed before this recovery
 * ran) — that is not a failure, it is a no-op (`{ ok: true, skipped: true }`), since clobbering a
 * genuine result with a stale stall signal would itself be a false state (T-4-23).
 *
 * Deliberately never touches `deps.ssh` — the connection never happened, so nothing about the
 * fingerprint, `lastSeenAt` or any discovery fact is touched either.
 */
export async function failInFlightConnection(
  deps: ServerServicesDeps,
  input: FailInFlightConnectionInput,
): Promise<FailInFlightConnectionResult> {
  const result: FailInFlightConnectionResult = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(servers)
      .where(eq(servers.id, input.serverId))
      .for('update');
    if (!row) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        message: `Server "${input.serverId}" not found`,
      };
    }
    if (row.status !== 'CONNECTING') {
      return { ok: true, skipped: true };
    }

    const now = deps.now();
    const nextStatus: ServerStatus = transition(row.status, 'ERROR');

    const [updatedRow] = await tx
      .update(servers)
      .set({ status: nextStatus, lastErrorCode: 'CONNECTION_LOST', updatedAt: now })
      .where(eq(servers.id, row.id))
      .returning();
    if (!updatedRow) {
      throw new Error('failInFlightConnection: server update returned no row');
    }

    const activityInput = {
      actorType: input.actor.type,
      actorId: input.actor.type === 'user' ? input.actor.id : null,
      entityType: 'server',
      entityId: row.id,
      action: 'server.connection_attempted',
      outcome: 'failure',
      errorCode: 'CONNECTION_LOST',
      // T-4-25: metadata is `{ reason }` from a fixed two-member union — no host, user,
      // credential or error text.
      metadata: { reason: input.reason },
    } as const;
    await writeActivityEvent(tx, activityInput, now);

    const [credentialRow] = await tx
      .select({ type: credentials.type })
      .from(credentials)
      .where(eq(credentials.id, updatedRow.credentialId))
      .limit(1);
    if (!credentialRow) {
      throw new Error(`failInFlightConnection: credential ${updatedRow.credentialId} not found`);
    }

    return { ok: true, skipped: false, server: toServerView(updatedRow, credentialRow.type) };
  });

  // D-04: publish only after the transaction has committed, and only for a real resolution.
  if (result.ok && !result.skipped) {
    await publishServerEvent(deps.events, { type: 'server.updated', server: result.server });
  }
  return result;
}

/**
 * Read-only list of every server currently `CONNECTING`, for the worker's startup sweep (D-12).
 * No lock, no transaction — the per-row lock is taken by `failInFlightConnection` itself when it
 * acts on a given id.
 */
export async function listConnectingServerIds(deps: ServerServicesDeps): Promise<string[]> {
  const rows = await deps.db
    .select({ id: servers.id })
    .from(servers)
    .where(eq(servers.status, 'CONNECTING'));
  return rows.map((row) => row.id);
}
