// Proves the sshd fixture matrix (02-02-PLAN.md Task 3) independently of the SSH adapter: every
// assertion here goes through `container.exec`, never SSH itself, and `packages/ssh` — which
// doesn't implement any behaviour yet — is never imported. If this file is green, a later
// scenario failure in plans 02-04..02-10 points unambiguously at `packages/ssh`, not at the
// fixture. First run of this file builds up to four image variants (plain + docker-CLI + slow-df
// per version); Docker's own layer cache makes subsequent local runs fast (see SUMMARY for the CI
// implication plan 02-10 records).
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertNoStrayTestContainers,
  hostKeyFingerprint,
  readTestKey,
  startSshd,
  waitForSlowCommandStart,
  type SshdFixture,
  type TestKeyName,
  type UbuntuVersion,
} from '../helpers/ssh.js';

const UBUNTU_VERSIONS = ['22.04', '24.04'] as const satisfies readonly UbuntuVersion[];
const TEST_KEY_NAMES = [
  'ed25519',
  'rsa3072',
  'ecdsa',
  'ed25519_unauthorized',
  'ed25519_locked',
] as const satisfies readonly TestKeyName[];

let fixture: SshdFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  await assertNoStrayTestContainers();
});

describe.each(UBUNTU_VERSIONS)('sshd fixture image (Ubuntu %s)', (ubuntu) => {
  it('starts and reaches the sshd-listening wait condition', async () => {
    fixture = await startSshd({ ubuntu });

    expect(fixture.host).toBeTruthy();
    expect(fixture.port).toBeGreaterThan(0);
  });

  it('deployer has docker-group membership and passwordless sudo; restricted has neither', async () => {
    fixture = await startSshd({ ubuntu });

    const deployerGroups = await fixture.container.exec(['id', '-nG', 'deployer']);
    expect(deployerGroups.stdout).toMatch(/\bdocker\b/);
    const deployerSudo = await fixture.container.exec(['sudo', '-n', '-u', 'root', 'true'], {
      user: 'deployer',
    });
    expect(deployerSudo.exitCode).toBe(0);

    const restrictedGroups = await fixture.container.exec(['id', '-nG', 'restricted']);
    expect(restrictedGroups.stdout).not.toMatch(/\bdocker\b/);
    const restrictedSudo = await fixture.container.exec(['sudo', '-n', '-u', 'root', 'true'], {
      user: 'restricted',
    });
    expect(restrictedSudo.exitCode).not.toBe(0);
  });

  it('root has the three build-time public keys; pwuser has no authorized_keys file at all', async () => {
    fixture = await startSshd({ ubuntu });

    const rootAuthorizedKeys = await fixture.container.exec(['cat', '/root/.ssh/authorized_keys']);
    expect(rootAuthorizedKeys.exitCode).toBe(0);
    // startSshd always supplies SSH_TEST_KEY_PASSPHRASE, so entrypoint.sh always appends a fourth
    // (ed25519_locked) key too — assert the three *build-time* keys are present as substrings
    // rather than asserting an exact line count, so this test doesn't depend on that D-02 detail.
    for (const name of ['ed25519', 'rsa3072', 'ecdsa'] as const) {
      const pub = await fixture.container.exec(['cat', `/keys/${name}.pub`]);
      expect(rootAuthorizedKeys.stdout).toContain(pub.stdout.trim());
    }

    const pwuserSsh = await fixture.container.exec(['test', '-e', '/home/pwuser/.ssh']);
    expect(pwuserSsh.exitCode).not.toBe(0);
  });

  it('readTestKey returns a non-empty OpenSSH private key for every named fixture key', async () => {
    fixture = await startSshd({ ubuntu });

    for (const name of TEST_KEY_NAMES) {
      const key = await readTestKey(fixture, name);
      expect(key).toContain('PRIVATE KEY');
    }
  });

  it('hostKeyFingerprint returns a SHA256 line with a key-type marker', async () => {
    fixture = await startSshd({ ubuntu });

    const line = await hostKeyFingerprint(fixture, 'ed25519');
    expect(line).toContain('SHA256:');
    expect(line).toMatch(/\(ED25519\)/);
  });

  it('two sequential containers from the same image report different host-key fingerprints', async () => {
    // Started sequentially, not in parallel — fileParallelism is off and containers are heavy
    // (vitest.integration.config.ts). Stopped explicitly in nested finally blocks rather than via
    // the module-level `fixture`, since two independent containers are alive at once here.
    const first = await startSshd({ ubuntu });
    try {
      const firstFingerprint = await hostKeyFingerprint(first, 'ed25519');

      const second = await startSshd({ ubuntu });
      try {
        const secondFingerprint = await hostKeyFingerprint(second, 'ed25519');
        expect(secondFingerprint).not.toEqual(firstFingerprint);
      } finally {
        await second.stop();
      }
    } finally {
      await first.stop();
    }
  });

  it('the docker-CLI variant has docker on PATH and a compose version; the plain variant has no docker binary', async () => {
    fixture = await startSshd({ ubuntu, dockerCli: true });

    const dockerPath = await fixture.container.exec(['sh', '-c', 'command -v docker']);
    expect(dockerPath.exitCode).toBe(0);

    const composeVersion = await fixture.container.exec(['sh', '-c', 'docker compose version --short']);
    expect(composeVersion.exitCode).toBe(0);
    expect(composeVersion.stdout.trim().length).toBeGreaterThan(0);

    await fixture.stop();

    fixture = await startSshd({ ubuntu });
    const noDocker = await fixture.container.exec(['sh', '-c', 'command -v docker']);
    expect(noDocker.exitCode).not.toBe(0);
  });

  it('slowDf variant resolves df to the shim and waitForSlowCommandStart observes the marker; the default variant never creates it', async () => {
    fixture = await startSshd({ ubuntu, slowDf: true });

    const shimPath = await fixture.container.exec(['sh', '-c', 'command -v df']);
    expect(shimPath.stdout.trim()).toBe('/usr/local/bin/df');

    // Backgrounded inside the container — the exec call returns as soon as the shell forks the
    // job (stdout/stderr redirected away), not when `df` itself finishes ~20s later.
    await fixture.container.exec(['sh', '-c', 'df -P -k / >/dev/null 2>&1 &']);
    await expect(waitForSlowCommandStart(fixture)).resolves.toBeUndefined();

    await fixture.stop();

    fixture = await startSshd({ ubuntu });
    const defaultDfPath = await fixture.container.exec(['sh', '-c', 'command -v df']);
    expect(defaultDfPath.stdout.trim()).toBe('/usr/bin/df');

    // Bounded, small attempt count — this must reject quickly, never hang, when nothing ever
    // touches the marker.
    await expect(waitForSlowCommandStart(fixture, 3)).rejects.toThrow();
  });
});
