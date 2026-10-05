// 12-11 (A6) / 12-12: the deploy pipeline writes its output through `DeploymentLogSink` only.
// Every entry is already redacted by the pipeline's per-run Redactor (the SSH stream redacts whole
// lines, so a secret split across network reads is whole again first). The real sink:
//   sanitize (ANSI, binary) -> 12-03 chunker (flush cadence, line and phase caps) -> insert into
//   `deployment_log_chunks` -> publish `deployment.log_chunk`.
// - Persist before publish, so a chunk seen live is always readable through `?since=` (A3).
// - Neither a database nor a Redis failure fails or stalls the deployment: `write` is synchronous
//   and never throws, the in-memory queue is bounded (`maxPendingBytes`, then chunks are dropped
//   and counted) and `close` waits at most `closeTimeoutMs` (H1, A5).
// - Failures are logged with ids, phase, seq and the error's class name only, never chunk content
//   or a driver message (it can quote the row).
import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
import {
  createBuildLogChunker,
  createLogChunkerPolicy,
  sanitizeLogText,
  type BuildLogChunk,
  type DeploymentLogPhase,
  type LogChunkerPolicy,
} from '@noodara/domain/deployment';
import type { Database } from '../db/client.js';
import { deploymentLogChunks } from '../db/schema/deployment-log-chunks.js';
import { deployments } from '../db/schema/deployments.js';
import { buildDeploymentLogChunkEvent } from '../events/deploy-engine-events.js';
import type { ServerEventPublisher } from '../events/server-event-publisher.js';

export interface DeploymentLogEntry {
  readonly phase: DeploymentLogPhase;
  readonly stream: 'stdout' | 'stderr' | 'system';
  /** Redacted text: one or more lines. */
  readonly text: string;
  /** Increases by one per entry across the whole deployment. */
  readonly seq: number;
}

export interface DeploymentLogSink {
  write(entry: DeploymentLogEntry): void;
  /** Called once when the deployment ends, after cleanup; must not throw. */
  close(): Promise<void>;
}

export const noopDeploymentLogSink: DeploymentLogSink = Object.freeze({
  write: () => {
    // Intentionally empty: tests and callers without a database.
  },
  close: () => Promise.resolve(),
});

export interface DeploymentLogChunkRow {
  readonly deploymentId: string;
  readonly phase: DeploymentLogPhase;
  readonly seq: number;
  readonly content: string;
  readonly byteLength: number;
}

/** Append-only persistence port. A duplicate (deployment, phase, seq) must reject (unique index). */
export interface DeploymentLogChunkWriter {
  insert(row: DeploymentLogChunkRow): Promise<void>;
}

export function createDbLogChunkWriter(db: Database): DeploymentLogChunkWriter {
  return {
    async insert(row) {
      await db.insert(deploymentLogChunks).values(row);
    },
  };
}

export interface LogSinkLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface LogSinkTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: LogSinkTimers = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    // A pending flush must never keep the worker process alive on its own.
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** 256 chunks of the 16 KB flush size: a stalled database costs at most this much per deployment. */
export const DEFAULT_LOG_SINK_MAX_PENDING_BYTES = 4 * 1024 * 1024;
export const DEFAULT_LOG_SINK_CLOSE_TIMEOUT_MS = 10_000;

export interface ChunkedLogSinkOptions {
  readonly deploymentId: string;
  readonly writer: DeploymentLogChunkWriter;
  readonly events: ServerEventPublisher;
  readonly logger: LogSinkLogger;
  readonly policy: LogChunkerPolicy;
  readonly now?: () => number;
  readonly timers?: LogSinkTimers;
  readonly maxPendingBytes?: number;
  readonly closeTimeoutMs?: number;
}

export interface LogSinkStats {
  readonly persistedChunks: number;
  readonly persistFailures: number;
  readonly publishFailures: number;
  readonly droppedChunks: number;
  /** Bytes queued and not yet handed to the writer. */
  readonly pendingBytes: number;
  /** Highest `pendingBytes` seen. */
  readonly peakPendingBytes: number;
}

