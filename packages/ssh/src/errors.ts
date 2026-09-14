// The SSH adapter's own error vocabulary (SERV-07). This module is the classified, safe-to-
// surface shape every adapter failure lands on; `error-classifier.ts` is the only file that
// knows the underlying SSH client library's raw shapes and turns them into these types. Kept
// free of any import of that library.

import type { ServerErrorCode } from '@noodara/domain/server';

/**
 * A classified SSH failure: an operator-facing `errorCode` plus an actionable message that has
 * already passed through a `Redactor`. Never carries a raw underlying-library `Error`, a stack
 * trace, or any credential (SEC-05, T-2-30).
 */
export interface SshFailure {
  readonly errorCode: ServerErrorCode;
  readonly message: string;
}

/**
 * Raised internally by `exec-with-timeout.ts` when a single command's independent timeout budget
 * (D-08, SEC-04) elapses before its channel closes. Carries only the command name (drawn from the
 * closed, project-authored allowlist — never user input) and the configured budget; never a raw
 * upstream message. `error-classifier.ts` recognises this type directly and maps it to
 * `COMMAND_TIMEOUT` via a named rule, with no underlying-library shape ever being consulted for
 * this case.
 */
export class CommandTimeoutError extends Error {
  readonly commandName: string;
  readonly timeoutMs: number;

  constructor(commandName: string, timeoutMs: number) {
    super(`Command "${commandName}" exceeded its ${String(timeoutMs)}ms timeout budget`);
    this.name = 'CommandTimeoutError';
    this.commandName = commandName;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Synthetic marker for ADR 0004's row 8 (mid-exec transport death): the underlying SSH client
 * library never raises an `'error'` event for this — the only signal is a channel `'close'` with
 * no exit code while a command was outstanding. Whatever code observes that channel-level
 * condition (plan 02-08/02-09) constructs this marker and hands it to `classifySshError` so the
 * same, single classification table produces the `CONNECTION_LOST` outcome, rather than
 * re-deriving the mapping ad hoc.
 */
export class TransportClosedError extends Error {
  readonly commandName: string;

  constructor(commandName: string) {
    super(`Transport closed with no exit code while "${commandName}" was in flight`);
    this.name = 'TransportClosedError';
    this.commandName = commandName;
  }
}

/**
 * Synthetic marker for D-11's `UNSUPPORTED_OS` warning code: discovery (not the SSH connection
 * itself) detects that the remote OS is outside the supported matrix (Ubuntu 22.04/24.04) and
 * constructs this so the same classification table produces a consistent `SshFailure` shape for
 * the detail view, keeping `UNSUPPORTED_OS` reachable through the rule table rather than
 * assembled ad hoc elsewhere.
 */
export class UnsupportedOsError extends Error {
  readonly detectedOs: string;

  constructor(detectedOs: string) {
    super(`Detected operating system "${detectedOs}" is outside the supported matrix`);
    this.name = 'UnsupportedOsError';
    this.detectedOs = detectedOs;
  }
}
