// QA-03 §6.5 scenario (Task 3 of 4): full discovery, the SERV-08 access-check matrix, the D-12
// Docker variants, and the SEC-05 canary — proven through `@noodara/ssh`'s public surface
// (`createSsh2Adapter`/`runDiscovery`) against real Ubuntu 22.04/24.04 sshd containers, with every
// fact independently cross-checked against `container.exec` (never against the 02-04 fixtures the
// parsers were originally written from).
//
// DISC-04 boundary (recorded here rather than left implicit): this file cannot produce a
// genuinely non-Ubuntu server without adding a third fixture image outside 02-CONTEXT.md's
// fixture plan — the phase's supported targets are 22.04 and 24.04 only (roadmap §6.2). The
// `UNSUPPORTED_OS` warning path is proven at the layer that can produce it: plan 02-05's
// `parseOsRelease` unit tests (`packages/domain/src/discovery/os-release.test.ts`) and plan
// 02-09's `runDiscovery` warning test (`packages/ssh/src/run-discovery.test.ts`).
import { afterEach, describe, expect, it } from 'vitest';
import { createRedactor, secretValue } from '@noodara/domain/security';
import { DISCOVERY_CHECK_IDS } from '@noodara/domain/discovery';
import { createSsh2Adapter, runDiscovery, type SshTimeouts } from '@noodara/ssh';
import {
  assertNoStrayTestContainers,
  readTestKey,
  startSshd,
  type SshdFixture,
  type UbuntuVersion,
} from '../helpers/ssh.js';

const UBUNTU_VERSIONS = ['22.04', '24.04'] as const satisfies readonly UbuntuVersion[];
const TIMEOUTS: SshTimeouts = { connectMs: 20_000, commandMs: 30_000, discoveryMs: 60_000 };

let fixture: SshdFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  await assertNoStrayTestContainers();
});

describe.each(UBUNTU_VERSIONS)('full discovery (Ubuntu %s)', (ubuntu) => {
  it('every DISC-01 fact matches an independent container.exec oracle, and checks run in DISCOVERY_CHECK_IDS order', async () => {
    fixture = await startSshd({ ubuntu });
    const key = await readTestKey(fixture, 'ed25519');
    const adapter = createSsh2Adapter();
    const redactor = createRedactor();

    const outcome = await adapter.connect({
      target: { host: fixture.host, port: fixture.port, user: 'deployer' },
      credential: { kind: 'private_key', privateKey: secretValue(key, 'ssh_private_key') },
      timeouts: TIMEOUTS,
      trustedFingerprint: null,
      redactor,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const snapshot = await runDiscovery({
      session: outcome.session,
      sshUser: 'deployer',
      timeouts: { discoveryMs: TIMEOUTS.discoveryMs },
      redactor,
    });

    // --- Independent oracle: every value is re-derived from `container.exec`, never from the
    //     same code path `runDiscovery` used, and never from the 02-04 captured fixtures. ---
    const hostnameOracle = (await fixture.container.exec(['hostname'])).stdout.trim();
    expect(snapshot.facts.hostname).toBe(hostnameOracle);

    const osReleaseOracle = (await fixture.container.exec(['cat', '/etc/os-release'])).stdout;
    const nameMatch = /^NAME="?([^"\n]+)"?$/m.exec(osReleaseOracle);
    const versionIdMatch = /^VERSION_ID="?([^"\n]+)"?$/m.exec(osReleaseOracle);
    expect(nameMatch).not.toBeNull();
    expect(versionIdMatch).not.toBeNull();
    expect(snapshot.facts.osDistribution).toBe(nameMatch?.[1]);
    expect(snapshot.facts.osVersion).toBe(versionIdMatch?.[1]);

    const archOracle = (await fixture.container.exec(['uname', '-m'])).stdout.trim();
    expect(snapshot.facts.arch).toBe(archOracle);

    const cpuOracle = Number((await fixture.container.exec(['nproc'])).stdout.trim());
    expect(snapshot.facts.cpuCores).toBe(cpuOracle);

    const memInfoOracle = (await fixture.container.exec(['cat', '/proc/meminfo'])).stdout;
    const memTotalMatch = /^MemTotal:\s*(\d+)\s*kB/m.exec(memInfoOracle);
    expect(memTotalMatch).not.toBeNull();
    const expectedRamMb = memTotalMatch !== null ? Math.round(Number(memTotalMatch[1]) / 1024) : NaN;
    expect(snapshot.facts.ramMb).toBe(expectedRamMb);

    const dfOracle = (await fixture.container.exec(['df', '-P', '-k', '/'])).stdout;
    const dfDataLine = dfOracle
      .trim()
      .split('\n')
      .at(1)
      ?.trim()
      .split(/\s+/);
    expect(dfDataLine).toBeDefined();
    const expectedTotalMb = Math.round(Number(dfDataLine?.[1]) / 1024);
    const expectedUsedMb = Math.round(Number(dfDataLine?.[2]) / 1024);
    expect(snapshot.facts.diskTotalMb).toBe(expectedTotalMb);
    expect(snapshot.facts.diskUsedMb).toBe(expectedUsedMb);

    // Uptime is monotonic, not exact — and, measured here, is the *host* kernel's uptime, not
    // the container's own age: `/proc/uptime` inside a container reflects the shared host kernel
    // unless a dedicated uptime/time namespace is configured, which this fixture does not set up.
    // A non-negative integer is therefore the honest bound; asserting a small value would be
    // false on any host that has been up for a while (a real earlier measurement on this
    // machine returned a multi-day figure).
    expect(snapshot.facts.uptimeSeconds).not.toBeNull();
    expect(Number.isInteger(snapshot.facts.uptimeSeconds)).toBe(true);
    expect(snapshot.facts.uptimeSeconds ?? -1).toBeGreaterThanOrEqual(0);

    // Plain image (no `dockerCli`): Docker is absent, which is itself a DISC-01 fact.
    expect(snapshot.facts.dockerInstalled).toBe(false);

    // --- Checks: one entry per DISCOVERY_CHECK_IDS value, in that exact order. `DISCOVERY_
    //     SEQUENCE` (packages/ssh's internal, unexported ordering) is built directly from this
    //     same canonical tuple, so asserting against it here proves the same fact without
    //     reaching past the package's public surface. ---
    expect(snapshot.checks).toHaveLength(DISCOVERY_CHECK_IDS.length);
    expect(snapshot.checks.map((check) => check.id)).toEqual([...DISCOVERY_CHECK_IDS]);

    await outcome.session.close();
  });
});

