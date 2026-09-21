// Testcontainers helper for D-18 layer 2 (06-10-PLAN.md): a privileged Ubuntu 22.04/24.04 fixture
// running its own nested `dockerd`, into which the real repo-root install.sh and locally built
// Noodara images can be injected and executed. Modeled directly on
// tests/integration/helpers/ssh.ts's own shape: `.withLabels({ 'noodara.test': 'true' })`, a real
// log-based wait strategy (never a fixed sleep), and an idempotent `stop()`.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenericContainer, Wait, type ExecOptions, type StartedTestContainer } from 'testcontainers';

// Resolved from this file's own location, never process.cwd() -- mirrors ssh.ts's IMAGES_CONTEXT
// resolution and control-plane-image.test.ts/web-image.test.ts's REPO_ROOT resolution, so this
// module works regardless of which directory a caller runs Vitest from.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMAGES_CONTEXT = path.resolve(HERE, '../images');
const REPO_ROOT = path.resolve(HERE, '../../..');
const INSTALL_SH_PATH = path.join(REPO_ROOT, 'install.sh');

/** The literal readiness line tests/integration/images/installer-dind-common/entrypoint.sh prints
 *  once its (possibly absent, see withDocker: false) nested dockerd is ready -- a single exported
 *  constant so the entrypoint script and this module's wait strategy can never drift apart. */
export const NOODARA_DIND_READY_LINE = 'NOODARA_DIND_READY';

export type InstallerDindUbuntu = '22.04' | '24.04';

export interface StartInstallerDindOptions {
  readonly ubuntu: InstallerDindUbuntu;
  /** Defaults true: Docker Engine pre-installed, matching install.sh's already-installed no-op
   *  path (D-14). Set false to exercise install.sh's own real apt-repo installation path. */
  readonly withDocker?: boolean;
  /** Defaults false: installs a `snap` stub (never real snapd) whose `snap list docker` exits 0. */
  readonly withSnapDocker?: boolean;
  /** Bounds the whole build+start+dockerd-ready wait -- the first build of a variant installs
   *  Docker Engine from the network, so this is generous by default. */
  readonly startupTimeoutMs?: number;
  /** When set, bind-mounts this EXISTING, caller-owned Docker volume as /var/lib/docker instead
   *  of creating a fresh one -- lets a "donor" fixture's own already-populated nested-Docker
   *  storage (images loaded via loadLocalImages) be reused verbatim by a SECOND, later fixture
   *  (06-12-PLAN.md's own no-Docker/D-14 scenario: a withDocker:false fixture has no daemon of its
   *  own to `docker load` into until install.sh's real apt-repo install brings one up moments
   *  before noodara_ensure_docker itself checks readiness -- far too tight a window to `docker
   *  save`/copy/`docker load` real production images into it live without racing install.sh's own
   *  bounded noodara_wait_for_docker_ready. Pre-populating the SAME /var/lib/docker volume from a
   *  donor fixture that already has Docker installed removes the race entirely: the moment the
   *  apt-installed daemon starts, `docker images` already shows everything the donor loaded). The
   *  caller owns creation and removal of this volume -- stop() never removes a volume it did not
   *  create itself. */
  readonly reuseDockerVolume?: string;
}

