// SERV-03/ACT-01: deletes an existing server. Deletion is the one operation that destroys
// evidence, so ordering and transactional scope are the whole point: the `server.deleted` event
// is written BEFORE any row disappears (D-14), then the `servers` row is removed — cascading
// `discovery_snapshots` (migration 0003) — and only then the `credentials` row, because
// `servers.credential_id` references it with ON DELETE no action. Deleting credentials first
// would violate that still-present reference. All of it commits in one `deps.db.transaction`, or
// nothing at all.
import { eq } from 'drizzle-orm';
import { writeActivityEvent } from '../activity/write-activity-event.js';
import { credentials } from '../db/schema/credentials.js';
import { servers } from '../db/schema/servers.js';
import type { ServerServicesDeps, ServiceActor } from './server-service-deps.js';

export interface DeleteServerInput {
  readonly actor: ServiceActor;
  readonly serverId: string;
  readonly confirmName: string;
}

export type DeleteServerFailureCode = 'NOT_FOUND' | 'SERVER_BUSY' | 'CONFIRMATION_MISMATCH';

export type DeleteServerResult =
  | { readonly ok: true; readonly serverId: string }
  | { readonly ok: false; readonly code: DeleteServerFailureCode; readonly message: string };

/**
 * SERV-03: requires the caller to repeat the server's exact name (D-12: strict `!==`, no
 * trimming, no case folding), rejects a server with a connection attempt in flight (D-11), then
 * — in one transaction — writes `server.deleted` against the still-live row, deletes the
 * `servers` row (cascading its `discovery_snapshots`) and finally its `credentials` row.
 */
export async function deleteServer(
  deps: ServerServicesDeps,
  input: DeleteServerInput,
): Promise<DeleteServerResult> {
  return deps.db.transaction(async (tx) => {
    // D-11/T-3-06: the row lock stops a concurrently in-flight connectAndDiscover from writing
    // status/fingerprint onto a row about to disappear.
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
    if (row.status === 'CONNECTING') {
      return {
        ok: false,
        code: 'SERVER_BUSY',
        message: 'Server has a connection attempt in flight',
      };
    }

    // D-12: exact, case-sensitive, untrimmed comparison against the live row's name — the caller
    // sends what the admin typed, nothing is normalized on either side.
    if (input.confirmName !== row.name) {
      return {
        ok: false,
        code: 'CONFIRMATION_MISMATCH',
        message: 'Confirmation name does not match the server name',
      };
    }

    const activityInput = {
      actorType: input.actor.type,
      actorId: input.actor.type === 'user' ? input.actor.id : null,
      entityType: 'server',
      entityId: row.id,
      action: 'server.deleted',
      outcome: 'success',
      metadata: { name: row.name, host: row.host },
    } as const;
    await writeActivityEvent(tx, activityInput, deps.now());

    // The servers row goes first — its delete cascades discovery_snapshots (migration 0003) —
    // then the credentials row, since servers.credential_id references it with ON DELETE no
    // action and would otherwise still be pointing at a row that's about to disappear.
    await tx.delete(servers).where(eq(servers.id, row.id));
    await tx.delete(credentials).where(eq(credentials.id, row.credentialId));

    return { ok: true, serverId: row.id };
  });
}
