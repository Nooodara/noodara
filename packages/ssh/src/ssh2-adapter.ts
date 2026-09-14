// The one place in the codebase that owns a real ssh2.Client (SERV-07, SEC-03). Every requirement
// in this phase converges here: SEC-03 depends on the TOFU verifier actually being wired into
// every `connect` call (02-RESEARCH.md's Pitfall 1 is precisely a verifier that exists but is not
// passed); SERV-07 depends on every ssh2 event reaching `classifySshError` instead of escaping as
// a rejection or an unhandled 'error' event. `createSsh2Adapter`'s `ssh2.Client` constructor is an
// injectable dependency (`deps.createClient`) with the real one as the default — that seam is what
// lets ssh2-adapter.test.ts drive every branch (a client that throws synchronously, a client that
// emits each ADR 0004 error shape, a client whose hostVerifier observes a mismatching blob)
// without pretending to test connection outcomes against a fake. Connection outcomes against a
// real sshd are plan 02-10's job.
import { Client } from 'ssh2';
import { revealSecret, type Redactor } from '@noodara/domain/security';
import type { ServerErrorCode } from '@noodara/domain/server';
import type { CommandName } from './commands/index.js';
import { classifySshError } from './error-classifier.js';
import { TransportClosedError, type SshFailure } from './errors.js';
import { execWithTimeout, type ExecChannel } from './exec-with-timeout.js';
import { formatFingerprint } from './fingerprint.js';
import { createHostVerifier, type HostVerifier } from './host-verifier.js';
import { loadPrivateKey } from './key-loader.js';
import type {
  ConnectInput,
  ConnectOutcome,
  ExecResult,
  HostFingerprint,
  SshCredential,
  SshPort,
  SshSession,
  SshTarget,
  SshTimeouts,
} from './ssh-port.js';

/** D-08/D-09: keepalive during a connection is fixed, never configurable per server. */
const KEEPALIVE_INTERVAL_MS = 10_000;

/**
 * D-05: ed25519 first, then ECDSA, then RSA SHA-2 — and no other host key algorithm. ssh2's own
 * default already negotiates ed25519 first (ADR 0004), but this list also *restricts* the set
 * (the default includes legacy `ssh-rsa`, which D-05 does not ask to accept for host keys signed
 * with the deprecated SHA-1 scheme).
 */
const HOST_KEY_ALGORITHMS = Object.freeze([
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
]);

interface KeyboardInteractivePrompt {
  readonly prompt: string;
  readonly echo: boolean;
}

/**
 * The narrowest structural shape this module needs from `ssh2.Client` — the injectable seam.
 * Never the concrete `ssh2.Client` type, so `ssh2-adapter.test.ts`'s fakes are honest doubles of
 * real event/callback mechanics rather than mocks of `ssh2` itself.
 */
interface Ssh2ClientLike {
  connect(options: Ssh2ConnectOptions): void;
  on(event: 'ready' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (err: unknown) => void): unknown;
  on(
    event: 'keyboard-interactive',
    listener: (
      name: string,
      instructions: string,
      lang: string,
      prompts: readonly KeyboardInteractivePrompt[],
      finish: (answers: readonly string[]) => void,
    ) => void,
  ): unknown;
  end(): void;
  exec(command: string, callback: (err: Error | undefined, channel: ExecChannel) => void): void;
}

interface Ssh2ConnectOptions {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly readyTimeout: number;
  readonly keepaliveInterval: number;
  readonly hostVerifier: (rawHostKey: Buffer) => boolean;
  readonly algorithms: { readonly serverHostKey: readonly string[] };
  readonly privateKey?: string;
  readonly passphrase?: string;
  readonly password?: string;
  readonly tryKeyboard?: boolean;
}

export interface CreateSsh2AdapterDeps {
  /** Defaults to a real `ssh2.Client`. Overridden by tests only. */
  readonly createClient?: () => Ssh2ClientLike;
}

/**
 * Raised by `SshSession.exec` for every rejection — already classified via `classifySshError`, so
 * `.message` is redacted and actionable and `.errorCode` is one of the seven `ServerErrorCode`s.
 * Never carries a raw underlying-library error.
 */
export class SshExecFailure extends Error {
  readonly errorCode: ServerErrorCode;

  constructor(failure: SshFailure) {
    super(failure.message);
    this.name = 'SshExecFailure';
    this.errorCode = failure.errorCode;
  }
}

interface RevealedCredential {
  readonly rawKey?: string;
  readonly rawPassphrase?: string;
  readonly rawPassword?: string;
}

