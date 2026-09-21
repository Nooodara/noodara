// 06-11-PLAN.md Task 1: the first real, end-to-end run of the real install.sh -- a clean Ubuntu
// 22.04/24.04 Docker-in-Docker container (Plan 06-10's harness), the real production Dockerfiles
// (Plans 06-03/06-05) built once and loaded with no registry (D-19), driven against the real
// docker-compose.yml (Plan 06-07) that install.sh itself embeds (Plan 06-09). Every earlier plan
// in this phase only ever stubbed `docker`; this is the first place a real daemon, a real Compose
// plugin and real images decide whether install.sh's own composition genuinely works.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInstallerDind, type InstallerDindFixture, type InstallerDindUbuntu } from '../helpers/installer-dind.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';
import {
  assertNoSecretLeak,
  assertSetupTokenOnlyOnceInStdout,
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
  statFixturePath,
  type BuiltImages,
} from './installer-scenario-helpers.js';

const UBUNTU_VERSIONS: InstallerDindUbuntu[] = ['22.04', '24.04'];
const INSTALL_DIR = '/opt/noodara';
const ENV_PATH = `${INSTALL_DIR}/.env`;
const INSTALL_LOG_PATH = `${INSTALL_DIR}/install.log`;
const COMPOSE_PATH = `${INSTALL_DIR}/docker-compose.yml`;

// Real synthetic admin used ONLY to redeem the printed token and prove it is usable (INST-04,
// hard_rule #8) -- never a real credential, and itself asserted to never leak (it is not a
// *generated* secret, so it is out of scope for the T-06-02 canary, but the sign-in cookie's own
// HttpOnly attribute is still checked).
const SYNTHETIC_ADMIN_EMAIL = 'installer-fresh-install@example.invalid';
const SYNTHETIC_ADMIN_PASSWORD = 'Fresh-Install Proof Passw0rd!';

// Building both real production images (~1.6GB combined) is by far the most expensive part of
// this suite -- generous but explicit, matching compose-stack.test.ts's own BUILD_TIMEOUT_MS
// precedent for the identical build.
const SETUP_TIMEOUT_MS = 900_000;

let images: BuiltImages | undefined;

