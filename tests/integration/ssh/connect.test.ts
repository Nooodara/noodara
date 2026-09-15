// QA-03 §6.5 scenarios (Task 1 of 4): successful connection, invalid credentials, invalid host,
// safe command execution — proven through `@noodara/ssh`'s public surface only
// (`createSsh2Adapter`/`COMMAND_NAMES`/`formatFingerprint`), against real Ubuntu 22.04/24.04 sshd
// containers, never a mocked `ssh2.Client`. `packages/ssh/src/index.ts`'s internals
// (`execWithTimeout`, `createHostVerifier`, `loadPrivateKey`, `classifySshError`) are deliberately
// never imported here.
import { afterEach, describe, expect, it } from 'vitest';
import { createRedactor, secretValue } from '@noodara/domain/security';
import { COMMAND_NAMES, createSsh2Adapter, type SshSession, type SshTimeouts } from '@noodara/ssh';
import {
  assertNoStrayTestContainers,
  hostKeyFingerprint,
  readTestKey,
  startSshd,
  type SshdFixture,
  type TestKeyName,
  type UbuntuVersion,
} from '../helpers/ssh.js';

const UBUNTU_VERSIONS = ['22.04', '24.04'] as const satisfies readonly UbuntuVersion[];

const TIMEOUTS: SshTimeouts = { connectMs: 20_000, commandMs: 30_000, discoveryMs: 60_000 };

/** A short `connectMs` for the `.invalid`-host scenario only — the outcome is certain either
 *  way (a fast DNS failure or a bounded readyTimeout), so there is no reason to wait 10s for it. */
const SHORT_CONNECT_TIMEOUTS: SshTimeouts = { connectMs: 2_000, commandMs: 30_000, discoveryMs: 60_000 };

let fixture: SshdFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  await assertNoStrayTestContainers();
});

