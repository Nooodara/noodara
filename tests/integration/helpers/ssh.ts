// Testcontainers helper staging every QA-03 scenario's infrastructure need (02-02-PLAN.md
// Task 2). Mirrors tests/integration/helpers/postgres.ts's shape: `.withLabels({ 'noodara.test':
// 'true' })`, readiness gated by a real wait strategy (never a fixed sleep), and an idempotent
// `stop()`. No test file under tests/integration/ssh/**.test.ts imports `testcontainers` directly
// after this lands — everything a scenario needs goes through this module.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GenericContainer,
  Wait,
  getContainerRuntimeClient,
  type StartedTestContainer,
} from "testcontainers";
import { expect } from "vitest";
import { startLabelledContainer } from "./container-start.js";
import { startWithPortBindingRetry } from "./port-binding-retry.js";
import { dockerCli as runDocker, reapOwnedSshContainers, SSH_OWNER_LABEL } from "./test-resources.js";

// Resolved from this file's own location, matching how tests/integration/helpers/migrations.ts
// resolves the migrations folder — never process.cwd(), so this module works regardless of which
// directory a caller runs Vitest from.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMAGES_CONTEXT = path.resolve(HERE, "../images");

/** Diagnostics never receive exceptions, fixture credentials, Docker objects or raw output.
 * A sink is a nonblocking observer: false/Promise means stop producing, with no queue or retry.
 * Promise rejections are consumed; diagnostic failure must not affect startup or cleanup. */
export type SshDiagnosticStage =
  | "image_build" | "container_create" | "container_start"
  | "published_port" | "ssh_readiness" | "cleanup";
export type SshDiagnosticOutcome = "begin" | "success" | "failure" | "timeout" | "cancelled";
export interface SshDiagnosticEvent {
  readonly owner: string;
  readonly stage: SshDiagnosticStage;
  readonly outcome: SshDiagnosticOutcome;
  readonly elapsedMs: number;
  readonly category?: "operation_failed" | "deadline" | "cancelled";
}
export type SshDiagnosticSink =
  (event: SshDiagnosticEvent) => void | boolean | Promise<unknown>;

export function createSshDiagnostics(
  owner: string,
  sink?: SshDiagnosticSink,
  now: () => number = () => performance.now(),
): { record: (stage: SshDiagnosticStage, outcome: SshDiagnosticOutcome, error?: unknown) => void } {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(owner)) {
    throw new Error("Invalid SSH fixture owner");
  }
  const origin = now();
  let elapsedMs = 0;
  let count = 0;
  let writable = true;
  return {
    record(stage, outcome, _error): void {
      // An exception is intentionally unused. Its message, cause and custom serializers may
      // contain credentials; safe categories derive exclusively from the observed outcome.
      if (!sink || !writable || count >= 64) return;
      if (!["image_build", "container_create", "container_start", "published_port", "ssh_readiness", "cleanup"].includes(stage)
        || !["begin", "success", "failure", "timeout", "cancelled"].includes(outcome)) return;
      count += 1;
      try {
        const elapsed = now() - origin;
        if (Number.isFinite(elapsed)) elapsedMs = Math.max(elapsedMs, Math.floor(elapsed));
        const category = outcome === "failure" ? "operation_failed"
          : outcome === "timeout" ? "deadline" : outcome === "cancelled" ? "cancelled" : undefined;
        const event: SshDiagnosticEvent = Object.freeze({
          owner, stage, outcome, elapsedMs, ...(category === undefined ? {} : { category }),
        });
        const result = sink(event);
        if (result === false) writable = false;
        if (result instanceof Promise) {
          writable = false;
          void result.catch(() => undefined);
        }
      } catch {
        writable = false;
      }
    },
  };
}

export type UbuntuVersion = "22.04" | "24.04";

