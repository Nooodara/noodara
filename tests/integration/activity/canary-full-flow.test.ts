import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createSsh2Adapter, formatFingerprint, parseFingerprint } from '@noodara/ssh';
import {
  activityEvents,
  credentials,
  discoverySnapshots,
  servers,
} from '../../../apps/control-plane/src/db/schema/index.js';
import {
  assertNoStrayTestContainers,
  readTestKey,
  startSshd,
  type SshdFixture,
} from '../helpers/ssh.js';
import { startServiceFixture, type ServiceFixture } from '../services/helpers/service-fixture.js';

// SEC-02's evidence (D-18): the full-flow leak scan `noodara-security` skill §9 describes, driven
// against a real Ubuntu sshd Testcontainer rather than a fake `SshPort`. This suite deliberately
// walks the same path a real admin's browser click would take — an encrypted `credentials` row,
// decrypted through `credential-store.ts`, handed to a real `createSsh2Adapter()` connection, with
// its outputs persisted through real application services (`createServerServices`) — never a
// stand-in or a double for any one of those steps. `tests/integration/activity/canary.test.ts`
// stays the fast, container-free Phase-1 subset of this same scan; this file is the second half
// `pnpm security:scan-leaks` names (Task 2 of this plan widens that script to run both).
//
// Every dynamic import below happens only after `startServiceFixture()` has already written a
// valid test environment to `process.env` — `env.ts`/`logger.ts`/`activity/redaction.ts` all
// transitively fail-fast at *import time* (INST-06), matching every other suite in this phase.
//
// A failure here is a security defect, not a flake: no retried assertion, no softened substring
// check, no skipped case.

let fixture: ServiceFixture | undefined;
let sshdFixture: SshdFixture | undefined;

afterEach(async () => {
  await sshdFixture?.stop();
  sshdFixture = undefined;
  await fixture?.stop();
  fixture = undefined;

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  await assertNoStrayTestContainers();
});

const SYSTEM = { type: 'system' as const };
const SERVER_NAME = 'sec-02-full-flow-canary';

