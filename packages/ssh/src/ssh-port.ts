// Adapter boundary contracts (SERV-07, SEC-04, 02-CONTEXT.md D-01..D-10). Every type downstream
// phase-2 plans implement against lives here, declared once so no later plan has to reverse-
// engineer a contract from a sibling plan's output. No I/O, no behaviour: Task 4 fills in the
// command allowlist this file imports `CommandName` from; plans 02-02..02-10 implement `SshPort`
// itself.

import type { ServerErrorCode } from '@noodara/domain/server';
import type { Redactor, SecretValue } from '@noodara/domain/security';
import type { CommandName, DeployCommandName, RemoteCommand } from './commands/index.js';

/** The connection coordinates for a single SSH attempt. No credential, no timeouts — see below. */
export interface SshTarget {
  readonly host: string;
  readonly port: number;
  readonly user: string;
}

/**
 * How the adapter authenticates (D-01/D-02/D-03). `passphrase` is genuinely optional under
 * `exactOptionalPropertyTypes` — omit the property entirely for an unencrypted key, never set it
 * to `undefined`.
 */
export type SshCredential =
  | { readonly kind: 'private_key'; readonly privateKey: SecretValue; readonly passphrase?: SecretValue }
  | { readonly kind: 'password'; readonly password: SecretValue };

/**
 * Timeouts in milliseconds, sourced by the caller from `NOODARA_SSH_*` env vars (D-09) and passed
 * as a parameter — nothing in `packages/ssh` may read environment variables directly. `connectMs` bounds
 * the TCP+handshake+auth phase, `commandMs` bounds each individual `exec`, `discoveryMs` bounds
 * the whole `runDiscovery` run across every command on one reused connection (D-08).
 */
export interface SshTimeouts {
  readonly connectMs: number;
  readonly commandMs: number;
  readonly discoveryMs: number;
}

/**
 * A host key fingerprint (D-04/D-05). `fingerprint` is the `SHA256:<base64-no-padding>` form
 * `ssh-keygen -lf` prints, computed over the raw host public key — never the pre-hashed hex digest
 * `ssh2`'s own `hostHash` option would otherwise hand back. `keyType` is the SSH algorithm name
 * (`ssh-ed25519`, `ecdsa-sha2-nistp256`, `rsa-sha2-512`, ...). The combined
 * `"<keyType> <fingerprint>"` rendering (D-05) is left to the plan that first needs to print it,
 * not declared here — this module stays declaration-only.
 */
export interface HostFingerprint {
  readonly keyType: string;
  readonly fingerprint: string;
}

/**
 * The result of running one allowlisted command. `stdout`/`stderr` are documented as already
 * redacted (via the `Redactor` passed into `ConnectInput`) and already truncated to 64 KB (SEC-05)
 * by the time a caller observes an `ExecResult` — never raw adapter internals.
 */
export interface ExecResult {
  readonly commandName: CommandName;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly truncated: boolean;
}

/**
 * A live, authenticated SSH connection. `exec` takes an allowlist key, never a command string —
 * that signature is half of SEC-04's "no user input reaches a shell" guarantee (the frozen
 * templates in `./commands` are the other half). `close` is always safe to call, including after
 * a failed `exec`.
 */
export interface SshSession {
  exec(name: CommandName): Promise<ExecResult>;
  close(): Promise<void>;
}

/** One delivery of streamed output (11-14): one or more complete lines, already redacted. */
export interface StreamChunk {
  readonly stream: 'stdout' | 'stderr';
  /** Redacted. Complete lines, except a final partial line flushed when the stream ends. */
  readonly text: string;
  /** Increases by one per chunk across both streams. */
  readonly seq: number;
  /** A line in this chunk was cut at `maxLineBytes`; the rest of that line was dropped. */
  readonly truncatedLine: boolean;
}

/** Every bound is mandatory (T-11-40). Closing the channel never stops the remote process (ADR
 *  0008 G2): a timeout or abort must be followed by `killSupervisedOperation`. */
export interface StreamOptions {
  /** Required when `command.stdin` is `'secret'`, rejected otherwise. Written once, then EOF. */
  readonly stdin?: SecretValue;
  readonly maxDurationMs: number;
  readonly idleTimeoutMs: number;
  /** Cap on the redacted bytes delivered through `onChunk`, both streams together. */
  readonly maxTotalBytes: number;
  readonly maxLineBytes: number;
  readonly signal?: AbortSignal;
  readonly onChunk: (chunk: StreamChunk) => void;
}

export interface StreamResult {
  readonly commandName: DeployCommandName;
  readonly outcome: 'completed' | 'timed_out' | 'idle_timeout' | 'aborted';
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly durationMs: number;
  /** Raw bytes received from the remote, both streams, delivered or not. */
  readonly totalBytes: number;
  /** A line was cut or `maxTotalBytes` stopped delivery. */
  readonly truncated: boolean;
  /** Last 8 KiB of redacted output per stream (including undelivered lines), for classifiers. */
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

/**
 * The deploy-engine session (11-14). Additive over `SshSession`: `stream` accepts only a
 * `RemoteCommand` (module-private brand, built by the deploy templates), never a string (T-11-43).
 * Several streams may run at once on one connection, each on its own channel.
 */
export interface SshDeploySession extends SshSession {
  stream(command: RemoteCommand, options: StreamOptions): Promise<StreamResult>;
}

/** Everything `SshPort.connect` needs. `redactor` is injected, never constructed internally. */
export interface ConnectInput {
  readonly target: SshTarget;
  readonly credential: SshCredential;
  readonly timeouts: SshTimeouts;
  /** `null` on first connect (no fingerprint has ever been trusted for this server) — see D-07. */
  readonly trustedFingerprint: HostFingerprint | null;
  readonly redactor: Redactor;
}

/**
 * The result of a connection attempt (D-06/D-07/D-10). On success, `fingerprintCaptured` is true
 * only when `trustedFingerprint` was `null` and this attempt is the one that captured it — the
 * caller (phase 3) persists it. On failure, `observedFingerprint` is present only for
 * `HOST_KEY_CHANGED`; every other error code omits it entirely (`exactOptionalPropertyTypes`).
 * `attempts` is 1 or 2 per D-10's single-retry policy.
 */
export type ConnectOutcome<S extends SshSession = SshSession> =
  | {
      readonly ok: true;
      readonly session: S;
      readonly fingerprint: HostFingerprint;
      readonly fingerprintCaptured: boolean;
      readonly attempts: number;
    }
  | {
      readonly ok: false;
      readonly errorCode: ServerErrorCode;
      readonly message: string;
      readonly attempts: number;
      readonly observedFingerprint?: HostFingerprint;
    };

/**
 * The one entrypoint every future adapter (or test double) implements. `connect` never rejects
 * and never throws (SERV-07) — every failure, including an unclassified one, lands as a
 * `{ ok: false }` outcome.
 */
export interface SshPort<S extends SshSession = SshSession> {
  connect(input: ConnectInput): Promise<ConnectOutcome<S>>;
}