export type ChunkedDeploymentLogSink = DeploymentLogSink & { stats(): LogSinkStats };

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function createChunkedDeploymentLogSink(options: ChunkedLogSinkOptions): ChunkedDeploymentLogSink {
  const { deploymentId, writer, events, logger } = options;
  const now = options.now ?? (() => Date.now());
  const timers = options.timers ?? realTimers;
  const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_LOG_SINK_MAX_PENDING_BYTES;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_LOG_SINK_CLOSE_TIMEOUT_MS;
  const chunker = createBuildLogChunker({ deploymentId, now, policy: options.policy });

  const queue: BuildLogChunk[] = [];
  let pendingBytes = 0;
  let peakPendingBytes = 0;
  let persistedChunks = 0;
  let persistFailures = 0;
  let publishFailures = 0;
  let droppedChunks = 0;
  let draining: Promise<void> | null = null;
  let timer: unknown = null;
  let closing: Promise<void> | null = null;

  async function persist(chunk: BuildLogChunk): Promise<void> {
    try {
      await writer.insert({
        deploymentId,
        phase: chunk.phase,
        seq: chunk.seq,
        content: chunk.text,
        byteLength: chunk.byteLength,
      });
      persistedChunks += 1;
    } catch (error) {
      persistFailures += 1;
      logger.warn(
        { deploymentId, phase: chunk.phase, seq: chunk.seq, errorKind: errorKind(error) },
        'deployment log chunk could not be persisted',
      );
    }
  }

  async function publish(chunk: BuildLogChunk): Promise<void> {
    try {
      await events.publish(
        buildDeploymentLogChunkEvent({ deploymentId, phase: chunk.phase, seq: chunk.seq, text: chunk.text }),
      );
    } catch (error) {
      publishFailures += 1;
      logger.warn(
        { deploymentId, phase: chunk.phase, seq: chunk.seq, errorKind: errorKind(error) },
        'deployment log chunk could not be published',
      );
    }
  }

  async function drain(): Promise<void> {
    for (let chunk = queue.shift(); chunk !== undefined; chunk = queue.shift()) {
      pendingBytes -= chunk.byteLength;
      await persist(chunk);
      await publish(chunk);
    }
    draining = null;
  }

  function enqueue(chunks: readonly BuildLogChunk[]): void {
    for (const chunk of chunks) {
      // The single phase-truncation notice is always kept: it explains the gap.
      if (chunk.kind === 'output' && pendingBytes + chunk.byteLength > maxPendingBytes) {
        droppedChunks += 1;
        continue;
      }
      queue.push(chunk);
      pendingBytes += chunk.byteLength;
      peakPendingBytes = Math.max(peakPendingBytes, pendingBytes);
    }
    if (queue.length > 0) draining ??= drain();
  }

  function schedule(): void {
    if (timer !== null || closing !== null) return;
    const wait = chunker.msUntilNextFlush();
    if (wait === null) return;
    timer = timers.setTimeout(() => {
      timer = null;
      try {
        enqueue(chunker.tick());
      } catch (error) {
        logger.warn({ deploymentId, errorKind: errorKind(error) }, 'deployment log flush failed');
      }
      schedule();
    }, wait);
  }

  async function settle(): Promise<void> {
    let handle: unknown = null;
    const deadline = new Promise<'timeout'>((resolve) => {
      handle = timers.setTimeout(() => {
        resolve('timeout');
      }, closeTimeoutMs);
    });
    const drained = (async () => {
      while (draining !== null) await draining;
      return 'drained' as const;
    })();
    const winner = await Promise.race([drained, deadline]);
    timers.clearTimeout(handle);
    if (winner === 'timeout') {
      logger.warn(
        { deploymentId, queuedChunks: queue.length, pendingBytes },
        'deployment log sink did not drain before its close timeout',
      );
    }
    if (droppedChunks > 0) {
      logger.warn({ deploymentId, droppedChunks }, 'deployment log chunks were dropped');
    }
  }

  return {
    write(entry) {
      if (closing !== null) return;
      try {
        enqueue(chunker.push(entry.phase, sanitizeLogText(entry.text)));
        schedule();
      } catch (error) {
        logger.warn({ deploymentId, errorKind: errorKind(error) }, 'deployment log entry was not accepted');
      }
    },

    close() {
      closing ??= (async () => {
        if (timer !== null) {
          timers.clearTimeout(timer);
          timer = null;
        }
        try {
          enqueue(chunker.flush());
        } catch (error) {
          logger.warn({ deploymentId, errorKind: errorKind(error) }, 'deployment log flush failed');
        }
        await settle();
      })();
      return closing;
    },

    stats() {
      return { persistedChunks, persistFailures, publishFailures, droppedChunks, pendingBytes, peakPendingBytes };
    },
  };
}

