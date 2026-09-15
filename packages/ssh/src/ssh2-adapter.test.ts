// Wiring tests for Ssh2Adapter (SERV-07, SEC-03). `createSsh2Adapter`'s `ssh2.Client` constructor
// is an injectable seam (`deps.createClient`); every test here drives a fake client that emits
// the exact event shapes docs/adr/0004-ssh-adapter-empirical-contracts.md measured against real
// fixtures. These are wiring tests, not connection-outcome tests: 02-RESEARCH.md's "no mocked
// Client for connection-outcome scenarios" rule is about outcomes against a real sshd, which plan
// 02-10's Testcontainers suite covers. This file proves the adapter's own control flow — the
// hostVerifier is always wired, no failure escapes as an exception, D-01/D-02/D-03 credential
// handling and D-05/D-06 host-key behaviour are correct.
import { utils, type ParsedKey } from 'ssh2';
import { createRedactor, secretValue } from '@noodara/domain/security';
import { describe, expect, it, vi } from 'vitest';
import { computeFingerprint, formatFingerprint } from './fingerprint.js';
import { createSsh2Adapter } from './ssh2-adapter.js';
import { generateTestKeys, type TestKeySet } from './testing/generate-keys.js';
import type { ConnectInput, HostFingerprint, SshCredential, SshTimeouts } from './ssh-port.js';

// --- Fakes -------------------------------------------------------------------------------------

interface KeyboardInteractivePrompt {
  readonly prompt: string;
  readonly echo: boolean;
}

class FakeExecChannel {
  readonly dataListeners: ((chunk: Buffer) => void)[] = [];
  readonly closeListeners: ((code: number | null, signal?: string) => void)[] = [];
  readonly stderrDataListeners: ((chunk: Buffer) => void)[] = [];
  destroyCalls = 0;

  readonly stderr = {
    on: (_event: 'data', listener: (chunk: Buffer) => void): void => {
      this.stderrDataListeners.push(listener);
    },
  };

  on(event: 'data', listener: (chunk: Buffer) => void): void;
  on(event: 'close', listener: (code: number | null, signal?: string) => void): void;
  on(
    event: 'data' | 'close',
    listener: ((chunk: Buffer) => void) | ((code: number | null, signal?: string) => void),
  ): void {
    if (event === 'data') {
      this.dataListeners.push(listener as (chunk: Buffer) => void);
    } else {
      this.closeListeners.push(listener as (code: number | null, signal?: string) => void);
    }
  }

  destroy(): void {
    this.destroyCalls += 1;
  }

  emitData(chunk: Buffer): void {
    for (const listener of this.dataListeners) listener(chunk);
  }

  emitClose(code: number | null): void {
    for (const listener of this.closeListeners) listener(code);
  }
}

type ConnectImpl = (options: Record<string, unknown>) => void;
type ExecImpl = (command: string, callback: (err: Error | undefined, channel: FakeExecChannel) => void) => void;

/** A minimal, controllable double for `ssh2.Client`'s surface, matching the shape
 *  `ssh2-adapter.ts`'s injectable `createClient` seam expects. No real `ssh2` involved. */
class FakeClient {
  readonly callOrder: string[] = [];
  readonly connectCalls: Record<string, unknown>[] = [];
  readonly execCommands: string[] = [];
  endCalls = 0;
  connectImpl: ConnectImpl | undefined;
  execImpl: ExecImpl | undefined;

  private readonly listeners = new Map<string, ((...args: never[]) => void)[]>();

