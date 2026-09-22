// 06-10-PLAN.md Task 2: proves the D-18 layer-2 harness itself -- startInstallerDind -- works on
// both Ubuntu 22.04 and 24.04 before any scenario (Plan 06-11/06-12) depends on it. Scope is
// deliberately limited to the harness/plumbing (hard_rule #11): this file does NOT implement a
// fresh-install/idempotent-rerun/preflight-matrix scenario -- it proves the nested dockerd
// answers, is isolated from the outer host daemon, loads locally built images with no registry,
// runs the real repo-root install.sh under genuine dash, and cleans up after itself.
//
// One shared "default" fixture (WITH_DOCKER=true, WITH_SNAP_DOCKER=false) per Ubuntu version is
// started once in `beforeAll` and reused across most assertions -- mirrors
// tests/integration/installer/web-image.test.ts's own beforeAll/afterAll-shared-fixture pattern,
// including moving the stray-container assertion into `afterAll` (never `afterEach`) so the
// still-running shared fixture is never misreported as a leak mid-suite. The two build-arg
// variants (withDocker: false, withSnapDocker: true) need their own image build, so they get
// their own self-contained container lifecycle inside a single `it()`.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInstallerDind, type InstallerDindFixture, type InstallerDindUbuntu } from '../helpers/installer-dind.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';

const UBUNTU_VERSIONS: InstallerDindUbuntu[] = ['22.04', '24.04'];

// The DinD fixture build (installs Docker Engine from download.docker.com the first time, cached
// by Docker's own layer cache afterward) plus the nested dockerd's own startup -- generous but
// still explicit, matching every other installer suite's own per-test timeout convention
// (control-plane-image.test.ts, web-image.test.ts, compose-stack.test.ts).
const FIXTURE_TIMEOUT_MS = 300_000;
const CLI_TIMEOUT_MS = 30_000;

const LOAD_TEST_BASE_IMAGE = 'alpine:3.21';
const PULL_TIMEOUT_MS = 120_000;

/** Host-side `alpine:3.21` re-tagged under a test-only name for the `loadLocalImages` proof --
 *  deliberately not the full apps/control-plane (1.22GB) / apps/web (402MB) production images:
 *  this file proves the save/copy/load MECHANISM, not a production image's own content, and
 *  building those here would duplicate Plans 06-11/06-12's own real end-to-end use of this exact
 *  mechanism against the real images. The base image is pulled when the host daemon does not
 *  already hold it: on a developer machine another suite usually has, but a CI runner whose
 *  preloaded images were pruned (ci.yml's disk-reclaim step) starts empty -- the first real run
 *  failed exactly there, on `docker tag` of an image that was never present. */
function tagLoadTestImage(ubuntu: InstallerDindUbuntu): string {
  const tag = `noodara-dind-loadtest:${ubuntu}-${randomUUID()}`;
  try {
    execFileSync('docker', ['image', 'inspect', LOAD_TEST_BASE_IMAGE], { stdio: 'ignore', timeout: CLI_TIMEOUT_MS });
  } catch {
    execFileSync('docker', ['pull', LOAD_TEST_BASE_IMAGE], { stdio: 'ignore', timeout: PULL_TIMEOUT_MS });
  }
  execFileSync('docker', ['tag', LOAD_TEST_BASE_IMAGE, tag], { timeout: CLI_TIMEOUT_MS });
  return tag;
}

function removeImage(tag: string): void {
  execFileSync('docker', ['rmi', '-f', tag], { stdio: 'ignore', timeout: CLI_TIMEOUT_MS });
}

