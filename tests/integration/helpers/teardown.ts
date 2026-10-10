// Bounded, best-effort teardown for integration suites (14-27). A hook that awaits its steps in a
// plain sequence never reaches `stack.stop()` when an earlier step hangs (the 900 s afterAll that
// leaked a deploy-engine stack in gate 14-15). Here every step gets its own timeout, a failed or
// timed-out step does not stop the next one, and the hook still fails loudly naming each failure.

export const DEFAULT_TEARDOWN_STEP_TIMEOUT_MS = 120_000;

export interface TeardownStep {
  readonly name: string;
  readonly run: () => unknown;
  /** Defaults to `stepTimeoutMs` of the call. */
  readonly timeoutMs?: number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runBounded(
  step: TeardownStep,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(timeoutMs)} ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([Promise.resolve().then(step.run), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs every step in order, each bounded; throws one error naming every step that failed. */
export async function runTeardown(
  owner: string,
  steps: readonly TeardownStep[],
  options: { stepTimeoutMs?: number } = {},
): Promise<void> {
  const failures: string[] = [];
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await runBounded(
        step,
        step.timeoutMs ??
          options.stepTimeoutMs ??
          DEFAULT_TEARDOWN_STEP_TIMEOUT_MS,
      );
    } catch (error) {
      errors.push(error);
      failures.push(`${step.name}: ${describeError(error)}`);
    }
  }
  if (failures.length > 0) {
    // A plain Error: vitest prints an AggregateError's first inner error, not its message.
    throw new Error(`${owner} teardown failed: ${failures.join('; ')}`, {
      cause: new AggregateError(errors),
    });
  }
}

/**
 * The value of a resource start, waiting at most `ms` for one still pending (its beforeAll timed
 * out mid-start, so nothing was assigned). Undefined when absent, rejected or still pending.
 */
export async function settleWithin<T>(
  start: Promise<T> | undefined,
  ms: number,
): Promise<T | undefined> {
  if (start === undefined) return undefined;
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
  });
  try {
    return await Promise.race([start.catch(() => undefined), gaveUp]);
  } finally {
    clearTimeout(timer);
  }
}
