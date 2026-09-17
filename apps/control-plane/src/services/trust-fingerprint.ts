// D-04/ACT-01: promotes a `pending_fingerprint` parked by a `HOST_KEY_CHANGED` connect failure
// into `host_fingerprint`, the only way an admin's explicit "Trust new fingerprint" decision may
// re-establish trust for a host that failed TOFU verification (T-3-07). No HTTP route exists yet
// — phase 4 exposes `POST /servers/:id/trust-fingerprint` over this service.
import { eq } from 'drizzle-orm';
import { transition, type ServerStatus } from '@noodara/domain/server';
import { writeActivityEvent } from '../activity/write-activity-event.js';
import { credentials } from '../db/schema/credentials.js';
import { servers } from '../db/schema/servers.js';
import { publishServerEvent } from '../events/server-event-publisher.js';
import type { ServerServicesDeps, ServiceActor } from './server-service-deps.js';
import { toServerView, type ServerView } from './server-view.js';

export interface TrustFingerprintInput {
  readonly actor: ServiceActor;
  readonly serverId: string;
}

export type TrustFingerprintFailureCode = 'NOT_FOUND' | 'SERVER_BUSY' | 'NO_PENDING_FINGERPRINT';

export type TrustFingerprintResult =
  | { readonly ok: true; readonly server: ServerView }
  | { readonly ok: false; readonly code: TrustFingerprintFailureCode; readonly message: string };

/**
 * D-04: locks the row, rejects a server with a connection attempt in flight (T-3-06) or with no
 * pending fingerprint to promote, then copies `pending_fingerprint` into `host_fingerprint`,
 * clears both pending columns and transitions `ERROR -> PENDING` with the `fingerprint_trusted`
 * reason `transition()` requires for that edge (D-15) — never a status literal. A pending
 * fingerprint can only have been parked by a `HOST_KEY_CHANGED` outcome, which always lands on
 * `ERROR` (docs/domain/server-state-transitions.md), so any other starting status reaching this
 * point with a non-null `pendingFingerprint` is a bug; the `InvalidTransitionError`/
 * `MissingTransitionReasonError` `transition()` would throw in that case is the correct response
 * and is deliberately not swallowed into a result code.
 */
export async function trustFingerprint(
  deps: ServerServicesDeps,
  input: TrustFingerprintInput,
): Promise<TrustFingerprintResult> {
  const result: TrustFingerprintResult = await deps.db.transaction(async (tx) => {
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
    if (row.pendingFingerprint === null) {
      return {
        ok: false,
        code: 'NO_PENDING_FINGERPRINT',
        message: 'Server has no pending fingerprint to trust',
      };
    }

    const previousFingerprint = row.hostFingerprint;
    const newFingerprint = row.pendingFingerprint;
    const now = deps.now();

    const nextStatus: ServerStatus = transition(row.status, 'PENDING', {
      reason: 'fingerprint_trusted',
    });

    const [updatedRow] = await tx
      .update(servers)
      .set({
        hostFingerprint: newFingerprint,
        hostFingerprintCapturedAt: now,
        pendingFingerprint: null,
        pendingFingerprintSeenAt: null,
        status: nextStatus,
        updatedAt: now,
      })
      .where(eq(servers.id, row.id))
      .returning();
    if (!updatedRow) {
      throw new Error('trustFingerprint: server update returned no row');
    }

    const activityInput = {
      actorType: input.actor.type,
      actorId: input.actor.type === 'user' ? input.actor.id : null,
      entityType: 'server',
      entityId: row.id,
      action: 'server.fingerprint_trusted',
      outcome: 'success',
      // D-16: fingerprints are public identifiers, not secrets — they belong in metadata.
      metadata: { previousFingerprint, newFingerprint },
    } as const;
    await writeActivityEvent(tx, activityInput, now);

    const [credentialRow] = await tx
      .select({ type: credentials.type })
      .from(credentials)
      .where(eq(credentials.id, updatedRow.credentialId))
      .limit(1);
    if (!credentialRow) {
      throw new Error(`trustFingerprint: credential ${updatedRow.credentialId} not found`);
    }

    return { ok: true, server: toServerView(updatedRow, credentialRow.type) };
  });

  // D-04: publish only after the transaction has committed.
  if (result.ok) {
    await publishServerEvent(deps.events, { type: 'server.updated', server: result.server });
  }
  return result;
}