export interface DeploymentLogSinkFactoryDeps {
  readonly writer: DeploymentLogChunkWriter;
  readonly events: ServerEventPublisher;
  readonly logger: LogSinkLogger;
  readonly policy: LogChunkerPolicy;
  readonly now?: () => number;
  readonly timers?: LogSinkTimers;
  readonly maxPendingBytes?: number;
  readonly closeTimeoutMs?: number;
}

/** `DeployJobDeps.sinkFor`: validates the policy once, then one sink per deployment. */
export function createDeploymentLogSinkFactory(
  deps: DeploymentLogSinkFactoryDeps,
): (deploymentId: string) => ChunkedDeploymentLogSink {
  const validated = createLogChunkerPolicy(deps.policy);
  if (!validated.ok) throw new RangeError(validated.message);
  const policy = validated.value;
  return (deploymentId) => createChunkedDeploymentLogSink({ ...deps, deploymentId, policy });
}

// --- Read side (A3, H2) ----------------------------------------------------------------------

export interface DeploymentLogQuery {
  /** Cursor: chunks after (`phase`, `since`) in phase order, then seq. */
  readonly phase: DeploymentLogPhase;
  readonly since: number;
  readonly limit: number;
}

export interface DeploymentLogChunkView {
  readonly phase: DeploymentLogPhase;
  readonly seq: number;
  readonly text: string;
  readonly byteLength: number;
  readonly createdAt: string;
}

export interface DeploymentLogPage {
  readonly items: readonly DeploymentLogChunkView[];
  readonly hasMore: boolean;
}

/** Null when the deployment does not exist (or is outside the caller's scope). */
export type DeploymentLogReader = (deploymentId: string, query: DeploymentLogQuery) => Promise<DeploymentLogPage | null>;

/**
 * Chunks strictly after the cursor. The `deployment_log_phase` enum sorts in
 * `DEPLOYMENT_LOG_PHASES` order, so "later" is a later phase or the same phase with a higher seq.
 */
export async function readDeploymentLogs(
  db: Database,
  deploymentId: string,
  query: DeploymentLogQuery,
): Promise<DeploymentLogPage | null> {
  const [owner] = await db.select({ id: deployments.id }).from(deployments).where(eq(deployments.id, deploymentId)).limit(1);
  if (owner === undefined) return null;
  const phaseParam = sql`${query.phase}::deployment_log_phase`;
  const rows = await db
    .select({
      phase: deploymentLogChunks.phase,
      seq: deploymentLogChunks.seq,
      text: deploymentLogChunks.content,
      byteLength: deploymentLogChunks.byteLength,
      createdAt: deploymentLogChunks.createdAt,
    })
    .from(deploymentLogChunks)
    .where(
      and(
        eq(deploymentLogChunks.deploymentId, deploymentId),
        or(
          sql`${deploymentLogChunks.phase} > ${phaseParam}`,
          and(sql`${deploymentLogChunks.phase} = ${phaseParam}`, gt(deploymentLogChunks.seq, query.since)),
        ),
      ),
    )
    .orderBy(asc(deploymentLogChunks.phase), asc(deploymentLogChunks.seq))
    .limit(query.limit + 1);
  return {
    items: rows.slice(0, query.limit).map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    hasMore: rows.length > query.limit,
  };
}