export interface StartSshdOptions {
  readonly ubuntu: UbuntuVersion;
  readonly diagnostics?: SshDiagnosticSink;
  readonly signal?: AbortSignal;
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

export interface SshdLifecycle {
  readonly result: Promise<SshdFixture>;
  /** Always fulfilled; joins startup and any late cleanup, even after result was cancelled. */
  readonly settled: Promise<void>;
  cancel: (reason?: Error) => void;
  stop: () => Promise<void>;
}

// Strong references retain ownership if a daemon fails to settle before teardown's bound.
// They disappear only after the operation and its late cleanup actually finish.
const pendingLifecycles = new Set<Promise<void>>();

/** Register this owner in the caller before awaiting result. Cancellation rejects result
 * promptly, but never detaches the build/start promise: stop joins it and fails closed if
 * Docker cannot settle. No zero-survivor claim is made until the final owned inventory. */
export function createSshdLifecycle(options: StartSshdOptions): SshdLifecycle {
  const controller = new AbortController();
  const forwardAbort = (): void => { controller.abort(options.signal?.reason); };
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (options.signal?.aborted === true) forwardAbort();
  let fixture: SshdFixture | undefined;
  let cleanupFailed = false;
  const startup = runSshd({ ...options, signal: controller.signal }, () => { cleanupFailed = true; });
  let rejectCancellation!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
  const onAbort = (): void => { rejectCancellation(controller.signal.reason); };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  if (controller.signal.aborted) onAbort();
  const settled = startup.then(async (started) => {
    fixture = started;
    if (controller.signal.aborted) {
      try { await started.stop(); } catch { cleanupFailed = true; }
    }
  }, () => undefined).finally(() => {
    controller.signal.removeEventListener("abort", onAbort);
    options.signal?.removeEventListener("abort", forwardAbort);
    pendingLifecycles.delete(settled);
  });
  pendingLifecycles.add(settled);
  const result = Promise.race([startup, cancelled]);
  // The caller still receives the original rejection; immediate observation prevents a timeout
  // between registration and awaiting result from becoming an unhandled rejection.
  void result.catch(() => undefined);
  const cancel = (reason = new Error("SSH fixture cancelled")): void => { controller.abort(reason); };
  let stopping: Promise<void> | undefined;
  return {
    result, settled, cancel,
    stop() {
      stopping ??= (async () => {
        if (fixture === undefined) cancel();
        const cleanup = (async () => {
          await settled;
          if (fixture !== undefined) await fixture.stop();
          if (cleanupFailed) throw new Error("SSH fixture cleanup unverified");
        })();
        const trackedCleanup = cleanup.then(() => undefined, () => undefined).finally(() => {
          pendingLifecycles.delete(trackedCleanup);
        });
        pendingLifecycles.add(trackedCleanup);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            cleanup,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error("SSH fixture cleanup unverified: creation did not settle")), 30_000);
            }),
          ]);
        } finally { clearTimeout(timer); }
      })();
      return stopping;
    },
  };
}

/** The names `readTestKey` accepts — matches the keys tests/integration/images/sshd-common's
 *  build-time (ed25519/rsa3072/ecdsa/ed25519_unauthorized) and start-time (ed25519_locked,
 *  D-02) key generation produce under /keys. */
export type TestKeyName =
  "ed25519" | "rsa3072" | "ecdsa" | "ed25519_unauthorized" | "ed25519_locked";

/**
 * Builds (or reuses Docker's layer cache for) the project-owned sshd image for `ubuntu`, starts
 * it labelled `noodara.test=true`, and waits for sshd's own "Server listening" log line — never a
 * fixed sleep. Returns the generated per-run password/passphrase so the caller can hand them to
 * the adapter under test without either value ever being a repository literal.
 */
export function startSshd(options: StartSshdOptions): Promise<SshdFixture> {
  return runSshd(options);
}

