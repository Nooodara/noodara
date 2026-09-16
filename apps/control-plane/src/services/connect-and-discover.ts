// DISC-03/D-01..D-08/D-16/D-17/ACT-01: the single entry point phase 4's `connect-server` job and
// DISC-05's re-run both call. Drives one SSH session through connect + discovery and persists the
// result, without ever leaking a secret, inventing a status, or throwing out of a remote-operation
// failure (SERV-07).
//
// Transaction shape (load-bearing, 03-08-PLAN.md's own objective): SSH work cannot be held inside
// a database transaction.
//   TX1 — `SELECT ... FOR UPDATE`, the D-05 conflict check, `transition(..., 'CONNECTING')`.
//   (SSH connect happens between the two transactions, in no transaction of its own — the
//   discovery half of this comment is filled in once Task 3 lands.)
//   TX2 — `applyConnectionResult`, the service-owned fingerprint timestamps and one
//   `server.connection_attempted` event, all atomic.
import { eq } from 'drizzle-orm';
import {
  runDiscovery,
  formatFingerprint,
  parseFingerprint,
  type HostFingerprint,
} from '@noodara/ssh';
import {
  applyConnectionResult,
  transition,
  type ServerConnectionState,
  type ServerErrorCode,
} from '@noodara/domain/server';
import type { ActivityWriteHandle } from '../activity/write-activity-event.js';
import { writeActivityEvent } from '../activity/write-activity-event.js';
import { credentials } from '../db/schema/credentials.js';
import { servers } from '../db/schema/servers.js';
import { decodeCredential } from './credential-store.js';
import type { ServerServicesDeps, ServiceActor } from './server-service-deps.js';
import { toServerView, type ServerView } from './server-view.js';

export interface ConnectAndDiscoverInput {
  readonly actor: ServiceActor;
  readonly serverId: string;
  /** Injection seam for tests (03-08-PLAN.md Task 1): scripting `runDiscovery`'s internals through
   *  a fake `SshSession` is impractical for the D-02 warnings/checks matrix, so a test overrides
   *  this to resolve directly to a fixture-built `DiscoverySnapshot`. Defaults to the real
   *  `runDiscovery` in production — never assigned any other value outside a test. */
  readonly discover?: typeof runDiscovery;
}

export type ConnectAndDiscoverFailureCode = 'NOT_FOUND' | 'ALREADY_CONNECTING';

export interface ConnectionReport {
  readonly ok: boolean;
  readonly errorCode?: ServerErrorCode;
  readonly attempts: number;
  readonly durationMs: number;
  readonly fingerprintCaptured: boolean;
}

export type ConnectAndDiscoverResult =
  | {
      readonly ok: true;
      readonly server: ServerView;
      readonly connection: ConnectionReport;
    }
  | {
      readonly ok: false;
      readonly code: ConnectAndDiscoverFailureCode;
      readonly message: string;
    };

type CredentialRow = typeof credentials.$inferSelect;
type ServerRow = typeof servers.$inferSelect;

interface LockedServer {
  readonly row: ServerRow;
  readonly credentialRow: CredentialRow;
}

type LockResult =
  | ({ readonly ok: true } & LockedServer)
  | { readonly ok: false; readonly code: ConnectAndDiscoverFailureCode; readonly message: string };

/** TX1: the row lock, D-05's conflict check and the `CONNECTING` transition — the only place this
 *  file reads the credential row, so the SSH phase below needs no further reads. */
async function lockAndBeginConnecting(
  deps: ServerServicesDeps,
  serverId: string,
): Promise<LockResult> {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx.select().from(servers).where(eq(servers.id, serverId)).for('update');
    if (!row) {
      return { ok: false, code: 'NOT_FOUND', message: `Server "${serverId}" not found` };
    }
    if (row.status === 'CONNECTING') {
      return {
        ok: false,
        code: 'ALREADY_CONNECTING',
        message: 'A connection attempt is already in flight',
      };
    }

    const newStatus = transition(row.status, 'CONNECTING');
    const [updatedRow] = await tx
      .update(servers)
      .set({ status: newStatus, updatedAt: deps.now() })
      .where(eq(servers.id, row.id))
      .returning();
    if (!updatedRow) {
      throw new Error('connectAndDiscover: CONNECTING update returned no row');
    }

    const [credentialRow] = await tx
      .select()
      .from(credentials)
      .where(eq(credentials.id, row.credentialId))
      .limit(1);
    if (!credentialRow) {
      throw new Error(`connectAndDiscover: credential ${row.credentialId} not found`);
    }

    return { ok: true, row: updatedRow, credentialRow };
  });
}

/** The `ConnectionResult` shape `applyConnectionResult` expects, built from a `ConnectOutcome`. */
function toConnectionResult(
  outcome: Awaited<ReturnType<ServerServicesDeps['ssh']['connect']>>,
): Parameters<typeof applyConnectionResult>[1] {
  if (outcome.ok) {
    return { ok: true, fingerprint: formatFingerprint(outcome.fingerprint) };
  }
  return {
    ok: false,
    errorCode: outcome.errorCode,
    ...(outcome.observedFingerprint !== undefined
      ? { observedFingerprint: formatFingerprint(outcome.observedFingerprint) }
      : {}),
  };
}

