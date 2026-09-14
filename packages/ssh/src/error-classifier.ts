// The single ssh2 -> ServerErrorCode classification table (SERV-07, T-2-26). This is the one
// place in `packages/ssh` allowed to reason about `ssh2`'s raw error shapes — every shape measured
// in docs/adr/0004-ssh-adapter-empirical-contracts.md's error-shape table lands here as exactly
// one of the seven `ServerErrorCode`s, and any shape nobody has classified yet lands on the
// documented terminal fallback rather than escaping as an unhandled rejection. `classifySshError`
// never throws: every candidate field is read behind a safe accessor (a getter can throw), every
// rule's own `matches`/`message` call is guarded, and the whole function is wrapped so a defect in
// this file itself cannot become the crash SERV-07 exists to prevent.
import type { Redactor } from '@noodara/domain/security';
import type { ServerErrorCode } from '@noodara/domain/server';
import { CommandTimeoutError, TransportClosedError, UnsupportedOsError, type SshFailure } from './errors.js';

/**
 * `phase` distinguishes what the same underlying transport-level signal means: a socket-level
 * failure observed while a connection was still being established (`connect`) never lost a live
 * session, while the identical signal observed once a command was in flight (`exec`) means a
 * session that existed was lost (ADR 0004's "Refused-port mapping decision"). Only the
 * `socket-reset` rule below actually branches on it — every other rule's outcome does not depend
 * on `phase`, per this plan's own instruction not to invent a distinction the measurements do not
 * support.
 */
export interface ClassifyContext {
  readonly phase: 'connect' | 'exec';
  readonly redactor: Redactor;
}

interface ClassificationRule {
  readonly name: string;
  readonly code: ServerErrorCode;
  readonly matches: (error: unknown, context: ClassifyContext) => boolean;
  readonly message: (error: unknown, context: ClassifyContext) => string;
}

/**
 * Reads `error[key]` behind a `try`/`catch`, returning `undefined` for anything short of a string
 * value — including when `error` is not an object, the key is absent, or reading it throws (one
 * of this plan's own hostile-input tests is exactly a `message` getter that throws).
 */
