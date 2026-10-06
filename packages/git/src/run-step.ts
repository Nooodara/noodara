// One remote step through SshDeploySession.stream (11-15). Mirrored in @noodara/docker.
// Output arrives already redacted by the session; stdout is collected for the parsers and every
// chunk is forwarded to the caller. A rejected stream (transport loss) never escapes as an
// exception: only usage errors (TypeError/RangeError, a programming bug) are rethrown.
import { revealSecret, type Redactor, type SecretValue } from '@noodara/domain/security';
import {
  registerSecretForStreaming,
  type RemoteCommand,
  type SshDeploySession,
  type StreamChunk,
  type StreamResult,
} from '@noodara/ssh';
import type { StepLimits, StepResult } from './step-result.js';

export interface StepContext {
  readonly session: SshDeploySession;
  readonly limits: StepLimits;
  readonly signal?: AbortSignal;
  readonly onChunk?: (chunk: StreamChunk) => void;
}

export type StepOutcome =
  | {
      readonly kind: 'completed';
      readonly result: StreamResult;
      readonly stdout: string;
    }
  | {
      readonly kind: 'interrupted';
      readonly outcome: 'aborted' | 'timed_out' | 'idle_timeout';
    }
  | { readonly kind: 'transport' };

export const SERVER_UNREACHABLE_MESSAGE =
  'The connection to the server was lost during the deployment. Check that the server is reachable, then redeploy.';

/** Maps a step that did not complete to the wrapper result: transport loss is SERVER_UNREACHABLE. */
export function notCompleted(
  outcome: Exclude<StepOutcome, { kind: 'completed' }>,
): StepResult<never> {
  if (outcome.kind === 'transport') {
    return {
      ok: false,
      kind: 'failed',
      code: 'SERVER_UNREACHABLE',
      message: SERVER_UNREACHABLE_MESSAGE,
    };
  }
  return { ok: false, kind: 'interrupted', outcome: outcome.outcome };
}

export async function runStep(
  context: StepContext,
  command: RemoteCommand,
  stdin?: SecretValue,
): Promise<StepOutcome> {
  const stdout: string[] = [];
  let result: StreamResult;
  try {
    result = await context.session.stream(command, {
      ...(stdin === undefined ? {} : { stdin }),
      maxDurationMs: context.limits.maxDurationMs,
      idleTimeoutMs: context.limits.idleTimeoutMs,
      maxTotalBytes: context.limits.maxTotalBytes,
      maxLineBytes: context.limits.maxLineBytes,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      onChunk: (chunk) => {
        if (chunk.stream === 'stdout') stdout.push(chunk.text);
        try {
          context.onChunk?.(chunk);
        } catch {
          // A consumer bug must not break the remote step.
        }
      },
    });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw error;
    return { kind: 'transport' };
  }
  if (result.outcome !== 'completed') return { kind: 'interrupted', outcome: result.outcome };
  return { kind: 'completed', result, stdout: stdout.join('') };
}

/**
 * Registers each secret (and each line of a multi-line one) with the session's redactor before
 * the first step; the returned function releases them. Registrations are reference-counted, so
 * releasing here never drops an outer holder's registration of the same secret (the run's).
 */
export function registerSecrets(redactor: Redactor, secrets: readonly SecretValue[]): () => void {
  const releases = secrets.map((secret) =>
    registerSecretForStreaming(redactor, revealSecret(secret), secret.kind),
  );
  return () => {
    for (const release of releases) release();
  };
}