describe.each(UBUNTU_VERSIONS)('fresh install on Ubuntu %s (06-11-PLAN.md Task 1, INST-01/INST-04)', (ubuntu) => {
  let fixture: InstallerDindFixture | undefined;

  beforeAll(async () => {
    // Built ONCE and reused across both Ubuntu-version describe blocks in this file -- the module-
    // scope `images` guard makes the second describe block's own beforeAll a no-op rebuild.
    images ??= buildInstallerScenarioImages('0611-fresh');
    fixture = await startInstallerDind({ ubuntu });
    await loadComposeImagesInto(fixture, images);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await fixture?.stop();
    // noodara-tdd skill Sec.5 / hard_rule #7: no container labelled noodara.test=true survives.
    await assertNoStrayTestContainers();
  }, FIXTURE_TIMEOUT_MS);

  it(
    'runs install.sh once, brings up a healthy six-service stack, and proves the printed token is real and usable',
    async () => {
      if (fixture === undefined) throw new Error('fixture is undefined -- beforeAll must have failed');
      const builtImages = images;
      if (builtImages === undefined) throw new Error('images is undefined -- beforeAll must have failed');

      const run = await fixture.runInstallSh(
        {
          NOODARA_INTERNAL_IMAGE_PREFIX: builtImages.imagePrefix,
          NOODARA_VERSION: builtImages.version,
          NOODARA_PUBLIC_URL: `http://127.0.0.1:${String(FIXTURE_PANEL_PORT)}`,
          NOODARA_PORT: String(FIXTURE_PANEL_PORT),
        },
        { timeoutMs: INSTALL_TIMEOUT_MS },
      );

      expect(run.exitCode, `install.sh exit ${String(run.exitCode)}, stderr:\n${run.stderr}`).toBe(0);

      // .env and docker-compose.yml both exist, .env is mode 600.
      const envRaw = await readFixtureFile(fixture, ENV_PATH);
      const env = parseEnvFile(envRaw);
      expect(await statFixturePath(fixture, ENV_PATH)).toBe('600 root:root');
      await readFixtureFile(fixture, COMPOSE_PATH); // exists, throws otherwise

      // Six services, migrate exited 0, api/web/postgres/redis healthy.
      const services = await composePsInFixture(fixture, INSTALL_DIR);
      const byService = new Map(services.map((entry) => [entry.Service, entry]));
      for (const name of ['postgres', 'redis', 'api', 'web']) {
        const entry = byService.get(name);
        if (entry === undefined) throw new Error(`no docker compose ps entry for "${name}"`);
        expect(entry.Health, `${name} health`).toBe('healthy');
      }
      const migrateEntry = byService.get('migrate');
      if (migrateEntry === undefined) throw new Error('no docker compose ps entry for "migrate"');
      expect(migrateEntry.ExitCode).toBe(0);

      // Only web publishes a host port (hard_rule #8).
      for (const entry of services) {
        const publishedPorts = entry.Publishers.filter((publisher) => publisher.PublishedPort !== 0);
        if (entry.Service === 'web') {
          expect(publishedPorts.length, 'web should publish exactly one host port').toBe(1);
        } else {
          expect(publishedPorts, `${entry.Service} must not publish any host port`).toHaveLength(0);
        }
      }

      // The installer's stdout names the resolved panel URL.
      expect(run.stdout).toContain(`Panel: http://127.0.0.1:${String(FIXTURE_PANEL_PORT)}`);

      // T-06-45: the printed token equals the value the api container's own logs actually
      // emitted -- byte equality, not merely both non-empty.
      const printedToken = extractSetupTokenValue(run.stdout, /One-time setup token: (\S+)/);
      if (printedToken === undefined) throw new Error(`no setup token line in stdout:\n${run.stdout}`);

      const apiLogsResult = await fixture.exec(['/bin/sh', '-c', `cd ${INSTALL_DIR} && docker compose logs api`]);
      expect(apiLogsResult.exitCode).toBe(0);
      const loggedToken = extractSetupTokenValue(apiLogsResult.stdout, /NOODARA_SETUP_TOKEN=(\S+)/);
      if (loggedToken === undefined) throw new Error(`no NOODARA_SETUP_TOKEN= line in api logs:\n${apiLogsResult.stdout}`);
      expect(printedToken).toBe(loggedToken);

      // The panel serves the real Next.js app.
      const rootResult = await fixture.exec([
        '/bin/sh',
        '-c',
        `curl -s -o /tmp/noodara-root-body -w '%{http_code}' http://127.0.0.1:${String(FIXTURE_PANEL_PORT)}/`,
      ]);
      expect(rootResult.exitCode).toBe(0);
      expect(Number(rootResult.stdout.trim())).toBe(200);
      const rootBody = await readFixtureFile(fixture, '/tmp/noodara-root-body');
      expect(rootBody.toLowerCase()).toContain('<!doctype html');

      // INST-04 (hard_rule #8): redeem the printed token through the real panel proxy (proves
      // /api/* reaches Fastify AND that the token is genuinely usable, not merely printed), then
      // sign in with the freshly created admin through the same proxy.
      const setupResult = await curlJsonInFixture(fixture, FIXTURE_PANEL_PORT, 'POST', '/api/setup', {
        token: printedToken,
        email: SYNTHETIC_ADMIN_EMAIL,
        password: SYNTHETIC_ADMIN_PASSWORD,
      });
      expect(setupResult.status, `POST /api/setup body: ${setupResult.body}`).toBe(200);

      const signInResult = await curlJsonInFixture(fixture, FIXTURE_PANEL_PORT, 'POST', '/api/auth/sign-in/email', {
        email: SYNTHETIC_ADMIN_EMAIL,
        password: SYNTHETIC_ADMIN_PASSWORD,
      });
      expect(signInResult.status, `POST /api/auth/sign-in/email body: ${signInResult.body}`).toBe(200);
      expect(hasHttpOnlyCookie(signInResult.headers), `sign-in response headers:\n${signInResult.headers}`).toBe(true);

      // T-06-02 canary: no generated secret reaches stdout, stderr or install.log; the setup token
      // occurs exactly once in stdout and never in install.log.
      const installLog = await readFixtureFile(fixture, INSTALL_LOG_PATH);
      const streams = runResultToStreams(run, installLog);
      assertNoSecretLeak(streams, env);
      assertSetupTokenOnlyOnceInStdout(streams, printedToken);
    },
    SETUP_TIMEOUT_MS,
  );
});

// Module-scope cleanup: the two images built once in the first describe block's beforeAll are
// removed exactly once, after every describe block in this file has finished -- never per-Ubuntu-
// version (they are shared).
afterAll(() => {
  if (images !== undefined) {
    removeBuiltImages(images);
    images = undefined;
  }
});
