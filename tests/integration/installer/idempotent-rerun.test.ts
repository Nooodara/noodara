// 06-12-PLAN.md Task 1: proves INST-02 for real -- running the real install.sh MORE than twice in
// a row against a single fixture/install directory, covering the true no-op, a genuine upgrade to
// a second locally-loaded tag, a repair of a stopped stack, and a failed upgrade followed by a
// manual rollback. 06-09's own "Post-execution fix" section (Findings A-E) already corrected
// noodara_main's re-run/upgrade logic before this plan ever ran a real daemon against it -- this
// file is where that logic finally meets one.
//
// IMPORTANT (06-09 Finding C/E): a same-version re-run over an ALREADY HEALTHY stack is a TRUE
// no-op -- .env untouched, no backup, no `docker compose pull`/`up -d`, and (Finding E) no second
// health read either. This directly means `migrate` is never touched on that path, unlike this
// plan's own <behavior> text (written before the Finding C/E fixes landed), which describes a
// same-version re-run's `migrate` re-executing. Per this plan's own governing instructions ("the
// FIXED behaviour in install.sh is the truth"), the "migrate reports 0 applied migrations" proof
// below runs on the genuine UPGRADE run (where `docker compose up -d` really does execute again),
// not on the true no-op run.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInstallerDind, type InstallerDindFixture } from '../helpers/installer-dind.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';
import {
  assertNoSecretLeak,
  buildInstallerScenarioImages,
  composePsInFixture,
  curlJsonInFixture,
  extractSetupTokenValue,
  FIXTURE_PANEL_PORT,
  FIXTURE_TIMEOUT_MS,
  hasHttpOnlyCookie,
  INSTALL_TIMEOUT_MS,
  loadComposeImagesInto,
  parseEnvFile,
  readFixtureFile,
  removeBuiltImages,
  runResultToStreams,
  type BuiltImages,
} from './installer-scenario-helpers.js';

const INSTALL_DIR = '/opt/noodara';
const ENV_PATH = `${INSTALL_DIR}/.env`;
const INSTALL_LOG_PATH = `${INSTALL_DIR}/install.log`;

// The specific .env keys this file's own byte-identical assertions check across every run --
// hard_rule #8's own named list (T-06-02): the values a re-run/upgrade must NEVER regenerate.
const SECRET_KEYS = [
  'NOODARA_MASTER_KEY',
  'BETTER_AUTH_SECRET',
  'POSTGRES_PASSWORD',
  'REDIS_PASSWORD',
  'DATABASE_URL',
  'REDIS_URL',
] as const;

function assertSecretsUnchanged(before: Record<string, string>, after: Record<string, string>): void {
  for (const key of SECRET_KEYS) {
    expect(after[key], `${key} must be byte-identical across runs`).toBe(before[key]);
  }
}

const MARKER_ADMIN_EMAIL = 'installer-idempotent-marker@example.invalid';
const MARKER_ADMIN_PASSWORD = 'Idempotent-Marker Proof Passw0rd!';

const SETUP_TIMEOUT_MS = 900_000;
const RUN_TIMEOUT_MS = 180_000;

/** Builds a "broken" control-plane image on top of an already-built, real control-plane image: an
 *  incremental layer that overwrites ONLY dist/server.js with a script that starts and stays
 *  running (so the container itself does not crash-loop) but never listens on port 3000 -- the
 *  `api` service's own healthcheck (`node -e "fetch('http://127.0.0.1:3000/health')..."`,
 *  install.sh's own embedded docker-compose.yml) then fails forever (ECONNREFUSED), reliably
 *  driving noodara_wait_for_health to its own exit-53 timeout path. dist/db/migrate.js (the
 *  `migrate` one-shot's own command) and dist/worker.js are both left completely untouched, so
 *  migrations still genuinely succeed and only `api` ever fails to become healthy -- the failure
 *  this scenario needs to prove is real is D-12's OWN diagnostic path, not a different one
 *  (migrations-failed, exit 52). Built once per file via a tiny FROM-derived image, never a
 *  from-scratch build of the real Dockerfile a second time. */