describe.each(UBUNTU_VERSIONS)('SSH connect scenarios (Ubuntu %s)', (ubuntu) => {
  describe('successful connection', () => {
    it.each(['ed25519', 'rsa3072', 'ecdsa'] as const satisfies readonly TestKeyName[])(
      'connects as deployer with a %s key and captures the host fingerprint',
      async (keyName) => {
        fixture = await startSshd({ ubuntu });
        const privateKey = await readTestKey(fixture, keyName);
        const adapter = createSsh2Adapter();

        const outcome = await adapter.connect({
          target: { host: fixture.host, port: fixture.port, user: 'deployer' },
          credential: { kind: 'private_key', privateKey: secretValue(privateKey, 'ssh_private_key') },
          timeouts: TIMEOUTS,
          trustedFingerprint: null,
          redactor: createRedactor(),
        });

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.fingerprintCaptured).toBe(true);
        expect(outcome.attempts).toBe(1);

        // The negotiated *host* key type is independent of `keyName`, which is the *client
        // authentication* key: `ssh2-adapter.ts` always sets `algorithms.serverHostKey` with
        // `ssh-ed25519` first (D-05, ADR 0004), and this fixture offers all three host key types,
        // so the host key negotiated here is always ed25519 regardless of which user-auth key
        // this subtest connects with.
        const keygenLine = await hostKeyFingerprint(fixture, 'ed25519');
        // D-04: the adapter's own SHA256 rendering must appear verbatim in ssh-keygen's own line
        // for the same host key — the independent oracle every fingerprint assertion compares
        // against.
        expect(keygenLine).toContain(outcome.fingerprint.fingerprint);

        await outcome.session.close();
      },
    );

    it('connects as deployer with the passphrase-protected ed25519_locked key (D-02)', async () => {
      fixture = await startSshd({ ubuntu });
      const privateKey = await readTestKey(fixture, 'ed25519_locked');
      const adapter = createSsh2Adapter();

      const outcome = await adapter.connect({
        target: { host: fixture.host, port: fixture.port, user: 'deployer' },
        credential: {
          kind: 'private_key',
          privateKey: secretValue(privateKey, 'ssh_private_key'),
          passphrase: secretValue(fixture.keyPassphrase, 'ssh_private_key'),
        },
        timeouts: TIMEOUTS,
        trustedFingerprint: null,
        redactor: createRedactor(),
      });

      expect(outcome.ok).toBe(true);
      if (outcome.ok) await outcome.session.close();
    });

    it('connects as pwuser via password/keyboard-interactive (D-03)', async () => {
      fixture = await startSshd({ ubuntu });
      const adapter = createSsh2Adapter();

      const outcome = await adapter.connect({
        target: { host: fixture.host, port: fixture.port, user: 'pwuser' },
        credential: { kind: 'password', password: secretValue(fixture.password, 'ssh_password') },
        timeouts: TIMEOUTS,
        trustedFingerprint: null,
        redactor: createRedactor(),
      });

      expect(outcome.ok).toBe(true);
      if (outcome.ok) await outcome.session.close();
    });
  });

  describe('invalid credentials', () => {
    it('a valid-but-unauthorized key against deployer -> AUTH_FAILED, attempts 1', async () => {
      fixture = await startSshd({ ubuntu });
      const key = await readTestKey(fixture, 'ed25519_unauthorized');
      const adapter = createSsh2Adapter();

      const outcome = await adapter.connect({
        target: { host: fixture.host, port: fixture.port, user: 'deployer' },
        credential: { kind: 'private_key', privateKey: secretValue(key, 'ssh_private_key') },
        timeouts: TIMEOUTS,
        trustedFingerprint: null,
        redactor: createRedactor(),
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.errorCode).toBe('AUTH_FAILED');
        expect(outcome.attempts).toBe(1);
      }
    });

    it('the correct key against a nonexistent username -> AUTH_FAILED, attempts 1', async () => {
      fixture = await startSshd({ ubuntu });
      const key = await readTestKey(fixture, 'ed25519');
      const adapter = createSsh2Adapter();

      const outcome = await adapter.connect({
        target: { host: fixture.host, port: fixture.port, user: 'nonexistentuser' },
        credential: { kind: 'private_key', privateKey: secretValue(key, 'ssh_private_key') },
        timeouts: TIMEOUTS,
        trustedFingerprint: null,
        redactor: createRedactor(),
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.errorCode).toBe('AUTH_FAILED');
        expect(outcome.attempts).toBe(1);
      }
    });

    it('pwuser with a wrong password -> AUTH_FAILED, attempts 1', async () => {
      fixture = await startSshd({ ubuntu });
      const adapter = createSsh2Adapter();

      const outcome = await adapter.connect({
        target: { host: fixture.host, port: fixture.port, user: 'pwuser' },
        credential: { kind: 'password', password: secretValue('definitely-wrong', 'ssh_password') },
        timeouts: TIMEOUTS,
        trustedFingerprint: null,
        redactor: createRedactor(),
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.errorCode).toBe('AUTH_FAILED');
        expect(outcome.attempts).toBe(1);
      }
    });

    it('ed25519_locked with a wrong passphrase -> AUTH_FAILED, attempts 1', async () => {
      fixture = await startSshd({ ubuntu });
      const privateKey = await readTestKey(fixture, 'ed25519_locked');
      const adapter = createSsh2Adapter();

      const outcome = await adapter.connect({
        target: { host: fixture.host, port: fixture.port, user: 'deployer' },
        credential: {
          kind: 'private_key',
          privateKey: secretValue(privateKey, 'ssh_private_key'),
          passphrase: secretValue('definitely-wrong-passphrase', 'ssh_private_key'),
        },
        timeouts: TIMEOUTS,
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

  describe('invalid host', () => {
    it('a hostname under the RFC 2606 .invalid TLD fails deterministically, resolver-dependent shape (ADR 0004 row 4)', async () => {
      const adapter = createSsh2Adapter();

      const outcome = await adapter.connect({
        target: { host: 'noodara-test-nonexistent.invalid', port: 22, user: 'irrelevant' },
        credential: { kind: 'password', password: secretValue('irrelevant', 'ssh_password') },
        timeouts: SHORT_CONNECT_TIMEOUTS,
        trustedFingerprint: null,
        redactor: createRedactor(),
      });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      // ADR 0004: this resolves fast (ENOTFOUND/EAI_AGAIN -> HOST_UNRESOLVED, never retried,
      // attempts: 1) on some resolvers and times out (-> CONNECT_TIMEOUT, retried once,
      // attempts: 2) on others — both are real, both are classified. Asserting the union, with
      // `attempts` pinned to whichever code actually occurred, is the honest contract here; a
      // single hardcoded shape would make this scenario flaky on a machine with a different
      // resolver, exactly the trap `docs/adr/0004-ssh-adapter-empirical-contracts.md`'s
      // "post-spike note" documents.
      expect(['HOST_UNRESOLVED', 'CONNECT_TIMEOUT']).toContain(outcome.errorCode);
      expect(outcome.attempts).toBe(outcome.errorCode === 'HOST_UNRESOLVED' ? 1 : 2);
    });
  });

  describe('safe command execution', () => {
    it('every allowlisted command returns an ExecResult with a defined exit code', async () => {
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

      for (const name of COMMAND_NAMES) {
        const result = await outcome.session.exec(name);
        expect(result.commandName).toBe(name);
        expect(typeof result.exitCode === 'number' || result.exitCode === null).toBe(true);
      }

      await outcome.session.close();
    });

    it('session.exec is typed over CommandName — an arbitrary command string is a compile error', () => {
      // A pure type-level check, deliberately never invoked at runtime: calling `exec` with a
      // string that isn't a `CommandName` (`'rm -rf /'` here) must not even compile. TypeScript
      // still type-checks a function body regardless of whether the function is ever called, so
      // `pnpm typecheck` — via `tests/integration/ssh/tsconfig.json` — catches a regression here
      // without this test ever needing a live container or session, and without ever actually
      // asking the adapter to run an unclassified string through a real shell. If the adapter's
      // `exec` signature ever widens `CommandName` to `string`, the `@ts-expect-error` below
      // itself becomes a compile error (an unused suppression), which is exactly the fail-loud
      // behaviour SEC-04 wants here.
      function attemptArbitraryCommand(session: SshSession): void {
        // @ts-expect-error -- 'rm -rf /' is not a CommandName; exec must reject an arbitrary string.
        session.exec('rm -rf /');
      }
      void attemptArbitraryCommand;

      expect(typeof attemptArbitraryCommand).toBe('function');
    });
  });
});
