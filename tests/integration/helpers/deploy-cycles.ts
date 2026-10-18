// 20-02: pure checks behind the deploy/rollback cycles stress suite
// (tests/integration/deploy-engine/cycles.test.ts). No I/O: the suite feeds them what it read from
// Postgres, the recorded events and the deploy host's `docker` output.
import {
  TERMINAL_DEPLOYMENT_STATUSES,
  transitionDeployment,
  type DeploymentStatus,
  type DeploymentTrigger,
} from '@noodara/domain/deployment';

const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_DEPLOYMENT_STATUSES);

export type ReplayResult =
  | { readonly ok: true; readonly final: DeploymentStatus; readonly path: readonly DeploymentStatus[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Replays the statuses one deployment was published with through `transitionDeployment`. A status
 * announced twice in a row is one state (a re-publish, not a transition). The path must start at
 * QUEUED and end terminal.
 */
export function replayDeploymentStatuses(
  statuses: readonly DeploymentStatus[],
  trigger: DeploymentTrigger,
): ReplayResult {
  const path = statuses.filter((status, index) => index === 0 || statuses[index - 1] !== status);
  const [first] = path;
  if (first !== 'QUEUED') return { ok: false, reason: `starts at ${first ?? 'nothing'}, not QUEUED` };
  let current: DeploymentStatus = first;
  for (const next of path.slice(1)) {
    try {
      current = transitionDeployment(current, next, trigger);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  if (!TERMINAL.has(current)) return { ok: false, reason: `ends at ${current}, not a terminal status` };
  return { ok: true, final: current, path };
}

const SIZE_UNITS: Readonly<Record<string, number>> = {
  B: 1,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
};

/** `docker system df` sizes ("0B", "12.5kB", "1.2GB"); NaN for anything else. */
export function parseDockerSize(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/.exec(raw.trim());
  if (!match) return Number.NaN;
  const unit = SIZE_UNITS[(match[2] ?? '').toUpperCase()];
  return unit === undefined ? Number.NaN : Number(match[1]) * unit;
}

export interface DfRow {
  readonly type: string;
  readonly total: number;
  readonly active: number;
  readonly sizeBytes: number;
}

/** `docker system df` rendered with the `|`-delimited `DF_FORMAT` ("Local Volumes" has a space). */
export const DF_FORMAT = '{{.Type}}|{{.TotalCount}}|{{.Active}}|{{.Size}}';

export function parseDf(raw: string): DfRow[] {
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [type = '', total = '', active = '', size = ''] = line.split('|');
      return { type: type.trim(), total: Number(total), active: Number(active), sizeBytes: parseDockerSize(size) };
    });
}

export function dfRow(rows: readonly DfRow[], type: string): DfRow {
  const row = rows.find((entry) => entry.type === type);
  if (!row) throw new Error(`docker system df has no "${type}" row`);
  return row;
}

export interface LogLedgerEntry {
  /** Rows the writer inserted without an error. */
  readonly inserted: number;
  /** The sink's own `stats()` once closed. */
  readonly persistedChunks: number;
  readonly droppedChunks: number;
  readonly persistFailures: number;
}

/**
 * H1: every chunk a deployment's sink produced is one row in deployment_log_chunks, none dropped,
 * none failed, none extra. Returns one line per problem; empty means reconciled.
 */
export function reconcileLogChunks(
  deploymentIds: readonly string[],
  ledger: ReadonlyMap<string, LogLedgerEntry>,
  rowsByDeployment: ReadonlyMap<string, number>,
): string[] {
  const problems: string[] = [];
  const known = new Set(deploymentIds);
  for (const id of deploymentIds) {
    const entry = ledger.get(id);
    const rows = rowsByDeployment.get(id) ?? 0;
    if (entry === undefined) {
      problems.push(`${id}: no log sink was opened`);
      continue;
    }
    if (entry.droppedChunks > 0) problems.push(`${id}: ${String(entry.droppedChunks)} chunks dropped`);
    if (entry.persistFailures > 0) problems.push(`${id}: ${String(entry.persistFailures)} chunk inserts failed`);
    if (entry.persistedChunks !== entry.inserted) {
      problems.push(`${id}: sink persisted ${String(entry.persistedChunks)}, writer inserted ${String(entry.inserted)}`);
    }
    if (rows !== entry.inserted) problems.push(`${id}: ${String(rows)} rows for ${String(entry.inserted)} inserts`);
    if (rows === 0) problems.push(`${id}: no log rows at all`);
  }
  for (const [id, rows] of rowsByDeployment) {
    if (!known.has(id)) problems.push(`${id}: ${String(rows)} log rows of a deployment no request created`);
  }
  return problems;
}

export interface DeliveryRow {
  readonly deliveryId: string;
  readonly outcome: string;
  readonly deploymentId: string | null;
}

/**
 * H1: one webhook_deliveries row per push issued, each `deployed` into its own deployment, which
 * is the deployment the request recorded. Returns one line per problem; empty means reconciled.
 */
export function reconcileWebhookDeliveries(
  issued: ReadonlyMap<string, string>,
  rows: readonly DeliveryRow[],
): string[] {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  for (const row of rows) seen.set(row.deliveryId, (seen.get(row.deliveryId) ?? 0) + 1);
  for (const [deliveryId, count] of seen) {
    if (count > 1) problems.push(`${deliveryId}: ${String(count)} delivery rows`);
    if (!issued.has(deliveryId)) problems.push(`${deliveryId}: a delivery row no request issued`);
  }
  for (const [deliveryId, deploymentId] of issued) {
    const row = rows.find((entry) => entry.deliveryId === deliveryId);
    if (!row) {
      problems.push(`${deliveryId}: delivery lost`);
      continue;
    }
    if (row.outcome !== 'deployed') problems.push(`${deliveryId}: outcome ${row.outcome}, expected deployed`);
    if (row.deploymentId !== deploymentId) {
      problems.push(`${deliveryId}: linked to ${row.deploymentId ?? 'no deployment'}, expected ${deploymentId}`);
    }
  }
  const linked = rows.map((row) => row.deploymentId).filter((id): id is string => id !== null);
  if (new Set(linked).size !== linked.length) problems.push('two deliveries share one deployment');
  return problems;
}

/** Sorted difference `after \ before`, for "what was left behind" messages. */
export function extraEntries(before: readonly string[], after: readonly string[]): string[] {
  const base = new Set(before);
  return [...new Set(after)].filter((entry) => !base.has(entry)).sort();
}
