// Wave 0 empirical spikes (02-04-PLAN.md): standing, permanent assertions for every fact
// docs/adr/0004-ssh-adapter-empirical-contracts.md records. This file measures real `ssh2`
// behaviour against the real sshd fixtures built in plans 02-01/02-02 — nothing here is
// reasoned from documentation or training knowledge. No plan before 02-06 implements `SshPort`;
// this file drives a raw `ssh2.Client` directly (via `@noodara/ssh/testing`, never the bare
// `ssh2` specifier `packages/ssh/src/boundary.test.ts` forbids outside packages/ssh) exactly as
// 02-04-PLAN.md's Task 1 instructs. A future `ssh2` upgrade that changes any of these shapes
// fails here, not silently inside a downstream plan's classifier or parser.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, utils } from '@noodara/ssh/testing';
import type { ClientChannel, ConnectConfig } from '@noodara/ssh/testing';
import { commandFor } from '@noodara/ssh';
import {
  assertNoStrayTestContainers,
  hostKeyFingerprint,
  readTestKey,
  startBlackholeListener,
  startSshd,
  waitForSlowCommandStart,
  type BlackholeListener,
  type SshdFixture,
  type UbuntuVersion,
} from '../helpers/ssh.js';

const UBUNTU_VERSIONS = ['22.04', '24.04'] as const satisfies readonly UbuntuVersion[];

// --- Shared spike plumbing (Tasks 1-3) --------------------------------------------------------

/** Every field `ssh2` might attach to an `Error`, read verbatim — never re-derived or guessed. */
interface ObservedError {
  readonly message: string;
  readonly level: string | undefined;
  readonly code: string | undefined;
  readonly errno: number | undefined;
  readonly syscall: string | undefined;
  readonly fatal: boolean | undefined;
}

function describeError(err: unknown): ObservedError {
  const e = err as Error & {
    level?: string;
    code?: string;
    errno?: number;
    syscall?: string;
    fatal?: boolean;
  };
  return {
    message: e.message,
    level: e.level,
    code: e.code,
    errno: e.errno,
    syscall: e.syscall,
    fatal: e.fatal,
  };
}

type ConnectAttempt =
  | { readonly ok: true; readonly client: Client; readonly elapsedMs: number }
  | { readonly ok: false; readonly err: ObservedError; readonly elapsedMs: number };

/**
 * The one raw-`ssh2.Client` connect helper every task in this file reuses: resolves on `ready`
 * or the first `error`, whichever comes first, with the elapsed wall-clock time attached so
 * Task 3's timeout-window assertions never depend on a fixed sleep.
 */
function attemptConnect(config: ConnectConfig): Promise<ConnectAttempt> {
  return new Promise((resolve) => {
    const client = new Client();
    const start = Date.now();
    let settled = false;
    const settle = (result: ConnectAttempt): void => {
      if (settled) return;
      settled = true;
      // Swallow any further 'error' events after this promise has already settled. Some failure
      // modes (e.g. the blackhole listener's readyTimeout firing) leave the underlying socket
      // alive; when its peer container is later stopped in `afterEach`, a second, later 'error'
      // can fire on this same abandoned Client — an unhandled 'error' event is a fatal, uncaught
      // exception in Node, and this function's single caller has already moved on by then.
      client.removeAllListeners('error');
      client.on('error', () => {
        /* intentionally ignored — see comment above */
      });
      resolve(result);
    };
    client.once('ready', () => {
      settle({ ok: true, client, elapsedMs: Date.now() - start });
    });
    client.once('error', (err: unknown) => {
      settle({ ok: false, err: describeError(err), elapsedMs: Date.now() - start });
    });
    client.connect(config);
  });
}

// --- Task 1: hostVerifier raw-key contract and fingerprint equivalence (open question 1) ------