  on(event: 'ready' | 'close', listener: () => void): this;
  on(event: 'error', listener: (err: unknown) => void): this;
  on(
    event: 'keyboard-interactive',
    listener: (
      name: string,
      instructions: string,
      lang: string,
      prompts: readonly KeyboardInteractivePrompt[],
      finish: (answers: readonly string[]) => void,
    ) => void,
  ): this;
  on(event: string, listener: (...args: never[]) => void): this {
    this.callOrder.push(`on:${event}`);
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) (listener as (...a: unknown[]) => void)(...args);
  }

  // Typed `unknown` (not a concrete options shape) so this fake's `connect` is assignable to
  // whatever concrete `Ssh2ConnectOptions` shape `ssh2-adapter.ts` declares internally — the seam
  // only needs the fake to *accept* whatever the adapter passes, never to name that type.
  connect(options: unknown): void {
    this.callOrder.push('connect');
    this.connectCalls.push(options as Record<string, unknown>);
    this.connectImpl?.(options as Record<string, unknown>);
  }

  end(): void {
    this.endCalls += 1;
  }

  exec(command: string, callback: (err: Error | undefined, channel: FakeExecChannel) => void): void {
    this.execCommands.push(command);
    this.execImpl?.(command, callback);
  }
}

function ssh2Error(shape: { readonly message: string; readonly level?: string }): Error {
  const error = new Error(shape.message) as Error & { level?: string };
  if (shape.level !== undefined) error.level = shape.level;
  return error;
}

