// 27-04 (A3, H2): follow mode of the unified logs. A follow polls the requested sources for entries
// newer than the last one it sent of each source and hands them out merged, ascending. It holds
// one runtime SSH session for its whole life and closes it on every end: idle timeout, hard max
// lifetime, client gone or shutdown. Open follows are capped per user and per service.
import { logEntryMatches, mergeLogEntries, type LogFilter, type LogSource } from '@noodara/domain';
import type { LogEntryView } from '@noodara/domain/api-contract';
import type { Redactor } from '@noodara/domain/security';
import type { Database } from '../../db/client.js';
import { compareLogPositions, type LogPosition } from './log-cursor.js';
import { positionOf, toView, type PositionedEntry } from './log-entries.js';
import type { SourceScan } from './log-page.js';
import {
  entryMs,
  fetchRuntimeWindow,
  scanActivity,
  scanChunks,
  type LogServiceRef,
  type RuntimeSession,
  type ScanWindow,
} from './log-sources.js';

export interface FollowLimits {
  readonly pollMs: number;
  /** No new entry for this long ends the stream. */
  readonly idleMs: number;
  /** Hard max lifetime of one stream. */
  readonly maxLifetimeMs: number;
  readonly maxPerUser: number;
  readonly maxPerService: number;
  /** Bound of each runtime fetch. */
  readonly runtimeTimeoutMs: number;
}

export const DEFAULT_FOLLOW_LIMITS: FollowLimits = Object.freeze({
  pollMs: 1_000,
  idleMs: 120_000,
  maxLifetimeMs: 600_000,
  maxPerUser: 3,
  maxPerService: 5,
  runtimeTimeoutMs: 30_000,
});

export type FollowEndReason = 'idle' | 'max_duration' | 'client_closed' | 'shutdown';

export type FollowFrame =
  | { readonly type: 'entry'; readonly entry: LogEntryView }
  | { readonly type: 'unavailable'; readonly source: LogSource; readonly error: 'LOG_SOURCE_UNAVAILABLE' }
  | { readonly type: 'end'; readonly reason: FollowEndReason };

export interface FollowSlot {
  /** Aborted on shutdown. */
  readonly shutdown: AbortSignal;
  /** Releases the slot; call once the stream has ended. Idempotent. */
  release(): void;
}

export interface FollowRegistry {
  /** Synchronous check-and-take: two concurrent opens can never both pass a cap. */
  acquire(userId: string, serviceId: string): FollowSlot | null;
  active(): number;
  /** Ends every open follow and waits for their slots to be released. */
  closeAll(): Promise<void>;
}

export function createFollowRegistry(limits: Pick<FollowLimits, 'maxPerUser' | 'maxPerService'>): FollowRegistry {
  const perUser = new Map<string, number>();
  const perService = new Map<string, number>();
  const open = new Map<AbortController, () => void>();
  const waiters = new Set<() => void>();
  const bump = (map: Map<string, number>, key: string, delta: number): void => {
    const next = (map.get(key) ?? 0) + delta;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  };
  return {
    acquire(userId, serviceId) {
      if ((perUser.get(userId) ?? 0) >= limits.maxPerUser) return null;
      if ((perService.get(serviceId) ?? 0) >= limits.maxPerService) return null;
      bump(perUser, userId, 1);
      bump(perService, serviceId, 1);
      const controller = new AbortController();
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        bump(perUser, userId, -1);
        bump(perService, serviceId, -1);
        open.delete(controller);
        if (open.size === 0) for (const wake of waiters) wake();
      };
      open.set(controller, release);
      return { shutdown: controller.signal, release };
    },
    active: () => open.size,
    async closeAll() {
      if (open.size === 0) return;
      const drained = new Promise<void>((resolve) => {
        const wake = (): void => {
          waiters.delete(wake);
          resolve();
        };
        waiters.add(wake);
      });
      for (const controller of open.keys()) controller.abort();
      await drained;
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal.addEventListener('abort', done, { once: true });
  });
}

export interface RunFollowInput {
  readonly db: Database;
  readonly service: LogServiceRef;
  readonly filter: LogFilter;
  /** Entries before this instant are never sent. */
  readonly startMs: number;
  readonly redactor: Redactor;
  /** Open runtime session, or null when runtime is not followed (or could not be reached). */
  readonly runtime: RuntimeSession | null;
  readonly limits: FollowLimits;
  /** The client connection; aborting it ends the stream. */
  readonly signal: AbortSignal;
  /** Aborted on shutdown. */
  readonly shutdown: AbortSignal;
  readonly emit: (frame: FollowFrame) => void;
  readonly now?: () => number;
}

