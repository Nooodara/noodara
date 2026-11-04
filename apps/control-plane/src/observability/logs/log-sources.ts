// 27-04 (A1, A4, H2): reads one service's log sources. Build and deploy entries come from stored
// chunks, activity from the audit trail, runtime from a bounded docker.logs_window fetched on
// demand over SSH. Every entry is redacted with a redactor holding the service's secret values
// (fail closed: no redactor, no entries). A scan that hits its row cap drops its oldest instant
// and reports a boundary, so an instant is never split across pages.
import { LOG_SOURCES, logTimestampMs, parseLogTimestamp, type LogSource } from '@noodara/domain';
import { createRedactor, type Redactor } from '@noodara/domain/security';
import { validateResourceId } from '@noodara/domain/validators';
import { fetchLogsWindow } from '@noodara/docker';
import { MAX_LOG_TAIL, type SshDeploySession } from '@noodara/ssh';
import { and, asc, desc, eq, gte, inArray, lt, or } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { activityEvents, deploymentLogChunks, deployments, secrets, services } from '../../db/schema/index.js';
import type { ConnectResult } from '../../deploy/deploy-worker.js';
import { decryptForDeploy } from '../../secrets/secret-store.js';
import type { MasterKeys } from '../../services/server-service-deps.js';
import type { LogPosition } from './log-cursor.js';
import {
  activityEntry,
  chunkEntries,
  finalizeEntry,
  positionEntries,
  positionOf,
  type PositionedEntry,
  type RawEntry,
} from './log-entries.js';
import type { SourceScan } from './log-page.js';

export interface LogServiceRef {
  readonly id: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly serverId: string;
}

/** By project id and service id together: another project's service is not found. */
export async function findLogService(db: Database, projectId: string, serviceId: string): Promise<LogServiceRef | null> {
  const [row] = await db
    .select({
      id: services.id,
      projectId: services.projectId,
      environmentId: services.environmentId,
      serverId: services.serverId,
    })
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.projectId, projectId)));
  return row ?? null;
}

export interface ServiceRedactor {
  readonly redactor: Redactor;
  /** Drops the registered values; idempotent. */
  release(): void;
}

/** A redactor holding every secret value the service can see (project, environment, service). */
export async function openServiceRedactor(
  db: Database,
  service: LogServiceRef,
  masterKeys: () => Promise<MasterKeys>,
): Promise<ServiceRedactor> {
  const chain = { projectId: service.projectId, environmentId: service.environmentId, serviceId: service.id };
  const rows = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(
      and(
        eq(secrets.projectId, chain.projectId),
        or(
          eq(secrets.scope, 'project'),
          and(eq(secrets.scope, 'environment'), eq(secrets.environmentId, chain.environmentId)),
          and(eq(secrets.scope, 'service'), eq(secrets.serviceId, chain.serviceId)),
        ),
      ),
    );
  const redactor = createRedactor();
  if (rows.length === 0) return { redactor, release: () => undefined };
  const lease = await decryptForDeploy(db, { chain, secretIds: rows.map((row) => row.id) }, await masterKeys(), redactor);
  return { redactor, release: () => lease.release() };
}

/** Inclusive window in epoch ms; `upperMs` already accounts for the cursor. */
export interface ScanWindow {
  readonly sinceMs: number;
  readonly upperMs: number;
}

const FIRST_SOURCE: LogSource = LOG_SOURCES[0] ?? 'build';

/** Epoch ms of an entry's timestamp (NaN when unparseable). */
export function entryMs(entry: { readonly timestamp: string }): number {
  const at = parseLogTimestamp(entry.timestamp);
  return at === null ? Number.NaN : logTimestampMs(at);
}

/**
 * Rows arrive newest first, capped at `limit`. When the cap was hit the oldest instant may be
 * incomplete: it is dropped and the boundary is the lowest position of the oldest kept instant.
 */