/** Reveals a credential's secret(s) exactly once, registering them with `redactor` at the moment
 *  of reveal (SEC-05) — before anything is placed on the connect options. */
function revealCredential(credential: SshCredential, redactor: Redactor): RevealedCredential {
  if (credential.kind === 'private_key') {
    const rawKey = revealSecret(credential.privateKey, redactor);
    if (credential.passphrase === undefined) return { rawKey };
    return { rawKey, rawPassphrase: revealSecret(credential.passphrase, redactor) };
  }
  return { rawPassword: revealSecret(credential.password, redactor) };
}

/**
 * Builds the `client.connect()` options object in one named function so "every connect supplies a
 * hostVerifier" (T-2-31) is checkable — and true — in exactly one place.
 */
function buildConnectOptions(params: {
  readonly target: SshTarget;
  readonly timeouts: SshTimeouts;
  readonly verifier: HostVerifier;
  readonly revealed: RevealedCredential;
}): Ssh2ConnectOptions {
  const { target, timeouts, verifier, revealed } = params;

  const base: Ssh2ConnectOptions = {
    host: target.host,
    port: target.port,
    username: target.user,
    readyTimeout: timeouts.connectMs,
    keepaliveInterval: KEEPALIVE_INTERVAL_MS,
    hostVerifier: (rawHostKey: Buffer) => verifier.verify(rawHostKey),
    algorithms: { serverHostKey: [...HOST_KEY_ALGORITHMS] },
  };

  if (revealed.rawKey !== undefined) {
    return {
      ...base,
      privateKey: revealed.rawKey,
      ...(revealed.rawPassphrase !== undefined ? { passphrase: revealed.rawPassphrase } : {}),
    };
  }

  if (revealed.rawPassword !== undefined) {
    return { ...base, password: revealed.rawPassword, tryKeyboard: true };
  }

  return base;
}

/** D-06: both fingerprints, with their key types, and no hint that the change might be benign. */
function buildHostKeyChangedMessage(trusted: HostFingerprint, observed: HostFingerprint): string {
  return (
    "The server's host key does not match the previously trusted fingerprint. " +
    `Trusted: ${formatFingerprint(trusted)}. Observed: ${formatFingerprint(observed)}. ` +
    "Verify the server's identity out of band before choosing \"Trust new fingerprint\" for the new key."
  );
}

/** Mutable state shared between the connect-phase listeners and the session created after
 *  'ready' — a single 'error'/'close' listener pair (attached once, kept for the connection's
 *  lifetime) reads and writes this so no ssh2 event can arrive with no listener attached. */
interface SessionState {
  inFlightCommand: CommandName | null;
  onTransportLost: ((failure: SshFailure) => void) | null;
  closed: boolean;
}

function makeSession(
  client: Ssh2ClientLike,
  redactor: Redactor,
  commandMs: number,
  sessionState: SessionState,
): SshSession {
  async function exec(name: CommandName): Promise<ExecResult> {
    if (sessionState.closed) {
      throw new SshExecFailure(classifySshError(new TransportClosedError(name), { phase: 'exec', redactor }));
    }

    sessionState.inFlightCommand = name;
    const transportLost = new Promise<never>((_resolve, reject) => {
      sessionState.onTransportLost = (failure) => {
        reject(new SshExecFailure(failure));
      };
    });

    try {
      return await Promise.race([
        execWithTimeout({ client, commandName: name, timeoutMs: commandMs, redactor }).catch((err: unknown) => {
          throw new SshExecFailure(classifySshError(err, { phase: 'exec', redactor }));
        }),
        transportLost,
      ]);
    } finally {
      sessionState.inFlightCommand = null;
      sessionState.onTransportLost = null;
    }
  }

  function close(): Promise<void> {
    if (!sessionState.closed) {
      sessionState.closed = true;
      try {
        client.end();
      } catch {
        // Already gone — close() must still resolve.
      }
    }
    return Promise.resolve();
  }

  return { exec, close };
}

const CONNECT_PHASE_CLOSE_MESSAGE =
  'The connection to the server was lost while connecting. This is often transient — the adapter will retry automatically.';

/**
 * One connect attempt (no retry, no mutex — plan 02-08 Task 2 wraps this with both). Never
 * rejects, never throws: every failure inside — a validation failure, a synchronous throw from
 * `createClient`/`connect`, or any ssh2 `error`/`close` event — resolves to `{ ok: false }`.
 */