describe('Task 1: hostVerifier raw-key contract (open question 1, D-04/D-05)', () => {
  let fixture: SshdFixture | undefined;
  let openClient: Client | undefined;

  afterEach(async () => {
    openClient?.end();
    openClient = undefined;
    await fixture?.stop();
    fixture = undefined;
    await assertNoStrayTestContainers();
  });

  it('hostVerifier receives the raw host key as a Buffer beginning with its RFC 4253 algorithm-name field, and default negotiation picks ed25519 first', async () => {
    fixture = await startSshd({ ubuntu: '24.04' });
    const privateKey = await readTestKey(fixture, 'ed25519');

    let observed: Buffer | undefined;
    let negotiatedServerHostKey: string | undefined;
    const attempt = await attemptConnect({
      host: fixture.host,
      port: fixture.port,
      username: 'deployer',
      privateKey,
      readyTimeout: 5000,
      hostVerifier: (key: Buffer) => {
        observed = key;
        return true;
      },
    });
    if (attempt.ok) {
      openClient = attempt.client;
      attempt.client.once('handshake', (negotiated: { serverHostKey: string }) => {
        negotiatedServerHostKey = negotiated.serverHostKey;
      });
    }

    expect(attempt.ok).toBe(true);
    expect(Buffer.isBuffer(observed)).toBe(true);

    const buf = observed as Buffer;
    // RFC 4253 §6.6: an SSH host key blob always begins with a 4-byte big-endian length
    // followed by that many ASCII bytes naming the algorithm — measured, not assumed.
    const algoNameLength = buf.readUInt32BE(0);
    const algoName = buf.subarray(4, 4 + algoNameLength).toString('ascii');
    expect(algoName).toBe('ssh-ed25519');

    // ssh2's own DEFAULT_SERVER_HOST_KEY list (lib/protocol/constants.js) unshifts 'ssh-ed25519'
    // onto the front whenever the Node runtime's `eddsaSupported` flag is set — no
    // `algorithms.serverHostKey` override was supplied above, and the server offers all three
    // types (D-05), so this is ssh2's own default choosing ed25519 first, not this repo forcing it.
    void negotiatedServerHostKey; // best-effort capture; the algoName assertion above is authoritative
  });

  it('utils.parseKey accepts the raw hostVerifier Buffer directly and yields the ed25519 algorithm name via .type (technique (a))', async () => {
    fixture = await startSshd({ ubuntu: '24.04' });
    const privateKey = await readTestKey(fixture, 'ed25519');

    let observed: Buffer | undefined;
    const attempt = await attemptConnect({
      host: fixture.host,
      port: fixture.port,
      username: 'deployer',
      privateKey,
      readyTimeout: 5000,
      hostVerifier: (key: Buffer) => {
        observed = key;
        return true;
      },
    });
    if (attempt.ok) openClient = attempt.client;
    expect(attempt.ok).toBe(true);

    const parsed = utils.parseKey(observed as Buffer);
    // Measured fact (not the research doc's guess): technique (a), `utils.parseKey(rawArgument)`,
    // DOES accept the raw wire-format host key blob and yields a real `.type` — the binary
    // fallback branch in ssh2's own keyParser.js (`readString` for the type, then `parseDER` on
    // the rest) happens to accept exactly RFC 4253's host-key-blob layout. Plan 02-06 may use
    // either technique (a) or the manual RFC 4253 decode proven in the test above; this repo
    // prefers (a) since it is a single call with no hand-rolled byte offsets.
    expect(parsed instanceof Error).toBe(false);
    if (!(parsed instanceof Error)) {
      expect(parsed.type).toBe('ssh-ed25519');
    }
  });

  it.each(['ed25519', 'rsa3072', 'ecdsa'] as const)(
    'the computed SHA256 fingerprint of the raw hostVerifier Buffer for a %s host key matches ssh-keygen -lf exactly (D-04)',
    async (keyName) => {
      fixture = await startSshd({ ubuntu: '24.04' });
      const privateKey = await readTestKey(fixture, 'ed25519'); // user-auth key; unrelated to which host key type is forced below

      const forcedAlgorithm = {
        ed25519: 'ssh-ed25519',
        rsa3072: 'rsa-sha2-512',
        ecdsa: 'ecdsa-sha2-nistp256',
      }[keyName];
      const keygenType = { ed25519: 'ed25519', rsa3072: 'rsa', ecdsa: 'ecdsa' }[keyName];

      let observed: Buffer | undefined;
      const attempt = await attemptConnect({
        host: fixture.host,
        port: fixture.port,
        username: 'deployer',
        privateKey,
        readyTimeout: 5000,
        algorithms: { serverHostKey: [forcedAlgorithm] },
        hostVerifier: (key: Buffer) => {
          observed = key;
          return true;
        },
      });
      if (attempt.ok) openClient = attempt.client;
      expect(attempt.ok).toBe(true);

      const computed =
        'SHA256:' +
        createHash('sha256')
          .update(observed as Buffer)
          .digest('base64')
          .replace(/=+$/, '');
      const keygenLine = await hostKeyFingerprint(fixture, keygenType);

      expect(keygenLine).toContain(computed);
    },
  );

  it('a wrong passphrase and a truncated key both fail utils.parseKey, and are distinguishable by message (A2)', async () => {
    fixture = await startSshd({ ubuntu: '24.04' });
    const locked = await readTestKey(fixture, 'ed25519_locked');

    const correct = utils.parseKey(locked, fixture.keyPassphrase);
    expect(correct instanceof Error).toBe(false);

    const wrongPassphrase = utils.parseKey(locked, 'definitely-wrong-passphrase');
    expect(wrongPassphrase instanceof Error).toBe(true);

    const truncated = locked.slice(0, Math.floor(locked.length / 2));
    const malformed = utils.parseKey(truncated);
    expect(malformed instanceof Error).toBe(true);

    if (wrongPassphrase instanceof Error && malformed instanceof Error) {
      // Measured fact: both come back as plain `Error` (no distinct subclass/name — A2's own
      // premise), but their *messages* are distinguishable verbatim strings, so plan 02-06's key
      // loader can say "wrong passphrase" specifically rather than only "unable to parse".
      expect(wrongPassphrase.message).not.toBe(malformed.message);
      expect(wrongPassphrase.message.toLowerCase()).toContain('passphrase');
    }
  });
});

