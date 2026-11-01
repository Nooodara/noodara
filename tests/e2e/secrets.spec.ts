// 24-04: a secret `database_url` at the environment scope and DATABASE_URL=<secret:database_url>
// at the service scope reach the env-api container: /env-digest matches the sha256 of the
// plaintext, while the UI (rows, effective view, build log, activity), the API list responses
// and the stack log files never carry it (per-run canary, A2). Deleting the still-referenced
// secret shows the SECRET_IN_USE copy, and the ACME/DNS test seams stay out of every shipped
// image and compose file (H1).
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { currentRun, expect, test } from './fixtures/deploy-host.js';
import {
  BASE_URL,
  Cleanup,
  ENGINE_TEST_TIMEOUT_MS,
  api,
  configureHealthcheck,
  connectServer,
  createGitService,
  createProject,
  deployViaApi,
  fixtureFiles,
  freePort,
  login,
  openService,
  removeServer,
  testRepo,
  uniqueSuffix,
  waitForStatus,
  type ConnectedServer,
} from './fixtures/engine.js';
import { STACK_LOG_DIR_NAME } from './fixtures/stack.js';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
/** Literal copy of apps/web/src/components/SecretsPanel.tsx SECRET_IN_USE_COPY (web is not importable). */
const SECRET_IN_USE_COPY = 'This secret is still referenced by these variables. Change or delete them first:';
const SECRET_NAME = 'database_url';
const VARIABLE_KEY = 'DATABASE_URL';
/** stack.ts mirrors process output every 500 ms. */
const LOG_FLUSH_WAIT_MS = 1_500;

/** Strings that belong to the e2e stack only. */
const SEAM_MARKERS = [/pebble/i, /minica/i, /NOODARA_ACME_CA_ROOT_FILE/, /E2E_DNS_SERVER_FILE/, /dns-seam/];
/** What ships: images, compose files and the installer. */
const SHIPPED_FILES = [
  'apps/control-plane/Dockerfile',
  'apps/web/Dockerfile',
  'docker-compose.yml',
  'docker-compose.dev.yml',
  'install.sh',
  '.dockerignore',
];
/** Sources that build into the images: they must not load or name the e2e seams. */
const SHIPPED_SOURCE_DIRS = ['apps/control-plane/src', 'apps/web/src', 'packages'];
const SOURCE_SEAM_MARKERS = [/E2E_DNS_SERVER_FILE/, /dns-seam/, /tests\/e2e\/fixtures/];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next' || entry === '.turbo') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs|cjs|json)$/.test(entry)) out.push(full);
  }
  return out;
}

test.describe('@e2e-secrets the ACME and DNS test seams never ship', () => {
  test('images, compose files and the installer carry no e2e seam', () => {
    for (const file of SHIPPED_FILES) {
      const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      for (const marker of SEAM_MARKERS) expect(marker.test(text), `${file} matches ${String(marker)}`).toBe(false);
    }
    for (const dir of SHIPPED_SOURCE_DIRS) {
      for (const file of walk(path.join(REPO_ROOT, dir))) {
        const text = readFileSync(file, 'utf8');
        for (const marker of SOURCE_SEAM_MARKERS) {
          expect(marker.test(text), `${path.relative(REPO_ROOT, file)} matches ${String(marker)}`).toBe(false);
        }
      }
    }
  });
});

let server: ConnectedServer | null = null;
let cleanup = new Cleanup();

function connected(): ConnectedServer {
  if (server === null) throw new Error('server not connected (beforeAll failed)');
  return server;
}

/** The environment's "Variables and secrets" disclosure on the project page, opened. */
async function environmentSecrets(page: Page, projectId: string, environmentId: string): Promise<Locator> {
  await page.goto(`/projects/${projectId}`);
  const disclosure = page.getByTestId(`environment-env-${environmentId}`);
  await disclosure.getByRole('button', { name: 'Variables and secrets' }).click();
  const panel = disclosure.getByTestId('secrets-panel-environment');
  await expect(panel).toBeVisible();
  return panel;
}

function expectNoCanary(where: string, text: string, canary: string): void {
  expect(text.includes(canary), `${where} carries the secret plaintext`).toBe(false);
}