function parseOrThrow(text: string): ParsedKey {
  const parsed = utils.parseKey(text);
  if (parsed instanceof Error || Array.isArray(parsed)) {
    throw new Error('test setup: expected a real generated key to parse cleanly');
  }
  return parsed;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// --- Fixtures ------------------------------------------------------------------------------------

const keys: TestKeySet = generateTestKeys();
const ed25519Blob = parseOrThrow(keys.ed25519).getPublicSSH();
const ed25519Fingerprint: HostFingerprint = computeFingerprint(ed25519Blob);

const TIMEOUTS: SshTimeouts = { connectMs: 10_000, commandMs: 30_000, discoveryMs: 60_000 };

function privateKeyCredential(key: string): SshCredential {
  return { kind: 'private_key', privateKey: secretValue(key, 'ssh_private_key') };
}

function passwordCredential(password: string): SshCredential {
  return { kind: 'password', password: secretValue(password, 'ssh_password') };
}

function buildInput(overrides: Partial<ConnectInput> = {}): ConnectInput {
  return {
    target: { host: 'server.example.internal', port: 22, user: 'deployer' },
    credential: privateKeyCredential(keys.ed25519),
    timeouts: TIMEOUTS,
    trustedFingerprint: null,
    redactor: createRedactor(),
    ...overrides,
  };
}

/** Simulates a real ssh2 handshake: calls the connect options' `hostVerifier` with a real raw
 *  host key blob, then emits `ready` if it accepted, or an `error` matching ADR 0004 row 7 if
 *  it rejected (a mismatching pinned fingerprint). */
function acceptHandshakeThenReady(client: FakeClient): ConnectImpl {
  return (options) => {
    const accepted = (options.hostVerifier as (buf: Buffer) => boolean)(ed25519Blob);
    if (!accepted) {
      client.emit('error', ssh2Error({ message: 'Host denied (verification failed)', level: 'handshake' }));
      return;
    }
    client.emit('ready');
  };
}

function buildAdapter(deps: Parameters<typeof createSsh2Adapter>[0] = {}) {
  // Defaults `sleep` to a fast no-op so a test that unintentionally produces a retryable outcome
  // (CONNECT_TIMEOUT/CONNECTION_LOST) never waits the real 2s D-10 gap; a test that specifically
  // exercises the retry wiring overrides `sleep` explicitly.
  return createSsh2Adapter({ sleep: () => Promise.resolve(), ...deps });
}

describe('createSsh2Adapter', () => {
  it('returns an object satisfying SshPort', () => {
    const adapter = buildAdapter({ createClient: () => new FakeClient() });
    expect(typeof adapter.connect).toBe('function');
  });

  describe('connect options (D-05, D-08, SEC-03)', () => {
    it('always supplies a hostVerifier, never a hostHash, the configured connect timeout, the fixed keepalive and the exact host key algorithm order', async () => {
      const client = new FakeClient();
      client.connectImpl = acceptHandshakeThenReady(client);
      const adapter = buildAdapter({ createClient: () => client });

      const outcome = await adapter.connect(buildInput());

      expect(outcome.ok).toBe(true);
      const options = client.connectCalls[0];
      expect(options).toBeDefined();
      expect(typeof options?.hostVerifier).toBe('function');
      expect(options?.hostHash).toBeUndefined();
      expect(options?.readyTimeout).toBe(TIMEOUTS.connectMs);
      expect(options?.keepaliveInterval).toBe(10_000);
      expect(options?.algorithms).toEqual({
        serverHostKey: [
          'ssh-ed25519',
          'ecdsa-sha2-nistp256',
          'ecdsa-sha2-nistp384',
          'ecdsa-sha2-nistp521',
          'rsa-sha2-512',
          'rsa-sha2-256',
        ],
      });
    });

    it('attaches an error listener before calling connect()', async () => {
      const client = new FakeClient();
      client.connectImpl = acceptHandshakeThenReady(client);
      const adapter = buildAdapter({ createClient: () => client });

      await adapter.connect(buildInput());

      const errorIndex = client.callOrder.indexOf('on:error');
      const connectIndex = client.callOrder.indexOf('connect');
      expect(errorIndex).toBeGreaterThanOrEqual(0);
      expect(errorIndex).toBeLessThan(connectIndex);
    });
  });

  describe('never rejects, never throws (SERV-07)', () => {
    it('resolves { ok: false } when the injected client throws synchronously from connect()', async () => {
      const client = new FakeClient();
      client.connect = () => {
        throw new Error('synchronous boom');
      };
      const adapter = buildAdapter({ createClient: () => client });

      await expect(adapter.connect(buildInput())).resolves.toMatchObject({ ok: false });
    });

    it('resolves { ok: false } when the injected createClient itself throws', async () => {
      const adapter = buildAdapter({
        createClient: () => {
          throw new Error('cannot construct client');
        },
      });

      await expect(adapter.connect(buildInput())).resolves.toMatchObject({ ok: false });
    });
  });

  describe('private-key credentials (D-01, D-02)', () => {
    it('validates the key before opening any socket, returning the loader message on failure', async () => {
      const createClient = vi.fn(() => new FakeClient());
      const adapter = buildAdapter({ createClient });

      const outcome = await adapter.connect(buildInput({ credential: privateKeyCredential('not a real key') }));

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.errorCode).toBe('AUTH_FAILED');
        expect(outcome.message.length).toBeGreaterThan(0);
      }
      expect(createClient).not.toHaveBeenCalled();
    });

    it('connects successfully with a valid private key', async () => {
      const client = new FakeClient();
      client.connectImpl = acceptHandshakeThenReady(client);
      const adapter = buildAdapter({ createClient: () => client });

      const outcome = await adapter.connect(buildInput());

      expect(outcome.ok).toBe(true);
      const options = client.connectCalls[0];
      expect(options?.privateKey).toBeDefined();
    });
  });

  describe('password credentials and keyboard-interactive (D-03)', () => {
    it('sets tryKeyboard and answers an all-password challenge with the same password for every prompt', async () => {
      let receivedAnswers: readonly string[] = [];
      const client = new FakeClient();
      client.connectImpl = (options) => {
        client.emit(
          'keyboard-interactive',
          'name',
          '',
          'en',
          [
            { prompt: 'Password:', echo: false },
            { prompt: 'Password (again):', echo: false },
          ],
          (answers: readonly string[]) => {
            receivedAnswers = answers;
            const accepted = (options.hostVerifier as (buf: Buffer) => boolean)(ed25519Blob);
            if (accepted) client.emit('ready');
          },
        );
      };
      const adapter = buildAdapter({ createClient: () => client });

      const outcome = await adapter.connect(buildInput({ credential: passwordCredential('hunter2') }));

      expect(receivedAnswers).toEqual(['hunter2', 'hunter2']);
      expect(outcome.ok).toBe(true);
      expect(client.connectCalls[0]?.tryKeyboard).toBe(true);
    });

    it('aborts with AUTH_FAILED when a keyboard-interactive challenge includes a non-password prompt', async () => {
      const client = new FakeClient();
      client.connectImpl = () => {
        client.emit(
          'keyboard-interactive',
          'name',
          '',
          'en',
          [{ prompt: 'Enter your 2FA code:', echo: false }],
          (answers: readonly string[]) => {
            expect(answers).toEqual([]);
            client.emit('error', ssh2Error({ message: 'All configured authentication methods failed', level: 'client-authentication' }));
          },
        );
      };
      const adapter = buildAdapter({ createClient: () => client });

      const outcome = await adapter.connect(buildInput({ credential: passwordCredential('hunter2') }));

      expect(outcome).toMatchObject({ ok: false, errorCode: 'AUTH_FAILED' });
    });
  });

  describe('host fingerprint capture and mismatch (D-06, D-07)', () => {
    it('captures the fingerprint on first connection when no fingerprint is trusted yet', async () => {
      const client = new FakeClient();
      client.connectImpl = acceptHandshakeThenReady(client);
      const adapter = buildAdapter({ createClient: () => client });

      const outcome = await adapter.connect(buildInput({ trustedFingerprint: null }));

      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.fingerprintCaptured).toBe(true);
        expect(outcome.fingerprint).toEqual(ed25519Fingerprint);
      }
    });

    it('does not report a capture when the observed key matches an already-pinned fingerprint', async () => {
      const client = new FakeClient();
      client.connectImpl = acceptHandshakeThenReady(client);
      const adapter = buildAdapter({ createClient: () => client });

      const outcome = await adapter.connect(buildInput({ trustedFingerprint: ed25519Fingerprint }));

      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.fingerprintCaptured).toBe(false);
        expect(outcome.fingerprint).toEqual(ed25519Fingerprint);
      }
    });

    it('rejects a mismatching host key with HOST_KEY_CHANGED, the observed fingerprint, and both renderings in the message', async () => {
      const client = new FakeClient();
      client.connectImpl = acceptHandshakeThenReady(client);
      const adapter = buildAdapter({ createClient: () => client });
      const wrongTrusted: HostFingerprint = { keyType: 'ssh-ed25519', fingerprint: 'SHA256:notTheRealFingerprintAtAll' };

      const outcome = await adapter.connect(buildInput({ trustedFingerprint: wrongTrusted }));

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.errorCode).toBe('HOST_KEY_CHANGED');
        expect(outcome.observedFingerprint).toEqual(ed25519Fingerprint);
        expect(outcome.message).toContain(formatFingerprint(wrongTrusted));
        expect(outcome.message).toContain(formatFingerprint(ed25519Fingerprint));
      }
    });
  });

  describe('session.exec (SEC-04, D-08)', () => {
    it('delegates to execWithTimeout for the given command and resolves an ExecResult', async () => {
      const client = new FakeClient();
      client.connectImpl = acceptHandshakeThenReady(client);
      const channel = new FakeExecChannel();
      client.execImpl = (_command, callback) => {
        callback(undefined, channel);
      };
      const adapter = buildAdapter({ createClient: () => client });
      const outcome = await adapter.connect(buildInput());
      if (!outcome.ok) throw new Error('test setup: expected a successful connect');

      const execPromise = outcome.session.exec('discovery.hostname');
      channel.emitData(Buffer.from('myhost\n'));
      channel.emitClose(0);
      const result = await execPromise;

      expect(result.stdout).toBe('myhost\n');
      expect(result.exitCode).toBe(0);
      expect(client.execCommands).toEqual(['hostname']);
    });

    it('rejects the in-flight exec with CONNECTION_LOST when the client closes with no prior error while a command is in flight', async () => {
      const client = new FakeClient();
      client.connectImpl = acceptHandshakeThenReady(client);
      const channel = new FakeExecChannel();
      client.execImpl = (_command, callback) => {
        callback(undefined, channel); // channel never closes — ADR 0004 row 8's exact hang
      };
      const adapter = buildAdapter({ createClient: () => client });
      const outcome = await adapter.connect(buildInput());
      if (!outcome.ok) throw new Error('test setup: expected a successful connect');

      const execPromise = outcome.session.exec('discovery.hostname');
      client.emit('close');

      await expect(execPromise).rejects.toMatchObject({ errorCode: 'CONNECTION_LOST' });
    });
  });

  describe('session.close', () => {
    it('calls client.end(), is safe to call more than once, and resolves even if the connection is already gone', async () => {
      const client = new FakeClient();
      client.connectImpl = acceptHandshakeThenReady(client);
      const adapter = buildAdapter({ createClient: () => client });
      const outcome = await adapter.connect(buildInput());
      if (!outcome.ok) throw new Error('test setup: expected a successful connect');

      await outcome.session.close();
      await expect(outcome.session.close()).resolves.toBeUndefined();
      expect(client.endCalls).toBe(1);
    });
  });

  describe('connect() never hangs on a close before ready', () => {
    it('resolves { ok: false, errorCode: CONNECTION_LOST } when the client closes with no prior error before ready', async () => {
      const client = new FakeClient();
      const barrier = deferred<undefined>();
      client.connectImpl = () => {
        void barrier.promise.then(() => {
          client.emit('close');
        });
      };
      const adapter = buildAdapter({ createClient: () => client });

      const outcomePromise = adapter.connect(buildInput());
      barrier.resolve(undefined);

      await expect(outcomePromise).resolves.toMatchObject({ ok: false, errorCode: 'CONNECTION_LOST' });
    });
  });

  describe('D-10 retry and the per-target mutex', () => {
    it('retries once after a CONNECT_TIMEOUT and reports attempts: 2, using the injected sleep', async () => {
      let callCount = 0;
      const createClient = () => {
        callCount += 1;
        const client = new FakeClient();
        client.connectImpl =
          callCount === 1
            ? () => {
                client.emit(
                  'error',
                  ssh2Error({ message: 'Timed out while waiting for handshake', level: 'client-timeout' }),
                );
              }
            : acceptHandshakeThenReady(client);
        return client;
      };
      const sleep = vi.fn(() => Promise.resolve());
      const adapter = buildAdapter({ createClient, sleep });

      const outcome = await adapter.connect(buildInput());

      expect(callCount).toBe(2);
      expect(sleep).toHaveBeenCalledWith(2000);
      expect(outcome).toMatchObject({ ok: true, attempts: 2 });
    });

    it('never retries AUTH_FAILED and reports attempts: 1', async () => {
      let callCount = 0;
      const createClient = () => {
        callCount += 1;
        return new FakeClient();
      };
      const sleep = vi.fn(() => Promise.resolve());
      const adapter = buildAdapter({ createClient, sleep });

      const outcome = await adapter.connect(buildInput({ credential: privateKeyCredential('not a real key') }));

      expect(callCount).toBe(0); // validation failure — no client ever created, let alone retried
      expect(sleep).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ ok: false, errorCode: 'AUTH_FAILED', attempts: 1 });
    });

    it('serialises concurrent connects to the same target', async () => {
      const order: string[] = [];
      let index = 0;
      const createClient = () => {
        index += 1;
        const current = index;
        const client = new FakeClient();
        client.connectImpl = (options) => {
          order.push(`start-${String(current)}`);
          (options.hostVerifier as (buf: Buffer) => boolean)(ed25519Blob);
          order.push(`ready-${String(current)}`);
          client.emit('ready');
        };
        return client;
      };
      const adapter = buildAdapter({ createClient });

      const first = adapter.connect(buildInput());
      const second = adapter.connect(buildInput());
      await Promise.all([first, second]);

      expect(order).toEqual(['start-1', 'ready-1', 'start-2', 'ready-2']);
    });
  });
});
