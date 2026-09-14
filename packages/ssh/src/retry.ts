// D-10's single-retry policy (SERV-07, PITFALLS.md #8, T-2-34). `withRetry` decides purely on the
// outcome's own `errorCode` — never on a caught exception, since plan 02-07's classifier already
// guarantees every ssh2 failure arrives as a value, not a throw. The 2s wait is injected
// (`deps.sleep`) so `retry.test.ts` drives it directly instead of waiting real wall-clock time.
import type { ServerErrorCode } from '@noodara/domain/server';

/**
 * D-10: exactly these two codes get a second attempt. Frozen and asserted in `retry.test.ts`
 * against the complement of every other `ServerErrorCode`, so a future code added to
 * `SERVER_ERROR_CODES` cannot silently become retryable without a deliberate edit here.
 */
export const RETRYABLE_ERROR_CODES = Object.freeze(['CONNECT_TIMEOUT', 'CONNECTION_LOST'] as const);

const RETRY_WAIT_MS = 2000;

function isRetryableErrorCode(code: ServerErrorCode): boolean {
  return (RETRYABLE_ERROR_CODES as readonly string[]).includes(code);
}

export interface RetryDeps {
  readonly sleep: (ms: number) => Promise<void>;
}

/** Production default: a real `setTimeout`-backed wait. Tests inject their own `sleep` instead. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Runs `attempt` once; if it fails with a retryable `errorCode` (D-10), waits `RETRY_WAIT_MS` (via
 * `deps.sleep`) and runs it exactly one more time — never a third attempt, whatever the second
 * result is. `attempts` on the returned outcome reflects how many times `attempt` actually ran —
 * set here, on both the success and the failure branch, since D-10's activity log needs it
 * either way.
 */
export async function withRetry<T extends { readonly ok: boolean; readonly errorCode?: ServerErrorCode }>(
  attempt: () => Promise<T>,
  deps: RetryDeps,
): Promise<T & { readonly attempts: number }> {
  const first = await attempt();
  const firstErrorCode = first.ok ? undefined : first.errorCode;
  if (first.ok || firstErrorCode === undefined || !isRetryableErrorCode(firstErrorCode)) {
    return { ...first, attempts: 1 };
  }

  await deps.sleep(RETRY_WAIT_MS);
  const second = await attempt();
  return { ...second, attempts: 2 };
}
