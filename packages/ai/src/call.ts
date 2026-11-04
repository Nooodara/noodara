import { setTimeout as sleepTimer } from 'node:timers/promises';
import { AIProviderError, errorForStatus, unavailable } from './errors.js';
import { createGuardedFetch, type CallState } from './guarded-fetch.js';

// One provider call: an explicit deadline combined with the caller's abort signal, bounded
// retries (429 honoring Retry-After, 5xx, dropped connections; never 401/403) and a classifier
// that turns anything the SDK throws into an AIProviderError.

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export interface AICallLimits {
  /** Deadline for the whole call, retries and stream included. */
  readonly timeoutMs: number;
  /** A body that sends nothing for this long is ended. */
  readonly idleTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  /** Upper bound for one backoff; a Retry-After above it fails fast as RATE_LIMITED. */
  readonly retryMaxDelayMs: number;
  readonly sleep: Sleep;
}

const defaultSleep: Sleep = async (ms, signal) => {
  await sleepTimer(ms, undefined, { signal });
};

export const DEFAULT_CALL_LIMITS: AICallLimits = Object.freeze({
  timeoutMs: 60_000,
  idleTimeoutMs: 30_000,
  maxResponseBytes: 8 * 1024 * 1024,
  maxRetries: 2,
  retryBaseDelayMs: 500,
  retryMaxDelayMs: 10_000,
  sleep: defaultSleep,
});

export function resolveLimits(overrides: Partial<AICallLimits> = {}): AICallLimits {
  const limits = { ...DEFAULT_CALL_LIMITS, ...overrides };
  for (const key of ['timeoutMs', 'idleTimeoutMs', 'maxResponseBytes'] as const) {
    if (!Number.isFinite(limits[key]) || limits[key] <= 0) throw new RangeError(`${key} must be positive`);
  }
  return limits;
}

interface HeaderBag {
  get(name: string): string | null;
}

function isHeaderBag(value: unknown): value is HeaderBag {
  return typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function';
}

/** Retry-After in ms from `retry-after-ms` or `retry-after` (seconds or HTTP date). */
export function parseRetryAfter(headers: unknown, now: number = Date.now()): number | undefined {
  if (!isHeaderBag(headers)) return undefined;
  const ms = headers.get('retry-after-ms');
  if (ms !== null && /^\d+(\.\d+)?$/.test(ms.trim())) return Math.ceil(Number(ms));
  const value = headers.get('retry-after')?.trim();
  if (value === undefined || value === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Math.ceil(Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export interface ProviderTransport {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch | undefined;
}

export class CallScope {
  readonly signal: AbortSignal;
  readonly limits: AICallLimits;
  readonly #deadline: AbortSignal;
  readonly #caller: AbortSignal | undefined;
  readonly #transport: ProviderTransport;

  constructor(limits: AICallLimits, transport: ProviderTransport, callerSignal?: AbortSignal) {
    this.limits = limits;
    this.#transport = transport;
    this.#caller = callerSignal;
    this.#deadline = AbortSignal.timeout(limits.timeoutMs);
    this.signal = callerSignal ? AbortSignal.any([callerSignal, this.#deadline]) : this.#deadline;
  }

  /** A fresh per-attempt state and the guarded fetch bound to it. */
  attempt(): { state: CallState; fetch: typeof fetch } {
    const state: CallState = { failure: undefined };
    const guarded = createGuardedFetch({
      baseUrl: this.#transport.baseUrl,
      maxResponseBytes: this.limits.maxResponseBytes,
      idleTimeoutMs: this.limits.idleTimeoutMs,
      signal: this.signal,
      state,
      fetchImpl: this.#transport.fetchImpl,
    });
    return { state, fetch: guarded };
  }

  classify(error: unknown, state?: CallState): AIProviderError {
    if (error instanceof AIProviderError) return error;
    if (this.#caller?.aborted === true) return unavailable('aborted');
    if (this.#deadline.aborted) return unavailable('timeout');
    if (state?.failure !== undefined) return unavailable(state.failure);
    if (typeof error === 'object' && error !== null) {
      const { status, headers, name } = error as { status?: unknown; headers?: unknown; name?: unknown };
      if (typeof status === 'number' && status >= 400) return errorForStatus(status, parseRetryAfter(headers));
      if (name === 'APIConnectionTimeoutError') return unavailable('timeout');
      if (name === 'APIConnectionError') return unavailable('connection');
      if (error instanceof SyntaxError) return unavailable('malformed');
    }
    return unavailable('unexpected_response');
  }

  /** Runs `run` with bounded retries. `run` receives the attempt state and guarded fetch. */
  async retry<T>(run: (attempt: { state: CallState; fetch: typeof fetch }) => Promise<T>): Promise<T> {
    for (let attemptNo = 0; ; attemptNo++) {
      const attempt = this.attempt();
      try {
        return await run(attempt);
      } catch (thrown) {
        const error = this.classify(thrown, attempt.state);
        if (!error.retryable || attemptNo >= this.limits.maxRetries) throw error;
        const backoff = Math.min(this.limits.retryBaseDelayMs * 2 ** attemptNo, this.limits.retryMaxDelayMs);
        if (error.retryAfterMs !== undefined && error.retryAfterMs > this.limits.retryMaxDelayMs) throw error;
        try {
          await this.limits.sleep(error.retryAfterMs ?? backoff, this.signal);
        } catch (sleepError) {
          throw this.classify(sleepError);
        }
        if (this.signal.aborted) throw this.classify(this.signal.reason);
      }
    }
  }
}