function asRecord(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

describe('D-18 full-flow canary: a real register -> connect+discover -> edit -> host-key-change -> trust -> connect -> delete flow leaks no secret', () => {
  it('proves the password canary, the private-key canary, its passphrase and the master key never reach the logger, a service result, activity_events.metadata, discovery_snapshots.payload or a simulated service error', async () => {
    fixture = await startServiceFixture();
    sshdFixture = await startSshd({ ubuntu: '24.04' });
    fixture.setSshPort(createSsh2Adapter());

    const { createServerServices } =
      await import('../../../apps/control-plane/src/services/server-services.js');
    const { appRedactor, toLogSafe } =
      await import('../../../apps/control-plane/src/activity/redaction.js');
    const { createLogger, writableForTests } =
      await import('../../../apps/control-plane/src/logger.js');
    const { env } = await import('../../../apps/control-plane/src/env.js');

    // Per-run canary values only — never a committed literal (D-18). `sshdFixture.password`
    // authenticates the fixture's password-only account (`pwuser`); the locked ed25519 key plus
    // its passphrase authenticate the fixture's key-only accounts (`root`/`deployer`).
    const passwordCanary = sshdFixture.password;
    const privateKeyCanary = await readTestKey(sshdFixture, 'ed25519_locked');
    const keyPassphraseCanary = sshdFixture.keyPassphrase;
    const masterKeyValue = env.NOODARA_MASTER_KEY;

    appRedactor.register(passwordCanary, 'ssh_password');
    appRedactor.register(privateKeyCanary, 'ssh_private_key');
    appRedactor.register(keyPassphraseCanary, 'ssh_private_key');

    const { stream, records } = writableForTests();
    const logger = createLogger({ level: 'info', destination: stream });
    const serviceResults: unknown[] = [];

    async function recordStep(label: string, result: unknown, serverId?: string): Promise<void> {
      serviceResults.push(result);
      logger.info({ step: label, result });
      if (serverId === undefined) return;
      const [rawServer] = await fixture!.db.select().from(servers).where(eq(servers.id, serverId));
      if (rawServer === undefined) return;
      logger.info({ step: label, rawServer: toLogSafe(asRecord(rawServer)) });
      const [rawCredential] = await fixture!.db
        .select()
        .from(credentials)
        .where(eq(credentials.id, rawServer.credentialId));
      if (rawCredential !== undefined) {
        logger.info({ step: label, rawCredential: toLogSafe(asRecord(rawCredential)) });
      }
    }

    try {
      const services = createServerServices(fixture.deps);

      // Step 1: register with the container's password-only account.
      const registerResult = await services.registerServer({
        actor: SYSTEM,
        name: SERVER_NAME,
        host: sshdFixture.host,
        sshPort: sshdFixture.port,
        sshUser: 'pwuser',
        credential: { kind: 'password', password: passwordCanary },
      });
      if (!registerResult.ok) {
        throw new Error(
          `registerServer failed unexpectedly: ${registerResult.code} ${registerResult.message}`,
        );
      }
      const serverId = registerResult.server.id;
      await recordStep('register', registerResult, serverId);

      // Step 2: connect + discover for real, over the password credential.
      const connectResult1 = await services.connectAndDiscover({ actor: SYSTEM, serverId });
      if (!connectResult1.ok) {
        throw new Error(`connectAndDiscover (step 2) returned ${connectResult1.code}`);
      }
      expect(connectResult1.connection.ok).toBe(true);
      expect(connectResult1.discovery).toBeDefined();
      await recordStep('connect-1', connectResult1, serverId);

      // Step 3: edit — replace the credential with the locked private key, and move the account
      // to the container's key-only user in the same edit (D-13/D-14 access change): the
      // fixture's password-only account never receives an authorized key, so a later connect
      // with the key credential can only succeed against `deployer`.
      const editResult = await services.editServer({
        actor: SYSTEM,
        serverId,
        sshUser: 'deployer',
        credential: {
          kind: 'private_key',
          privateKey: privateKeyCanary,
          passphrase: keyPassphraseCanary,
        },
      });
      if (!editResult.ok) {
        throw new Error(`editServer failed unexpectedly: ${editResult.code} ${editResult.message}`);
      }
      await recordStep('edit', editResult, serverId);

      // Step 4: force a host-key change without a second container — overwrite the stored
      // fingerprint with a syntactically valid but different value (a direct row UPDATE, not a
      // service call, mirroring plan 03-08's own `patchServerRow` arrangement helper), then
      // connect again with the now-current key credential.
      const [rowBeforeHostKeyChange] = await fixture.db
        .select()
        .from(servers)
        .where(eq(servers.id, serverId));
      if (
        rowBeforeHostKeyChange?.hostFingerprint === null ||
        rowBeforeHostKeyChange === undefined
      ) {
        throw new Error('expected a host fingerprint captured by step 2');
      }
      const trustedFingerprint = parseFingerprint(rowBeforeHostKeyChange.hostFingerprint);
      const corruptedFingerprint = formatFingerprint({
        keyType: trustedFingerprint.keyType,
        fingerprint: `SHA256:${'Z'.repeat(43)}`,
      });
      await fixture.db
        .update(servers)
        .set({ hostFingerprint: corruptedFingerprint })
        .where(eq(servers.id, serverId));

      const connectResult2 = await services.connectAndDiscover({ actor: SYSTEM, serverId });
      if (!connectResult2.ok) {
        throw new Error(`connectAndDiscover (step 4) returned ${connectResult2.code}`);
      }
      expect(connectResult2.connection.ok).toBe(false);
      expect(connectResult2.connection.errorCode).toBe('HOST_KEY_CHANGED');
      await recordStep('connect-2-host-key-changed', connectResult2, serverId);

      const [rowAfterHostKeyChange] = await fixture.db
        .select()
        .from(servers)
        .where(eq(servers.id, serverId));
      expect(rowAfterHostKeyChange?.pendingFingerprint).not.toBeNull();
      const pendingFingerprintToTrust = rowAfterHostKeyChange?.pendingFingerprint;
      if (pendingFingerprintToTrust === undefined || pendingFingerprintToTrust === null) {
        throw new Error('expected a pending fingerprint to trust');
      }

      // Step 5: trust the newly observed fingerprint.
      const trustResult = await services.trustFingerprint({
        actor: SYSTEM,
        serverId,
        fingerprint: pendingFingerprintToTrust,
      });
      if (!trustResult.ok) {
        throw new Error(
          `trustFingerprint failed unexpectedly: ${trustResult.code} ${trustResult.message}`,
        );
      }
      await recordStep('trust-fingerprint', trustResult, serverId);

      // Step 6: connect once more with the same key credential — now against the trusted
      // fingerprint, so this attempt reaches discovery again.
      const connectResult3 = await services.connectAndDiscover({ actor: SYSTEM, serverId });
      if (!connectResult3.ok) {
        throw new Error(`connectAndDiscover (step 6) returned ${connectResult3.code}`);
      }
      expect(connectResult3.connection.ok).toBe(true);
      if (connectResult3.discovery === undefined) {
        throw new Error('expected step 6 to reach discovery');
      }
      await recordStep('connect-3', connectResult3, serverId);

      // DISC-03: exactly two discovery_snapshots rows exist before deletion — one per connect
      // attempt that actually reached discovery (steps 2 and 6). Step 4's attempt fails at the
      // SSH-connect phase (HOST_KEY_CHANGED) and never reaches discovery at all, so it inserts
      // no snapshot; `connectAndDiscover` only ever writes a snapshot on the branch where a
      // `DiscoverySnapshot` was actually produced.
      const snapshotRowsBeforeDelete = await fixture.db
        .select()
        .from(discoverySnapshots)
        .where(eq(discoverySnapshots.serverId, serverId));
      expect(snapshotRowsBeforeDelete).toHaveLength(2);
      const snapshotsOutput = JSON.stringify(snapshotRowsBeforeDelete);

      // The denormalized `servers` facts columns match the last snapshot's own collected facts.
      const [serverRowBeforeDelete] = await fixture.db
        .select()
        .from(servers)
        .where(eq(servers.id, serverId));
      if (serverRowBeforeDelete === undefined) {
        throw new Error('expected the server row to still exist before deletion');
      }
      const [lastSnapshotRow] = await fixture.db
        .select()
        .from(discoverySnapshots)
        .where(eq(discoverySnapshots.id, connectResult3.discovery.snapshotId));
      if (lastSnapshotRow === undefined) {
        throw new Error('expected the last discovery snapshot row to exist');
      }
      const lastFacts = (lastSnapshotRow.payload as { facts: Record<string, unknown> }).facts;
      expect(serverRowBeforeDelete.hostname).not.toBeNull();
      expect(serverRowBeforeDelete.osDistribution).not.toBeNull();
      expect(serverRowBeforeDelete.arch).not.toBeNull();
      expect(serverRowBeforeDelete.dockerInstalled).not.toBeNull();
      expect(serverRowBeforeDelete.hostname).toBe(lastFacts.hostname);
      expect(serverRowBeforeDelete.osDistribution).toBe(lastFacts.osDistribution);
      expect(serverRowBeforeDelete.arch).toBe(lastFacts.arch);
      expect(serverRowBeforeDelete.dockerInstalled).toBe(lastFacts.dockerInstalled);

      // Capture (e): a simulated service error whose message embeds every canary, redacted
      // through `appRedactor.redact` exactly as phase 4's future error handler must. Every real
      // connect attempt above already released its own momentarily-revealed raw values from this
      // same shared `appRedactor` the moment its session closed (WR-02) — the private-key
      // canary's full PEM text is still caught unconditionally by the redactor's structural
      // `BEGIN ... PRIVATE KEY` pattern, but the opaque password/passphrase canaries are not
      // structural, so they are re-registered here for this capture to be a meaningful test of
      // the pattern phase 4 will actually follow, not an artifact of stale registration state.
      appRedactor.register(passwordCanary, 'ssh_password');
      appRedactor.register(privateKeyCanary, 'ssh_private_key');
      appRedactor.register(keyPassphraseCanary, 'ssh_private_key');
      let simulatedErrorOutput: string;
      try {
        throw new Error(
          `ssh operation failed for password=${passwordCanary} key=${privateKeyCanary} ` +
            `passphrase=${keyPassphraseCanary} masterKey=${masterKeyValue}`,
        );
      } catch (error) {
        simulatedErrorOutput = appRedactor.redact((error as Error).message);
      }

      // Step 7: delete, confirming with the server's exact name.
      const deleteResult = await services.deleteServer({
        actor: SYSTEM,
        serverId,
        confirmName: SERVER_NAME,
      });
      if (!deleteResult.ok) {
        throw new Error(
          `deleteServer failed unexpectedly: ${deleteResult.code} ${deleteResult.message}`,
        );
      }
      await recordStep('delete', deleteResult);

      const snapshotRowsAfterDelete = await fixture.db
        .select()
        .from(discoverySnapshots)
        .where(eq(discoverySnapshots.serverId, serverId));
      expect(snapshotRowsAfterDelete).toHaveLength(0);

      // Capture (c): activity_events.metadata survives deletion (no FK cascade from `servers`),
      // so this is read after every step above, including the delete itself.
      const metadataRows = await fixture.db
        .select({ metadata: activityEvents.metadata })
        .from(activityEvents)
        .where(eq(activityEvents.entityId, serverId));
      expect(metadataRows.length).toBeGreaterThan(0);
      const metadataOutput = JSON.stringify(metadataRows);

      // Capture (a): every log line pino actually wrote — service results plus the raw
      // `servers`/`credentials` rows, each passed through `toLogSafe` (noodara-security §3/§8).
      const logOutput = JSON.stringify(records());
      // Capture (b): every service result collected along the way.
      const resultsOutput = JSON.stringify(serviceResults);

      for (const captured of [
        logOutput,
        resultsOutput,
        metadataOutput,
        snapshotsOutput,
        simulatedErrorOutput,
      ]) {
        expect(captured).not.toContain(passwordCanary);
        expect(captured).not.toContain(privateKeyCanary);
        expect(captured).not.toContain('BEGIN OPENSSH PRIVATE KEY');
        expect(captured).not.toContain(keyPassphraseCanary);
        expect(captured).not.toContain(masterKeyValue);
      }
    } finally {
      appRedactor.release(passwordCanary);
      appRedactor.release(privateKeyCanary);
      appRedactor.release(keyPassphraseCanary);
    }
  });
});