export interface ExecResultLike {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface InstallerDindExecOptions {
  readonly env?: Record<string, string>;
  readonly user?: string;
  /** testcontainers' own `exec()` accepts no timeout (checked against the installed
   *  testcontainers@12.1.0 API before writing this) -- this wraps every exec in an explicit
   *  `Promise.race` bound instead (hard_rule #7: "explicit timeouts on every exec/build/load"). */
  readonly timeoutMs?: number;
}

export interface LoadLocalImagesResult {
  /** Size in bytes of the `docker save` tar, measured on the host before it is copied in. */
  readonly tarBytes: number;
  /** Wall-clock duration of `docker save` on the host, in milliseconds. */
  readonly saveDurationMs: number;
  /** Wall-clock duration of `docker load` inside the nested daemon, in milliseconds. */
  readonly loadDurationMs: number;
}

export interface InstallerDindFixture {
  readonly container: StartedTestContainer;
  /** Runs an arbitrary command inside the fixture, bounded by an explicit timeout. */
  exec(command: string[], options?: InstallerDindExecOptions): Promise<ExecResultLike>;
  /** Copies the real repo-root install.sh in and executes it as a real file under `/bin/sh`
   *  (never bash, never piped through stdin) with the given environment -- D-18 layer 2's own
   *  whole point is a realistic install.sh invocation, so install.log paths and $0-style
   *  behaviour stay realistic. */
  runInstallSh(env?: Record<string, string>, options?: InstallerDindExecOptions): Promise<ExecResultLike>;
  /** `docker save`s the given host-local tags, copies the tar in, and `docker load`s it into the
   *  nested daemon -- D-19, no registry involved. */
  loadLocalImages(tags: string[], options?: { timeoutMs?: number }): Promise<LoadLocalImagesResult>;
  /** Safe to call more than once. Also removes this fixture's own `/var/lib/docker` volume. */
  stop: () => Promise<void>;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 300_000;
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const DEFAULT_INSTALL_SH_TIMEOUT_MS = 300_000;
const DEFAULT_LOAD_TIMEOUT_MS = 300_000;
// Bounds every host-side `docker` CLI spawn this module makes directly (volume create/rm, save) --
// distinct from the in-container exec timeouts above.
const HOST_CLI_TIMEOUT_MS = 120_000;

/** Bounds an arbitrary promise with an explicit timeout, since testcontainers' own `exec()` and
 *  `.build()` accept none (hard_rule #7). Rejecting here only stops THIS module from waiting
 *  forever -- it cannot cancel a command already running server-side inside the container, an
 *  honestly-documented limitation of wrapping a library that offers no cancellation hook. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`installer-dind: ${label} timed out after ${String(ms)}ms`));
    }, ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

function removeVolume(volumeName: string): void {
  execFileSync('docker', ['volume', 'rm', '-f', volumeName], {
    timeout: HOST_CLI_TIMEOUT_MS,
    stdio: 'ignore',
  });
}

/**
 * Builds (or reuses Docker's layer cache for) the project-owned installer-DinD image for
 * `options.ubuntu`, starts it privileged and labelled `noodara.test=true`, and waits for the
 * nested dockerd's own deterministic readiness line -- never a fixed sleep. The fixture's own
 * `/var/lib/docker` lives on a dedicated, project-owned, explicitly-labelled Docker volume (never
 * the host's own Docker storage, never a bind mount outside a mkdtemp dir) so a genuinely separate
 * nested daemon never touches the host's real Docker (T-06-47/hard_rule #7).
 */
export async function startInstallerDind(options: StartInstallerDindOptions): Promise<InstallerDindFixture> {
  const {
    ubuntu,
    withDocker = true,
    withSnapDocker = false,
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    reuseDockerVolume,
  } = options;

  const ownsVolume = reuseDockerVolume === undefined;
  const volumeName = reuseDockerVolume ?? `noodara-dind-${ubuntu.replace('.', '')}-${randomUUID()}`;
  if (ownsVolume) {
    execFileSync('docker', ['volume', 'create', '--label', 'noodara.test=true', volumeName], {
      timeout: HOST_CLI_TIMEOUT_MS,
      stdio: 'ignore',
    });
  }

  let image;
  try {
    image = await withTimeout(
      GenericContainer.fromDockerfile(IMAGES_CONTEXT, `installer-dind-ubuntu-${ubuntu}/Dockerfile`)
        .withBuildArgs({ WITH_DOCKER: String(withDocker), WITH_SNAP_DOCKER: String(withSnapDocker) })
        .build(),
      startupTimeoutMs,
      `build installer-dind-ubuntu-${ubuntu}`,
    );
  } catch (error) {
    if (ownsVolume) removeVolume(volumeName);
    throw error;
  }

  const container = image
    .withLabels({ 'noodara.test': 'true' })
    // A nested dockerd requires privileged mode (T-06-47) -- there is no meaningful alternative
    // for testing a host installer's own Docker-Engine-installation and docker-compose-driving
    // behavior. Bounded exposure: project-owned image, this repo's own test suite only, no
    // untrusted input, always stopped by the idempotent stop() below plus the noodara.test=true
    // stray-container gate.
    .withPrivilegedMode()
    .withBindMounts([{ source: volumeName, target: '/var/lib/docker' }])
    .withWaitStrategy(Wait.forLogMessage(NOODARA_DIND_READY_LINE))
    .withStartupTimeout(startupTimeoutMs);

  let started: StartedTestContainer;
  try {
    started = await container.start();
  } catch (error) {
    // The container never reached running -- without this, a volume this fixture itself created
    // would leak silently (hard_rule #7's own multi-GB leak warning). A reused (not owned) volume
    // is left alone -- its own creator is responsible for removing it.
    if (ownsVolume) removeVolume(volumeName);
    throw error;
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await started.stop();
    if (ownsVolume) removeVolume(volumeName);
  };

  const exec = async (command: string[], execOptions: InstallerDindExecOptions = {}): Promise<ExecResultLike> => {
    const { env, user, timeoutMs = DEFAULT_EXEC_TIMEOUT_MS } = execOptions;
    // Built conditionally (rather than `{ env, user }` directly) because this repo's
    // `exactOptionalPropertyTypes: true` rejects explicitly assigning `undefined` to an optional
    // property -- only include a key when a real value was actually supplied.
    const dockerodeOptions: Partial<ExecOptions> = {};
    if (env !== undefined) dockerodeOptions.env = env;
    if (user !== undefined) dockerodeOptions.user = user;
    const result = await withTimeout(
      started.exec(command, dockerodeOptions),
      timeoutMs,
      `exec ${command.join(' ')}`,
    );
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  };

  const runInstallSh = async (
    env: Record<string, string> = {},
    runOptions: InstallerDindExecOptions = {},
  ): Promise<ExecResultLike> => {
    const containerPath = '/opt/noodara-install-under-test.sh';
    await started.copyFilesToContainer([{ source: INSTALL_SH_PATH, target: containerPath, mode: 0o755 }]);
    const { timeoutMs = DEFAULT_INSTALL_SH_TIMEOUT_MS, user } = runOptions;
    const execOptions: InstallerDindExecOptions = { env, timeoutMs };
    return exec(['/bin/sh', containerPath], user === undefined ? execOptions : { ...execOptions, user });
  };

  const loadLocalImages = async (
    tags: string[],
    loadOptions: { timeoutMs?: number } = {},
  ): Promise<LoadLocalImagesResult> => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'noodara-dind-images-'));
    const tarPath = path.join(tmpDir, 'images.tar');
    try {
      const saveStart = Date.now();
      execFileSync('docker', ['save', '-o', tarPath, ...tags], { timeout: HOST_CLI_TIMEOUT_MS });
      const saveDurationMs = Date.now() - saveStart;
      const tarBytes = statSync(tarPath).size;

      const containerTarPath = '/tmp/noodara-images.tar';
      await started.copyFilesToContainer([{ source: tarPath, target: containerTarPath }]);

      const loadStart = Date.now();
      const result = await exec(['docker', 'load', '-i', containerTarPath], {
        timeoutMs: loadOptions.timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
      });
      const loadDurationMs = Date.now() - loadStart;
      if (result.exitCode !== 0) {
        throw new Error(`installer-dind: docker load failed (exit ${String(result.exitCode)}): ${result.stderr}`);
      }
      return { tarBytes, saveDurationMs, loadDurationMs };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  };

  return { container: started, exec, runInstallSh, loadLocalImages, stop };
}