/** Runs one follow to its end. Never rejects; always closes the runtime session. */
export async function runFollow(input: RunFollowInput): Promise<FollowEndReason> {
  const now = input.now ?? Date.now;
  const { limits, filter } = input;
  const stop = new AbortController();
  const onStop = (): void => {
    stop.abort();
  };
  input.signal.addEventListener('abort', onStop, { once: true });
  input.shutdown.addEventListener('abort', onStop, { once: true });
  if (input.signal.aborted || input.shutdown.aborted) stop.abort();

  const stopped = (): boolean => stop.signal.aborted;
  let runtime = input.runtime;
  const last = new Map<LogSource, LogPosition>();
  const started = now();
  let lastNews = started;
  // The window is checked per source by position; level and search still apply.
  const matchFilter: LogFilter = { ...filter, sinceMs: 0, untilMs: Number.MAX_SAFE_INTEGER };
  const wants = (source: LogSource): boolean => filter.sources.includes(source);

  const fresh = (source: LogSource, scan: SourceScan): PositionedEntry[] => {
    const previous = last.get(source);
    return scan.entries.filter((entry) =>
      previous === undefined ? entryMs(entry) >= input.startMs : compareLogPositions(positionOf(entry), previous) > 0,
    );
  };
  const lowerOf = (source: LogSource): number => {
    const previous = last.get(source);
    return previous === undefined ? input.startMs : Math.min(entryMs(previous), now());
  };

  const reason = await (async (): Promise<FollowEndReason> => {
    try {
      for (;;) {
        if (stopped()) break;
        const upperMs = now();
        const windowOf = (source: LogSource): ScanWindow => ({ sinceMs: lowerOf(source), upperMs });
        const bySource: Partial<Record<LogSource, PositionedEntry[]>> = {};

        if (wants('build') || wants('deploy')) {
          const sinceMs = Math.min(lowerOf('build'), lowerOf('deploy'));
          const chunks = await scanChunks(input.db, input.service.id, { sinceMs, upperMs }, input.redactor);
          if (wants('build')) bySource.build = fresh('build', chunks.build);
          if (wants('deploy')) bySource.deploy = fresh('deploy', chunks.deploy);
        }
        if (wants('activity')) {
          bySource.activity = fresh('activity', await scanActivity(input.db, input.service.id, windowOf('activity'), input.redactor));
        }
        if (runtime !== null && !stopped()) {
          const fetched = await fetchRuntimeWindow(runtime, input.service.id, windowOf('runtime'), input.redactor, limits.runtimeTimeoutMs, {
            signal: stop.signal,
          });
          if (fetched.ok) {
            bySource.runtime = fresh('runtime', fetched.scan);
          } else if (!stopped()) {
            input.emit({ type: 'unavailable', source: 'runtime', error: 'LOG_SOURCE_UNAVAILABLE' });
            await runtime.close();
            runtime = null;
          }
        }
        if (stopped()) break;

        for (const [source, entries] of Object.entries(bySource) as [LogSource, PositionedEntry[]][]) {
          const newest = entries.at(-1);
          if (newest !== undefined) last.set(source, positionOf(newest));
        }
        const merged = mergeLogEntries(bySource).filter((entry) => logEntryMatches(entry, matchFilter));
        for (const entry of merged) input.emit({ type: 'entry', entry: toView(entry) });

        const at = now();
        if (merged.length > 0) lastNews = at;
        if (at - started >= limits.maxLifetimeMs) return 'max_duration';
        if (at - lastNews >= limits.idleMs) return 'idle';
        const wait = Math.min(limits.pollMs, started + limits.maxLifetimeMs - at, lastNews + limits.idleMs - at);
        await sleep(wait, stop.signal);
      }
    } catch {
      // A failed read ends the stream like a disconnect; nothing about it reaches the client.
      return input.shutdown.aborted ? 'shutdown' : 'client_closed';
    }
    return input.shutdown.aborted ? 'shutdown' : 'client_closed';
  })();

  input.signal.removeEventListener('abort', onStop);
  input.shutdown.removeEventListener('abort', onStop);
  if (runtime !== null) await runtime.close();
  return reason;
}