function capRows<T>(rows: readonly T[], limit: number, timeOf: (row: T) => number): { rows: T[]; boundary: LogPosition | null } {
  const ascending = [...rows].reverse();
  if (rows.length < limit) return { rows: ascending, boundary: null };
  const oldest = timeOf(ascending[0] as T);
  const kept = ascending.filter((row) => timeOf(row) !== oldest);
  const lowest = kept[0];
  const boundaryMs = lowest === undefined ? oldest : timeOf(lowest);
  return { rows: kept, boundary: { timestamp: new Date(boundaryMs).toISOString(), source: FIRST_SOURCE, seq: 0 } };
}

function scanOf(raw: readonly RawEntry[], redactor: Redactor, boundary: LogPosition | null): SourceScan {
  return { entries: positionEntries(raw.map((entry) => finalizeEntry(entry, redactor))), boundary };
}

export const CHUNK_SCAN_ROWS = 500;
export const ACTIVITY_SCAN_ROWS = 1000;

/** Build and deploy entries of the service's deployments within the window. */
export async function scanChunks(
  db: Database,
  serviceId: string,
  window: ScanWindow,
  redactor: Redactor,
  limit = CHUNK_SCAN_ROWS,
): Promise<{ build: SourceScan; deploy: SourceScan }> {
  // Postgres keeps microseconds: the upper bound is the next millisecond, exclusive.
  const rows = await db
    .select({
      id: deploymentLogChunks.id,
      phase: deploymentLogChunks.phase,
      content: deploymentLogChunks.content,
      createdAt: deploymentLogChunks.createdAt,
    })
    .from(deploymentLogChunks)
    .innerJoin(deployments, eq(deployments.id, deploymentLogChunks.deploymentId))
    .where(
      and(
        eq(deployments.serviceId, serviceId),
        gte(deploymentLogChunks.createdAt, new Date(window.sinceMs)),
        lt(deploymentLogChunks.createdAt, new Date(window.upperMs + 1)),
      ),
    )
    .orderBy(desc(deploymentLogChunks.createdAt), desc(deploymentLogChunks.id))
    .limit(limit);
  const capped = capRows(rows, limit, (row) => row.createdAt.getTime());
  const raw = capped.rows.flatMap((row) => chunkEntries(row));
  return {
    build: scanOf(raw.filter((entry) => entry.source === 'build'), redactor, capped.boundary),
    deploy: scanOf(raw.filter((entry) => entry.source === 'deploy'), redactor, capped.boundary),
  };
}

/** Activity about the service itself or one of its deployments: action and outcome only. */
export async function scanActivity(
  db: Database,
  serviceId: string,
  window: ScanWindow,
  redactor: Redactor,
  limit = ACTIVITY_SCAN_ROWS,
): Promise<SourceScan> {
  const ofService = db.select({ id: deployments.id }).from(deployments).where(eq(deployments.serviceId, serviceId));
  const rows = await db
    .select({
      id: activityEvents.id,
      occurredAt: activityEvents.occurredAt,
      action: activityEvents.action,
      outcome: activityEvents.outcome,
      errorCode: activityEvents.errorCode,
    })
    .from(activityEvents)
    .where(
      and(
        or(
          and(eq(activityEvents.entityType, 'service'), eq(activityEvents.entityId, serviceId)),
          and(eq(activityEvents.entityType, 'deployment'), inArray(activityEvents.entityId, ofService)),
        ),
        gte(activityEvents.occurredAt, new Date(window.sinceMs)),
        lt(activityEvents.occurredAt, new Date(window.upperMs + 1)),
      ),
    )
    .orderBy(desc(activityEvents.occurredAt), desc(activityEvents.id))
    .limit(limit);
  const capped = capRows(rows, limit, (row) => row.occurredAt.getTime());
  return scanOf(capped.rows.map((row) => activityEntry(row)), redactor, capped.boundary);
}

export type LogConnect = (serverId: string, redactor: Redactor, signal: AbortSignal | undefined) => Promise<ConnectResult>;

