// Testcontainers helper staging every QA-03 scenario's infrastructure need (02-02-PLAN.md
// Task 2). Mirrors tests/integration/helpers/postgres.ts's shape: `.withLabels({ 'noodara.test':
// 'true' })`, readiness gated by a real wait strategy (never a fixed sleep), and an idempotent
// `stop()`. No test file under tests/integration/ssh/**.test.ts imports `testcontainers` directly
// after this lands — everything a scenario needs goes through this module.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GenericContainer,
  Wait,
  getContainerRuntimeClient,
  type StartedTestContainer,
} from 'testcontainers';
import { expect } from 'vitest';

// Resolved from this file's own location, matching how tests/integration/helpers/migrations.ts
// resolves the migrations folder — never process.cwd(), so this module works regardless of which
// directory a caller runs Vitest from.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMAGES_CONTEXT = path.resolve(HERE, '../images');

export type UbuntuVersion = '22.04' | '24.04';

export interface StartSshdOptions {
  readonly ubuntu: UbuntuVersion;
  readonly dockerCli?: boolean;
  readonly slowDf?: boolean;
  /** Fixed host port binding — the HOST_KEY_CHANGED scenario needs two successive containers
   *  reachable at the same host:port. Omit for an OS-assigned free port (the default for every
   *  other scenario). */
  readonly hostPort?: number;
}

export interface SshdFixture {
  readonly container: StartedTestContainer;
  readonly host: string;
  readonly port: number;
  /** Per-run random value injected as SSH_TEST_PASSWORD (D-03) — never a committed literal. */
  readonly password: string;
  /** Per-run random value injected as SSH_TEST_KEY_PASSPHRASE (D-02) — never a committed literal. */
  readonly keyPassphrase: string;
  /** Safe to call more than once. */
  stop: () => Promise<void>;
}

/** The names `readTestKey` accepts — matches the keys tests/integration/images/sshd-common's
 *  build-time (ed25519/rsa3072/ecdsa/ed25519_unauthorized) and start-time (ed25519_locked,
 *  D-02) key generation produce under /keys. */
export type TestKeyName = 'ed25519' | 'rsa3072' | 'ecdsa' | 'ed25519_unauthorized' | 'ed25519_locked';

/**
 * Builds (or reuses Docker's layer cache for) the project-owned sshd image for `ubuntu`, starts
 * it labelled `noodara.test=true`, and waits for sshd's own "Server listening" log line — never a
 * fixed sleep. Returns the generated per-run password/passphrase so the caller can hand them to
 * the adapter under test without either value ever being a repository literal.
 */
export async function startSshd(options: StartSshdOptions): Promise<SshdFixture> {
  const { ubuntu, dockerCli = false, slowDf = false, hostPort } = options;

  const password = randomUUID();
  const keyPassphrase = randomUUID();

  const image = await GenericContainer.fromDockerfile(IMAGES_CONTEXT, `sshd-ubuntu-${ubuntu}/Dockerfile`)
    .withBuildArgs({ WITH_DOCKER_CLI: String(dockerCli), WITH_SLOW_DF: String(slowDf) })
    .build();

  const container = image
    .withLabels({ 'noodara.test': 'true' })
    .withEnvironment({ SSH_TEST_PASSWORD: password, SSH_TEST_KEY_PASSPHRASE: keyPassphrase })
    .withExposedPorts(hostPort === undefined ? 22 : { container: 22, host: hostPort })
    .withWaitStrategy(Wait.forLogMessage(/Server listening on .* port 22/));

  const started = await container.start();

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await started.stop();
  };

  return {
    container: started,
    host: started.getHost(),
    port: started.getMappedPort(22),
    password,
    keyPassphrase,
    stop,
  };
}

/**
 * Returns the OpenSSH private key text for one of the fixture's build-time or start-time keys.
 * Throws a clear error on a non-zero exec exit code, so a missing fixture key fails loudly rather
 * than producing an empty string that later looks like a parse bug.
 */