describe.each(UBUNTU_VERSIONS)('SERV-08 access-check matrix (Ubuntu %s)', (ubuntu) => {
  it.each([
    { user: 'root', expectedSudo: 'not_applicable', expectedDockerGroup: 'not_applicable' },
    { user: 'deployer', expectedSudo: 'pass', expectedDockerGroup: 'pass' },
    { user: 'restricted', expectedSudo: 'fail', expectedDockerGroup: 'fail' },
  ] as const)(
    '$user -> sudo:$expectedSudo, docker_group:$expectedDockerGroup, with the other nine checks unaffected',
    async ({ user, expectedSudo, expectedDockerGroup }) => {
      // `dockerCli: true` so the "other nine checks" genuinely includes `docker_version`/
      // `docker_compose_version` passing (D-12: CLI present + daemon unreachable is still a
      // `pass` check) — on the plain image those two report `fail` regardless of which user
      // connects, which would make this loop's "every other check still passes" assertion false
      // for a reason that has nothing to do with SERV-08's sudo/docker-group matrix.
      fixture = await startSshd({ ubuntu, dockerCli: true });
      const key = await readTestKey(fixture, 'ed25519');
      const adapter = createSsh2Adapter();
      const redactor = createRedactor();

      const outcome = await adapter.connect({
        target: { host: fixture.host, port: fixture.port, user },
        credential: { kind: 'private_key', privateKey: secretValue(key, 'ssh_private_key') },
        timeouts: TIMEOUTS,
        trustedFingerprint: null,
        redactor,
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      const snapshot = await runDiscovery({
        session: outcome.session,
        sshUser: user,
        timeouts: { discoveryMs: TIMEOUTS.discoveryMs },
        redactor,
      });

      const sudoCheck = snapshot.checks.find((check) => check.id === 'sudo');
      const dockerGroupCheck = snapshot.checks.find((check) => check.id === 'docker_group');
      expect(sudoCheck?.status).toBe(expectedSudo);
      expect(dockerGroupCheck?.detail.length).toBeGreaterThan(0);
      expect(dockerGroupCheck?.status).toBe(expectedDockerGroup);
      expect(sudoCheck?.detail.length).toBeGreaterThan(0);

      // D-13: a failed access check is a warning, not a blocker — every other check still
      // passes, including for `restricted`, which fails both access checks.
      const otherChecks = snapshot.checks.filter((check) => check.id !== 'sudo' && check.id !== 'docker_group');
      for (const check of otherChecks) {
        expect(check.status, `check "${check.id}" was not pass for user "${user}"`).toBe('pass');
      }

      await outcome.session.close();
    },
  );
});

describe.each(UBUNTU_VERSIONS)('Docker variants (D-12) (Ubuntu %s)', (ubuntu) => {
  it('the plain image reports dockerInstalled: false, a skipped compose check, no UNSUPPORTED_OS warning, and every other fact populated', async () => {
    fixture = await startSshd({ ubuntu });
    const key = await readTestKey(fixture, 'ed25519');
    const adapter = createSsh2Adapter();
    const redactor = createRedactor();

    const outcome = await adapter.connect({
      target: { host: fixture.host, port: fixture.port, user: 'deployer' },
      credential: { kind: 'private_key', privateKey: secretValue(key, 'ssh_private_key') },
      timeouts: TIMEOUTS,
      trustedFingerprint: null,
      redactor,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const snapshot = await runDiscovery({
      session: outcome.session,
      sshUser: 'deployer',
      timeouts: { discoveryMs: TIMEOUTS.discoveryMs },
      redactor,
    });

    expect(snapshot.facts.dockerInstalled).toBe(false);
    expect(snapshot.facts.dockerVersion).toBeNull();
    const composeCheck = snapshot.checks.find((check) => check.id === 'docker_compose_version');
    expect(composeCheck?.status).toBe('skipped');
    expect(snapshot.warnings).not.toContain('UNSUPPORTED_OS');

    for (const fact of [
      snapshot.facts.hostname,
      snapshot.facts.osDistribution,
      snapshot.facts.osVersion,
      snapshot.facts.arch,
      snapshot.facts.cpuCores,
      snapshot.facts.ramMb,
      snapshot.facts.diskTotalMb,
      snapshot.facts.diskUsedMb,
      snapshot.facts.uptimeSeconds,
    ]) {
      expect(fact).not.toBeNull();
    }

    await outcome.session.close();
  });

  it('the docker-CLI image reports a client version matching the container\'s own docker version --format json output', async () => {
    fixture = await startSshd({ ubuntu, dockerCli: true });
    const key = await readTestKey(fixture, 'ed25519');
    const adapter = createSsh2Adapter();
    const redactor = createRedactor();

    const outcome = await adapter.connect({
      target: { host: fixture.host, port: fixture.port, user: 'deployer' },
      credential: { kind: 'private_key', privateKey: secretValue(key, 'ssh_private_key') },
      timeouts: TIMEOUTS,
      trustedFingerprint: null,
      redactor,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const snapshot = await runDiscovery({
      session: outcome.session,
      sshUser: 'deployer',
      timeouts: { discoveryMs: TIMEOUTS.discoveryMs },
      redactor,
    });

    expect(snapshot.facts.dockerInstalled).toBe(true);
    expect(snapshot.facts.dockerVersion).not.toBeNull();

    const oracleResult = await fixture.container.exec([
      'sh',
      '-c',
      "docker version --format '{{json .}}'",
    ]);
    const oracleJson: unknown = JSON.parse(oracleResult.stdout);
    const oracleClientVersion = (oracleJson as { Client?: { Version?: unknown } }).Client?.Version;
    expect(snapshot.facts.dockerVersion).toBe(oracleClientVersion);

    await outcome.session.close();
  });
});

describe.each(UBUNTU_VERSIONS)('SEC-05 canary (Ubuntu %s)', (ubuntu) => {
  it('a canary SSH password never appears in any exec output, discovery check detail, the serialised snapshot, or a failure message', async () => {
    fixture = await startSshd({ ubuntu });
    // The canary must be the account's *actual* password, or the connection below simply fails
    // AUTH_FAILED (a genuinely different value can't authenticate) — `fixture.password` is
    // already a fresh, per-run `randomUUID()` value (tests/integration/helpers/ssh.ts), never a
    // committed literal, so it satisfies the "distinctive, per-run" canary requirement directly.
    const canaryPassword = fixture.password;
    const adapter = createSsh2Adapter();
    const redactor = createRedactor();

    const outcome = await adapter.connect({
      target: { host: fixture.host, port: fixture.port, user: 'pwuser' },
      credential: { kind: 'password', password: secretValue(canaryPassword, 'ssh_password') },
      timeouts: TIMEOUTS,
      trustedFingerprint: null,
      redactor,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const execResult = await outcome.session.exec('discovery.hostname');

    const snapshot = await runDiscovery({
      session: outcome.session,
      sshUser: 'pwuser',
      timeouts: { discoveryMs: TIMEOUTS.discoveryMs },
      redactor,
    });

    // A failure outcome too (D-02/SEC-05): a second connection with the *wrong* password must
    // never echo the *correct* canary anywhere in its own AUTH_FAILED message.
    const failedAttempt = await adapter.connect({
      target: { host: fixture.host, port: fixture.port, user: 'pwuser' },
      credential: { kind: 'password', password: secretValue('definitely-wrong-not-the-canary', 'ssh_password') },
      timeouts: TIMEOUTS,
      trustedFingerprint: null,
      redactor,
    });

    const haystacks: string[] = [
      execResult.stdout,
      execResult.stderr,
      ...snapshot.checks.map((check) => check.detail),
      JSON.stringify(snapshot),
      failedAttempt.ok ? '' : failedAttempt.message,
    ];

    for (const haystack of haystacks) {
      expect(haystack).not.toContain(canaryPassword);
    }

    await outcome.session.close();
  });
});
