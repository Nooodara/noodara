// 12-12 (A4): build-log retention. Chunks older than NOODARA_DEPLOY_LOG_RETENTION_DAYS are deleted
// in bounded batches (short transactions, no long lock on the table); deployment rows are never
// touched. The worker runs one purge at start and then on a fixed interval, never two at once.
import { inArray, lt } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { deploymentLogChunks } from '../db/schema/deployment-log-chunks.js';

const DAY_MS = 86_400_000;
export const DEFAULT_LOG_RETENTION_INTERVAL_MS = 3_600_000;
export const LOG_RETENTION_BATCH_SIZE = 5000;

export function logRetentionCutoff(now: Date, retentionDays: number): Date {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new RangeError('Log retention needs a whole number of days from 1 to 365');
  }
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

/** Deletes every chunk created before `cutoff`, `batchSize` rows per statement. Returns the count. */
export async function purgeDeploymentLogChunks(
  db: Database,
  cutoff: Date,
  batchSize: number = LOG_RETENTION_BATCH_SIZE,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const batch = db
      .select({ id: deploymentLogChunks.id })
      .from(deploymentLogChunks)
      .where(lt(deploymentLogChunks.createdAt, cutoff))
      .limit(batchSize);
    const rows = await db
      .delete(deploymentLogChunks)
      .where(inArray(deploymentLogChunks.id, batch))
      .returning({ id: deploymentLogChunks.id });
    deleted += rows.length;
    if (rows.length < batchSize) return deleted;
  }
}

export interface RetentionTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: RetentionTimers = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface DeploymentLogRetentionOptions {
  readonly purge: (cutoff: Date) => Promise<number>;
  readonly retentionDays: number;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly logger: {
    info(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
  };
  readonly timers?: RetentionTimers;
}

export interface DeploymentLogRetentionHandle {
  stop(): Promise<void>;
}

export function startDeploymentLogRetention(options: DeploymentLogRetentionOptions): DeploymentLogRetentionHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_LOG_RETENTION_INTERVAL_MS;
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new RangeError('Log retention needs a positive interval');
  }
  // Validates retentionDays up front, so a bad value fails the boot instead of every run.
  logRetentionCutoff(new Date(0), options.retentionDays);
  const now = options.now ?? (() => new Date());
  const timers = options.timers ?? realTimers;
  const { logger, retentionDays } = options;
  let timer: unknown = null;
  let running: Promise<void> | null = null;
  let stopped = false;

  async function run(): Promise<void> {
    try {
      const deletedChunks = await options.purge(logRetentionCutoff(now(), retentionDays));
      logger.info({ deletedChunks, retentionDays }, 'deployment log retention purge complete');
    } catch (error) {
      // Only the class name: a driver message can quote SQL parameters or a connection string.
      logger.warn({ errorKind: error instanceof Error ? error.name : typeof error }, 'deployment log retention purge failed');
    }
  }

  function schedule(ms: number): void {
    if (stopped) return;
    timer = timers.setTimeout(() => {
      timer = null;
      running = run().finally(() => {
        running = null;
        schedule(intervalMs);
      });
    }, ms);
  }

  schedule(0);

  return {
    async stop() {
      stopped = true;
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
      if (running !== null) await running;
    },
  };
}
