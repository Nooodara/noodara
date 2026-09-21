// 06-11-PLAN.md Task 2: proves INST-05 for real -- `NOODARA_ADMIN_EMAIL`/`NOODARA_ADMIN_PASSWORD`
// supplied to the real install.sh make bootstrap-admin.ts (apps/control-plane) take the pre-seed
// branch instead of issuing a setup token, and the supplied credentials never reach stdout,
// stderr or install.log. Runs on Ubuntu 22.04 ONLY (see the plan's own <action> text): the
// pre-seed decision is entirely application-side (apps/control-plane/src/boot/bootstrap-admin.ts),
// already covered on both Ubuntu-irrelevant unit/integration layers; Task 1's own fresh-install
// scenario already proves install.sh itself works identically on both Ubuntu versions, so
// repeating this suite's own heaviest fixture (image build + load + full compose up) a second time
// here buys nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInstallerDind, type InstallerDindFixture } from '../helpers/installer-dind.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';
import {
  assertNoSecretLeak,
  buildInstallerScenarioImages,
  composePsInFixture,
  curlJsonInFixture,
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

// Policy-valid (packages/domain/src/validators/password.ts: >=12 chars, not a common password,
// not equal to the email/local part) AND carries the exact character classes install.sh's Finding
// B fix (06-04-SUMMARY.md) had to handle: a literal '$', a literal space, and the two-character
// ' #' sequence Compose's own .env parser treats as an inline comment when NOT single-quoted.
// Never a real credential.
const PRESEED_ADMIN_EMAIL = 'installer-preseed-admin@example.invalid';
const PRESEED_ADMIN_PASSWORD = 'Nood@ra$Preseed #1 Admin';

const SETUP_TIMEOUT_MS = 900_000;

let images: BuiltImages | undefined;

describe('admin pre-seed on Ubuntu 22.04 (06-11-PLAN.md Task 2, INST-05)', () => {
  let fixture: InstallerDindFixture | undefined;

  beforeAll(async () => {
    images = buildInstallerScenarioImages('0611-preseed');
    fixture = await startInstallerDind({ ubuntu: '22.04' });
    await loadComposeImagesInto(fixture, images);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await fixture?.stop();
    if (images !== undefined) {
      removeBuiltImages(images);
      images = undefined;
    }
    // noodara-tdd skill Sec.5 / hard_rule #7: no container labelled noodara.test=true survives.
    await assertNoStrayTestContainers();
  }, FIXTURE_TIMEOUT_MS);

  it(
    'creates the admin directly from NOODARA_ADMIN_EMAIL/PASSWORD, prints no token, and never leaks the credentials',
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
          NOODARA_ADMIN_EMAIL: PRESEED_ADMIN_EMAIL,
          NOODARA_ADMIN_PASSWORD: PRESEED_ADMIN_PASSWORD,
        },
        { timeoutMs: INSTALL_TIMEOUT_MS },
      );

      expect(run.exitCode, `install.sh exit ${String(run.exitCode)}, stderr:\n${run.stderr}`).toBe(0);

      const services = await composePsInFixture(fixture, INSTALL_DIR);
      const byService = new Map(services.map((entry) => [entry.Service, entry]));
      for (const name of ['postgres', 'redis', 'api', 'web']) {
        const entry = byService.get(name);
        if (entry === undefined) throw new Error(`no docker compose ps entry for "${name}"`);
        expect(entry.Health, `${name} health`).toBe('healthy');
      }

      // .env contains both pre-seed variables (install.sh writes them, single-quoted).
      const envRaw = await readFixtureFile(fixture, ENV_PATH);
      const env = parseEnvFile(envRaw);
      expect(env.NOODARA_ADMIN_EMAIL).toBe(PRESEED_ADMIN_EMAIL);
      expect(env.NOODARA_ADMIN_PASSWORD).toBe(PRESEED_ADMIN_PASSWORD);

      // The summary states the admin was created from the supplied credentials -- no token field.
      expect(run.stdout).toContain('Admin account created from the supplied NOODARA_ADMIN_EMAIL/NOODARA_ADMIN_PASSWORD');
      expect(run.stdout).not.toMatch(/One-time setup token/);
      expect(run.stdout).not.toMatch(/NOODARA_SETUP_TOKEN=/);

      // The api container's own log history contains no NOODARA_SETUP_TOKEN= line at all --
      // confirms bootstrap-admin.ts genuinely took the pre-seed branch, never issuing a token.
      const apiLogsResult = await fixture.exec(['/bin/sh', '-c', `cd ${INSTALL_DIR} && docker compose logs api`]);
      expect(apiLogsResult.exitCode).toBe(0);
      expect(apiLogsResult.stdout).not.toMatch(/NOODARA_SETUP_TOKEN=/);

      // Neither the email nor the password appears in stderr or install.log (the email IS
      // expected in .env by necessity -- the assertion is about output streams and the log file,
      // per this task's own <behavior> text).
      const installLog = await readFixtureFile(fixture, INSTALL_LOG_PATH);
      expect(run.stderr.includes(PRESEED_ADMIN_EMAIL), 'stderr must not contain the admin email').toBe(false);
      expect(run.stderr.includes(PRESEED_ADMIN_PASSWORD), 'stderr must not contain the admin password').toBe(false);
      expect(installLog.includes(PRESEED_ADMIN_EMAIL), 'install.log must not contain the admin email').toBe(false);
      expect(installLog.includes(PRESEED_ADMIN_PASSWORD), 'install.log must not contain the admin password').toBe(
        false,
      );
      // The password (a canary value here, T-06-02) must also never appear in stdout.
      expect(run.stdout.includes(PRESEED_ADMIN_PASSWORD), 'stdout must not contain the admin password').toBe(false);

      // Every OTHER generated secret is still absent from every stream/log too (T-06-02).
      const streams = runResultToStreams(run, installLog);
      assertNoSecretLeak(streams, env);

      // The pre-seeded admin can actually authenticate: POST /api/auth/sign-in/email through the
      // real panel proxy returns 200 with an HttpOnly session cookie -- the lighter of the two
      // proofs this task's <action> text offers, chosen over driving a full browser.
      const signInResult = await curlJsonInFixture(fixture, FIXTURE_PANEL_PORT, 'POST', '/api/auth/sign-in/email', {
        email: PRESEED_ADMIN_EMAIL,
        password: PRESEED_ADMIN_PASSWORD,
      });
      expect(signInResult.status, `POST /api/auth/sign-in/email body: ${signInResult.body}`).toBe(200);
      expect(hasHttpOnlyCookie(signInResult.headers), `sign-in response headers:\n${signInResult.headers}`).toBe(true);
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    'warns and issues a token instead when only NOODARA_ADMIN_EMAIL is supplied (the pair must be both-or-neither)',
    async () => {
      // Uses the SAME fixture and images as the test above, but this run must be a genuinely
      // separate installation directory: install.sh keys "already installed" on
      // NOODARA_INSTALL_DIR/.env existing, and the fixture above already wrote one. A second
      // fixture with the same images loaded is the cleanest way to prove this branch on a
      // completely fresh /opt/noodara without re-paying the image build cost.
      const onlyEmailFixture = await startInstallerDind({ ubuntu: '22.04' });
      try {
        const builtImages = images;
        if (builtImages === undefined) throw new Error('images is undefined -- beforeAll must have failed');
        await loadComposeImagesInto(onlyEmailFixture, builtImages);

        const run = await onlyEmailFixture.runInstallSh(
          {
            NOODARA_INTERNAL_IMAGE_PREFIX: builtImages.imagePrefix,
            NOODARA_VERSION: builtImages.version,
            NOODARA_PUBLIC_URL: `http://127.0.0.1:${String(FIXTURE_PANEL_PORT)}`,
            NOODARA_PORT: String(FIXTURE_PANEL_PORT),
            NOODARA_ADMIN_EMAIL: PRESEED_ADMIN_EMAIL,
          },
          { timeoutMs: INSTALL_TIMEOUT_MS },
        );

        expect(run.exitCode, `install.sh exit ${String(run.exitCode)}, stderr:\n${run.stderr}`).toBe(0);
        // Names both variables, never the password value (there is none supplied here, but the
        // assertion holds regardless -- the warning text itself must never echo a value).
        expect(run.stderr).toContain('NOODARA_ADMIN_EMAIL');
        expect(run.stderr).toContain('NOODARA_ADMIN_PASSWORD');
        expect(run.stderr).not.toContain(PRESEED_ADMIN_EMAIL);
        // A setup token is still printed (no pre-seed took effect).
        expect(run.stdout).toMatch(/One-time setup token: \S+/);
      } finally {
        await onlyEmailFixture.stop();
      }
    },
    SETUP_TIMEOUT_MS,
  );
});
