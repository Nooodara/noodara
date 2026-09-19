// DISC-03/D-01..D-08/D-16/D-17/ACT-01: the single entry point phase 4's `connect-server` job and
// DISC-05's re-run both call. Drives one SSH session through connect + discovery and persists the
// result, without ever leaking a secret, inventing a status, or throwing out of a remote-operation
// failure (SERV-07).
//
// Transaction shape (load-bearing, 03-08-PLAN.md's own objective): SSH work cannot be held inside
// a database transaction.
//   TX1 — `SELECT ... FOR UPDATE`, the D-05 conflict check, `transition(..., 'CONNECTING')`.
//   (SSH connect + discovery + session close happen between the two transactions, in no
//   transaction of their own.)
//   TX2 — `applyConnectionResult`, the service-owned fingerprint timestamps, D-02's optional
//   second `transition()`, the append-only snapshot insert, the denormalized `servers` UPDATE and
//   both activity events — all atomic (D-07).
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
import {
  classifySnapshotOutcome,
  mergeDiscoveryFacts,
  type SnapshotOutcome,
} from '@noodara/domain/discovery';
import type { ActivityWriteHandle } from '../activity/write-activity-event.js';
import { writeActivityEvent } from '../activity/write-activity-event.js';
import { credentials } from '../db/schema/credentials.js';
import { discoverySnapshots } from '../db/schema/discovery-snapshots.js';
import { servers } from '../db/schema/servers.js';
import { publishServerEvent } from '../events/server-event-publisher.js';
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

export interface DiscoveryReport {
  readonly snapshotId: string;
  readonly outcome: SnapshotOutcome;
  readonly warnings: readonly ServerErrorCode[];
  readonly checksFailed: readonly string[];
}

