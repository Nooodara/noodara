// 06-12-PLAN.md Task 2: proves INST-03 against a genuine Ubuntu filesystem and package manager --
// every preflight cause fails inside a real container with its own exit code, before anything is
// written, including the multi-failure ordering case (D-17). The final describe block is the one
// place in this whole phase that exercises install.sh's real, unstubbed apt-repo Docker
// installation (D-14) -- the ONLY network-dependent test in this phase (hard_rule #8).
//
// Deliberately does NOT re-test anything tests/unit/installer/preflight.test.ts already covers
// deterministically at the shell-unit layer (the per-cause exit-code table, message wording) --
// this file's own value is exclusively what a real container adds: real `ss` output, a real
// filesystem, a real unprivileged user, a real apt installation.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { startInstallerDind, type InstallerDindFixture } from '../helpers/installer-dind.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';
import {
  assertNoSecretLeak,
  buildInstallerScenarioImages,
  composePsInFixture,
  FIXTURE_PANEL_PORT,
  INSTALL_TIMEOUT_MS,
  loadComposeImagesInto,
  parseEnvFile,
  readFixtureFile,
  removeBuiltImages,
  runResultToStreams,
  type BuiltImages,
} from './installer-scenario-helpers.js';

const INSTALL_DIR = '/opt/noodara';
const SCENARIO_TIMEOUT_MS = 300_000;
const NO_DOCKER_TIMEOUT_MS = 1_800_000;

/** Writes `content` to `absolutePath` inside the fixture via a quoted heredoc -- always
 *  test-controlled content, never operator input, so no shell-injection concern applies. */
async function writeFixtureFile(fixture: InstallerDindFixture, absolutePath: string, content: string): Promise<void> {
  const heredoc = `cat > ${absolutePath} <<'NOODARA_PREFLIGHT_EOF'\n${content}\nNOODARA_PREFLIGHT_EOF\n`;
  const result = await fixture.exec(['/bin/sh', '-c', heredoc]);
  if (result.exitCode !== 0) {
    throw new Error(`writeFixtureFile: writing ${absolutePath} failed (exit ${String(result.exitCode)}): ${result.stderr}`);
  }
}

function osReleaseContent(id: string, versionId: string, codename: string): string {
  return `ID=${id}\nVERSION_ID="${versionId}"\nVERSION_CODENAME=${codename}`;
}

function meminfoContent(totalKb: number): string {
  return `MemTotal:       ${String(totalKb)} kB\nMemFree:        102400 kB`;
}

/** Starts a real TCP listener (netcat-openbsd, installed in both installer-dind Dockerfiles
 *  specifically for this file) bound to `port` inside the fixture, backgrounded and disowned so it
 *  outlives this exec call, then polls the fixture's own `ss -tuln` until the listener is
 *  genuinely up -- never trusting that the background command merely started without checking, so
 *  a failed setup here can never masquerade as a passing busy-port assertion. */
async function startBusyPortListener(fixture: InstallerDindFixture, port: number): Promise<void> {
  await fixture.exec(['/bin/sh', '-c', `nohup nc -l ${String(port)} >/tmp/noodara-nc-${String(port)}.log 2>&1 & disown`]);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const check = await fixture.exec(['/bin/sh', '-c', `ss -tuln | grep -q ':${String(port)} ' && echo up || echo down`]);
    if (check.stdout.trim() === 'up') return;
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  throw new Error(`busy-port listener on ${String(port)} inside the fixture never came up`);
}

/** D-17's own actual requirement, only truly testable against a real filesystem: every "must fail
 *  before writing" preflight cause leaves NOTHING behind. */
async function assertNotInstalled(fixture: InstallerDindFixture): Promise<void> {
  const result = await fixture.exec(['/bin/sh', '-c', `[ -e ${INSTALL_DIR} ] && echo present || echo absent`]);
  expect(result.stdout.trim(), `${INSTALL_DIR} must not exist after a failed preflight`).toBe('absent');
}

function runInstallEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NOODARA_PUBLIC_URL: `http://127.0.0.1:${String(FIXTURE_PANEL_PORT)}`,
    NOODARA_PORT: String(FIXTURE_PANEL_PORT),
    ...overrides,
  };
}

