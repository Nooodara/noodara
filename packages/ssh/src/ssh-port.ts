// Adapter boundary contracts (SERV-07, SEC-04, 02-CONTEXT.md D-01..D-10). Every type downstream
// phase-2 plans implement against lives here, declared once so no later plan has to reverse-
// engineer a contract from a sibling plan's output. No I/O, no behaviour: Task 4 fills in the
// command allowlist this file imports `CommandName` from; plans 02-02..02-10 implement `SshPort`
// itself.

import type { ServerErrorCode } from '@noodara/domain/server';
import type { Redactor, SecretValue } from '@noodara/domain/security';
import type { CommandName } from './commands/index.js';

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
export type ConnectOutcome =
  | {
      readonly ok: true;
      readonly session: SshSession;
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
export interface SshPort {
  connect(input: ConnectInput): Promise<ConnectOutcome>;
}