export type ConnectAndDiscoverResult =
  | {
      readonly ok: true;
      readonly server: ServerView;
      readonly connection: ConnectionReport;
      readonly discovery?: DiscoveryReport;
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

/** The subset of the D-02 discovery mapping this module derives before opening TX2 — never a
 *  status literal assigned anywhere else in this file. A discriminated union (rather than a flat
 *  `{ status; lastErrorCode }` shape) so a caller narrowing on `status !== 'CONNECTED'` gets a
 *  provably non-null `lastErrorCode` back, with no assertion needed at the write-site. */
type DiscoveryStatusPatch =
  | { readonly status: 'ERROR'; readonly lastErrorCode: 'COMMAND_TIMEOUT' }
  | { readonly status: 'UNREACHABLE'; readonly lastErrorCode: 'CONNECTION_LOST' }
  | { readonly status: 'CONNECTED'; readonly lastErrorCode: ServerErrorCode | null };

/**
 * D-02's exact mapping, in order: a `COMMAND_TIMEOUT` warning outranks an all-failed outcome
 * (both can theoretically coexist — the discovery-total budget can be exceeded on the very last
 * runnable check, leaving every prior check `pass`), which in turn outranks a lone
 * `UNSUPPORTED_OS` warning. `applyConnectionResult` is never called a second time here (it throws
 * once the status is already `CONNECTED`, Pitfall 7) — both status-changing branches use
 * `transition()` directly, exactly like docs/domain/server-state-transitions.md documents. D-03:
 * the CONNECTED -> DISCONNECTED system-close edge is never reached from this function.
 */
function classifyDiscoveryOutcome(
  warnings: readonly ServerErrorCode[],
  snapshotOutcome: SnapshotOutcome,
): DiscoveryStatusPatch {
  if (warnings.includes('COMMAND_TIMEOUT')) {
    transition('CONNECTED', 'ERROR');
    return { status: 'ERROR', lastErrorCode: 'COMMAND_TIMEOUT' };
  }
  if (snapshotOutcome === 'failed') {
    transition('CONNECTED', 'UNREACHABLE');
    return { status: 'UNREACHABLE', lastErrorCode: 'CONNECTION_LOST' };
  }
  if (warnings.includes('UNSUPPORTED_OS')) {
    return { status: 'CONNECTED', lastErrorCode: 'UNSUPPORTED_OS' };
  }
  return { status: 'CONNECTED', lastErrorCode: null };
}

/** The twelve `servers` fact columns `mergeDiscoveryFacts` reads/writes, projected off a row. */
function currentFactsOf(row: ServerRow): Parameters<typeof mergeDiscoveryFacts>[0] {
  return {
    hostname: row.hostname,
    osDistribution: row.osDistribution,
    osVersion: row.osVersion,
    arch: row.arch,
    cpuCores: row.cpuCores,
    ramMb: row.ramMb,
    diskTotalMb: row.diskTotalMb,
    diskUsedMb: row.diskUsedMb,
    uptimeSeconds: row.uptimeSeconds,
    dockerInstalled: row.dockerInstalled,
    dockerVersion: row.dockerVersion,
    dockerComposeVersion: row.dockerComposeVersion,
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

async function writeDiscoveryCompletedEvent(
  handle: ActivityWriteHandle,
  deps: ServerServicesDeps,
  actor: ServiceActor,
  serverId: string,
  statusPatch: DiscoveryStatusPatch,
  snapshotId: string,
  warnings: readonly ServerErrorCode[],
  checksFailed: readonly string[],
): Promise<void> {
  const activityInput = {
    actorType: actor.type,
    actorId: actor.type === 'user' ? actor.id : null,
    entityType: 'server',
    entityId: serverId,
    action: 'server.discovery_completed',
    outcome: statusPatch.status === 'CONNECTED' ? ('success' as const) : ('failure' as const),
    ...(statusPatch.status === 'CONNECTED' ? {} : { errorCode: statusPatch.lastErrorCode }),
    metadata: { snapshotId, warnings, checksFailed },
  } as const;
  await writeActivityEvent(handle, activityInput, deps.now());
}

/**
 * DISC-03: decrypts the credential, transitions to `CONNECTING` under a row lock (D-05), connects
 * over SSH and — when connected — runs discovery on the same session before closing it (Pitfall 3:
 * the `finally` around discovery+close is mandatory even though `runDiscovery` itself never
 * throws). Never throws for an SSH-level failure (SERV-07): every connect/discovery outcome is
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

  // D-04: announce CONNECTING the instant TX1 commits, before the credential is decoded or the
  // (potentially multi-second) SSH phase starts — `locked.row` is already TX1's `.returning()`
  // value, so no extra read is needed.
  await publishServerEvent(deps.events, {
    type: 'server.updated',
    server: toServerView(row, credentialRow.type),
  });

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

  let snapshot: Awaited<ReturnType<typeof runDiscovery>> | undefined;
  if (outcome.ok) {
    try {
      const discover = input.discover ?? runDiscovery;
      snapshot = await discover({
        session: outcome.session,
        sshUser: row.sshUser,
        timeouts: { discoveryMs: deps.timeouts.discoveryMs },
        redactor: deps.redactor,
        // D-05: best-effort, fire-and-forget per-check progress — mirrors publishServerEvent's own
        // "never let a publish failure affect the run" contract. `void`, never awaited: onCheck is
        // a synchronous callback per run-discovery.ts's contract, and awaiting a Redis publish here
        // would serialize SSH work behind it.
        onCheck: (check) => {
          void publishServerEvent(deps.events, {
            type: 'server.discovery_progress',
            serverId: row.id,
            check,
          });
        },
      });
    } finally {
      // Pitfall 3: this `finally` must exist even though `runDiscovery` itself never throws — a
      // bug anywhere above it must not leak the credential's redactor registration for the life
      // of the process.
      await outcome.session.close();
    }
  }

  const result = await deps.db.transaction(async (tx) => {
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

    if (snapshot === undefined) {
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
    }

    // DISC-03/D-06/D-07: a run that reached discovery writes one append-only snapshot and
    // denormalizes `servers`, on top of the connection result computed above, all in this same
    // transaction (D-07's atomicity).
    const snapshotOutcome = classifySnapshotOutcome(snapshot.checks);
    const checksFailed = snapshot.checks
      .filter((check) => check.status === 'fail')
      .map((check) => check.id);
    const statusPatch = classifyDiscoveryOutcome(snapshot.warnings, snapshotOutcome);
    const mergedFacts = mergeDiscoveryFacts(currentFactsOf(row), snapshot.facts);

    const [snapshotRow] = await tx
      .insert(discoverySnapshots)
      .values({
        serverId: row.id,
        collectedAt: deps.now(),
        outcome: snapshotOutcome,
        errorCode: statusPatch.lastErrorCode,
        payload: snapshot,
      })
      .returning();
    if (!snapshotRow) {
      throw new Error('connectAndDiscover: discovery snapshot insert returned no row');
    }

    const [updatedRow] = await tx
      .update(servers)
      .set({
        status: statusPatch.status,
        lastErrorCode: statusPatch.lastErrorCode,
        hostFingerprint: nextState.hostFingerprint,
        pendingFingerprint: nextState.pendingFingerprint,
        lastSeenAt: nextState.lastSeenAt,
        hostFingerprintCapturedAt,
        pendingFingerprintSeenAt,
        ...mergedFacts,
        updatedAt: deps.now(),
      })
      .where(eq(servers.id, row.id))
      .returning();
    if (!updatedRow) {
      throw new Error('connectAndDiscover: post-discovery server update returned no row');
    }

    await writeConnectionAttemptedEvent(tx, deps, input.actor, row.id, outcome, durationMs);
    await writeDiscoveryCompletedEvent(
      tx,
      deps,
      input.actor,
      row.id,
      statusPatch,
      snapshotRow.id,
      snapshot.warnings,
      checksFailed,
    );

    return {
      ok: true as const,
      server: toServerView(updatedRow, credentialRow.type),
      connection: buildConnectionReport(outcome, durationMs),
      discovery: {
        snapshotId: snapshotRow.id,
        outcome: snapshotOutcome,
        warnings: snapshot.warnings,
        checksFailed,
      },
    };
  });

  // D-04: publish the outcome only after TX2 has committed — never inside the transaction
  // callback. Both branches above always resolve `{ ok: true }` (this function's only `ok: false`
  // exits are TX1's `lockAndBeginConnecting`, already returned above).
  await publishServerEvent(deps.events, { type: 'server.updated', server: result.server });
  return result;
}
