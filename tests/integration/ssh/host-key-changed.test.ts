// QA-03 §6.5 TOFU/HOST_KEY_CHANGED scenario (Task 1 of 4, SEC-03). Two real, sequential sshd
// containers on the same fixed host:port (fresh host keys per plan 02-02's entrypoint) prove the
// whole TOFU lifecycle: capture on first connect, rejection of a changed key, and — the negative
// case that makes the rejection meaningful — that the new key works once it is the one pinned.
// `fileParallelism: false` (vitest.integration.config.ts) is what makes a fixed host port safe
// here: exactly one test file runs at a time in this suite, so nothing else can race this port.
import { afterEach, describe, expect, it } from 'vitest';
import { createRedactor, secretValue } from '@noodara/domain/security';
import { createSsh2Adapter, formatFingerprint, type SshTimeouts } from '@noodara/ssh';
import {
  assertNoStrayTestContainers,
  readTestKey,
  startSshd,
  type SshdFixture,
  type UbuntuVersion,
} from '../helpers/ssh.js';

const UBUNTU_VERSIONS = ['22.04', '24.04'] as const satisfies readonly UbuntuVersion[];
const TIMEOUTS: SshTimeouts = { connectMs: 20_000, commandMs: 30_000, discoveryMs: 60_000 };

// A high, unlikely port, fixed only because this scenario needs two successive containers
// reachable at the exact same host:port. Safe under `fileParallelism: false`.
const FIXED_HOST_PORT = 42_522;

let fixture: SshdFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  await assertNoStrayTestContainers();
});

describe.each(UBUNTU_VERSIONS)('TOFU and HOST_KEY_CHANGED (Ubuntu %s)', (ubuntu) => {
  it('captures on first connect, rejects a changed host key twice, and accepts the new key only once pinned (D-06/D-07)', async () => {
    const adapter = createSsh2Adapter();

    // --- First container: capture the fingerprint, then stop it. ---
    fixture = await startSshd({ ubuntu, hostPort: FIXED_HOST_PORT });
    const keyA = await readTestKey(fixture, 'ed25519');

    const first = await adapter.connect({
      target: { host: fixture.host, port: fixture.port, user: 'deployer' },
      credential: { kind: 'private_key', privateKey: secretValue(keyA, 'ssh_private_key') },
      timeouts: TIMEOUTS,
      trustedFingerprint: null,
      redactor: createRedactor(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const fingerprintA = first.fingerprint;
    await first.session.close();

    await fixture.stop();
    fixture = undefined;

    // --- Second container on the same fixed host:port: fresh host keys per-run (plan 02-02's
    //     entrypoint regenerates them on every start), so this is a genuinely different key. ---
    fixture = await startSshd({ ubuntu, hostPort: FIXED_HOST_PORT });
    const keyB = await readTestKey(fixture, 'ed25519');

    const mismatch = await adapter.connect({
      target: { host: fixture.host, port: fixture.port, user: 'deployer' },
      credential: { kind: 'private_key', privateKey: secretValue(keyB, 'ssh_private_key') },
      timeouts: TIMEOUTS,
      trustedFingerprint: fingerprintA,
      redactor: createRedactor(),
    });

    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) return;
    expect(mismatch.errorCode).toBe('HOST_KEY_CHANGED');
    expect(mismatch.attempts).toBe(1);
    expect(mismatch.observedFingerprint).toBeDefined();
    const fingerprintB = mismatch.observedFingerprint;
    if (fingerprintB === undefined) return;
    expect(fingerprintB).not.toEqual(fingerprintA);
    // D-06: the message carries both fingerprints, with their key types, verbatim.
    expect(mismatch.message).toContain(formatFingerprint(fingerprintA));
    expect(mismatch.message).toContain(formatFingerprint(fingerprintB));

    // --- Negative case: without this, a verifier that rejects everything would also pass the
    //     assertions above. Pinning B's own (new) fingerprint must succeed. ---
    const success = await adapter.connect({
      target: { host: fixture.host, port: fixture.port, user: 'deployer' },
      credential: { kind: 'private_key', privateKey: secretValue(keyB, 'ssh_private_key') },
      timeouts: TIMEOUTS,
      trustedFingerprint: fingerprintB,
      redactor: createRedactor(),
    });
    expect(success.ok).toBe(true);
    if (success.ok) {
      expect(success.fingerprintCaptured).toBe(false);
      await success.session.close();
    }

    // --- D-07: nothing about the first mismatching attempt "remembers" and auto-accepts the new
    //     key — repeating the exact same mismatching connect (A's fingerprint still pinned)
    //     rejects again, identically. There is no way to proceed without an explicit re-pin. ---
    const mismatchAgain = await adapter.connect({
      target: { host: fixture.host, port: fixture.port, user: 'deployer' },
      credential: { kind: 'private_key', privateKey: secretValue(keyB, 'ssh_private_key') },
      timeouts: TIMEOUTS,
      trustedFingerprint: fingerprintA,
      redactor: createRedactor(),
    });
    expect(mismatchAgain.ok).toBe(false);
    if (!mismatchAgain.ok) {
      expect(mismatchAgain.errorCode).toBe('HOST_KEY_CHANGED');
      expect(mismatchAgain.observedFingerprint).toEqual(fingerprintB);
    }
  });
});
