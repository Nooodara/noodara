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
import type { ConnectConfig } from '@noodara/ssh/testing';
import {
  assertNoStrayTestContainers,
  hostKeyFingerprint,
  readTestKey,
  startSshd,
  type SshdFixture,
} from '../helpers/ssh.js';

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
