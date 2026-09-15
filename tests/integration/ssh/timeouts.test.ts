// QA-03 §6.5 scenarios (Task 2 of 4): network timeout and command timeout — proven through
// `@noodara/ssh`'s public surface only, against a real blackhole TCP listener and real Ubuntu
// 22.04/24.04 sshd containers. This is the ADR 0004 CONNECT_TIMEOUT strategy in production use,
// not a re-measurement of it (that lives in `contracts.test.ts`).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRedactor, secretValue } from '@noodara/domain/security';
import { createSsh2Adapter, type SshTimeouts } from '@noodara/ssh';
import {
  assertNoStrayTestContainers,
  readTestKey,
  startBlackholeListener,
  startSshd,
  type BlackholeListener,
  type SshdFixture,
  type UbuntuVersion,
} from '../helpers/ssh.js';

const UBUNTU_VERSIONS = ['22.04', '24.04'] as const satisfies readonly UbuntuVersion[];
const NORMAL_TIMEOUTS: SshTimeouts = { connectMs: 20_000, commandMs: 30_000, discoveryMs: 60_000 };

// SERV-07's "never crashes the API" is only genuinely proven by observing that nothing escapes
// as an unhandled rejection — every scenario below awaits or `.rejects`-asserts its promise, and
// this listener is the independent witness that nothing slipped past that.
const recordedUnhandledRejections: unknown[] = [];
function onUnhandledRejection(reason: unknown): void {
  recordedUnhandledRejections.push(reason);
}

beforeAll(() => {
  process.on('unhandledRejection', onUnhandledRejection);
});

let fixture: SshdFixture | undefined;
let blackhole: BlackholeListener | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;
  await blackhole?.stop();
  blackhole = undefined;

  await assertNoStrayTestContainers();

  expect(recordedUnhandledRejections).toEqual([]);
});

describe('network timeout (D-08, D-10)', () => {
  it('a silent peer (blackhole listener) yields CONNECT_TIMEOUT, retried once, attempts: 2', async () => {
    blackhole = await startBlackholeListener();
    const adapter = createSsh2Adapter();

    const outcome = await adapter.connect({
      target: { host: blackhole.host, port: blackhole.port, user: 'irrelevant' },
      credential: { kind: 'password', password: secretValue('irrelevant', 'ssh_password') },
      timeouts: { connectMs: 1_500, commandMs: 30_000, discoveryMs: 60_000 },
      trustedFingerprint: null,
      redactor: createRedactor(),
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorCode).toBe('CONNECT_TIMEOUT');
      // D-10: CONNECT_TIMEOUT is one of exactly two retryable codes — a second attempt runs
      // after a fixed 2s wait, so `attempts` is 2, not 1.
      expect(outcome.attempts).toBe(2);
    }
  });

  it('a real auth failure is never retried — attempts: 1 (the retry is code-scoped, not universal)', async () => {
    fixture = await startSshd({ ubuntu: '24.04' });
    const adapter = createSsh2Adapter();

    const outcome = await adapter.connect({
      target: { host: fixture.host, port: fixture.port, user: 'pwuser' },
      credential: { kind: 'password', password: secretValue('definitely-wrong', 'ssh_password') },
      timeouts: NORMAL_TIMEOUTS,
      trustedFingerprint: null,
      redactor: createRedactor(),
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorCode).toBe('AUTH_FAILED');
      expect(outcome.attempts).toBe(1);
    }
  });
});

describe.each(UBUNTU_VERSIONS)('command timeout (Ubuntu %s)', (ubuntu) => {
  it('a 1ms command budget yields COMMAND_TIMEOUT without destroying the underlying connection', async () => {
    fixture = await startSshd({ ubuntu });
    const key = await readTestKey(fixture, 'ed25519');
    const adapter = createSsh2Adapter();

    // `SshTimeouts.commandMs` is bound once per `connect()` call and applies to every `exec()`
    // on the resulting session (packages/ssh/src/ssh2-adapter.ts's `makeSession` closes over a
    // single `commandMs`) — there is no per-call override. A 1ms budget cannot be met by any
    // real round trip over a real TCP connection, which is exactly what makes this deterministic
    // without a remote `sleep` and without adding a command outside the frozen allowlist.
    const tightTimeouts: SshTimeouts = { connectMs: 10_000, commandMs: 1, discoveryMs: 60_000 };

    const outcome = await adapter.connect({
      target: { host: fixture.host, port: fixture.port, user: 'deployer' },
      credential: { kind: 'private_key', privateKey: secretValue(key, 'ssh_private_key') },
      timeouts: tightTimeouts,
      trustedFingerprint: null,
      redactor: createRedactor(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    await expect(outcome.session.exec('discovery.hostname')).rejects.toMatchObject({
      errorCode: 'COMMAND_TIMEOUT',
    });

    // Proves "the timeout destroyed the channel, not the connection": a second `exec` on the
    // very same session — still bound by the same 1ms budget, since it cannot be raised
    // per-call — also fails with its own independent COMMAND_TIMEOUT rather than
    // CONNECTION_LOST. If the first timeout had killed the transport, this second command would
    // instead observe a dead socket (CONNECTION_LOST), not a fresh per-command timeout.
    await expect(outcome.session.exec('discovery.hostname')).rejects.toMatchObject({
      errorCode: 'COMMAND_TIMEOUT',
    });

    // The transport (and the server) are still healthy: a fresh connection to the same fixture,
    // with a normal command budget, succeeds and its command completes normally.
    const secondOutcome = await adapter.connect({
      target: { host: fixture.host, port: fixture.port, user: 'deployer' },
      credential: { kind: 'private_key', privateKey: secretValue(key, 'ssh_private_key') },
      timeouts: NORMAL_TIMEOUTS,
      trustedFingerprint: null,
      redactor: createRedactor(),
    });
    expect(secondOutcome.ok).toBe(true);
    if (secondOutcome.ok) {
      const result = await secondOutcome.session.exec('discovery.hostname');
      expect(result.exitCode).toBe(0);
      await secondOutcome.session.close();
    }

    await expect(outcome.session.close()).resolves.toBeUndefined();
  });
});