// --- Task 2: Docker version detection shapes (open question 2, assumption A3) ------------------

interface ExecCapture {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

async function runAs(fixture: SshdFixture, command: string, user: string): Promise<ExecCapture> {
  const result = await fixture.container.exec(['sh', '-c', command], { user });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

describe.each(UBUNTU_VERSIONS)('Task 2: docker version detection shapes (Ubuntu %s)', (ubuntu) => {
  let fixture: SshdFixture | undefined;

  afterEach(async () => {
    await fixture?.stop();
    fixture = undefined;
    await assertNoStrayTestContainers();
  });

  it('docker version --format json exits 127 with empty stdout when the docker binary is absent (plain image)', async () => {
    fixture = await startSshd({ ubuntu });

    const result = await runAs(fixture, commandFor('docker.version'), 'deployer');

    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('docker: not found');
  });

  it('docker version --format json exits non-zero but stdout is valid JSON with a Client key when the CLI is present and the daemon is unreachable', async () => {
    fixture = await startSshd({ ubuntu, dockerCli: true });

    const result = await runAs(fixture, commandFor('docker.version'), 'deployer');

    expect(result.exitCode).not.toBe(0);
    // Pitfall 2: this must never be collapsed into `docker_installed = false` — stdout parses as
    // real JSON with a `Client` key and a null `Server`, distinct from the exit-127 case above.
    const parsed: unknown = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({ Client: expect.any(Object) as object, Server: null });
    // stderr never contaminates stdout — JSON.parse above already proves this, but assert the
    // failure text lives in stderr explicitly so a future ssh2/docker upgrade that starts mixing
    // the two streams fails here.
    expect(result.stderr).toContain('failed to connect to the docker API');
  });

  it('docker compose version --short exits 127 when the docker binary is absent (plain image)', async () => {
    fixture = await startSshd({ ubuntu });

    const result = await runAs(fixture, commandFor('docker.compose_version'), 'deployer');

    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe('');
  });

  it('docker compose version --short succeeds without a daemon when the CLI is present', async () => {
    fixture = await startSshd({ ubuntu, dockerCli: true });

    const result = await runAs(fixture, commandFor('docker.compose_version'), 'deployer');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });
});

// --- Task 3: CONNECT_TIMEOUT candidates and the ssh2 error-shape table (open question 3, A4/A5) -

describe('Task 3: CONNECT_TIMEOUT candidate selection (open question 3, A4)', () => {
  let fixture: SshdFixture | undefined;
  let blackhole: BlackholeListener | undefined;

  afterEach(async () => {
    await fixture?.stop();
    fixture = undefined;
    await blackhole?.stop();
    blackhole = undefined;
    await assertNoStrayTestContainers();
  });

  it('candidate (a) — the blackhole listener — fails within a bounded window around the configured readyTimeout, level client-timeout (the chosen strategy)', async () => {
    blackhole = await startBlackholeListener();
    const configuredTimeout = 2000;

    const attempt = await attemptConnect({
      host: blackhole.host,
      port: blackhole.port,
      username: 'irrelevant',
      password: 'irrelevant',
      readyTimeout: configuredTimeout,
      hostVerifier: () => true,
    });

    expect(attempt.ok).toBe(false);
    if (!attempt.ok) {
      expect(attempt.err.level).toBe('client-timeout');
      expect(attempt.err.message).toBe('Timed out while waiting for handshake');
      // Elapsed-time window, not a fixed sleep: must land at-or-after the configured timeout and
      // within a few seconds of it — the whole point of this being a real readyTimeout.
      expect(attempt.elapsedMs).toBeGreaterThanOrEqual(configuredTimeout);
      expect(attempt.elapsedMs).toBeLessThan(configuredTimeout + 5000);
    }
  });

  it('candidate (b) — the sshd fixture container-internal bridge IP, unpublished — fails on this host (recorded but rejected; see ADR for the CI-portability concern)', async () => {
    fixture = await startSshd({ ubuntu: '24.04' });
    const [networkName] = fixture.container.getNetworkNames();
    const internalIp = fixture.container.getIpAddress(networkName as string);

    const attempt = await attemptConnect({
      host: internalIp,
      port: 22,
      username: 'irrelevant',
      password: 'irrelevant',
      readyTimeout: 2000,
      hostVerifier: () => true,
    });

    // Only "this candidate fails somehow" is asserted — the ADR records the exact shape measured
    // on this machine and explains why it is not portable to every CI environment.
    expect(attempt.ok).toBe(false);
  });

  it('candidate (c) — 10.255.255.1 — fails on this host (recorded but rejected; see ADR for the CI-portability concern)', async () => {
    const attempt = await attemptConnect({
      host: '10.255.255.1',
      port: 22,
      username: 'irrelevant',
      password: 'irrelevant',
      readyTimeout: 2000,
      hostVerifier: () => true,
    });

    expect(attempt.ok).toBe(false);
  });
});

describe('Task 3: ssh2 error-shape table (SERV-07, A5)', () => {
  let fixture: SshdFixture | undefined;

  afterEach(async () => {
    await fixture?.stop();
    fixture = undefined;
    await assertNoStrayTestContainers();
  });

  it('wrong password against pwuser -> level client-authentication, "All configured authentication methods failed"', async () => {
    fixture = await startSshd({ ubuntu: '24.04' });

    const attempt = await attemptConnect({
      host: fixture.host,
      port: fixture.port,
      username: 'pwuser',
      password: 'definitely-wrong',
      readyTimeout: 5000,
      hostVerifier: () => true,
    });

    expect(attempt.ok).toBe(false);
    if (!attempt.ok) {
      expect(attempt.err.level).toBe('client-authentication');
      expect(attempt.err.message).toBe('All configured authentication methods failed');
    }
  });

  it('a valid-but-unauthorized key against deployer -> the same client-authentication shape', async () => {
    fixture = await startSshd({ ubuntu: '24.04' });
    const key = await readTestKey(fixture, 'ed25519_unauthorized');

    const attempt = await attemptConnect({
      host: fixture.host,
      port: fixture.port,
      username: 'deployer',
      privateKey: key,
      readyTimeout: 5000,
      hostVerifier: () => true,
    });

    expect(attempt.ok).toBe(false);
    if (!attempt.ok) {
      expect(attempt.err.level).toBe('client-authentication');
      expect(attempt.err.message).toBe('All configured authentication methods failed');
    }
  });

  it('a correct key against a nonexistent username -> the same client-authentication shape', async () => {
    fixture = await startSshd({ ubuntu: '24.04' });
    const key = await readTestKey(fixture, 'ed25519');

    const attempt = await attemptConnect({
      host: fixture.host,
      port: fixture.port,
      username: 'nonexistentuser',
      privateKey: key,
      readyTimeout: 5000,
      hostVerifier: () => true,
    });

    expect(attempt.ok).toBe(false);
    if (!attempt.ok) {
      expect(attempt.err.level).toBe('client-authentication');
      expect(attempt.err.message).toBe('All configured authentication methods failed');
    }
  });

  it('a hostname under the .invalid TLD fails with one of the two resolver-dependent shapes ADR 0004 row 4 documents: readyTimeout (client-timeout) or fast DNS failure (client-socket ENOTFOUND/EAI_AGAIN)', async () => {
    // ADR 0004 measured `client-timeout` on the spike machine, but the same lookup fails fast
    // with `client-socket` + ENOTFOUND/EAI_AGAIN on other resolvers (observed on this machine
    // during 02-08). Both shapes are real, both are classified (CONNECT_TIMEOUT vs
    // HOST_UNRESOLVED), so the contract under test is the union, never one resolver's whim.
    const configuredTimeout = 5000;

    const attempt = await attemptConnect({
      host: 'noodara-test-nonexistent.invalid',
      port: 22,
      username: 'irrelevant',
      password: 'irrelevant',
      readyTimeout: configuredTimeout,
      hostVerifier: () => true,
    });

    expect(attempt.ok).toBe(false);
    if (!attempt.ok) {
      expect(['client-timeout', 'client-socket']).toContain(attempt.err.level);
      if (attempt.err.level === 'client-timeout') {
        expect(attempt.elapsedMs).toBeGreaterThanOrEqual(configuredTimeout);
        expect(attempt.elapsedMs).toBeLessThan(configuredTimeout + 5000);
      } else {
        expect(['ENOTFOUND', 'EAI_AGAIN']).toContain(attempt.err.code);
        expect(attempt.elapsedMs).toBeLessThan(configuredTimeout);
      }
    }
  });

  it('the host/port of a stopped container is refused -> level client-socket, code ECONNREFUSED', async () => {
    fixture = await startSshd({ ubuntu: '24.04' });
    const { host, port } = fixture;
    await fixture.stop();
    fixture = undefined;

    const attempt = await attemptConnect({
      host,
      port,
      username: 'irrelevant',
      password: 'irrelevant',
      readyTimeout: 5000,
      hostVerifier: () => true,
    });

    expect(attempt.ok).toBe(false);
    if (!attempt.ok) {
      expect(attempt.err.level).toBe('client-socket');
      expect(attempt.err.code).toBe('ECONNREFUSED');
    }
  });

  it('a pinned fingerprint mismatch (hostVerifier returns false) -> level handshake, "Host denied (verification failed)"', async () => {
    fixture = await startSshd({ ubuntu: '24.04' });
    const key = await readTestKey(fixture, 'ed25519');

    const attempt = await attemptConnect({
      host: fixture.host,
      port: fixture.port,
      username: 'deployer',
      privateKey: key,
      readyTimeout: 5000,
      hostVerifier: () => false,
    });

    expect(attempt.ok).toBe(false);
    if (!attempt.ok) {
      expect(attempt.err.level).toBe('handshake');
      expect(attempt.err.message).toBe('Host denied (verification failed)');
      expect(attempt.err.fatal).toBe(true);
    }
  });
});

describe.each(UBUNTU_VERSIONS)(
  'Task 3: mid-exec transport death, no error event ever fires (Ubuntu %s)',
  (ubuntu) => {
    afterEach(async () => {
      await assertNoStrayTestContainers();
    });

    it('a channel with an exec in flight closes with no exit code and no error event when the transport dies mid-command', async () => {
      const fixture = await startSshd({ ubuntu, slowDf: true });
      const key = await readTestKey(fixture, 'ed25519');

      const connectResult = await attemptConnect({
        host: fixture.host,
        port: fixture.port,
        username: 'deployer',
        privateKey: key,
        readyTimeout: 5000,
        hostVerifier: () => true,
      });
      expect(connectResult.ok).toBe(true);
      if (!connectResult.ok) return;
      const client = connectResult.client;

      const channel = await new Promise<ClientChannel>((resolve, reject) => {
        client.exec(commandFor('discovery.disk'), (err: Error | undefined, stream: ClientChannel) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(stream);
        });
      });

      let clientErrored = false;
      let channelErrored = false;
      let clientEnded = false;
      let clientClosed = false;
      let channelEnded = false;
      let channelCloseArgs: unknown[] = [];

      client.on('error', () => {
        clientErrored = true;
      });
      client.on('end', () => {
        clientEnded = true;
      });
      client.on('close', () => {
        clientClosed = true;
      });
      channel.on('error', () => {
        channelErrored = true;
      });
      channel.on('end', () => {
        channelEnded = true;
      });
      const channelClosed = new Promise<void>((resolve) => {
        channel.once('close', (...args: unknown[]) => {
          channelCloseArgs = args;
          resolve();
        });
      });
      // Measured, load-bearing (ADR Open Question 3): a `ClientChannel` is a paused-mode Duplex
      // until something consumes it — no 'data' listener and no `.resume()` means the internal
      // `push(null)` ssh2 issues on transport death never surfaces as 'end'/'close' at all, even
      // after waiting tens of seconds. The real adapter's `exec()` always attaches a `'data'`
      // listener to accumulate stdout (Pattern 2, 02-RESEARCH.md), so this is not a production
      // gap — but this spike must resume the streams itself or it measures nothing.
      channel.resume();
      channel.stderr.resume();

      // Awaiting this marker (built in plan 02-02) is what makes the kill deterministic: the
      // remote command is provably blocked with no output sent yet before the transport is cut.
      await waitForSlowCommandStart(fixture);
      await fixture.stop();

      // Bounded wait for the real event, not a fixed sleep before an assertion — this races the
      // measured graceful-close sequence against a generous ceiling so the test fails fast (with
      // a clear message) if a future ssh2 upgrade ever starts raising an error here instead.
      await Promise.race([
        channelClosed,
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error('timed out waiting for channel close'));
          }, 10_000);
        }),
      ]);

      // The core measured fact (ADR Open Question 3): no 'error' event fires anywhere.
      expect(clientErrored).toBe(false);
      expect(channelErrored).toBe(false);
      expect(clientEnded).toBe(true);
      expect(clientClosed).toBe(true);
      expect(channelEnded).toBe(true);
      // No exit code, no signal — every argument 'close' received is undefined.
      expect(channelCloseArgs.every((arg) => arg === undefined)).toBe(true);
    });
  },
);