async function attemptConnect(
  input: ConnectInput,
  createClient: () => Ssh2ClientLike,
): Promise<ConnectOutcome> {
  const { target, credential, timeouts, trustedFingerprint, redactor } = input;

  if (credential.kind === 'private_key') {
    const loaded = loadPrivateKey(credential, redactor);
    if (!loaded.ok) {
      return {
        ok: false,
        errorCode: loaded.kind === 'auth' ? loaded.errorCode : 'AUTH_FAILED',
        message: loaded.message,
        attempts: 1,
      };
    }
  }

  const verifier = createHostVerifier({ trusted: trustedFingerprint });
  const revealed = revealCredential(credential, redactor);
  const options = buildConnectOptions({ target, timeouts, verifier, revealed });

  let client: Ssh2ClientLike;
  try {
    client = createClient();
  } catch (thrown) {
    const failure = classifySshError(thrown, { phase: 'connect', redactor });
    return { ok: false, errorCode: failure.errorCode, message: failure.message, attempts: 1 };
  }

  return new Promise<ConnectOutcome>((resolve) => {
    let settled = false;
    const sessionState: SessionState = { inFlightCommand: null, onTransportLost: null, closed: false };

    function settle(outcome: ConnectOutcome): void {
      if (settled) return;
      settled = true;
      resolve(outcome);
    }

    // Attached before connect() is called, and never removed: an ssh2 'error' arriving after
    // 'ready' with no listener is an unhandled 'error' event, which crashes the process — the
    // single most likely way SERV-07 gets violated in practice.
    client.on('error', (err: unknown) => {
      if (!settled) {
        const failure = classifySshError(err, { phase: 'connect', redactor });
        if (failure.errorCode === 'HOST_KEY_CHANGED' && trustedFingerprint !== null) {
          const observed = verifier.observed();
          if (observed !== null) {
            settle({
              ok: false,
              errorCode: 'HOST_KEY_CHANGED',
              message: redactor.redact(buildHostKeyChangedMessage(trustedFingerprint, observed)),
              attempts: 1,
              observedFingerprint: observed,
            });
            return;
          }
        }
        settle({ ok: false, errorCode: failure.errorCode, message: failure.message, attempts: 1 });
        return;
      }
      if (sessionState.inFlightCommand !== null && sessionState.onTransportLost !== null) {
        sessionState.onTransportLost(classifySshError(err, { phase: 'exec', redactor }));
      }
    });

    client.on('close', () => {
      sessionState.closed = true;
      if (!settled) {
        settle({
          ok: false,
          errorCode: 'CONNECTION_LOST',
          message: redactor.redact(CONNECT_PHASE_CLOSE_MESSAGE),
          attempts: 1,
        });
        return;
      }
      if (sessionState.inFlightCommand !== null && sessionState.onTransportLost !== null) {
        const failure = classifySshError(new TransportClosedError(sessionState.inFlightCommand), {
          phase: 'exec',
          redactor,
        });
        sessionState.onTransportLost(failure);
      }
    });

    if (revealed.rawPassword !== undefined) {
      const rawPassword = revealed.rawPassword;
      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        const allPasswordPrompts = prompts.every((prompt) => /password/i.test(prompt.prompt));
        if (!allPasswordPrompts) {
          finish([]); // D-03: any non-password prompt aborts — ssh2 exhausts auth and emits 'error'
          return;
        }
        finish(prompts.map(() => rawPassword));
      });
    }

    client.on('ready', () => {
      const observed = verifier.observed();
      settle({
        ok: true,
        session: makeSession(client, redactor, timeouts.commandMs, sessionState),
        fingerprint: observed ?? { keyType: 'unknown', fingerprint: '' },
        fingerprintCaptured: verifier.captured(),
        attempts: 1,
      });
    });

    try {
      client.connect(options);
    } catch (thrown) {
      const failure = classifySshError(thrown, { phase: 'connect', redactor });
      settle({ ok: false, errorCode: failure.errorCode, message: failure.message, attempts: 1 });
    }
  });
}

/**
 * The one entrypoint every future adapter or test double implements (`SshPort`). Plan 02-08 Task
 * 2 wraps `attemptConnect` with D-10's single retry and a per-target mutex; this task's `connect`
 * is exactly one attempt.
 */
export function createSsh2Adapter(deps: CreateSsh2AdapterDeps = {}): SshPort {
  const createClient = deps.createClient ?? (() => new Client() as unknown as Ssh2ClientLike);

  async function connect(input: ConnectInput): Promise<ConnectOutcome> {
    return attemptConnect(input, createClient);
  }

  return { connect };
}