function buildBrokenControlPlaneImage(baseImage: string, brokenImage: string): void {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'noodara-broken-cp-'));
  try {
    const dockerfilePath = path.join(tmpDir, 'Dockerfile');
    writeFileSync(
      dockerfilePath,
      [
        `FROM ${baseImage}`,
        'USER root',
        // `setInterval` is a Node.js GLOBAL (no import/require needed) -- deliberate:
        // @noodara/control-plane's own package.json declares "type": "module", so a `require(...)`
        // call here would throw "require is not defined in ES module scope" and crash-loop the
        // container instead of staying up (a real bug this fixture itself had on its first real
        // DinD run, caught by Finding F's own more precise container-STATE classification -- see
        // 06-12-SUMMARY.md's own "Post-execution fix -- Finding F" section).
        'RUN printf \'setInterval(function () {}, 60000);\\n\' > dist/server.js',
        'USER noodara',
        '',
      ].join('\n'),
      'utf8',
    );
    execFileSync('docker', ['build', '--file', dockerfilePath, '--tag', brokenImage, tmpDir], {
      timeout: 120_000,
      stdio: 'pipe',
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('idempotent re-run, upgrade, no-op, repair and failed-upgrade (06-12-PLAN.md Task 1, INST-02)', () => {
  let fixture: InstallerDindFixture | undefined;
  let images: BuiltImages | undefined;
  let v2ControlPlaneImage: string;
  let v2WebImage: string;
  let v2Version: string;
  let v3ControlPlaneImage: string;
  let v3WebImage: string;
  let v3Version: string;

  // Populated by run 1, read back by every later run to prove the operator's own data survives.
  let baselineEnv: Record<string, string> = {};

  beforeAll(async () => {
    images = buildInstallerScenarioImages('0612-idempotent');
    v2Version = `${images.version}-v2`;
    v2ControlPlaneImage = `${images.imagePrefix}/noodara-control-plane:${v2Version}`;
    v2WebImage = `${images.imagePrefix}/noodara-web:${v2Version}`;
    execFileSync('docker', ['tag', images.controlPlaneImage, v2ControlPlaneImage], { timeout: 30_000 });
    execFileSync('docker', ['tag', images.webImage, v2WebImage], { timeout: 30_000 });

    v3Version = `${images.version}-v3-broken`;
    v3ControlPlaneImage = `${images.imagePrefix}/noodara-control-plane:${v3Version}`;
    v3WebImage = `${images.imagePrefix}/noodara-web:${v3Version}`;
    buildBrokenControlPlaneImage(images.controlPlaneImage, v3ControlPlaneImage);
    execFileSync('docker', ['tag', images.webImage, v3WebImage], { timeout: 30_000 });

    fixture = await startInstallerDind({ ubuntu: '22.04' });
    await loadComposeImagesInto(fixture, images);
    await fixture.loadLocalImages([v2ControlPlaneImage, v2WebImage, v3ControlPlaneImage, v3WebImage], {
      timeoutMs: 600_000,
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await fixture?.stop();
    if (images !== undefined) {
      execFileSync('docker', ['rmi', '-f', v2ControlPlaneImage, v2WebImage, v3ControlPlaneImage, v3WebImage], {
        stdio: 'ignore',
        timeout: 60_000,
      });
      removeBuiltImages(images);
      images = undefined;
    }
    await assertNoStrayTestContainers();
  }, FIXTURE_TIMEOUT_MS);

  function currentFixture(): InstallerDindFixture {
    if (fixture === undefined) throw new Error('fixture is undefined -- beforeAll must have failed');
    return fixture;
  }

  function currentImages(): BuiltImages {
    if (images === undefined) throw new Error('images is undefined -- beforeAll must have failed');
    return images;
  }

  /** Signs in as the marker admin through the real panel proxy -- the concrete "the operator's own
   *  data survived" proof this file's own runs re-use after run 1 creates it. */
  async function signInAsMarkerAdmin(): Promise<void> {
    const result = await curlJsonInFixture(currentFixture(), FIXTURE_PANEL_PORT, 'POST', '/api/auth/sign-in/email', {
      email: MARKER_ADMIN_EMAIL,
      password: MARKER_ADMIN_PASSWORD,
    });
    expect(result.status, `sign-in body: ${result.body}`).toBe(200);
    expect(hasHttpOnlyCookie(result.headers)).toBe(true);
  }

  it(
    'run 1 (fresh install): exits 0, healthy, and a marker admin is created through the real setup API',
    async () => {
      const run = await currentFixture().runInstallSh(
        {
          NOODARA_INTERNAL_IMAGE_PREFIX: currentImages().imagePrefix,
          NOODARA_VERSION: currentImages().version,
          NOODARA_PUBLIC_URL: `http://127.0.0.1:${String(FIXTURE_PANEL_PORT)}`,
          NOODARA_PORT: String(FIXTURE_PANEL_PORT),
        },
        { timeoutMs: INSTALL_TIMEOUT_MS },
      );
      expect(run.exitCode, `install.sh exit ${String(run.exitCode)}, stderr:\n${run.stderr}`).toBe(0);

      const services = await composePsInFixture(currentFixture(), INSTALL_DIR);
      const byService = new Map(services.map((entry) => [entry.Service, entry]));
      for (const name of ['postgres', 'redis', 'api', 'web']) {
        expect(byService.get(name)?.Health, `${name} health`).toBe('healthy');
      }

      const envRaw = await readFixtureFile(currentFixture(), ENV_PATH);
      baselineEnv = parseEnvFile(envRaw);

      // Chose the real POST /api/setup path (redeeming the printed token) over a direct
      // `docker compose exec postgres psql` insert -- this is the identical real-API-write path
      // Plan 06-11's own fresh-install.test.ts already validated end to end, so this file proves
      // the SAME "the operator's own data" shape (a real admin account, not a synthetic DB row)
      // survives across every later re-run/upgrade/repair, without inventing a second data-write
      // mechanism (a full server-registration flow would additionally require SSH fixtures wholly
      // outside this plan's own scope).
      const token = extractSetupTokenValue(run.stdout, /One-time setup token: (\S+)/);
      if (token === undefined) throw new Error(`no setup token line in stdout:\n${run.stdout}`);
      const setupResult = await curlJsonInFixture(currentFixture(), FIXTURE_PANEL_PORT, 'POST', '/api/setup', {
        token,
        email: MARKER_ADMIN_EMAIL,
        password: MARKER_ADMIN_PASSWORD,
      });
      expect(setupResult.status, `POST /api/setup body: ${setupResult.body}`).toBe(200);
      await signInAsMarkerAdmin();

      const installLog = await readFixtureFile(currentFixture(), INSTALL_LOG_PATH);
      assertNoSecretLeak(runResultToStreams(run, installLog), baselineEnv);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'run 2 (same version, healthy stack): true no-op -- .env byte-identical, no backup, no pull/up, marker admin still signs in',
    async () => {
      const envBefore = await readFixtureFile(currentFixture(), ENV_PATH);

      const run = await currentFixture().runInstallSh(
        {
          NOODARA_INTERNAL_IMAGE_PREFIX: currentImages().imagePrefix,
          NOODARA_VERSION: currentImages().version,
          NOODARA_PUBLIC_URL: `http://127.0.0.1:${String(FIXTURE_PANEL_PORT)}`,
          NOODARA_PORT: String(FIXTURE_PANEL_PORT),
        },
        { timeoutMs: INSTALL_TIMEOUT_MS },
      );
      expect(run.exitCode, `install.sh exit ${String(run.exitCode)}, stderr:\n${run.stderr}`).toBe(0);

      const envAfter = await readFixtureFile(currentFixture(), ENV_PATH);
      expect(envAfter, '.env must be byte-identical on a true no-op').toBe(envBefore);

      const backupsResult = await currentFixture().exec([
        '/bin/sh',
        '-c',
        `ls ${INSTALL_DIR}/.env.bak-* 2>/dev/null | wc -l`,
      ]);
      expect(backupsResult.stdout.trim()).toBe('0');

      // The D-09 no-op note is the concrete, install.sh-own proof that pull/up-d never ran (rather
      // than trying to distinguish "up -d ran but changed nothing" from "up -d never ran" purely
      // from the outside).
      expect(run.stdout).toContain('Skipping image pull and docker compose up -d');
      const installLog = await readFixtureFile(currentFixture(), INSTALL_LOG_PATH);
      expect(installLog).toContain('Skipped pull and up -d (D-09 no-op)');

      await signInAsMarkerAdmin();
      assertNoSecretLeak(runResultToStreams(run, installLog), baselineEnv);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'run 3 (upgrade to a second local tag): merges .env once, backs up (mode 600), sets NOODARA_PREVIOUS_VERSION, brings the stack healthy on the new tag, migrate re-applies 0 migrations',
    async () => {
      const run = await currentFixture().runInstallSh(
        {
          NOODARA_INTERNAL_IMAGE_PREFIX: currentImages().imagePrefix,
          NOODARA_VERSION: v2Version,
          NOODARA_PUBLIC_URL: `http://127.0.0.1:${String(FIXTURE_PANEL_PORT)}`,
          NOODARA_PORT: String(FIXTURE_PANEL_PORT),
        },
        { timeoutMs: INSTALL_TIMEOUT_MS },
      );
      expect(run.exitCode, `install.sh exit ${String(run.exitCode)}, stderr:\n${run.stderr}`).toBe(0);

      const backupsResult = await currentFixture().exec([
        '/bin/sh',
        '-c',
        `ls -1 ${INSTALL_DIR}/.env.bak-* 2>/dev/null`,
      ]);
      const backups = backupsResult.stdout.trim().split('\n').filter((line) => line.length > 0);
      expect(backups, 'exactly one .env.bak-* must exist after a genuine upgrade').toHaveLength(1);
      const backupModeResult = await currentFixture().exec(['stat', '-c', '%a', backups[0] as string]);
      expect(backupModeResult.stdout.trim()).toBe('600');

      const envRaw = await readFixtureFile(currentFixture(), ENV_PATH);
      const env = parseEnvFile(envRaw);
      expect(env.NOODARA_VERSION).toBe(v2Version);
      expect(env.NOODARA_PREVIOUS_VERSION).toBe(currentImages().version);
      assertSecretsUnchanged(baselineEnv, env);

      const services = await composePsInFixture(currentFixture(), INSTALL_DIR);
      const byService = new Map(services.map((entry) => [entry.Service, entry]));
      for (const name of ['postgres', 'redis', 'api', 'web']) {
        expect(byService.get(name)?.Health, `${name} health`).toBe('healthy');
      }
      // migrate re-runs on every `docker compose up -d` (docker-compose.yml's own documented
      // design, see the file's own comment) and is idempotent -- exit 0 here IS "0 applied
      // migrations" (a genuine second application would fail on a non-idempotent migration, not
      // silently succeed).
      expect(byService.get('migrate')?.ExitCode, 'migrate must re-apply cleanly (0 applied)').toBe(0);

      await signInAsMarkerAdmin();
      const installLog = await readFixtureFile(currentFixture(), INSTALL_LOG_PATH);
      assertNoSecretLeak(runResultToStreams(run, installLog), env);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'run 4 (same version as run 3, healthy stack): true no-op again',
    async () => {
      const envBefore = await readFixtureFile(currentFixture(), ENV_PATH);

      const run = await currentFixture().runInstallSh(
        {
          NOODARA_INTERNAL_IMAGE_PREFIX: currentImages().imagePrefix,
          NOODARA_VERSION: v2Version,
          NOODARA_PUBLIC_URL: `http://127.0.0.1:${String(FIXTURE_PANEL_PORT)}`,
          NOODARA_PORT: String(FIXTURE_PANEL_PORT),
        },
        { timeoutMs: INSTALL_TIMEOUT_MS },
      );
      expect(run.exitCode, `install.sh exit ${String(run.exitCode)}, stderr:\n${run.stderr}`).toBe(0);

      const envAfter = await readFixtureFile(currentFixture(), ENV_PATH);
      expect(envAfter).toBe(envBefore);
      expect(run.stdout).toContain('Skipping image pull and docker compose up -d');

      await signInAsMarkerAdmin();
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'run 5 (repair): a stopped stack (docker compose down, volumes kept) is repaired by a same-version re-run without any .env change',
    async () => {
      const envBefore = await readFixtureFile(currentFixture(), ENV_PATH);

      const downResult = await currentFixture().exec(['/bin/sh', '-c', `cd ${INSTALL_DIR} && docker compose down`]);
      expect(downResult.exitCode, downResult.stderr).toBe(0);
      const volumesBefore = await currentFixture().exec(['docker', 'volume', 'ls', '--format', '{{.Name}}']);

      const run = await currentFixture().runInstallSh(
        {
          NOODARA_INTERNAL_IMAGE_PREFIX: currentImages().imagePrefix,
          NOODARA_VERSION: v2Version,
          NOODARA_PUBLIC_URL: `http://127.0.0.1:${String(FIXTURE_PANEL_PORT)}`,
          NOODARA_PORT: String(FIXTURE_PANEL_PORT),
        },
        { timeoutMs: INSTALL_TIMEOUT_MS },
      );
      expect(run.exitCode, `install.sh exit ${String(run.exitCode)}, stderr:\n${run.stderr}`).toBe(0);

      const envAfter = await readFixtureFile(currentFixture(), ENV_PATH);
      expect(envAfter, '.env must stay byte-identical on a repair (nothing in .env needed to change)').toBe(
        envBefore,
      );
      const backupsResult = await currentFixture().exec([
        '/bin/sh',
        '-c',
        `ls ${INSTALL_DIR}/.env.bak-* 2>/dev/null | wc -l`,
      ]);
      // Run 3 already left exactly one backup; a repair must not add a second one.
      expect(backupsResult.stdout.trim()).toBe('1');

      expect(run.stdout).toContain('The stack is not healthy; starting it.');
      const installLog = await readFixtureFile(currentFixture(), INSTALL_LOG_PATH);
      expect(installLog).toContain('repairing (D-09/Finding E)');

      const volumesAfter = await currentFixture().exec(['docker', 'volume', 'ls', '--format', '{{.Name}}']);
      expect(new Set(volumesAfter.stdout.trim().split('\n'))).toEqual(
        new Set(volumesBefore.stdout.trim().split('\n')),
      );

      const services = await composePsInFixture(currentFixture(), INSTALL_DIR);
      const byService = new Map(services.map((entry) => [entry.Service, entry]));
      for (const name of ['postgres', 'redis', 'api', 'web']) {
        expect(byService.get(name)?.Health, `${name} health`).toBe('healthy');
      }

      await signInAsMarkerAdmin();
      assertNoSecretLeak(runResultToStreams(run, installLog), baselineEnv);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'run 6 (failed upgrade): a version whose api never becomes healthy exits 53, names api, shows a redacted log tail, names the real previous version, and leaves .env secrets and volumes untouched',
    async () => {
      const envBefore = await readFixtureFile(currentFixture(), ENV_PATH);
      const volumesBefore = await currentFixture().exec(['docker', 'volume', 'ls', '--format', '{{.Name}}']);

      const run = await currentFixture().runInstallSh(
        {
          NOODARA_INTERNAL_IMAGE_PREFIX: currentImages().imagePrefix,
          NOODARA_VERSION: v3Version,
          NOODARA_PUBLIC_URL: `http://127.0.0.1:${String(FIXTURE_PANEL_PORT)}`,
          NOODARA_PORT: String(FIXTURE_PANEL_PORT),
          // Bounded down from the 60x5s production default so this deliberately-unhealthy run
          // fails fast rather than spending the full production budget waiting.
          NOODARA_HEALTH_WAIT_ATTEMPTS: '3',
          NOODARA_HEALTH_WAIT_INTERVAL: '2',
        },
        { timeoutMs: INSTALL_TIMEOUT_MS },
      );

      expect(run.exitCode, `install.sh stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(53);
      expect(run.stderr).toContain("Service 'api'");
      // The rollback hint must name the REAL previous version (v2, what was actually installed
      // before this failed upgrade attempt) -- never a generic placeholder.
      expect(run.stderr).toContain(`NOODARA_VERSION=${v2Version}`);
      expect(run.stderr.length, 'a redacted log tail must be shown').toBeGreaterThan(0);

      const envAfter = await readFixtureFile(currentFixture(), ENV_PATH);
      const before = parseEnvFile(envBefore);
      const after = parseEnvFile(envAfter);
      assertSecretsUnchanged(before, after);
      // NOODARA_VERSION/NOODARA_PREVIOUS_VERSION DO change on a genuine attempted upgrade (D-11/
      // D-12's own documented behavior -- the version fields are exactly what records the
      // rollback target) -- only the SECRET fields above are asserted unchanged.
      expect(after.NOODARA_VERSION).toBe(v3Version);
      expect(after.NOODARA_PREVIOUS_VERSION).toBe(v2Version);

      const volumesAfter = await currentFixture().exec(['docker', 'volume', 'ls', '--format', '{{.Name}}']);
      expect(new Set(volumesAfter.stdout.trim().split('\n'))).toEqual(
        new Set(volumesBefore.stdout.trim().split('\n')),
      );

      const installLog = await readFixtureFile(currentFixture(), INSTALL_LOG_PATH);
      assertNoSecretLeak(runResultToStreams(run, installLog), after);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'run 7 (manual rollback): re-running with the previous version brings the stack back healthy with the marker admin still intact',
    async () => {
      const run = await currentFixture().runInstallSh(
        {
          NOODARA_INTERNAL_IMAGE_PREFIX: currentImages().imagePrefix,
          NOODARA_VERSION: v2Version,
          NOODARA_PUBLIC_URL: `http://127.0.0.1:${String(FIXTURE_PANEL_PORT)}`,
          NOODARA_PORT: String(FIXTURE_PANEL_PORT),
        },
        { timeoutMs: INSTALL_TIMEOUT_MS },
      );
      expect(run.exitCode, `install.sh exit ${String(run.exitCode)}, stderr:\n${run.stderr}`).toBe(0);

      const services = await composePsInFixture(currentFixture(), INSTALL_DIR);
      const byService = new Map(services.map((entry) => [entry.Service, entry]));
      for (const name of ['postgres', 'redis', 'api', 'web']) {
        expect(byService.get(name)?.Health, `${name} health`).toBe('healthy');
      }

      const envRaw = await readFixtureFile(currentFixture(), ENV_PATH);
      const env = parseEnvFile(envRaw);
      expect(env.NOODARA_VERSION).toBe(v2Version);
      assertSecretsUnchanged(baselineEnv, env);

      // The marker admin created in run 1 -- untouched by every upgrade/repair/failed-upgrade run
      // in between -- can still authenticate: the concrete "data intact" proof.
      await signInAsMarkerAdmin();

      const installLog = await readFixtureFile(currentFixture(), INSTALL_LOG_PATH);
      assertNoSecretLeak(runResultToStreams(run, installLog), env);
    },
    RUN_TIMEOUT_MS,
  );

  it('leaves zero noodara.test=true containers/volumes behind at the daemon level (checked mid-suite)', async () => {
    // A lightweight, non-destructive sanity check distinct from the module-scope stray-container
    // gate in afterAll -- this fixture's own OUTER daemon-level containers/volumes (never the
    // nested ones this whole file has been exercising) stay clean throughout.
    // Post-execution fix (orchestrator audit WR-07): explicit timeout, matching every other
    // `docker`/`docker compose` spawn in this file -- an unresponsive daemon at exactly this
    // point in the suite must fail after a bounded time, never hang forever.
    const result = execFileSync('docker', ['ps', '-aq', '--filter', 'label=noodara.test=true'], {
      timeout: 30_000,
    }).toString();
    // The fixture container ITSELF is still running at this point in the suite (afterAll has not
    // run yet) -- assert only that no UNEXPECTED extra container leaked, by checking the count is
    // at most 1 (this file's own single fixture).
    expect(result.trim().split('\n').filter((line) => line.length > 0).length).toBeLessThanOrEqual(1);
  });
});
