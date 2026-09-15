// QA-03 §6.5 scenarios (Task 2 of 4): connection loss (both directions) and reconnect — proven
// through `@noodara/ssh`'s public surface only, against real Ubuntu 22.04/24.04 sshd containers.
// `SshSession.exec` is documented to be allowed to reject (unlike `SshPort.connect`, which never
// rejects/throws — see ssh-port.ts); SERV-07's "never crashes the API" is proven here not by a
// resolved-vs-rejected shape but by every rejection being awaited/asserted and by the
// `unhandledRejection` listener below recording nothing.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRedactor, secretValue } from '@noodara/domain/security';
import { createSsh2Adapter, type SshTimeouts } from '@noodara/ssh';
import {
  assertNoStrayTestContainers,
  readTestKey,
  startSshd,
  waitForSlowCommandStart,
  type SshdFixture,
  type UbuntuVersion,
} from '../helpers/ssh.js';

const UBUNTU_VERSIONS = ['22.04', '24.04'] as const satisfies readonly UbuntuVersion[];
const TIMEOUTS: SshTimeouts = { connectMs: 20_000, commandMs: 30_000, discoveryMs: 60_000 };

// A different fixed port than host-key-changed.test.ts's, so the two files' fixed-port scenarios
// can never collide even if test ordering changes. Safe under `fileParallelism: false`
// (vitest.integration.config.ts) — only one test file's tests run at a time.
const FIXED_HOST_PORT = 42_533;

const recordedUnhandledRejections: unknown[] = [];
function onUnhandledRejection(reason: unknown): void {
  recordedUnhandledRejections.push(reason);
}

beforeAll(() => {
  process.on('unhandledRejection', onUnhandledRejection);
});

beforeEach(() => {
  recordedUnhandledRejections.length = 0;
});

/**
 * Every scenario in this file that expects `session.exec()` to reject must attach a handler in
 * the very same synchronous tick the promise is created — never after an intervening `await`.
 * Node's `unhandledRejection` detection fires at the end of the microtask queue a promise
 * rejected in; if the caller waits (e.g. for `waitForSlowCommandStart`/`fixture.stop()`) before
 * ever touching the promise, the promise can genuinely reject while nothing is listening yet,
 * which is a real `unhandledRejection` even though the caller "gets to it" a moment later. Wrapping
 * immediately into an always-resolving `{ ok, value | error }` result is what a real caller
 * (phase 3/4) must also do for a fire-then-await-later `exec()` call, and it is what keeps this
 * file's own `unhandledRejection` listener honestly empty.
 */
function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

let fixture: SshdFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  await assertNoStrayTestContainers();

  expect(recordedUnhandledRejections).toEqual([]);
});