function buildConnectionReport(
  outcome: Awaited<ReturnType<ServerServicesDeps['ssh']['connect']>>,
  durationMs: number,
): ConnectionReport {
  if (outcome.ok) {
    return {
      ok: true,
      attempts: outcome.attempts,
      durationMs,
      fingerprintCaptured: outcome.fingerprintCaptured,
    };
  }
  return {
    ok: false,
    errorCode: outcome.errorCode,
    attempts: outcome.attempts,
    durationMs,
    fingerprintCaptured: false,
  };
}

async function writeConnectionAttemptedEvent(
  handle: ActivityWriteHandle,
  deps: ServerServicesDeps,
  actor: ServiceActor,
  serverId: string,
  outcome: Awaited<ReturnType<ServerServicesDeps['ssh']['connect']>>,
  durationMs: number,
): Promise<void> {
  const activityInput = {
    actorType: actor.type,
    actorId: actor.type === 'user' ? actor.id : null,
    entityType: 'server',
    entityId: serverId,
    action: 'server.connection_attempted',
    outcome: outcome.ok ? ('success' as const) : ('failure' as const),
    ...(outcome.ok ? {} : { errorCode: outcome.errorCode }),
    metadata: {
      attempts: outcome.attempts,
      durationMs,
      fingerprintCaptured: outcome.ok ? outcome.fingerprintCaptured : false,
    },
  } as const;
  await writeActivityEvent(handle, activityInput, deps.now());
}

/**
 * DISC-03: decrypts the credential, transitions to `CONNECTING` under a row lock (D-05), then
 * connects over SSH. Never throws for an SSH-level failure (SERV-07): every connect outcome is
 * applied to the server row and reported back as a successful service call.
 */
export async function connectAndDiscover(
  deps: ServerServicesDeps,
  input: ConnectAndDiscoverInput,
): Promise<ConnectAndDiscoverResult> {
  const locked = await lockAndBeginConnecting(deps, input.serverId);
  if (!locked.ok) {
    return locked;
  }
  const { row, credentialRow } = locked;

  // SSH work happens between the two transactions, in no transaction of its own — see this
  // file's header note.
  const credential = decodeCredential(credentialRow, deps.masterKeys);
  const trustedFingerprint: HostFingerprint | null =
    row.hostFingerprint === null ? null : parseFingerprint(row.hostFingerprint);

  const startedAt = deps.now();
  const outcome = await deps.ssh.connect({
    target: { host: row.host, port: row.sshPort, user: row.sshUser },
    credential,
    timeouts: deps.timeouts,
    trustedFingerprint,
    redactor: deps.redactor,
  });
  const durationMs = deps.now().getTime() - startedAt.getTime();

  // Task 3 fills the discovery half in here, on the success path, before the session closes.
  if (outcome.ok) {
    await outcome.session.close();
  }

  return deps.db.transaction(async (tx) => {
    const currentState: ServerConnectionState = {
      status: row.status,
      lastErrorCode: row.lastErrorCode,
      hostFingerprint: row.hostFingerprint,
      pendingFingerprint: row.pendingFingerprint,
      lastSeenAt: row.lastSeenAt,
    };
    const nextState = applyConnectionResult(currentState, toConnectionResult(outcome), deps.now());

    // Pitfall 4: these two timestamps are this service's job, never `applyConnectionResult`'s.
    const hostFingerprintCapturedAt =
      outcome.ok && outcome.fingerprintCaptured ? deps.now() : row.hostFingerprintCapturedAt;
    const pendingFingerprintSeenAt =
      !outcome.ok &&
      outcome.errorCode === 'HOST_KEY_CHANGED' &&
      outcome.observedFingerprint !== undefined
        ? deps.now()
        : row.pendingFingerprintSeenAt;

    const [updatedRow] = await tx
      .update(servers)
      .set({
        status: nextState.status,
        lastErrorCode: nextState.lastErrorCode,
        hostFingerprint: nextState.hostFingerprint,
        pendingFingerprint: nextState.pendingFingerprint,
        lastSeenAt: nextState.lastSeenAt,
        hostFingerprintCapturedAt,
        pendingFingerprintSeenAt,
        updatedAt: deps.now(),
      })
      .where(eq(servers.id, row.id))
      .returning();
    if (!updatedRow) {
      throw new Error('connectAndDiscover: connection-result server update returned no row');
    }

    await writeConnectionAttemptedEvent(tx, deps, input.actor, row.id, outcome, durationMs);

    return {
      ok: true as const,
      server: toServerView(updatedRow, credentialRow.type),
      connection: buildConnectionReport(outcome, durationMs),
    };
  });
}