describe.each(UBUNTU_VERSIONS)('installer DinD harness -- Ubuntu %s (06-10-PLAN.md)', (ubuntu) => {
  let fixture: InstallerDindFixture | undefined;

  beforeAll(async () => {
    fixture = await startInstallerDind({ ubuntu });
  }, FIXTURE_TIMEOUT_MS);

  afterAll(async () => {
    await fixture?.stop();
    // noodara-tdd skill Sec.5 / hard_rule #7: no container labelled noodara.test=true survives.
    // Placed in afterAll (not afterEach), matching web-image.test.ts's own documented fix -- the
    // shared fixture above is intentionally long-lived across every it() in this describe block.
    await assertNoStrayTestContainers();
  }, FIXTURE_TIMEOUT_MS);

  it(
    'nested dockerd answers a real "docker version" from inside',
    async () => {
      if (fixture === undefined) throw new Error('fixture is undefined -- beforeAll must have failed');
      const result = await fixture.exec(['docker', 'version']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Server:');
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'is isolated from the outer host Docker daemon (T-06-47 boundary)',
    async () => {
      if (fixture === undefined) throw new Error('fixture is undefined -- beforeAll must have failed');
      const result = await fixture.exec(['docker', 'ps', '-a', '--format', '{{.Names}}']);
      expect(result.exitCode).toBe(0);
      // The outer host's own, unrelated containers (per this plan's own hard_rules: never
      // touched, never listed) must never be visible from inside the nested daemon.
      expect(result.stdout).not.toContain('nuestracasa-neon-proxy');
      expect(result.stdout).not.toContain('decisionmaker-postgres');
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    '/bin/sh inside the fixture is dash, not bash (T-06-49, Pitfall 1)',
    async () => {
      if (fixture === undefined) throw new Error('fixture is undefined -- beforeAll must have failed');
      const result = await fixture.exec(['/bin/sh', '-c', 'echo ${BASH_VERSION:-nobash}']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('nobash');
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'loadLocalImages makes docker image inspect succeed inside the nested daemon with no registry (D-19)',
    async () => {
      if (fixture === undefined) throw new Error('fixture is undefined -- beforeAll must have failed');
      const tag = tagLoadTestImage(ubuntu);
      try {
        const result = await fixture.loadLocalImages([tag]);
        expect(result.tarBytes).toBeGreaterThan(0);
        expect(result.loadDurationMs).toBeGreaterThanOrEqual(0);
        // Printed deliberately: 06-RESEARCH.md Open Question 2 asks the SUMMARY to record the
        // measured tar size and load duration so Plan 06-13 can size the CI job's timeout
        // honestly -- the literal measurement belongs in the SUMMARY, not reconstructed after
        // the fact.
        console.log(
          `loadLocalImages (Ubuntu ${ubuntu}): tarBytes=${String(result.tarBytes)} saveDurationMs=${String(result.saveDurationMs)} loadDurationMs=${String(result.loadDurationMs)}`,
        );

        const inspect = await fixture.exec(['docker', 'image', 'inspect', tag]);
        expect(inspect.exitCode).toBe(0);
      } finally {
        removeImage(tag);
      }
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'runInstallSh copies and executes the real repo-root install.sh under genuine dash (source-only proof)',
    async () => {
      if (fixture === undefined) throw new Error('fixture is undefined -- beforeAll must have failed');
      // NOODARA_INSTALL_SH_SOURCE_ONLY=1 (the exact guard tests/unit/installer/sh-harness.ts's
      // own runInstallerShell relies on) only defines functions and returns -- proves the real
      // file, copied in via copyFilesToContainer and executed as a real file argument to
      // `/bin/sh` (not `sh -c "..."`, not piped through stdin), parses and runs cleanly under a
      // genuine Ubuntu dash. This is deliberately NOT a fresh-install/idempotent-rerun scenario
      // (hard_rule #11) -- it proves the copy+exec mechanism, nothing about install.sh's own
      // behavior beyond "it runs".
      const result = await fixture.runInstallSh({ NOODARA_INSTALL_SH_SOURCE_ONLY: '1' });
      expect(result.exitCode).toBe(0);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'runInstallSh executes the real, non-source-only install.sh and reaches its own real preflight (exit 10, not-root)',
    async () => {
      if (fixture === undefined) throw new Error('fixture is undefined -- beforeAll must have failed');
      // The REAL (non-source-only) code path, run as `nobody` (a standard account present in both
      // base images, no extra image layer needed) -- noodara_check_root is the very first call
      // noodara_main makes, so this fails deterministically and instantly, with zero writes, zero
      // network calls and zero docker/compose activity: a genuine first-touch proof that
      // install.sh runs under real dash end to end from a fresh `exec()`, without reaching into
      // fresh-install/idempotent-rerun/preflight-matrix scenario territory (hard_rule #11).
      const result = await fixture.runInstallSh({}, { user: 'nobody' });
      expect(result.exitCode).toBe(10);
      expect(result.stderr.toLowerCase()).toContain('root');
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'withDocker: false yields a fixture where "docker version" fails from inside',
    async () => {
      const noDockerFixture = await startInstallerDind({ ubuntu, withDocker: false });
      try {
        const result = await noDockerFixture.exec(['sh', '-c', 'docker version']);
        expect(result.exitCode).not.toBe(0);
      } finally {
        await noDockerFixture.stop();
      }
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'withSnapDocker: true yields a fixture where "snap list docker" succeeds',
    async () => {
      const snapFixture = await startInstallerDind({ ubuntu, withSnapDocker: true });
      try {
        const result = await snapFixture.exec(['snap', 'list', 'docker']);
        expect(result.exitCode).toBe(0);
      } finally {
        await snapFixture.stop();
      }
    },
    FIXTURE_TIMEOUT_MS,
  );
});