async function runSshd(
  options: StartSshdOptions,
  onCleanupUnverified: () => void = () => undefined,
): Promise<SshdFixture> {
  const { ubuntu, dockerCli = false, slowDf = false, hostPort, signal } = options;
  const checkCancelled = (): void => { signal?.throwIfAborted(); };
  checkCancelled();

  // Ownership exists before either build or start is awaited.
  const owner = randomUUID();
  const diagnostic = createSshDiagnostics(owner, options.diagnostics ?? (
    process.env.NOODARA_SSH_DIAGNOSTICS === "1"
      ? (event) => process.stdout.write(`${JSON.stringify(event)}\n`) : undefined
  ));
  let activeStage: SshDiagnosticStage = "image_build";
  const record = (stage: SshDiagnosticStage, outcome: SshDiagnosticOutcome): void => {
    if (outcome === "begin") activeStage = stage;
    diagnostic.record(stage, outcome);
  };
  const password = randomUUID();
  const keyPassphrase = randomUUID();

  const imageName = `noodara-test/sshd-diagnostics:${owner}`;
  let imageBuilt = false;
  const removeOwnedImage = async (): Promise<void> => {
    if (!imageBuilt) return;
    // The fixture owns this tag, not untagged parent layers shared as build cache.
    try { await runDocker(["image", "rm", "--no-prune", imageName]); } catch {
      onCleanupUnverified();
      throw new Error("SSH fixture cleanup unverified");
    }
    imageBuilt = false;
  };
  record("image_build", "begin");
  try {
    await GenericContainer.fromDockerfile(
    IMAGES_CONTEXT,
    `sshd-ubuntu-${ubuntu}/Dockerfile`,
  )
    .withBuildArgs({
      WITH_DOCKER_CLI: String(dockerCli),
      WITH_SLOW_DF: String(slowDf),
    })
    .build(imageName);
    imageBuilt = true;
    record("image_build", "success");
    checkCancelled();
  } catch (error: unknown) {
    record("image_build", signal?.aborted === true ? "cancelled" : "failure");
    if (imageBuilt) {
      record("cleanup", "begin");
      try { await removeOwnedImage(); record("cleanup", "success"); } catch { record("cleanup", "failure"); }
    }
    throw error;
  }

  // Hooks observe testcontainers' actual milestones. containerStarting runs only after its
  // published-port inspector succeeds; start+port intervals overlap deliberately, since that
  // library does not expose a hook between Docker.start and its port-inspection loop.
  class DiagnosticSshContainer extends GenericContainer {
    protected override beforeContainerCreated(): Promise<void> {
      checkCancelled();
      record("container_create", "begin");
      return Promise.resolve();
    }
    protected override containerCreated(): Promise<void> {
      record("container_create", "success");
      checkCancelled();
      record("container_start", "begin");
      record("published_port", "begin");
      return Promise.resolve();
    }
    protected override containerStarting(): Promise<void> {
      checkCancelled();
      record("container_start", "success");
      record("published_port", "success");
      record("ssh_readiness", "begin");
      return Promise.resolve();
    }
    protected override containerStarted(): Promise<void> {
      checkCancelled();
      record("ssh_readiness", "success");
      return Promise.resolve();
    }
  }

  // A name of our own so a container Docker CREATED but could not START (a host-port binding race,
  // see port-binding-retry.ts) can be removed by name -- testcontainers hands back no handle for a
  // container whose start() threw, and a never-started `noodara.test=true` container is exactly
  // what the nightly's stray-container guard reports.
  const containerName = `noodara-sshd-${ubuntu}-${owner}`;
  const container = new DiagnosticSshContainer(imageName)
    .withName(containerName)
    .withLabels({ "noodara.test": "true" })
    .withEnvironment({
      SSH_TEST_PASSWORD: password,
      SSH_TEST_KEY_PASSPHRASE: keyPassphrase,
    })
    .withExposedPorts(
      hostPort === undefined ? 22 : { container: 22, host: hostPort },
    )
    .withWaitStrategy(Wait.forLogMessage(/Server listening on .* port 22/));

  const removeCreatedContainer = async (): Promise<void> => {
    record("cleanup", "begin");
    try {
      await reapOwnedSshContainers(owner);
      record("cleanup", "success");
    } catch {
      onCleanupUnverified();
      record("cleanup", "failure");
      throw new Error("SSH fixture cleanup unverified");
    }
  };

  // Interrupt readiness/port inspection when possible. A daemon create already in flight may
  // finish later, so this early sweep is never the final zero-leak proof: the operation below
  // remains owned and its final sweep runs only after start has settled.
  let abortCleanup: Promise<void> | undefined;
  const onAbort = (): void => {
    abortCleanup = removeCreatedContainer();
    // This promise remains owned and is joined below; consume rejection immediately as well.
    void abortCleanup.catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  let started: StartedTestContainer;
  try {
    // Only a FIXED host port can race a just-stopped container's mapping; a random port never
    // collides, so it gets exactly one attempt like before.
    started = await startWithPortBindingRetry(
      () =>
        startLabelledContainer("sshd-ubuntu", (labels) =>
          container.withLabels({ ...labels, [SSH_OWNER_LABEL]: owner }).start(),
          { ...(signal === undefined ? {} : { signal }) },
        ),
      {
        attempts: hostPort === undefined ? 1 : 5,
        delayMs: 1000,
        onFailedAttempt: removeCreatedContainer,
        ...(signal === undefined ? {} : { signal }),
      },
    );
  } catch (error: unknown) {
    record(activeStage, signal?.aborted === true ? "cancelled" : "failure");
    signal?.removeEventListener("abort", onAbort);
    await abortCleanup?.catch(() => undefined);
    await removeCreatedContainer().catch(() => undefined);
    await removeOwnedImage().catch(() => undefined);
    throw signal?.aborted === true ? signal.reason : error;
  }

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      signal?.removeEventListener("abort", onAbort);
      record("cleanup", "begin");
      let failed = false;
      // Abort's early owner sweep may already have removed a late returned handle. Do not
      // send stop to a stale handle (or treat its expected 404 as a new cleanup failure).
      if (signal?.aborted !== true) {
        try { await started.stop(); } catch { failed = true; }
      }
      try { await abortCleanup; } catch { failed = true; }
      try { await reapOwnedSshContainers(owner); } catch { failed = true; }
      try { await removeOwnedImage(); } catch { failed = true; }
      if (failed) onCleanupUnverified();
      record("cleanup", failed ? "failure" : "success");
      if (failed) throw new Error("SSH fixture cleanup unverified");
    })();
    return stopping;
  };
  if (signal?.aborted === true) {
    record(activeStage, "cancelled");
    await stop().catch(() => undefined);
    throw signal.reason;
  }

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
export async function readTestKey(
  fixture: SshdFixture,
  name: TestKeyName,
): Promise<string> {
  const result = await fixture.container.exec(["cat", `/keys/${name}`]);
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
export async function hostKeyFingerprint(
  fixture: SshdFixture,
  keyType: string,
): Promise<string> {
  const result = await fixture.container.exec([
    "ssh-keygen",
    "-lf",
    `/etc/ssh/ssh_host_${keyType}_key.pub`,
  ]);
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
 * since no route-lookup behaviour is involved.
 *
 * 02-04-PLAN.md's empirical measurement found the original `while true; do nc -l -p 9000; done`
 * form of this command does NOT blackhole: plain BusyBox `nc -l` (no `-e`) pipes the accepted
 * socket to its own stdin/stdout, and as soon as `ssh2`'s client writes its identification banner
 * immediately after connecting, that `nc` process's write side breaks (its stdout is not a real
 * consumer) and it exits, resetting the connection — measured as `ssh2` failing in single-digit
 * milliseconds with `Connection lost before handshake` / `level: 'protocol'`, never a
 * `readyTimeout`. `-lk -e /bin/sleep infinity` fixes this: `-e` hands the accepted socket to
 * `sleep infinity` (a process that never reads or writes it, so nothing is ever echoed back or
 * used to signal an exit) and `-k` (BusyBox's own "persistent server" flag, documented as
 * requiring `-e`) keeps the listener accepting further connections without the shell-loop
 * respawn race that let the old form drop connections between iterations. Re-verified against a
 * live container: two sequential connection attempts each failed with
 * `level: 'client-timeout'` / `Timed out while waiting for handshake` at the configured
 * `readyTimeout` (±~1-2ms), never a fast reset.
 */
export async function startBlackholeListener(): Promise<BlackholeListener> {
  const blackhole = new GenericContainer("alpine:3.21")
    .withExposedPorts(9000)
    .withCommand(["nc", "-lk", "-p", "9000", "-e", "/bin/sleep", "infinity"])
    .withWaitStrategy(Wait.forListeningPorts());
  const container = await startLabelledContainer("alpine:3.21", (labels) =>
    blackhole.withLabels(labels).start(),
  );

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await container.stop();
  };

  return {
    host: container.getHost(),
    port: container.getMappedPort(9000),
    stop,
  };
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
export async function waitForSlowCommandStart(
  fixture: SshdFixture,
  maxAttempts = 30,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await fixture.container.exec([
      "test",
      "-f",
      "/tmp/noodara-slow-df-started",
    ]);
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
  const stray = containers.filter(
    (container) => container.Labels["noodara.test"] === "true",
  );
  expect(stray).toHaveLength(0);
}