function safeStringField(error: unknown, key: string): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  try {
    const value = (error as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function isClientAuthentication(error: unknown): boolean {
  return safeStringField(error, 'level') === 'client-authentication';
}

function isFastDnsFailure(error: unknown): boolean {
  const code = safeStringField(error, 'code');
  return code === 'ENOTFOUND' || code === 'EAI_AGAIN';
}

function isConnectRefused(error: unknown): boolean {
  return safeStringField(error, 'code') === 'ECONNREFUSED';
}

function isHandshakeOrReadyTimeout(error: unknown): boolean {
  return safeStringField(error, 'level') === 'client-timeout';
}

function isHostKeyRejection(error: unknown): boolean {
  return safeStringField(error, 'level') === 'handshake';
}

function isResetOrClosedSocket(error: unknown): boolean {
  const code = safeStringField(error, 'code');
  return code === 'ECONNRESET' || code === 'EPIPE';
}

/**
 * The ordered, frozen rule table (SERV-07). Order is explicit and load-bearing: structured fields
 * (`level`, `code`) are checked before any message-string match, and the terminal fallback is its
 * own named, visible entry — never an implicit `else`. Deleting a row from this table makes the
 * exhaustiveness test in `error-classifier.test.ts` fail, since every `ServerErrorCode` must
 * remain reachable by at least one rule.
 */
export const ERROR_CLASSIFICATION_RULES: readonly ClassificationRule[] = Object.freeze([
  {
    name: 'auth-failed',
    code: 'AUTH_FAILED',
    matches: (error) => isClientAuthentication(error),
    message: () =>
      'Authentication failed. Verify the SSH credential (private key or password) configured for this server, and that the username is correct.',
  },
  {
    name: 'host-unresolved',
    code: 'HOST_UNRESOLVED',
    matches: (error) => isFastDnsFailure(error),
    message: () =>
      'The server hostname could not be resolved. Check the hostname and DNS configuration for this server.',
  },
  {
    name: 'connect-refused',
    code: 'CONNECT_TIMEOUT',
    matches: (error) => isConnectRefused(error),
    message: () =>
      'The connection was refused. Check that the SSH service is running on the configured host and port, and that no firewall is blocking it.',
  },
  {
    name: 'connect-timeout',
    code: 'CONNECT_TIMEOUT',
    matches: (error) => isHandshakeOrReadyTimeout(error),
    message: () =>
      'Could not establish an SSH connection within the configured timeout. Check network connectivity, firewall rules and that the host is reachable.',
  },
  {
    name: 'host-key-changed',
    code: 'HOST_KEY_CHANGED',
    matches: (error) => isHostKeyRejection(error),
    message: () =>
      "The server's host key does not match the previously trusted fingerprint. Verify the server's identity out of band, then approve the new fingerprint only if the change is expected.",
  },
  {
    name: 'socket-reset',
    code: 'CONNECTION_LOST',
    matches: (error) => isResetOrClosedSocket(error),
    message: (_error, context) =>
      context.phase === 'exec'
        ? 'The connection to the server was lost while a command was running. This is often transient — the adapter will retry automatically.'
        : 'The connection to the server was lost while connecting. This is often transient — the adapter will retry automatically.',
  },
  {
    name: 'command-timeout',
    code: 'COMMAND_TIMEOUT',
    matches: (error) => error instanceof CommandTimeoutError,
    message: (error) => {
      if (error instanceof CommandTimeoutError) {
        return `The command "${error.commandName}" did not complete within ${String(error.timeoutMs)}ms and was terminated.`;
      }
      return 'A command did not complete within its configured timeout and was terminated.';
    },
  },
  {
    // ADR 0004 row 8: `ssh2` never raises an `'error'` event for a transport that dies mid-exec —
    // the only signal is a channel `'close'` with no exit code while a command was outstanding.
    // Whatever observes that condition (plan 02-08/02-09) constructs a `TransportClosedError`
    // rather than this classifier trying to infer it from an `'error'` event that never fires.
    name: 'mid-exec-transport-death',
    code: 'CONNECTION_LOST',
    matches: (error) => error instanceof TransportClosedError,
    message: () =>
      'The connection to the server was lost while a command was running. This is often transient — the adapter will retry automatically.',
  },
  {
    // D-11: an OS outside the supported matrix is a warning, not an `ssh2` failure. Discovery
    // constructs this marker so the same table produces a consistent, actionable message.
    name: 'unsupported-os',
    code: 'UNSUPPORTED_OS',
    matches: (error) => error instanceof UnsupportedOsError,
    message: (error) => {
      if (error instanceof UnsupportedOsError) {
        return `Detected operating system "${error.detectedOs}" is outside the supported matrix (Ubuntu 22.04/24.04). The connection succeeded, but some features may not work as expected.`;
      }
      return 'The detected operating system is outside the supported matrix (Ubuntu 22.04/24.04).';
    },
  },
  {
    // The documented terminal fallback (a decision, not a gap): an unrecognised failure reports
    // as CONNECTION_LOST because that code lands on UNREACHABLE (a retryable, non-alarming state)
    // rather than ERROR, and D-10 permits it a single retry — the right behaviour for a condition
    // nobody has classified yet. This is the one rule allowed to include part of an upstream
    // message, and the caller still redacts the final result unconditionally.
    name: 'unclassified-fallback',
    code: 'CONNECTION_LOST',
    matches: () => true,
    message: (error) => {
      const upstreamMessage = safeStringField(error, 'message');
      const detail = upstreamMessage !== undefined && upstreamMessage.length > 0 ? upstreamMessage : 'no message available';
      return `An unrecognised SSH failure occurred (${detail}). Treating it as a lost connection; the adapter will retry automatically.`;
    },
  },
]);

const SAFE_FALLBACK_MESSAGE =
  'An unrecognised SSH failure occurred. Treating it as a lost connection; the adapter will retry automatically.';

/**
 * Classifies any `ssh2` failure (or any other value — never assume `error` is an `Error`) into a
 * `SshFailure`. Never throws (SERV-07): a broken rule, a hostile input, or an unexpected exception
 * anywhere in this function still produces a `CONNECTION_LOST` result rather than propagating.
 */
export function classifySshError(error: unknown, context: ClassifyContext): SshFailure {
  try {
    for (const rule of ERROR_CLASSIFICATION_RULES) {
      let isMatch: boolean;
      try {
        isMatch = rule.matches(error, context);
      } catch {
        isMatch = false;
      }
      if (!isMatch) continue;

      let message: string;
      try {
        message = rule.message(error, context);
      } catch {
        message = SAFE_FALLBACK_MESSAGE;
      }

      return { errorCode: rule.code, message: context.redactor.redact(message) };
    }
    // Unreachable in practice: `unclassified-fallback`'s `matches` always returns `true`, so the
    // loop above always returns before reaching here. Kept as a last-resort safety net so this
    // function can never fall through without a value.
    return { errorCode: 'CONNECTION_LOST', message: context.redactor.redact(SAFE_FALLBACK_MESSAGE) };
  } catch {
    return { errorCode: 'CONNECTION_LOST', message: SAFE_FALLBACK_MESSAGE };
  }
}
