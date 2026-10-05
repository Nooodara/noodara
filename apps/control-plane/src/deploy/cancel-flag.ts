// 12-13 (A2, H1): the Redis cancel flag `noodara:deploy-cancel:<deploymentId>`. The API sets it
// for a deployment the worker already owns; only the worker reads it and transitions the row.
// - `request` is SET NX PX: the first cancel sets it (true), a repeat is a no-op (false). The TTL
//   is the deploy job lock (deploy-job-budget.ts), so an orphaned flag expires on its own.
// - `watchDeployCancel` polls the flag and aborts its signal once; a Redis error is a missed poll,
//   never a cancel and never a crash.
// - Every call is bounded: the worker's connection has no command timeout of its own.
import type { Redis } from 'ioredis';

export const DEPLOY_CANCEL_KEY_PREFIX = 'noodara:deploy-cancel:';
export const DEPLOY_CANCEL_POLL_MS = 1_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 2_000;

export function deployCancelKey(deploymentId: string): string {
  return `${DEPLOY_CANCEL_KEY_PREFIX}${deploymentId}`;
}

/** The three commands this module uses; the unit test passes a fake. */
export interface CancelFlagRedis {
  setNxPx(key: string, value: string, ttlMs: number): Promise<boolean>;
  exists(key: string): Promise<boolean>;
  del(key: string): Promise<void>;
}

export function cancelFlagRedisFrom(redis: Redis): CancelFlagRedis {
  return {
    async setNxPx(key, value, ttlMs) {
      return (await redis.set(key, value, 'PX', ttlMs, 'NX')) === 'OK';
    },
    async exists(key) {
      return (await redis.exists(key)) > 0;
    },
    async del(key) {
      await redis.del(key);
    },
  };
}

export type CancelRequestResult = 'requested' | 'already_requested' | 'unavailable';

export interface DeployCancelFlags {
  /** Never throws; `unavailable` when Redis did not answer in time. */
  request(deploymentId: string): Promise<CancelRequestResult>;
  /** Never throws; false when Redis did not answer (a missed poll). */
  isRequested(deploymentId: string): Promise<boolean>;
  /** Best effort; never throws. */
  clear(deploymentId: string): Promise<void>;
}

export interface DeployCancelFlagsOptions {
  readonly redis: CancelFlagRedis;
  /** computeDeployCancelKeyTtlMs(NOODARA_DEPLOY_MAX_MS) */
  readonly ttlMs: number;
  readonly commandTimeoutMs?: number;
}

async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        handle = setTimeout(() => {
          reject(new Error('cancel flag: command timed out'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

export function createDeployCancelFlags(options: DeployCancelFlagsOptions): DeployCancelFlags {
  const { redis, ttlMs } = options;
  const timeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  return {
    async request(deploymentId) {
      try {
        const set = await bounded(redis.setNxPx(deployCancelKey(deploymentId), '1', ttlMs), timeoutMs);
        return set ? 'requested' : 'already_requested';
      } catch {
        return 'unavailable';
      }
    },
    async isRequested(deploymentId) {
      try {
        return await bounded(redis.exists(deployCancelKey(deploymentId)), timeoutMs);
      } catch {
        return false;
      }
    },
    async clear(deploymentId) {
      try {
        await bounded(redis.del(deployCancelKey(deploymentId)), timeoutMs);
      } catch {
        // The TTL removes it anyway.
      }
    },
  };
}

export interface DeployCancelWatch {
  /** Aborted once the flag is seen; never aborted by a Redis failure. */
  readonly signal: AbortSignal;
  stop(): void;
}

export interface WatchDeployCancelOptions {
  readonly flags: Pick<DeployCancelFlags, 'isRequested'>;
  readonly deploymentId: string;
  readonly pollMs?: number;
}

/** Polls right away, then every `pollMs` until the flag is seen or `stop` is called. */
export function watchDeployCancel(options: WatchDeployCancelOptions): DeployCancelWatch {
  const controller = new AbortController();
  const pollMs = options.pollMs ?? DEPLOY_CANCEL_POLL_MS;
  let stopped = false;
  // A call, not the variable: `stop()` flips it while a poll awaits Redis, which narrowing misses.
  const isStopped = (): boolean => stopped;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const poll = async (): Promise<void> => {
    if (isStopped()) return;
    const requested = await options.flags.isRequested(options.deploymentId);
    if (isStopped()) return;
    if (requested) {
      controller.abort();
      return;
    }
    timer = setTimeout(() => void poll(), pollMs);
  };
  void poll();

  return {
    signal: controller.signal,
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