test.describe('@e2e-secrets secret -> deploy -> never exposed', () => {
  test.use({ actionTimeout: 30_000, navigationTimeout: 30_000 });

  test.beforeAll(async ({ browser, deployHost }) => {
    test.setTimeout(5 * 60_000);
    const context = await browser.newContext({ baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      await login(page);
      server = await connectServer(page, deployHost);
    } finally {
      await context.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    if (server === null) return;
    const current = server;
    const context = await browser.newContext({ baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      await login(page);
      await removeServer(page, current);
    } finally {
      await context.close();
    }
  });

  test.beforeEach(async ({ page }) => {
    test.setTimeout(ENGINE_TEST_TIMEOUT_MS);
    cleanup = new Cleanup();
    await login(page);
  });

  test.afterEach(async ({ page }) => {
    await cleanup.run(page);
  });

  test('the container sees the secret while UI, API and logs never carry it; a referenced secret cannot go', async ({
    page,
    deployHost,
  }) => {
    const suffix = uniqueSuffix();
    const canary = `canary${randomBytes(16).toString('hex')}`;
    const plaintext = `postgres://app:${canary}@db.internal:5432/app`;
    const name = `secrets-${suffix}`;
    const repo = testRepo(deployHost, name);
    await repo.commit(fixtureFiles('env-api'), 'env-api');
    const { projectId, environmentId } = await createProject(page, cleanup, `${name}-project`);
    const service = await createGitService(page, deployHost, {
      projectId,
      environmentId,
      serverId: connected().id,
      name,
      repoUrl: repo.url,
      publishedPort: freePort(),
    });
    await configureHealthcheck(page, service, false);

    // A2: the secret at the environment scope, from the project page.
    const secrets = await environmentSecrets(page, projectId, environmentId);
    await secrets.getByTestId('secret-create-name').fill(SECRET_NAME);
    await secrets.getByTestId('secret-create-value').fill(plaintext);
    await secrets.getByTestId('secret-create-submit').click();
    await expect(secrets.getByTestId('secrets-list')).toContainText(SECRET_NAME);

    // A2: the reference at the service scope, from the service page.
    await openService(page, service);
    const variables = page.getByTestId('env-panel-service');
    await variables.getByTestId('env-add-key').fill(VARIABLE_KEY);
    await variables.getByTestId('env-add-value').fill(`<secret:${SECRET_NAME}>`);
    await variables.getByTestId('env-add-submit').click();
    await expect(variables.getByTestId('env-list')).toContainText(VARIABLE_KEY);

    const deploymentId = await deployViaApi(page, cleanup, service.serviceId);
    expect(await waitForStatus(page, deploymentId, ['SUCCESS', 'FAILED', 'ROLLED_BACK'])).toBe('SUCCESS');

    // A2: the running container sees the plaintext (only its digest leaves the container).
    const digest = await deployHost.curlPublishedPort(service.publishedPort, `/env-digest?name=${VARIABLE_KEY}`);
    expect(digest.status).toBe(200);
    expect(digest.body.trim()).toBe(createHash('sha256').update(plaintext, 'utf8').digest('hex'));

    // A2: the UI: rows, effective view, build log, activity.
    await openService(page, service);
    await expect(page.getByTestId(`effective-row-${VARIABLE_KEY}`)).toBeVisible();
    await expect(page.getByTestId('env-panel-service').getByTestId('env-list')).toContainText(VARIABLE_KEY);
    await expect(page.getByTestId('secrets-panel-service')).toBeVisible();
    expectNoCanary('service page', await page.content(), canary);

    const projectSecrets = await environmentSecrets(page, projectId, environmentId);
    await expect(projectSecrets.getByTestId('secrets-list')).toContainText(SECRET_NAME);
    expectNoCanary('project page', await page.content(), canary);

    await openService(page, service, `?deployment=${deploymentId}`);
    const buildLog = page.getByTestId('build-log-panel');
    await expect(buildLog).toBeVisible();
    await expect(page.getByTestId('build-log-loading')).toHaveCount(0);
    await expect(buildLog).not.toBeEmpty();
    expectNoCanary('build log', await page.content(), canary);

    await page.goto('/activity');
    await expect(page.getByTestId('activity-row').first()).toBeVisible();
    expectNoCanary('activity page', await page.content(), canary);

    // A2: every API list that touches the variable, the secret or the deployment.
    const lists = [
      `/api/projects/${projectId}/secrets`,
      `/api/projects/${projectId}/environments/${environmentId}/secrets`,
      `/api/projects/${projectId}/services/${service.serviceId}/secrets`,
      `/api/projects/${projectId}/env`,
      `/api/projects/${projectId}/environments/${environmentId}/env`,
      `/api/projects/${projectId}/services/${service.serviceId}/env`,
      `/api/projects/${projectId}/services/${service.serviceId}/env/effective`,
      `/api/deployments/${deploymentId}`,
      `/api/deployments/${deploymentId}/logs`,
      `/api/services/${service.serviceId}/deployments?limit=50`,
      '/api/activity?limit=200',
    ];
    for (const url of lists) {
      const listed = await api(page, 'GET', url);
      expect(listed.status, `${url}: ${JSON.stringify(listed.body)}`).toBe(200);
      expectNoCanary(url, JSON.stringify(listed.body), canary);
    }

    // H1: a referenced secret cannot be deleted; the panel names the variable that uses it.
    const panel = await environmentSecrets(page, projectId, environmentId);
    const secretRow = panel.locator('[data-testid^="secret-row-"]').filter({ hasText: SECRET_NAME });
    await secretRow.getByTestId('secret-delete').click();
    await page.getByTestId('secret-delete-confirm').getByRole('button', { name: 'Delete secret' }).click();
    const inUse = panel.getByTestId('secret-in-use');
    await expect(inUse).toContainText(SECRET_IN_USE_COPY);
    await expect(inUse.getByTestId('secret-in-use-item')).toContainText(VARIABLE_KEY);
    await expect(secretRow).toBeVisible();

    // A2: the stack's own log files (api, worker, web) never carried the plaintext.
    await new Promise((resolve) => setTimeout(resolve, LOG_FLUSH_WAIT_MS));
    const logDir = path.join(currentRun().runDir, STACK_LOG_DIR_NAME);
    const logs = readdirSync(logDir).filter((file) => file.endsWith('.log'));
    expect(logs.sort()).toEqual(expect.arrayContaining(['api.log', 'worker.log']));
    for (const file of logs) {
      const text = readFileSync(path.join(logDir, file), 'utf8');
      if (file === 'api.log' || file === 'worker.log') expect(text.length, `${file} is empty`).toBeGreaterThan(0);
      expectNoCanary(`stack log ${file}`, text, canary);
    }
  });
});
