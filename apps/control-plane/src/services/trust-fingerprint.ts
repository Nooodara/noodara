// D-04/ACT-01: promotes a `pending_fingerprint` parked by a `HOST_KEY_CHANGED` connect failure
// into `host_fingerprint`, the only way an admin's explicit "Trust new fingerprint" decision may
// re-establish trust for a host that failed TOFU verification (T-3-07). Phase 4 exposes `POST
// /servers/:id/trust-fingerprint` over this service; gap 6 / T-5G-27 (05-VERIFICATION.md;
// .planning/todos/pending/2026-09-19-trust-fingerprint-toctou.md) binds that route to the exact
// fingerprint value the admin saw, closing the display/promote TOCTOU a client-side re-GET alone
// could only narrow.
import { and, eq } from 'drizzle-orm';
import { canTrustFingerprint, transition, type ServerStatus } from '@noodara/domain/server';
import { writeActivityEvent } from '../activity/write-activity-event.js';
import { credentials } from '../db/schema/credentials.js';
import { servers } from '../db/schema/servers.js';
import { publishServerEvent } from '../events/server-event-publisher.js';
import type { ServerServicesDeps, ServiceActor } from './server-service-deps.js';
import { toServerView, type ServerView } from './server-view.js';

export interface TrustFingerprintInput {
  readonly actor: ServiceActor;
  readonly serverId: string;
  /** Gap 6 / T-5G-27: the exact fingerprint the admin was shown — promotion only happens if this
   *  still equals the row's live `pending_fingerprint` at promote time (see the atomic conditional
   *  UPDATE below). */
  readonly fingerprint: string;
}

export type TrustFingerprintFailureCode =
  | 'NOT_FOUND'
  | 'SERVER_BUSY'
  | 'NO_PENDING_FINGERPRINT'
  | 'SERVER_NOT_TRUSTABLE'
  | 'FINGERPRINT_MISMATCH';

export type TrustFingerprintResult =
  | { readonly ok: true; readonly server: ServerView }
  | { readonly ok: false; readonly code: TrustFingerprintFailureCode; readonly message: string };

/**
 * D-04/T-5G-27: locks the row, rejects a server with a connection attempt in flight (T-3-06) or
 * with no pending fingerprint to promote, then — since gap 6's fix — rejects a status the
 * `fingerprint_trusted` edge cannot legally land from (`SERVER_NOT_TRUSTABLE`, via
 * `canTrustFingerprint`, so `transition()` below is only ever reached from a status where it is
 * guaranteed not to throw) before attempting an atomic conditional promote: the `UPDATE` is scoped
 * to `WHERE id = ... AND pending_fingerprint = input.fingerprint`, so a value that changed between
 * whatever the admin last saw and this call is never promoted — it fails closed as
 * `FINGERPRINT_MISMATCH`, with no status change, no activity event and no published event. Only a
 * genuine match copies `pending_fingerprint` into `host_fingerprint`, clears both pending columns
 * and transitions `ERROR -> PENDING` with the `fingerprint_trusted` reason `transition()` requires
 * for that edge (D-15) — never a status literal.
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
    if (!canTrustFingerprint(row.status)) {
      return {
        ok: false,
        code: 'SERVER_NOT_TRUSTABLE',
        message: 'Server is not in a state that can trust a fingerprint',
      };
    }

    const previousFingerprint = row.hostFingerprint;
    const newFingerprint = row.pendingFingerprint;
    const now = deps.now();

    const nextStatus: ServerStatus = transition(row.status, 'PENDING', {
      reason: 'fingerprint_trusted',
    });

    // T-5G-27-01/02: the conditional WHERE clause — not the row lock alone — is what makes this
    // an atomic "promote iff still what the admin saw" instead of "promote whatever is pending
    // right now". `.returning()` yields no row exactly when `pending_fingerprint` no longer equals
    // `input.fingerprint`.
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
      .where(and(eq(servers.id, row.id), eq(servers.pendingFingerprint, input.fingerprint)))
      .returning();
    if (!updatedRow) {
      // T-5G-27-06: nothing happened — no activity event, no published event.
      return {
        ok: false,
        code: 'FINGERPRINT_MISMATCH',
        message: 'Submitted fingerprint no longer matches the server’s pending fingerprint',
      };
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
