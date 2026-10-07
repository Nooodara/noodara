// 14-10 (D12, ADR 0009): after a SUCCESS deployment, `docker builder prune -f --filter until=168h`
// on that server, at most once per server per 24 h. Best effort and host-wide: every outcome is
// returned, nothing throws, and nothing here can change a deployment's status.
// - H2: the Redis key is taken with SET NX EX *before* the prune, so two concurrent deployments run
//   one prune. Redis down means skip (never an unbounded prune); a failed or timed-out prune
//   deletes the key so the next deployment retries instead of being silenced for 24 h.
// - H3: the prune has a hard timeout, its output (cache ids) is neither logged nor published, and
//   failures are logged by error class only.
import { pruneBuilderCache, type StepLimits, type StepResult } from '@noodara/docker';
import type { Redactor } from '@noodara/domain/security';
import type { SshDeploySession } from '@noodara/ssh';
import type { Redis } from 'ioredis';
import type { DeployJobLogger } from './deploy-worker.js';

export const BUILD_CACHE_PRUNE_TTL_SECONDS = 86_400;

/** Hard stop for one prune; the idle timeout equals it because the command prints at the end. */
export const BUILD_CACHE_PRUNE_LIMITS: StepLimits = Object.freeze({
  maxDurationMs: 120_000,
  idleTimeoutMs: 120_000,
  maxTotalBytes: 65_536,
  maxLineBytes: 4096,
});

export function buildCachePruneKey(serverId: string): string {
  return `noodara:build-cache-prune:${serverId}`;
}

export interface BuildCachePruneRedis {
  /** SET key 1 EX ttl NX; true when this caller took the key. */
  setNxEx(key: string, ttlSeconds: number): Promise<boolean>;
  del(key: string): Promise<void>;
}

export function buildCachePruneRedisFrom(redis: Redis): BuildCachePruneRedis {
  return {
    async setNxEx(key, ttlSeconds) {
      return (await redis.set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
    },
    async del(key) {
      await redis.del(key);
    },
  };
}

export type BuildCachePruneOutcome =
  | 'disabled'
  | 'skipped_building'
  | 'skipped_check_failed'
  | 'skipped_redis'
  | 'skipped_recent'
  | 'pruned'
  | 'failed';

export interface BuildCachePruneInput {
  readonly serverId: string;
  readonly deploymentId: string;
  readonly session: SshDeploySession;
  readonly redactor: Redactor;
}

export interface BuildCachePruneDeps {
  /** NOODARA_BUILD_CACHE_PRUNE */
  readonly mode: 'on' | 'off';
  readonly redis: BuildCachePruneRedis;
  /** True when a deployment other than `deploymentId` is BUILDING on the server. */
  readonly hasOtherBuilding: (serverId: string, deploymentId: string) => Promise<boolean>;
  readonly prune?: (input: BuildCachePruneInput) => Promise<StepResult<null>>;
  readonly logger: Pick<DeployJobLogger, 'warn'> & Partial<Pick<DeployJobLogger, 'info' | 'error'>>;
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function defaultPrune(input: BuildCachePruneInput): Promise<StepResult<null>> {
  // No onChunk: the prune output never reaches the deployment log.
  return pruneBuilderCache({ session: input.session, redactor: input.redactor, limits: BUILD_CACHE_PRUNE_LIMITS });
}

export function createBuildCachePrune(deps: BuildCachePruneDeps): (input: BuildCachePruneInput) => Promise<BuildCachePruneOutcome> {
  const prune = deps.prune ?? defaultPrune;
  const { logger } = deps;

  return async (input) => {
    if (deps.mode === 'off') return 'disabled';
    const { serverId, deploymentId } = input;
    try {
      if (await deps.hasOtherBuilding(serverId, deploymentId)) return 'skipped_building';
    } catch (error) {
      logger.warn({ serverId, errorKind: errorKind(error) }, 'build cache prune skipped: building check failed');
      return 'skipped_check_failed';
    }

    const key = buildCachePruneKey(serverId);
    try {
      if (!(await deps.redis.setNxEx(key, BUILD_CACHE_PRUNE_TTL_SECONDS))) return 'skipped_recent';
    } catch (error) {
      logger.warn({ serverId, errorKind: errorKind(error) }, 'build cache prune skipped: Redis unavailable');
      return 'skipped_redis';
    }

    let failure: string | null = null;
    try {
      const result = await prune(input);
      if (!result.ok) failure = result.kind === 'failed' ? result.code : result.outcome;
    } catch (error) {
      failure = errorKind(error);
    }
    if (failure === null) return 'pruned';

    // Class only: the remote message can list cache ids.
    logger.warn({ serverId, deploymentId, errorKind: failure }, 'build cache prune failed; it will retry on a later deployment');
    try {
      await deps.redis.del(key);
    } catch (error) {
      logger.warn({ serverId, errorKind: errorKind(error) }, 'build cache prune key could not be released');
    }
    return 'failed';
  };
}
