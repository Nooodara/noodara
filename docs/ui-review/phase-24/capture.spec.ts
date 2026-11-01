// 24-05 (A3): screenshots of the phase-24 screens (domains panel, service variables with the
// effective view, environment secrets, reverse proxy card) at 375 and 1280 px, dark and light.
// Real data from the e2e deploy host with Pebble: one issued domain and one pointing elsewhere.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../../../tests/e2e/fixtures/acme.js';
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
  field,
  fixtureFiles,
  freePort,
  login,
  openService,
  removeServer,
  testRepo,
  uniqueSuffix,
  waitForStatus,
  type EngineService,
} from '../../../tests/e2e/fixtures/engine.js';

const DIR = path.resolve('docs/ui-review/phase-24');
const WIDTHS = [375, 1280] as const;
const THEMES = ['dark', 'light'] as const;
const CERT_TIMEOUT_MS = 5 * 60_000;

async function shoot(page: Page, name: string, prepare: (page: Page) => Promise<void>): Promise<void> {
  for (const width of WIDTHS) {
    for (const theme of THEMES) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await prepare(page);
      await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
      await page.waitForTimeout(1200);
      mkdirSync(DIR, { recursive: true });
      await page.screenshot({ path: path.join(DIR, `${name}-${width}-${theme}.png`), animations: 'disabled' });
    }
  }
}

async function certStatus(page: Page, service: EngineService, hostname: string): Promise<string | undefined> {
  const list = await api(page, 'GET', `/api/projects/${service.projectId}/services/${service.serviceId}/domains`);
  const items = (list.body as { items: { hostname: string; certStatus: string }[] }).items;
  return items.find((row) => row.hostname === hostname)?.certStatus;
}

test('phase-24 screens', async ({ browser, page, deployHost, acme }) => {
  test.setTimeout(ENGINE_TEST_TIMEOUT_MS * 3);
  const cleanup = new Cleanup();
  const context = await browser.newContext({ baseURL: BASE_URL });
  const setup = await context.newPage();
  await login(setup);
  const server = await connectServer(setup, deployHost, '127.0.0.1');
  try {
    const install = await api(setup, 'POST', `/api/servers/${server.id}/proxy`, { acmeEmail: 'ops@example.com' });
    expect(install.status, JSON.stringify(install.body)).toBe(202);
    await expect
      .poll(async () => field((await api(setup, 'GET', `/api/servers/${server.id}`)).body, 'proxyStatus'), {
        timeout: 4 * 60_000,
        intervals: [2_000, 5_000],
      })
      .toBe('RUNNING');

    const suffix = uniqueSuffix();
    const repo = testRepo(deployHost, `capture-${suffix}`);
    await repo.commit(fixtureFiles('node-api'), 'node-api');
    const { projectId, environmentId } = await createProject(setup, cleanup, `Capture ${suffix}`);
    const service = await createGitService(setup, deployHost, {
      projectId,
      environmentId,
      serverId: server.id,
      name: 'api',
      repoUrl: repo.url,
      publishedPort: freePort(),
    });
    await configureHealthcheck(setup, service, false);

    // Environment secret and variables, through the UI as a user would.
    await setup.goto(`/projects/${projectId}`);
    const envDisclosure = setup.getByTestId(`environment-env-${environmentId}`);
    await envDisclosure.getByRole('button', { name: 'Variables and secrets' }).click();
    const secrets = envDisclosure.getByTestId('secrets-panel-environment');
    await secrets.getByTestId('secret-create-name').fill('database_url');
    await secrets.getByTestId('secret-create-value').fill(`postgres://app:capture${suffix}@db.internal:5432/app`);
    await secrets.getByTestId('secret-create-submit').click();
    await expect(secrets.getByTestId('secrets-list')).toContainText('database_url');

    await openService(setup, service);
    const variables = setup.getByTestId('env-panel-service');
    for (const [key, value] of [
      ['DATABASE_URL', '<secret:database_url>'],
      ['LOG_LEVEL', 'info'],
    ] as const) {
      await variables.getByTestId('env-add-key').fill(key);
      await variables.getByTestId('env-add-value').fill(value);
      await variables.getByTestId('env-add-submit').click();
      await expect(variables.getByTestId('env-list')).toContainText(key);
    }

    const deploymentId = await deployViaApi(setup, cleanup, service.serviceId);
    expect(await waitForStatus(setup, deploymentId, ['SUCCESS', 'FAILED', 'ROLLED_BACK'])).toBe('SUCCESS');

    // Domains: one issued by Pebble, one pointing elsewhere (DNS mismatch, then Failed).
    const issued = `api.r${suffix}.test`;
    const elsewhere = `www.r${suffix}.test`;
    await acme.pointAtServer(issued);
    await acme.pointAt(elsewhere, '203.0.113.9');
    await openService(setup, service);
    const panel = setup.getByTestId('domains-panel');
    for (const hostname of [issued, elsewhere]) {
      await panel.getByTestId('domain-add-input').fill(hostname);
      await panel.getByTestId('domain-add-submit').click();
      const row = panel.locator('[data-testid^="domain-row-"]').filter({ hasText: hostname });
      await expect(row).toBeVisible();
      await row.getByTestId('domain-check-dns').click();
    }
    for (const [hostname, status] of [
      [issued, 'ISSUED'],
      [elsewhere, 'FAILED'],
    ] as const) {
      await expect
        .poll(() => certStatus(setup, service, hostname), { timeout: CERT_TIMEOUT_MS, intervals: [2_000, 5_000] })
        .toBe(status);
    }

    await login(page);
    await shoot(page, 'domains-panel', async (p) => {
      await openService(p, service);
      const failedRow = p.getByTestId('domains-panel').locator('[data-testid^="domain-row-"]').filter({ hasText: elsewhere });
      await failedRow.getByTestId('domain-details').getByRole('button', { name: 'Details' }).click();
      await expect(failedRow.getByTestId('domain-cert-failure')).toBeVisible();
      await p.getByTestId('domains-panel').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    });
    await shoot(page, 'service-variables', async (p) => {
      await openService(p, service);
      await expect(p.getByTestId('effective-row-DATABASE_URL')).toBeVisible();
      await p.getByTestId('env-panel-service').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    });
    await shoot(page, 'environment-secrets', async (p) => {
      await p.goto(`/projects/${projectId}`);
      const disclosure = p.getByTestId(`environment-env-${environmentId}`);
      await disclosure.getByRole('button', { name: 'Variables and secrets' }).click();
      const envSecrets = disclosure.getByTestId('secrets-panel-environment');
      await expect(envSecrets.getByTestId('secrets-list')).toContainText('database_url');
      await disclosure.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    });
    await shoot(page, 'proxy-card', async (p) => {
      await p.goto(`/servers/${server.id}`);
      await expect(p.getByTestId('proxy-status-pill')).toBeVisible();
      await p.getByTestId('proxy-card').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    });
    await acme.pebble.clearARecord(issued);
    await acme.pebble.clearARecord(elsewhere);
  } finally {
    await cleanup.run(setup).catch(() => undefined);
    await api(setup, 'POST', `/api/servers/${server.id}/proxy/remove`).catch(() => undefined);
    await expect
      .poll(async () => (await deployHost.listContainers()).includes('noodara-traefik'), { timeout: 90_000 })
      .toBe(false)
      .catch(() => undefined);
    await removeServer(setup, server).catch(() => undefined);
    await context.close();
  }
});
