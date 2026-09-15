// Roadmap §6.7's "100 conexiones exitosas consecutivas en suite automatizada" criterion (QA-03).
// Opt-in and gated by the NOODARA_STRESS environment flag — deliberately excluded from the
// PR-blocking path (`.planning/phases/02-adaptador-ssh-aislado-y-probado-con-testcontainers/
// 02-VALIDATION.md`'s "Manual-Only Verifications" table records why). It belongs to the v0.1
// release gate and to a future nightly run (phase 6 scope) — no nightly workflow is added here.
//
// Run it explicitly with:
//   NOODARA_STRESS=1 pnpm exec vitest run --config vitest.integration.config.ts tests/integration/ssh/stress-connections.test.ts
//
// Without the flag, this whole suite reports as skipped (not silently absent) so `pnpm
// test:integration`'s summary still shows it exists.
import { afterEach, describe, expect, it } from 'vitest';
import { createRedactor, secretValue } from '@noodara/domain/security';
import { createSsh2Adapter, type SshTimeouts } from '@noodara/ssh';
import { assertNoStrayTestContainers, readTestKey, startSshd, type SshdFixture } from '../helpers/ssh.js';

const TIMEOUTS: SshTimeouts = { connectMs: 20_000, commandMs: 30_000, discoveryMs: 60_000 };
const CONNECTION_CYCLES = 100;
const STRESS_ENABLED = process.env['NOODARA_STRESS'] === '1' || process.env['NOODARA_STRESS'] === 'true';

let fixture: SshdFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  await assertNoStrayTestContainers();
});

describe.skipIf(!STRESS_ENABLED)('§6.7 stress: 100 consecutive successful connections', () => {
  it(
    `connects and closes cleanly ${String(CONNECTION_CYCLES)} times in a row against one container, attempts: 1 and an identical fingerprint every time`,
    async () => {
      fixture = await startSshd({ ubuntu: '24.04' });
      const key = await readTestKey(fixture, 'ed25519');
      const adapter = createSsh2Adapter();

      let firstFingerprint: string | undefined;

      for (let cycle = 0; cycle < CONNECTION_CYCLES; cycle += 1) {
        const outcome = await adapter.connect({
          target: { host: fixture.host, port: fixture.port, user: 'deployer' },
          credential: { kind: 'private_key', privateKey: secretValue(key, 'ssh_private_key') },
          timeouts: TIMEOUTS,
          trustedFingerprint: null,
          redactor: createRedactor(),
        });

        expect(outcome.ok, `connection cycle ${String(cycle)} did not succeed`).toBe(true);
        if (!outcome.ok) break;
        expect(outcome.attempts).toBe(1);

        if (firstFingerprint === undefined) {
          firstFingerprint = outcome.fingerprint.fingerprint;
        } else {
          expect(outcome.fingerprint.fingerprint).toBe(firstFingerprint);
        }

        await outcome.session.close();
      }
    },
    10 * 60 * 1000,
  );
});
