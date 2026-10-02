// Shared result shape of the ssh-adapter wrappers (11-15). Mirror of @noodara/git's step-result.ts:
// the two packages may depend only on @noodara/domain and @noodara/ssh, never on each other.
import type { DeploymentErrorCode } from '@noodara/domain/deployment';
import type { StreamResult } from '@noodara/ssh';

/** Bounds for every remote step, passed by the caller (packages never read env). */
export interface StepLimits {
  readonly maxDurationMs: number;
  readonly idleTimeoutMs: number;
  readonly maxTotalBytes: number;
  readonly maxLineBytes: number;
}

/**
 * `interrupted`: the step did not finish. `timed_out`/`idle_timeout` are mapped by the caller to
 * BUILD_TIMEOUT/BUILD_STALLED (D15); `aborted` means the caller cancelled. Closing a channel never
 * stops the remote process (ADR 0008 G2), so the caller must follow with killSupervisedOperation.
 */
export type StepResult<T> =
  | { readonly ok: true; readonly value: T; readonly result: StreamResult }
  | {
      readonly ok: false;
      readonly kind: 'failed';
      readonly code: DeploymentErrorCode;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly kind: 'interrupted';
      readonly outcome: 'aborted' | 'timed_out' | 'idle_timeout';
    };
