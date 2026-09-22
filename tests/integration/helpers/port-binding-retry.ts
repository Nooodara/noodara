// Bounded retry around starting a container on a FIXED host port. Docker releases a just-stopped
// container's published port asynchronously: a test that stops container A and immediately starts
// container B on the very same host:port (tests/e2e/host-key.spec.ts's real host-key-change
// scenarios) occasionally hits the window in between and Docker answers
// `failed to set up container networking: driver failed programming external connectivity`.
// Observed once in 930 E2E runs on the first real nightly (2026-09-22, iteration 10/20). The
// stop() that preceded it had returned, so there is nothing for the caller to await -- the only
// honest remedy is to try again a bounded number of times, and only for that one error shape.

/** The two messages Docker's daemon produces when a published host port is (still) taken. */
const PORT_BINDING_RACE_PATTERNS = [
  /driver failed programming external connectivity/i,
  /address already in use/i,
  /port is already allocated/i,
];

export function isPortBindingRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return PORT_BINDING_RACE_PATTERNS.some((pattern) => pattern.test(message));
}

export interface PortBindingRetryOptions {
  /** Total attempts including the first one. Default 5. */
  readonly attempts?: number;
  /** Pause between attempts, in milliseconds. Default 1000. */
  readonly delayMs?: number;
  /** Runs after every failed attempt, before the delay: the caller removes whatever the failed
   *  attempt left behind (a container Docker created but never started). */
  readonly onFailedAttempt?: (error: unknown, attempt: number) => Promise<void> | void;
  /** Injectable for tests; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Calls `start` until it resolves, retrying only on a port-binding race and at most
 *  `attempts` times. Any other error, and the last race error, are rethrown unchanged. */
export async function startWithPortBindingRetry<T>(
  start: () => Promise<T>,
  options: PortBindingRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 1000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (attempts < 1) throw new RangeError('attempts must be at least 1');

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await start();
    } catch (error: unknown) {
      if (!isPortBindingRace(error) || attempt >= attempts) throw error;
      await options.onFailedAttempt?.(error, attempt);
      await sleep(delayMs);
    }
  }
}
