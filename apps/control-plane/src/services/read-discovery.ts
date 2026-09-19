// DISC-02/D-05: the read side of a server's discovery history — the latest run only (D-07 limits
// v0.1 to the latest run, no run-history endpoint). Mirrors read-servers.ts's read discipline: no
// transaction, no activity event (a read is neither, ACT-01), absence expressed as a value (the
// all-null/empty shape), never a thrown error or a `{ ok, code }` result union.
import { desc, eq } from 'drizzle-orm';
import type { DiscoveryCheck, SnapshotOutcome } from '@noodara/domain/discovery';
import { DISCOVERY_CHECK_IDS, DISCOVERY_CHECK_STATUSES } from '@noodara/domain/discovery';
import type { ServerErrorCode } from '@noodara/domain/server';
import { discoverySnapshots } from '../db/schema/discovery-snapshots.js';
import type { ServerServicesDeps } from './server-service-deps.js';

export interface LatestDiscoveryView {
  readonly collectedAt: Date | null;
  readonly outcome: SnapshotOutcome | null;
  readonly checks: readonly DiscoveryCheck[];
  readonly warnings: readonly ServerErrorCode[];
}

const DISCOVERY_CHECK_ID_SET: ReadonlySet<string> = new Set(DISCOVERY_CHECK_IDS);
const DISCOVERY_CHECK_STATUS_SET: ReadonlySet<string> = new Set(DISCOVERY_CHECK_STATUSES);

function isDiscoveryCheck(value: unknown): value is DiscoveryCheck {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    DISCOVERY_CHECK_ID_SET.has(candidate.id) &&
    typeof candidate.status === 'string' &&
    DISCOVERY_CHECK_STATUS_SET.has(candidate.status) &&
    typeof candidate.detail === 'string' &&
    typeof candidate.durationMs === 'number'
  );
}

/** Defensively projects `checks` off a stored `jsonb` payload — the column has no schema of its
 *  own (it stores a `DiscoverySnapshot` verbatim), so a missing or malformed array yields `[]`
 *  rather than throwing. */
function projectChecks(payload: unknown): readonly DiscoveryCheck[] {
  if (typeof payload !== 'object' || payload === null) {
    return [];
  }
  const checks = (payload as Record<string, unknown>).checks;
  if (!Array.isArray(checks)) {
    return [];
  }
  return checks.filter(isDiscoveryCheck);
}

/** Defensively projects `warnings` off a stored `jsonb` payload, same discipline as
 *  `projectChecks`. Validated for shape (a non-empty string) rather than the full
 *  `ServerErrorCode` enum, matching the column's own reuse of `server_error_code`. */
function projectWarnings(payload: unknown): readonly ServerErrorCode[] {
  if (typeof payload !== 'object' || payload === null) {
    return [];
  }
  const warnings = (payload as Record<string, unknown>).warnings;
  if (!Array.isArray(warnings)) {
    return [];
  }
  return warnings.filter((warning): warning is ServerErrorCode => typeof warning === 'string');
}

/**
 * The latest discovery run for `serverId`, projected to exactly `collectedAt`/`outcome`/`checks`/
 * `warnings` — every other key the stored payload carries (notably the discovery facts) is
 * deliberately dropped (T-5-18): this function can never become a pass-through for the whole
 * `jsonb` column. Returns the all-null/empty shape when no snapshot exists yet.
 */
export async function readLatestDiscovery(
  deps: ServerServicesDeps,
  serverId: string,
): Promise<LatestDiscoveryView> {
  const [row] = await deps.db
    .select({
      collectedAt: discoverySnapshots.collectedAt,
      outcome: discoverySnapshots.outcome,
      payload: discoverySnapshots.payload,
    })
    .from(discoverySnapshots)
    .where(eq(discoverySnapshots.serverId, serverId))
    .orderBy(desc(discoverySnapshots.collectedAt))
    .limit(1);

  if (!row) {
    return { collectedAt: null, outcome: null, checks: [], warnings: [] };
  }

  return {
    collectedAt: row.collectedAt,
    outcome: row.outcome,
    checks: projectChecks(row.payload),
    warnings: projectWarnings(row.payload),
  };
}