export async function readTestKey(fixture: SshdFixture, name: TestKeyName): Promise<string> {
  const result = await fixture.container.exec(['cat', `/keys/${name}`]);
  if (result.exitCode !== 0) {
    throw new Error(
      `readTestKey: 'cat /keys/${name}' exited ${String(result.exitCode)}: ${result.stderr}`,
    );
  }
  return result.stdout;
}

/**
 * The independent oracle every fingerprint assertion in this phase compares against (D-04): the
 * raw `ssh-keygen -lf` output line for one of the container's current host keys. `keyType` is the
 * short form `ssh-keygen` uses in its host-key filenames (`ed25519`, `ecdsa`, `rsa`), not the full
 * SSH algorithm name.
 */
export async function hostKeyFingerprint(fixture: SshdFixture, keyType: string): Promise<string> {
  const result = await fixture.container.exec(['ssh-keygen', '-lf', `/etc/ssh/ssh_host_${keyType}_key.pub`]);
  if (result.exitCode !== 0) {
    throw new Error(
      `hostKeyFingerprint: 'ssh-keygen -lf' for ${keyType} exited ${String(result.exitCode)}: ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

export interface BlackholeListener {
  readonly host: string;
  readonly port: number;
  stop: () => Promise<void>;
}

/**
 * A TCP peer that accepts a connection and then sends nothing, ever — the CONNECT_TIMEOUT
 * scenario primitive (02-CONTEXT.md "Escenarios de red"; 02-RESEARCH.md Assumption A4). Unlike an
 * unroutable IP, an accept-then-silent listener makes `ssh2`'s `readyTimeout` the only possible
 * outcome deterministically on both macOS Docker Desktop and GitHub `ubuntu-latest` runners,
 * since no route-lookup behaviour is involved. `busybox nc -l` (Alpine's own `nc`) accepts a
 * connection and, with nothing on its stdin, never writes a byte back — exactly the primitive
 * needed. The `while true` loop means the listener survives more than one connection attempt.
 */
export async function startBlackholeListener(): Promise<BlackholeListener> {
  const container = await new GenericContainer('alpine:3.21')
    .withLabels({ 'noodara.test': 'true' })
    .withExposedPorts(9000)
    .withCommand(['sh', '-c', 'while true; do nc -l -p 9000; done'])
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await container.stop();
  };

  return { host: container.getHost(), port: container.getMappedPort(9000), stop };
}

/**
 * The observable trigger for the mid-exec connection-loss scenario (plan 02-10): polls for the
 * marker file `slow-df.sh` (tests/integration/images/sshd-common/slow-df.sh) touches immediately
 * before it blocks, up to `maxAttempts` back-to-back `container.exec` round trips — no timer and
 * no fixed delay between attempts, since each round trip is itself the pacing. A caller who has
 * awaited this function knows the remote `df` is blocked inside its ~20s sleep with no output
 * sent yet, so a subsequent `stop()` (or connection kill) lands mid-exec deterministically, with
 * roughly 19 seconds of margin before the shim would otherwise degrade into a slow success.
 */
export async function waitForSlowCommandStart(fixture: SshdFixture, maxAttempts = 30): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await fixture.container.exec(['test', '-f', '/tmp/noodara-slow-df-started']);
    if (result.exitCode === 0) return;
  }
  throw new Error(
    `waitForSlowCommandStart: /tmp/noodara-slow-df-started did not appear after ${String(maxAttempts)} attempts`,
  );
}

/**
 * The extracted form of the assertion previously inlined in tests/integration/db/migrations.test.ts's
 * `afterEach` (noodara-tdd skill §5): no container labelled `noodara.test=true` may survive a
 * test run. Exported here so every tests/integration/ssh/*.test.ts file can call it from its own
 * `afterEach` without duplicating the import. `testcontainers`' `NetworkClient` exposes no
 * `list()` method (only `getById`/`create`/`remove`), so there is no equivalent network-level
 * check to perform here — every network this phase creates is created and removed by
 * Testcontainers itself as part of a container's own lifecycle.
 */
export async function assertNoStrayTestContainers(): Promise<void> {
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  const stray = containers.filter((container) => container.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
}