describe.each(UBUNTU_VERSIONS)('connection loss (Ubuntu %s)', (ubuntu) => {
  it('exec after the container is already stopped -> CONNECTION_LOST', async () => {
    fixture = await startSshd({ ubuntu });
    const key = await readTestKey(fixture, 'ed25519');
    const adapter = createSsh2Adapter();

    const outcome = await adapter.connect({
      target: { host: fixture.host, port: fixture.port, user: 'deployer' },
      credential: { kind: 'private_key', privateKey: secretValue(key, 'ssh_private_key') },
      timeouts: TIMEOUTS,
      trustedFingerprint: null,
      redactor: createRedactor(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // Deterministic by construction: the transport is provably gone (the container is stopped
    // and `fixture.stop()` has already resolved) before `exec` is ever called.
    await fixture.stop();
    fixture = undefined;

    const result = await settle(outcome.session.exec('discovery.hostname'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ errorCode: 'CONNECTION_LOST' });
    }
  });

  it('a command already in flight when the transport dies -> CONNECTION_LOST (the mid-exec branch of error-classifier.ts)', async () => {
    fixture = await startSshd({ ubuntu, slowDf: true });
    const key = await readTestKey(fixture, 'ed25519');
    const adapter = createSsh2Adapter();

    const outcome = await adapter.connect({
      target: { host: fixture.host, port: fixture.port, user: 'deployer' },
      credential: { kind: 'private_key', privateKey: secretValue(key, 'ssh_private_key') },
      timeouts: TIMEOUTS,
      trustedFingerprint: null,
      redactor: createRedactor(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // `discovery.disk` is unchanged (`df -P -k /`, still the frozen allowlist template) — the
    // `slowDf` fixture variant shadows only the remote `df` binary with a shim that signals it
    // started, then blocks for ~20s. Three things make the kill below deterministic rather than a
    // race: (1) the allowlisted command text never changes — the shim is a property of this test
    // image, not of the allowlist; (2) the kill is sequenced after an *observed* marker
    // (`waitForSlowCommandStart`), never after a fixed delay; (3) the shim blocks for ~20s, so the
    // kill lands with roughly nineteen seconds of margin. If the shim were somehow not in place,
    // the command would return real `df` output and the assertion below would fail loudly — this
    // cannot hang and cannot pass by accident.
    const settledExec = settle(outcome.session.exec('discovery.disk'));
    await waitForSlowCommandStart(fixture);
    await fixture.stop();
    fixture = undefined;

    const result = await settledExec;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ errorCode: 'CONNECTION_LOST' });
    }
  });
});

describe.each(UBUNTU_VERSIONS)('reconnect (Ubuntu %s)', (ubuntu) => {
  it('a clean close followed by a reconnect succeeds with the same fingerprint, fingerprintCaptured: false', async () => {
    const adapter = createSsh2Adapter();
    fixture = await startSshd({ ubuntu, hostPort: FIXED_HOST_PORT });
    const key = await readTestKey(fixture, 'ed25519');

    const first = await adapter.connect({
      target: { host: fixture.host, port: fixture.port, user: 'deployer' },
      credential: { kind: 'private_key', privateKey: secretValue(key, 'ssh_private_key') },
      timeouts: TIMEOUTS,
      trustedFingerprint: null,
      redactor: createRedactor(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.session.close();

    const second = await adapter.connect({
      target: { host: fixture.host, port: fixture.port, user: 'deployer' },
      credential: { kind: 'private_key', privateKey: secretValue(key, 'ssh_private_key') },
      timeouts: TIMEOUTS,
      trustedFingerprint: first.fingerprint,
      redactor: createRedactor(),
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.fingerprint).toEqual(first.fingerprint);
      expect(second.fingerprintCaptured).toBe(false);
      await second.session.close();
    }
  });

  it('a server that failed once is not permanently unusable (PITFALLS.md #8): connect succeeds again after a failed attempt against a stopped container', async () => {
    const adapter = createSsh2Adapter();
    fixture = await startSshd({ ubuntu, hostPort: FIXED_HOST_PORT });
    const { host: stoppedHost, port: stoppedPort } = fixture;
    await fixture.stop();
    fixture = undefined;

    const failedAttempt = await adapter.connect({
      target: { host: stoppedHost, port: stoppedPort, user: 'deployer' },
      credential: { kind: 'password', password: secretValue('irrelevant', 'ssh_password') },
      timeouts: { connectMs: 2_000, commandMs: 30_000, discoveryMs: 60_000 },
      trustedFingerprint: null,
      redactor: createRedactor(),
    });
    expect(failedAttempt.ok).toBe(false);

    fixture = await startSshd({ ubuntu, hostPort: FIXED_HOST_PORT });
    const key = await readTestKey(fixture, 'ed25519');

    const recovered = await adapter.connect({
      target: { host: fixture.host, port: fixture.port, user: 'deployer' },
      credential: { kind: 'private_key', privateKey: secretValue(key, 'ssh_private_key') },
      timeouts: TIMEOUTS,
      trustedFingerprint: null,
      redactor: createRedactor(),
    });
    expect(recovered.ok).toBe(true);
    if (recovered.ok) await recovered.session.close();
  });
});