describe('preflight matrix inside real Ubuntu (06-12-PLAN.md Task 2, INST-03)', () => {
  afterEach(async () => {
    await assertNoStrayTestContainers();
  });

  it(
    'snap-installed Docker: exits 17, names snap and the removal command, and writes nothing',
    async () => {
      const fixture = await startInstallerDind({ ubuntu: '22.04', withSnapDocker: true });
      try {
        const run = await fixture.runInstallSh(runInstallEnv(), { timeoutMs: INSTALL_TIMEOUT_MS });

        expect(run.exitCode).toBe(17);
        expect(run.stderr).toContain('snap');
        expect(run.stderr).toContain('sudo snap remove docker');
        await assertNotInstalled(fixture);
      } finally {
        await fixture.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'busy panel port: exits 16, names the port and suggests NOODARA_PORT, and writes nothing',
    async () => {
      const fixture = await startInstallerDind({ ubuntu: '22.04' });
      try {
        await startBusyPortListener(fixture, FIXTURE_PANEL_PORT);

        const run = await fixture.runInstallSh(runInstallEnv(), { timeoutMs: INSTALL_TIMEOUT_MS });

        expect(run.exitCode).toBe(16);
        expect(run.stderr).toContain(String(FIXTURE_PANEL_PORT));
        expect(run.stderr).toContain('NOODARA_PORT');
        await assertNotInstalled(fixture);
      } finally {
        await fixture.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'unsupported OS: NOODARA_OS_RELEASE_FILE describing Ubuntu 20.04 exits 12 naming both supported versions, and writes nothing',
    async () => {
      const fixture = await startInstallerDind({ ubuntu: '22.04' });
      try {
        const osReleasePath = '/tmp/noodara-os-release-2004';
        await writeFixtureFile(fixture, osReleasePath, osReleaseContent('ubuntu', '20.04', 'focal'));

        const run = await fixture.runInstallSh(
          runInstallEnv({ NOODARA_OS_RELEASE_FILE: osReleasePath }),
          { timeoutMs: INSTALL_TIMEOUT_MS },
        );

        expect(run.exitCode).toBe(12);
        expect(run.stderr).toContain('20.04');
        expect(run.stderr).toContain('22.04');
        expect(run.stderr).toContain('24.04');
        await assertNotInstalled(fixture);
      } finally {
        await fixture.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'insufficient RAM: a 512MB NOODARA_MEMINFO_FILE exits 14, and writes nothing',
    async () => {
      const fixture = await startInstallerDind({ ubuntu: '22.04' });
      try {
        const meminfoPath = '/tmp/noodara-meminfo-512';
        await writeFixtureFile(fixture, meminfoPath, meminfoContent(524288));

        const run = await fixture.runInstallSh(
          runInstallEnv({ NOODARA_MEMINFO_FILE: meminfoPath }),
          { timeoutMs: INSTALL_TIMEOUT_MS },
        );

        expect(run.exitCode).toBe(14);
        await assertNotInstalled(fixture);
      } finally {
        await fixture.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    '1536MB RAM warns and proceeds past the resource check (bounded by a busy port right after it, so this test does not attempt a real install)',
    async () => {
      const fixture = await startInstallerDind({ ubuntu: '22.04' });
      try {
        const meminfoPath = '/tmp/noodara-meminfo-1536';
        await writeFixtureFile(fixture, meminfoPath, meminfoContent(1572864));
        await startBusyPortListener(fixture, FIXTURE_PANEL_PORT);

        const run = await fixture.runInstallSh(
          runInstallEnv({ NOODARA_MEMINFO_FILE: meminfoPath }),
          { timeoutMs: INSTALL_TIMEOUT_MS },
        );

        // Exit 16 (busy port), never 14 (insufficient RAM) -- proves the resource check itself
        // passed (with a warning), reaching the later port check instead of stopping preflight.
        expect(run.exitCode).toBe(16);
        expect(run.stderr.toLowerCase()).toContain('warning');
        expect(run.stderr).toContain('1536');
        await assertNotInstalled(fixture);
      } finally {
        await fixture.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'NOODARA_SKIP_RESOURCE_CHECK=1 proceeds past a failing 512MB check (bounded by a busy port right after it)',
    async () => {
      const fixture = await startInstallerDind({ ubuntu: '22.04' });
      try {
        const meminfoPath = '/tmp/noodara-meminfo-512-skip';
        await writeFixtureFile(fixture, meminfoPath, meminfoContent(524288));
        await startBusyPortListener(fixture, FIXTURE_PANEL_PORT);

        const run = await fixture.runInstallSh(
          runInstallEnv({ NOODARA_MEMINFO_FILE: meminfoPath, NOODARA_SKIP_RESOURCE_CHECK: '1' }),
          { timeoutMs: INSTALL_TIMEOUT_MS },
        );

        expect(run.exitCode).toBe(16);
        expect(run.stdout).toContain('NOODARA_SKIP_RESOURCE_CHECK=1');
        await assertNotInstalled(fixture);
      } finally {
        await fixture.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'combined snap + busy port: exits 17, and the port is never mentioned (D-17 ordering, 06-RESEARCH.md Pitfall 6)',
    async () => {
      const fixture = await startInstallerDind({ ubuntu: '22.04', withSnapDocker: true });
      try {
        await startBusyPortListener(fixture, FIXTURE_PANEL_PORT);

        const run = await fixture.runInstallSh(runInstallEnv(), { timeoutMs: INSTALL_TIMEOUT_MS });

        expect(run.exitCode).toBe(17);
        expect(run.stderr).toContain('snap');
        expect(run.stderr).not.toContain('already in use');
        expect(run.stderr).not.toContain(String(FIXTURE_PANEL_PORT));
        await assertNotInstalled(fixture);
      } finally {
        await fixture.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    'non-root: running install.sh as an unprivileged user exits 10, and writes nothing',
    async () => {
      const fixture = await startInstallerDind({ ubuntu: '22.04' });
      try {
        const run = await fixture.runInstallSh(runInstallEnv(), {
          timeoutMs: INSTALL_TIMEOUT_MS,
          user: 'nobody',
        });

        expect(run.exitCode).toBe(10);
        expect(run.stderr.toLowerCase()).toContain('root');
        await assertNotInstalled(fixture);
      } finally {
        await fixture.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------
  // NETWORK-DEPENDENT (hard_rule #8): the ONLY test in this entire phase that reaches the public
  // internet (download.docker.com + Ubuntu's own apt mirrors). Ubuntu 22.04 only, its own generous
  // timeout. Every other test above and in every sibling installer suite uses
  // NOODARA_INTERNAL_IMAGE_PREFIX / an explicit NOODARA_VERSION / an explicit NOODARA_PUBLIC_URL,
  // needing no internet/DNS at all.
  //
  // The withDocker:false fixture has no dockerd and no systemd to start one once install.sh's own
  // real `apt-get install docker-ce ...` makes the binary appear -- entirely a FIXTURE limitation
  // (a real VPS has systemd to do this "for free"), solved in tests/integration/images/
  // installer-dind-common/entrypoint.sh's own background watcher (06-12-PLAN.md commit
  // "fix(06-12): start dockerd once install.sh installs it in the no-Docker fixture"), never a
  // test-only branch inside install.sh. Loading the real production images into a daemon that does
  // not exist yet is also impossible from the test side without racing install.sh's own bounded
  // noodara_wait_for_docker_ready -- solved by pre-populating this fixture's OWN /var/lib/docker
  // volume from a "donor" fixture (withDocker:true, images loaded normally) BEFORE the withDocker:
  // false fixture's daemon ever starts, so the images are already present the instant the
  // apt-installed daemon comes up -- no live image-loading race to lose.
  // ---------------------------------------------------------------------------------------------
  describe('no-Docker apt install path (D-14, INST-01, network-dependent, Ubuntu 22.04 only)', () => {
    it(
      'installs Docker Engine and the Compose plugin from the apt repository, then completes the install with a healthy stack',
      async () => {
        const volumeName = `noodara-nodocker-donor-${randomUUID()}`;
        // Post-execution fix (orchestrator audit WR-06): both the build and the volume create
        // previously ran BEFORE this try block -- a failure in that two-line window (the volume
        // create throwing, for example) left the just-built ~1.6GB images never removed. Both now
        // run inside the try, and each cleanup call in `finally` is guarded so it only runs
        // against something this run actually created.
        let images: BuiltImages | undefined;
        let volumeCreated = false;
        let donor: InstallerDindFixture | undefined;
        let target: InstallerDindFixture | undefined;
        try {
          images = buildInstallerScenarioImages('0612-nodocker');
          execFileSync('docker', ['volume', 'create', '--label', 'noodara.test=true', volumeName], {
            timeout: 60_000,
            stdio: 'ignore',
          });
          volumeCreated = true;

          donor = await startInstallerDind({ ubuntu: '22.04', withDocker: true, reuseDockerVolume: volumeName });
          await loadComposeImagesInto(donor, images);
          await donor.stop();
          donor = undefined;

          target = await startInstallerDind({ ubuntu: '22.04', withDocker: false, reuseDockerVolume: volumeName });

          const run = await target.runInstallSh(
            {
              NOODARA_INTERNAL_IMAGE_PREFIX: images.imagePrefix,
              NOODARA_VERSION: images.version,
              NOODARA_PUBLIC_URL: `http://127.0.0.1:${String(FIXTURE_PANEL_PORT)}`,
              NOODARA_PORT: String(FIXTURE_PANEL_PORT),
            },
            { timeoutMs: NO_DOCKER_TIMEOUT_MS },
          );

          expect(run.exitCode, `install.sh exit ${String(run.exitCode)}, stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(
            0,
          );

          // Docker genuinely came from Docker's own apt repository -- never docker.io, never a
          // get.docker.com script (hard_rule #8, T-06-06).
          const dpkgResult = await target.exec(['dpkg-query', '-W', '-f', '${Version}', 'docker-ce']);
          expect(dpkgResult.exitCode, dpkgResult.stderr).toBe(0);
          expect(dpkgResult.stdout.length).toBeGreaterThan(0);

          const sourcesResult = await target.exec(['cat', '/etc/apt/sources.list.d/docker.list']);
          expect(sourcesResult.exitCode).toBe(0);
          expect(sourcesResult.stdout).toContain('download.docker.com');
          expect(sourcesResult.stdout).toContain('signed-by=/etc/apt/keyrings/docker.asc');

          const keyringModeResult = await target.exec(['stat', '-c', '%a', '/etc/apt/keyrings/docker.asc']);
          expect(keyringModeResult.stdout.trim()).toBe('644');

          const keyringHeadResult = await target.exec(['head', '-n', '1', '/etc/apt/keyrings/docker.asc']);
          expect(keyringHeadResult.stdout.trim()).toBe('-----BEGIN PGP PUBLIC KEY BLOCK-----');

          const policyResult = await target.exec(['apt-cache', 'policy', 'docker-ce']);
          expect(policyResult.stdout).toContain('download.docker.com');

          const dockerIoResult = await target.exec([
            '/bin/sh',
            '-c',
            'dpkg -l docker.io 2>/dev/null | grep -q "^ii" && echo present || echo absent',
          ]);
          expect(dockerIoResult.stdout.trim()).toBe('absent');
          expect(run.stdout).not.toContain('get.docker.com');
          expect(run.stderr).not.toContain('get.docker.com');

          const services = await composePsInFixture(target, INSTALL_DIR);
          const byService = new Map(services.map((entry) => [entry.Service, entry]));
          for (const name of ['postgres', 'redis', 'api', 'web']) {
            expect(byService.get(name)?.Health, `${name} health`).toBe('healthy');
          }

          const envRaw = await readFixtureFile(target, `${INSTALL_DIR}/.env`);
          const env = parseEnvFile(envRaw);
          const installLog = await readFixtureFile(target, `${INSTALL_DIR}/install.log`);
          assertNoSecretLeak(runResultToStreams(run, installLog), env);
        } finally {
          await donor?.stop();
          await target?.stop();
          if (volumeCreated) {
            execFileSync('docker', ['volume', 'rm', '-f', volumeName], { stdio: 'ignore', timeout: 60_000 });
          }
          if (images) {
            removeBuiltImages(images);
          }
          await assertNoStrayTestContainers();
        }
      },
      NO_DOCKER_TIMEOUT_MS,
    );
  });
});