export interface RuntimeSession {
  readonly session: SshDeploySession;
  close(): Promise<void>;
}

async function closeQuietly(close: () => Promise<void>): Promise<void> {
  try {
    await close();
  } catch {
    // A failed close never changes the outcome.
  }
}

/**
 * Connects within `timeoutMs`, or null. A connect that resolves after the deadline has its
 * session closed at once, so a timed-out request never leaves one open.
 */
export async function openRuntimeSession(
  connect: LogConnect,
  serverId: string,
  redactor: Redactor,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RuntimeSession | null> {
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, timeoutMs);
    controller.signal.addEventListener('abort', () => {
      resolve('timeout');
    }, { once: true });
  });
  const attempt = connect(serverId, redactor, controller.signal).catch((): ConnectResult => ({ ok: false, code: 'SERVER_UNREACHABLE' }));
  try {
    const winner = await Promise.race([attempt, deadline]);
    if (winner === 'timeout' || !winner.ok) {
      void attempt.then((late) => (late.ok ? closeQuietly(late.close) : undefined));
      return null;
    }
    let closed = false;
    return {
      session: winner.session,
      close: async () => {
        if (closed) return;
        closed = true;
        await closeQuietly(winner.close);
      },
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

const RUNTIME_MAX_BYTES = 512 * 1024;

export type RuntimeFetch = { readonly ok: true; readonly scan: SourceScan } | { readonly ok: false };

/** One bounded window over an open session; the fetch is cut at `timeoutMs`. */
export async function fetchRuntimeWindow(
  runtime: RuntimeSession,
  serviceId: string,
  window: ScanWindow,
  redactor: Redactor,
  timeoutMs: number,
  options: { readonly tail?: number; readonly signal?: AbortSignal } = {},
): Promise<RuntimeFetch> {
  const tail = options.tail ?? MAX_LOG_TAIL;
  const id = validateResourceId(serviceId);
  if (!id.ok) return { ok: false };
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  const timer = setTimeout(abort, timeoutMs);
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    // Docker timestamps carry nanoseconds: the upper bound is the next millisecond.
    const result = await fetchLogsWindow(
      {
        session: runtime.session,
        redactor,
        // probe() sizes its own exec budget from the template; these bound nothing else.
        limits: { maxDurationMs: timeoutMs, idleTimeoutMs: timeoutMs, maxTotalBytes: RUNTIME_MAX_BYTES, maxLineBytes: RUNTIME_MAX_BYTES },
        signal: controller.signal,
      },
      { serviceId: id.value, since: iso(window.sinceMs), until: iso(window.upperMs + 1), tail },
    );
    if (!result.ok) return { ok: false };
    if (result.value.kind === 'missing') return { ok: true, scan: { entries: [], boundary: null } };
    const { lines, capped } = result.value;
    const raw: RawEntry[] = lines.map((line) => ({
      source: 'runtime',
      timestamp: line.timestamp,
      stream: line.stream,
      text: line.text,
      truncated: line.truncated,
    }));
    const entries = positionEntries(raw.map((entry) => finalizeEntry(entry, redactor)));
    const oldest: PositionedEntry | undefined = entries[0];
    const full = capped || lines.length >= tail;
    return {
      ok: true,
      scan: { entries, boundary: full && oldest !== undefined ? positionOf(oldest) : null, capped },
    };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

/** Connect, fetch one window, close: the whole read is bounded by `timeoutMs`. */
export async function scanRuntime(
  connect: LogConnect,
  service: LogServiceRef,
  window: ScanWindow,
  redactor: Redactor,
  timeoutMs: number,
): Promise<RuntimeFetch> {
  const started = Date.now();
  const runtime = await openRuntimeSession(connect, service.serverId, redactor, timeoutMs);
  if (runtime === null) return { ok: false };
  try {
    const left = Math.max(1, timeoutMs - (Date.now() - started));
    return await fetchRuntimeWindow(runtime, service.id, window, redactor, left);
  } finally {
    await runtime.close();
  }
}
